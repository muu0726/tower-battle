import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { parseClientMessage, type ServerMessage } from "../shared/protocol";
import { matches, matchResults } from "./db/schema";
import type { Env } from "./env";
import { createRoomData, RoomEngine, type Effects, type MatchRecord, type PieceRecord, type RoomData } from "./room/engine";

interface Attachment {
  playerId: string | null;
}

const ROOM_KEY = "room";
const PIECE_PREFIX = "piece:";

/**
 * 合言葉ルーム 1 つにつき 1 インスタンス。ゲームのルールは RoomEngine に任せ、ここは I/O だけを担当する。
 * - WebSocket Hibernation API: 休止中もソケットは維持され、各ソケットには playerId を attachment で持たせる
 * - 状態は DO ストレージに保存し、起動時に復元する（休止でメモリが消えても続きから再開できる）
 * - 締切は DO アラームで管理する
 */
export class GameRoom extends DurableObject<Env> {
  private engine!: RoomEngine;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 接続維持の ping には DO を起こさずに応答
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      const data = (await ctx.storage.get<RoomData>(ROOM_KEY)) ?? createRoomData("");
      const pieces = await ctx.storage.list<PieceRecord>({ prefix: PIECE_PREFIX });
      this.engine = new RoomEngine(data, pieces.values(), {
        now: () => Date.now(),
        random: () => Math.random(),
        uuid: () => crypto.randomUUID(),
      });
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const code = request.headers.get("X-Room-Code");
    if (code && !this.engine.data.code) {
      this.engine.data.code = code;
      await this.ctx.storage.put(ROOM_KEY, this.engine.data);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
    const msg = parseClientMessage(json);
    if (!msg) {
      this.sendTo(ws, { type: "ERROR", code: "BAD_MESSAGE", message: "不正なメッセージです" });
      return;
    }

    if (msg.type === "JOIN") {
      const { playerId, effects } = this.engine.join(msg);
      if (playerId) ws.serializeAttachment({ playerId } satisfies Attachment);
      await this.apply(effects, ws);
      return;
    }

    const playerId = this.attachment(ws).playerId;
    if (!playerId) {
      this.sendTo(ws, { type: "ERROR", code: "NOT_JOINED", message: "先に入室してください" });
      return;
    }
    await this.apply(this.engine.handle(playerId, msg), ws);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // 既に閉じている
    }
    await this.onSocketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  async alarm(): Promise<void> {
    await this.apply(this.engine.alarm(), null);
  }

  // ---------------------------------------------------------------------------

  private async onSocketGone(ws: WebSocket) {
    const playerId = this.attachment(ws).playerId;
    if (!playerId) return;
    // 同じプレイヤーが別のソケットで再接続済みなら切断扱いにしない
    const stillConnected = this.ctx
      .getWebSockets()
      .some((s) => s !== ws && s.readyState === WebSocket.OPEN && this.attachment(s).playerId === playerId);
    if (stillConnected) return;
    await this.apply(this.engine.disconnect(playerId), null);
  }

  private attachment(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { playerId: null };
  }

  private sendTo(ws: WebSocket, msg: ServerMessage | string) {
    try {
      ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    } catch {
      // 送信中に切れたソケットは close イベント側で処理される
    }
  }

  private async apply(effects: Effects, origin: WebSocket | null) {
    if (origin) for (const msg of effects.reply) this.sendTo(origin, msg);

    if (effects.send.length > 0) {
      const sockets = this.ctx.getWebSockets().map((ws) => ({ ws, playerId: this.attachment(ws).playerId }));
      for (const { to, msg } of effects.send) {
        const text = JSON.stringify(msg);
        for (const { ws, playerId } of sockets) {
          if (!playerId) continue;
          if (to.kind === "only" && playerId !== to.playerId) continue;
          if (to.kind === "except" && playerId === to.playerId) continue;
          this.sendTo(ws, text);
        }
      }
    }

    const storage = this.ctx.storage;
    if (effects.clearPieces) {
      const keys = [...(await storage.list({ prefix: PIECE_PREFIX })).keys()];
      // delete は 1 回 128 キーまで
      for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
    }
    for (const piece of effects.putPieces) await storage.put(PIECE_PREFIX + piece.id, piece);
    if (effects.deletePieceIds.length > 0) await storage.delete(effects.deletePieceIds.map((id) => PIECE_PREFIX + id));
    if (effects.dirty) await storage.put(ROOM_KEY, this.engine.data);

    if (effects.alarm === null) await storage.deleteAlarm();
    else if (effects.alarm !== undefined) await storage.setAlarm(effects.alarm);

    if (effects.match) await this.recordMatch(effects.match);
  }

  private async recordMatch(m: MatchRecord) {
    try {
      const db = drizzle(this.env.DB);
      await db.batch([
        db.insert(matches).values({
          id: m.id,
          roomCode: m.roomCode,
          playerCount: m.playerCount,
          totalTurns: m.totalTurns,
          winnerPlayerIndex: m.winnerPlayerIndex,
          winnerName: m.winnerName,
          startedAt: new Date(m.startedAt),
          endedAt: new Date(m.endedAt),
        }),
        db.insert(matchResults).values(m.results.map((r) => ({ matchId: m.id, ...r }))),
      ]);
    } catch (err) {
      // 記録に失敗してもゲーム自体は続ける
      console.error("failed to record match", m.id, err);
    }
  }
}
