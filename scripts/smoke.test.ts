/**
 * 通しの動作確認: `npm run dev` を起動した状態で `npm run smoke`
 *
 * 仮想プレイヤー 3 人（A=ホスト, B, C）が本物の WebSocket で同じ合言葉の部屋に入り、試合を最後までプレイする。
 *   ターン1 A: 島の上に置く / ターン2 B: 島の外に落とす（脱落）/ ターン3 C: 置く / ターン4 A: 落とす（脱落）→ C の勝ち
 * 途中で C の回線を切って自動再接続させ、状態が戻ること、終了後に D1 に試合結果が入っていることも確認する。
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { WORLD } from "../shared/constants";
import type { Pose, ServerMessage, Vec2 } from "../shared/protocol";
import type { SizeRequirement } from "../shared/sizeRule";
import { RoomClient } from "../src/net/roomClient";
import { initialRoomView, reduceRoom, type RoomView } from "../src/net/roomStore";

const BASE_URL = process.env.SMOKE_URL ?? "http://localhost:5173";
/** 試合結果を確認する D1。本番に向けて流すときは SMOKE_D1=remote */
const D1_TARGET = process.env.SMOKE_D1 === "remote" ? "--remote" : "--local";
/** 1x1 の透明 PNG */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, pred: () => boolean, timeoutMs = 10_000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what}`);
    await sleep(20);
  }
}

function squareFor(req: SizeRequirement): Vec2[][] {
  const side = Math.max(req.minWidth, Math.sqrt(req.minPixels)) * 1.1;
  const lo = (256 - side) / 2;
  const hi = lo + side;
  return [[{ x: lo, y: lo }, { x: hi, y: lo }, { x: hi, y: hi }, { x: lo, y: hi }]];
}

class Bot {
  view: RoomView = initialRoomView;
  readonly log: ServerMessage[] = [];
  readonly client: RoomClient;
  private myTurns = 0;
  /** 手番の前に待つもの（再接続の完了待ちなど） */
  beforeTurn: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    code: string,
    /** 自分の n 回目の手番で落とすか */
    private readonly fallOnTurn: (n: number) => boolean,
  ) {
    this.client = new RoomClient({ code, name, baseUrl: BASE_URL, storage: memory() });
    this.client.onMessage((msg) => {
      this.view = reduceRoom(this.view, msg);
      this.log.push(msg);
      void this.act(msg);
    });
  }

  get id() {
    return this.view.me;
  }

  received(type: ServerMessage["type"]) {
    return this.log.filter((m) => m.type === type);
  }

  private async act(msg: ServerMessage) {
    const me = this.view.me;
    if (msg.type === "TURN_START" && msg.activePlayerId === me) {
      this.myTurns++;
      await this.beforeTurn;
      this.client.send({ type: "DRAW_SUBMIT", polygons: squareFor(msg.sizeRequirement), image: TINY_PNG, reason: "button" });
    }
    if (msg.type === "PIECE_SUBMITTED" && msg.piece.ownerId === me) {
      this.client.sendPreview(300, 0);
      this.client.sendPreview(350, 0.1);
      await sleep(80);
      const fall = this.fallOnTurn(this.myTurns);
      this.client.drop(fall ? WORLD.minX : WORLD.islandX, 0);
    }
    if (msg.type === "DROPPED" && msg.simulatorId === me) {
      const fall = this.fallOnTurn(this.myTurns);
      const settledY = WORLD.islandY - 60 - Object.keys(this.view.pieces).length * 80;
      const y = fall ? WORLD.deathY + 100 : settledY;
      this.client.sendStream([{ id: msg.pieceId, x: msg.x, y: 400, angle: 0 }]);
      await sleep(60);
      this.client.sendStream([{ id: msg.pieceId, x: msg.x, y, angle: 0 }]);
      await sleep(60);
      const snapshot: Pose[] = Object.values(this.view.pieces)
        .filter((p) => p.pose)
        .map((p) => ({ id: p.id, ...p.pose! }));
      if (!fall) snapshot.push({ id: msg.pieceId, x: msg.x, y, angle: 0 });
      this.client.settle(snapshot, fall ? [msg.pieceId] : []);
    }
  }
}

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function d1(sql: string): Record<string, unknown>[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "tower-battle-db", D1_TARGET, "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (JSON.parse(out) as { results: Record<string, unknown>[] }[])[0].results;
}

describe("smoke: 3 人で 1 試合", () => {
  it("入室 → 対戦 → 切断と再接続 → 脱落 → 勝敗 → D1 記録", async () => {
    const health = await fetch(`${BASE_URL}/api/health`).catch(() => null);
    if (!health?.ok) throw new Error(`開発サーバーに接続できません (${BASE_URL})。先に npm run dev を起動してください`);

    const code = `smoke-${Date.now().toString(36)}`;
    const a = new Bot("A", code, (n) => n === 2);
    const b = new Bot("B", code, () => true);
    const c = new Bot("C", code, () => false);

    // --- 入室（順番に入って P1〜P3 になる）---
    for (const bot of [a, b, c]) {
      bot.client.connect();
      await waitFor(`${bot.name} WELCOME`, () => bot.view.me !== null);
    }
    await waitFor("全員が 3 人を認識", () => [a, b, c].every((x) => x.view.room?.players.length === 3));
    expect(a.view.room!.hostId).toBe(a.id);
    expect(a.view.room!.players.map((p) => [p.name, p.index])).toEqual([
      ["A", 0],
      ["B", 1],
      ["C", 2],
    ]);

    // C の回線を最初のターン中に切り、再接続が終わるまで A は描かない
    let reconnected!: () => void;
    a.beforeTurn = new Promise((r) => (reconnected = r));

    a.client.send({ type: "START" });
    await waitFor("C が TURN_START を受信", () => c.received("TURN_START").length === 1);
    const cId = c.id;
    c.client.simulateNetworkDrop();
    await waitFor("C の再接続", () => c.received("WELCOME").length === 2);
    expect(c.id).toBe(cId);
    expect(c.view.room!.phase).toBe("drawing");
    reconnected();

    // 対戦中の新規入室は拒否される
    const late = new Bot("Late", code, () => false);
    late.client.connect();
    await waitFor("Late が拒否される", () => late.received("ERROR").length > 0);
    expect(late.received("ERROR")[0]).toMatchObject({ code: "ROOM_IN_PROGRESS" });
    expect(late.client.connectionStatus).toBe("closed");

    // --- 試合終了まで ---
    await waitFor("GAME_OVER", () => [a, b, c].every((x) => x.received("GAME_OVER").length === 1), 20_000);
    const over = a.received("GAME_OVER")[0];
    expect(over).toMatchObject({ type: "GAME_OVER", winnerId: c.id, ranking: [c.id, a.id, b.id] });

    // --- 中継の確認 ---
    expect(b.received("PREVIEW").length).toBeGreaterThan(0); // A のプレビューが B に届く
    expect(a.log.some((m) => m.type === "PREVIEW")).toBe(true); // B・C のプレビューは A に届く
    expect(c.received("STATE_STREAM").length).toBeGreaterThan(0);
    const turnResults = c.received("TURN_RESULT");
    expect(turnResults.map((m) => m.type === "TURN_RESULT" && m.eliminatedPlayerId)).toEqual([null, b.id, null, a.id]);
    for (const bot of [a, b, c]) expect(bot.received("ERROR")).toEqual([]);
    // 盤面には落ちなかった 2 ピースが残る
    expect(Object.keys(c.view.pieces)).toHaveLength(2);

    // --- D1 ---
    if (over.type !== "GAME_OVER") throw new Error("unreachable");
    const [match] = d1(`SELECT * FROM matches WHERE id = '${over.matchId}'`);
    expect(match).toMatchObject({ room_code: code, player_count: 3, total_turns: 4, winner_player_index: 2, winner_name: "C" });
    const results = d1(`SELECT player_index, player_name, rank, pieces_placed, eliminated_turn FROM match_results WHERE match_id = '${over.matchId}' ORDER BY rank`);
    expect(results).toEqual([
      { player_index: 2, player_name: "C", rank: 1, pieces_placed: 1, eliminated_turn: null },
      { player_index: 0, player_name: "A", rank: 2, pieces_placed: 2, eliminated_turn: 4 },
      { player_index: 1, player_name: "B", rank: 3, pieces_placed: 1, eliminated_turn: 2 },
    ]);

    // --- 再戦でロビーに戻る ---
    a.client.send({ type: "RESTART" });
    await waitFor("ロビーに戻る", () => [a, b, c].every((x) => x.view.room?.phase === "lobby"));
    expect(c.view.pieces).toEqual({});

    for (const bot of [a, b, c, late]) bot.client.close();
  });
});
