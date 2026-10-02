/**
 * RoomEngine — 合言葉ルーム 1 つ分のゲーム進行（純粋なロジック）
 *
 * Durable Object からは「入力（参加・メッセージ・切断・アラーム）→ 効果（送信・アラーム・保存・D1 記録）」
 * の関数として使う。I/O を持たず、時刻・乱数・ID 生成を注入できるので Node 上でテストできる。
 */
import {
  DRAW_CANVAS_SIZE,
  DRAW_TIME_LIMIT_MS,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLACE_TIME_LIMIT_MS,
  PLAYER_COLORS,
  SERVER_GRACE_MS,
  SETTLE_TIMEOUT_MS,
  WORLD,
} from "../../shared/constants";
import type {
  ClientMessage,
  ErrorCode,
  PieceData,
  Pose,
  PublicPlayer,
  RoomPhase,
  RoomSnapshot,
  ServerMessage,
  Vec2,
} from "../../shared/protocol";
import { evaluateSize, measurePolygons, rollSizeRequirement, type SizeRequirement } from "../../shared/sizeRule";

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

export interface PlayerRecord {
  id: string;
  name: string;
  index: number;
  connected: boolean;
  eliminated: boolean;
  eliminatedAtTurn: number | null;
  piecesPlaced: number;
}

/** 不変のピース情報（画像が大きいので DO ストレージには 1 ピース 1 キーで保存） */
export interface PieceRecord {
  id: string;
  ownerId: string;
  ownerIndex: number;
  polygons: Vec2[][];
  image: string | null;
}

/** 部屋のメタ情報（DO ストレージの "room" キーにまるごと保存） */
export interface RoomData {
  code: string;
  phase: RoomPhase;
  hostId: string | null;
  players: PlayerRecord[];
  turn: number;
  activePlayerId: string | null;
  sizeRequirement: SizeRequirement | null;
  deadline: number | null;
  pendingPieceId: string | null;
  lastPreview: { x: number; angle: number } | null;
  /** 落下中に物理担当から届いた最新フレーム（静止待ちタイムアウト時の確定に使う） */
  lastFrame: Pose[] | null;
  simulatorId: string | null;
  /** 確定済みピースの位置（ピース本体と分けて保存し、毎ターンの書き込み量を抑える） */
  poses: Record<string, Omit<Pose, "id">>;
  startedAt: number | null;
  eliminationOrder: string[];
  winnerId: string | null;
  ranking: string[] | null;
  matchId: string | null;
}

export interface MatchRecord {
  id: string;
  roomCode: string;
  playerCount: number;
  totalTurns: number;
  winnerPlayerIndex: number | null;
  winnerName: string | null;
  startedAt: number;
  endedAt: number;
  results: {
    playerIndex: number;
    playerName: string;
    color: string;
    rank: number;
    piecesPlaced: number;
    eliminatedTurn: number | null;
  }[];
}

export type Target = { kind: "all" } | { kind: "only"; playerId: string } | { kind: "except"; playerId: string };

export interface Effects {
  /** 入力元の接続だけに返すメッセージ（参加前のエラーや WELCOME など） */
  reply: ServerMessage[];
  send: { to: Target; msg: ServerMessage }[];
  /** undefined = 変更なし / null = 解除 / number = その時刻に設定 */
  alarm: number | null | undefined;
  /** RoomData を保存し直す必要があるか */
  dirty: boolean;
  putPieces: PieceRecord[];
  deletePieceIds: string[];
  clearPieces: boolean;
  match: MatchRecord | null;
}

export interface EngineDeps {
  now(): number;
  random(): number;
  uuid(): string;
}

function emptyEffects(): Effects {
  return { reply: [], send: [], alarm: undefined, dirty: false, putPieces: [], deletePieceIds: [], clearPieces: false, match: null };
}

export function createRoomData(code: string): RoomData {
  return {
    code,
    phase: "lobby",
    hostId: null,
    players: [],
    turn: 0,
    activePlayerId: null,
    sizeRequirement: null,
    deadline: null,
    pendingPieceId: null,
    lastPreview: null,
    lastFrame: null,
    simulatorId: null,
    poses: {},
    startedAt: null,
    eliminationOrder: [],
    winnerId: null,
    ranking: null,
    matchId: null,
  };
}

const ERROR_TEXT: Record<ErrorCode, string> = {
  BAD_MESSAGE: "不正なメッセージです",
  NOT_JOINED: "先に入室してください",
  ROOM_FULL: "この部屋は満員です（最大4人）",
  ROOM_IN_PROGRESS: "この部屋は対戦中です",
  NOT_HOST: "ホストだけが操作できます",
  NOT_ENOUGH_PLAYERS: `${MIN_PLAYERS}人以上集まると開始できます`,
  WRONG_PHASE: "今はその操作はできません",
  NOT_YOUR_TURN: "あなたの手番ではありません",
  SIZE_TOO_SMALL: "サイズ規定を満たしていません",
};

/** 規定未達の時間切れ提出を受け入れる許容率（クライアントが拡大済みのはずなので多少の誤差は通す） */
const TIMEOUT_SIZE_TOLERANCE = 0.9;

export function sanitizeName(raw: string, index: number): string {
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  return Array.from(name).slice(0, MAX_NAME_LENGTH).join("") || PLAYER_COLORS[index].label;
}

// ---------------------------------------------------------------------------
// エンジン
// ---------------------------------------------------------------------------

export class RoomEngine {
  readonly data: RoomData;
  readonly pieces = new Map<string, PieceRecord>();
  private fx: Effects = emptyEffects();

  constructor(
    data: RoomData,
    pieces: Iterable<PieceRecord>,
    private readonly deps: EngineDeps,
  ) {
    this.data = data;
    for (const p of pieces) this.pieces.set(p.id, p);
  }

  // ---- 入力 -----------------------------------------------------------------

  /** JOIN。新規参加・再接続のどちらも扱う。成功すればその接続の playerId を返す */
  join(msg: Extract<ClientMessage, { type: "JOIN" }>): { playerId: string | null; effects: Effects } {
    return this.run(() => {
      const d = this.data;
      const existing = msg.playerId ? this.player(msg.playerId) : undefined;
      if (existing) {
        existing.connected = true;
        this.fx.reply.push(this.welcome(existing.id));
        this.broadcastRoomState(existing.id);
        return existing.id;
      }
      if (d.phase !== "lobby") return this.replyError("ROOM_IN_PROGRESS");
      if (d.players.length >= MAX_PLAYERS) return this.replyError("ROOM_FULL");

      const used = new Set(d.players.map((p) => p.index));
      let index = 0;
      while (used.has(index)) index++;
      const player: PlayerRecord = {
        id: this.deps.uuid(),
        name: sanitizeName(msg.name, index),
        index,
        connected: true,
        eliminated: false,
        eliminatedAtTurn: null,
        piecesPlaced: 0,
      };
      d.players.push(player);
      d.players.sort((a, b) => a.index - b.index);
      d.hostId ??= player.id;
      this.fx.reply.push(this.welcome(player.id));
      this.broadcastRoomState(player.id);
      return player.id;
    });
  }

  /** 入室済みプレイヤーからのメッセージ */
  handle(playerId: string, msg: ClientMessage): Effects {
    const { effects } = this.run(() => {
      const player = this.player(playerId);
      if (!player) return this.replyError("NOT_JOINED");
      switch (msg.type) {
        case "JOIN":
          return this.replyError("WRONG_PHASE");
        case "START":
          return this.onStart(player);
        case "RESTART":
          return this.onRestart(player);
        case "DRAW_SUBMIT":
          return this.onDrawSubmit(player, msg);
        case "PREVIEW":
          return this.onPreview(player, msg.x, msg.angle);
        case "DROP":
          return this.onDrop(player, msg.x, msg.angle);
        case "STATE_STREAM":
          return this.onStream(player, msg.frame);
        case "SETTLED":
          return this.onSettled(player, msg.snapshot, msg.fallen);
      }
    });
    // 高頻度の中継（PREVIEW / STATE_STREAM）は保存しない。DO が休止するほど間が空くことはない
    if (msg.type === "PREVIEW" || msg.type === "STATE_STREAM") effects.dirty = false;
    return effects;
  }

  /** そのプレイヤーの接続がすべて切れた */
  disconnect(playerId: string): Effects {
    return this.run(() => {
      const d = this.data;
      const player = this.player(playerId);
      if (!player) return;
      if (d.phase === "lobby") {
        d.players = d.players.filter((p) => p.id !== playerId);
        if (d.hostId === playerId) d.hostId = d.players[0]?.id ?? null;
      } else {
        // 対戦中は席を残す。自分の手番が来た時点でまだ切断中なら脱落（nextTurn で判定）
        player.connected = false;
      }
      this.broadcastRoomState();
    }).effects;
  }

  /** DO アラーム（締切）。フェーズごとにクライアントの代わりに処理を進める */
  alarm(): Effects {
    return this.run(() => {
      const d = this.data;
      if (d.deadline == null) return;
      const now = this.deps.now();
      const fireAt = this.alarmTimeFor(d.phase, d.deadline);
      if (fireAt == null) return;
      if (now < fireAt) {
        this.fx.alarm = fireAt;
        return;
      }
      if (d.phase === "drawing") this.submitFallbackPiece();
      else if (d.phase === "placing") this.drop(d.lastPreview?.x ?? WORLD.islandX, d.lastPreview?.angle ?? 0);
      else if (d.phase === "settling") this.settleFromLastFrame();
    }).effects;
  }

  // ---- ハンドラ ---------------------------------------------------------------

  private onStart(player: PlayerRecord) {
    const d = this.data;
    if (d.phase !== "lobby") return this.replyError("WRONG_PHASE");
    if (d.hostId !== player.id) return this.replyError("NOT_HOST");
    const ready = d.players.filter((p) => p.connected);
    if (ready.length < MIN_PLAYERS) return this.replyError("NOT_ENOUGH_PLAYERS");

    d.players = ready;
    for (const p of d.players) {
      p.eliminated = false;
      p.eliminatedAtTurn = null;
      p.piecesPlaced = 0;
    }
    d.turn = 0;
    d.activePlayerId = null;
    d.startedAt = this.deps.now();
    d.eliminationOrder = [];
    d.winnerId = null;
    d.ranking = null;
    d.matchId = null;
    d.poses = {};
    this.pieces.clear();
    this.fx.clearPieces = true;
    this.broadcastRoomState();
    this.nextTurn();
  }

  private onRestart(player: PlayerRecord) {
    const d = this.data;
    if (d.phase !== "finished") return this.replyError("WRONG_PHASE");
    if (d.hostId !== player.id) return this.replyError("NOT_HOST");
    d.players = d.players.filter((p) => p.connected);
    if (!d.players.some((p) => p.id === d.hostId)) d.hostId = d.players[0]?.id ?? null;
    for (const p of d.players) {
      p.eliminated = false;
      p.eliminatedAtTurn = null;
      p.piecesPlaced = 0;
    }
    Object.assign(d, {
      phase: "lobby",
      turn: 0,
      activePlayerId: null,
      sizeRequirement: null,
      deadline: null,
      pendingPieceId: null,
      lastPreview: null,
      lastFrame: null,
      simulatorId: null,
      poses: {},
      startedAt: null,
      eliminationOrder: [],
      winnerId: null,
      ranking: null,
      matchId: null,
    } satisfies Partial<RoomData>);
    this.pieces.clear();
    this.fx.clearPieces = true;
    this.fx.alarm = null;
    this.broadcastRoomState();
  }

  private onDrawSubmit(player: PlayerRecord, msg: Extract<ClientMessage, { type: "DRAW_SUBMIT" }>) {
    const d = this.data;
    if (d.phase !== "drawing") return this.replyError("WRONG_PHASE");
    if (d.activePlayerId !== player.id) return this.replyError("NOT_YOUR_TURN");
    const req = d.sizeRequirement!;
    const ev = evaluateSize(measurePolygons(msg.polygons), req);
    const accepted =
      ev.ok || (msg.reason === "timeout" && ev.sideRatio >= TIMEOUT_SIZE_TOLERANCE && ev.areaRatio >= TIMEOUT_SIZE_TOLERANCE * TIMEOUT_SIZE_TOLERANCE);
    if (!accepted && msg.reason === "button") return this.replyError("SIZE_TOO_SMALL");
    // 時間切れ提出が規定に届かない場合も止めずに受け入れる（クライアントはキャンバス上限まで拡大済み）
    this.acceptPiece(player, msg.polygons, msg.image);
  }

  private onPreview(player: PlayerRecord, x: number, angle: number) {
    const d = this.data;
    if (d.phase !== "placing" || d.activePlayerId !== player.id) return;
    d.lastPreview = { x: clampX(x), angle };
    // 高頻度なので保存しない（落ちても締切時に中央へ落とすだけ）
    this.fx.send.push({ to: { kind: "except", playerId: player.id }, msg: { type: "PREVIEW", ...d.lastPreview } });
  }

  private onDrop(player: PlayerRecord, x: number, angle: number) {
    const d = this.data;
    if (d.phase !== "placing") return this.replyError("WRONG_PHASE");
    if (d.activePlayerId !== player.id) return this.replyError("NOT_YOUR_TURN");
    this.drop(x, angle);
  }

  private onStream(player: PlayerRecord, frame: Pose[]) {
    const d = this.data;
    if (d.phase !== "settling" || d.simulatorId !== player.id) return;
    d.lastFrame = frame.filter((p) => this.pieces.has(p.id));
    this.fx.send.push({ to: { kind: "except", playerId: player.id }, msg: { type: "STATE_STREAM", frame: d.lastFrame } });
  }

  private onSettled(player: PlayerRecord, snapshot: Pose[], fallen: string[]) {
    const d = this.data;
    if (d.phase !== "settling") return this.replyError("WRONG_PHASE");
    if (d.simulatorId !== player.id) return this.replyError("NOT_YOUR_TURN");
    this.finalizeTurn(snapshot, fallen);
  }

  // ---- 進行 -----------------------------------------------------------------

  private acceptPiece(owner: PlayerRecord, polygons: Vec2[][], image: string | null) {
    const d = this.data;
    const piece: PieceRecord = { id: this.deps.uuid(), ownerId: owner.id, ownerIndex: owner.index, polygons, image };
    this.pieces.set(piece.id, piece);
    this.fx.putPieces.push(piece);
    d.phase = "placing";
    d.pendingPieceId = piece.id;
    d.lastPreview = null;
    d.deadline = this.deps.now() + PLACE_TIME_LIMIT_MS;
    this.fx.alarm = this.alarmTimeFor("placing", d.deadline);
    this.fx.send.push({ to: { kind: "all" }, msg: { type: "PIECE_SUBMITTED", piece: this.pieceData(piece), deadline: d.deadline } });
  }

  /** 締切までに提出が無かった → 規定を満たす四角を代わりに出す（画像なし） */
  private submitFallbackPiece() {
    const d = this.data;
    const owner = this.player(d.activePlayerId!);
    if (!owner) return;
    const req = d.sizeRequirement!;
    const side = Math.min(DRAW_CANVAS_SIZE * 0.9, Math.max(req.minWidth, Math.sqrt(req.minPixels)) * 1.08);
    const lo = (DRAW_CANVAS_SIZE - side) / 2;
    const hi = lo + side;
    const square = [
      { x: lo, y: lo },
      { x: hi, y: lo },
      { x: hi, y: hi },
      { x: lo, y: hi },
    ];
    this.acceptPiece(owner, [square], null);
  }

  private drop(x: number, angle: number) {
    const d = this.data;
    const active = this.player(d.activePlayerId!);
    d.phase = "settling";
    d.lastPreview = { x: clampX(x), angle };
    d.lastFrame = null;
    d.simulatorId = this.chooseSimulator();
    d.deadline = this.deps.now() + SETTLE_TIMEOUT_MS;
    this.fx.alarm = this.alarmTimeFor("settling", d.deadline);
    if (active) active.piecesPlaced++;
    this.fx.send.push({
      to: { kind: "all" },
      msg: {
        type: "DROPPED",
        pieceId: d.pendingPieceId!,
        x: d.lastPreview.x,
        angle,
        simulatorId: d.simulatorId,
        deadline: d.deadline,
      },
    });
  }

  /** 物理担当: 手番の人 → 接続中の生存者 → 接続中の誰か */
  private chooseSimulator(): string | null {
    const d = this.data;
    const active = this.player(d.activePlayerId!);
    if (active?.connected) return active.id;
    return (
      d.players.find((p) => p.connected && !p.eliminated)?.id ?? d.players.find((p) => p.connected)?.id ?? null
    );
  }

  /** 静止待ちタイムアウト。最後に届いたフレームで確定する（無ければ投下ピースを無効化） */
  private settleFromLastFrame() {
    const d = this.data;
    const frame = d.lastFrame;
    if (!frame || frame.length === 0) {
      this.finalizeTurn([], [], true);
      return;
    }
    const fallen = frame.filter((p) => p.y > WORLD.deathY).map((p) => p.id);
    this.finalizeTurn(
      frame.filter((p) => p.y <= WORLD.deathY),
      fallen,
    );
  }

  /**
   * ターンを確定する。fallen は盤面から消すピース。
   * discardPending = true のとき（物理担当が誰もいなかった）は投下ピースを黙って取り除き、脱落は発生させない。
   */
  private finalizeTurn(snapshot: Pose[], fallenIds: string[], discardPending = false) {
    const d = this.data;
    const realFalls = [...new Set(fallenIds)].filter((id) => this.pieces.has(id));
    const removed = new Set(realFalls);
    const accepted = snapshot.filter((p) => this.pieces.has(p.id) && !removed.has(p.id));
    for (const p of accepted) d.poses[p.id] = { x: p.x, y: p.y, angle: p.angle };

    // 確定位置の無い投下ピースは盤面に残せない。物理担当が省いたなら落下扱い、担当不在なら無効化
    const pending = d.pendingPieceId;
    if (pending && !d.poses[pending] && !removed.has(pending)) {
      if (!discardPending) realFalls.push(pending);
      removed.add(pending);
    }
    for (const id of removed) {
      this.pieces.delete(id);
      delete d.poses[id];
      this.fx.deletePieceIds.push(id);
    }

    // 1 つでも落ちたら手番の人が脱落
    let eliminatedPlayerId: string | null = null;
    if (realFalls.length > 0 && d.activePlayerId) {
      eliminatedPlayerId = d.activePlayerId;
      this.eliminate(eliminatedPlayerId);
    }

    d.pendingPieceId = null;
    d.simulatorId = null;
    d.lastFrame = null;
    this.fx.send.push({
      to: { kind: "all" },
      msg: { type: "TURN_RESULT", snapshot: accepted, fallen: [...removed], eliminatedPlayerId },
    });
    this.nextTurn();
  }

  /** 次の生存者へ。その人が切断中なら脱落させてさらに次へ。残り 1 人以下なら終了 */
  private nextTurn() {
    const d = this.data;
    for (;;) {
      const alive = d.players.filter((p) => !p.eliminated);
      if (alive.length <= 1) return this.finish();
      const current = d.activePlayerId ? this.player(d.activePlayerId) : undefined;
      const next =
        (current ? alive.find((p) => p.index > current.index) : undefined) ??
        // 先頭に戻る（current が無ければ最初の人）
        alive[0];
      d.activePlayerId = next.id;
      if (!next.connected) {
        this.eliminate(next.id);
        this.fx.send.push({ to: { kind: "all" }, msg: { type: "PLAYER_ELIMINATED", playerId: next.id, reason: "disconnected" } });
        continue;
      }
      return this.beginTurn(next);
    }
  }

  private beginTurn(player: PlayerRecord) {
    const d = this.data;
    d.turn++;
    d.phase = "drawing";
    d.activePlayerId = player.id;
    d.sizeRequirement = rollSizeRequirement(() => this.deps.random());
    d.pendingPieceId = null;
    d.lastPreview = null;
    d.lastFrame = null;
    d.simulatorId = null;
    d.deadline = this.deps.now() + DRAW_TIME_LIMIT_MS;
    this.fx.alarm = this.alarmTimeFor("drawing", d.deadline);
    this.fx.send.push({
      to: { kind: "all" },
      msg: {
        type: "TURN_START",
        turn: d.turn,
        activePlayerId: player.id,
        sizeRequirement: d.sizeRequirement,
        timeLimit: DRAW_TIME_LIMIT_MS,
        deadline: d.deadline,
      },
    });
  }

  private eliminate(playerId: string) {
    const d = this.data;
    const p = this.player(playerId);
    if (!p || p.eliminated) return;
    p.eliminated = true;
    p.eliminatedAtTurn = d.turn;
    d.eliminationOrder.push(p.id);
  }

  private finish() {
    const d = this.data;
    const now = this.deps.now();
    const alive = d.players.filter((p) => !p.eliminated);
    const winner = alive.length === 1 ? alive[0] : null;
    // 脱落が遅いほど上位
    const ranking = [...(winner ? [winner.id] : []), ...[...d.eliminationOrder].reverse()];
    d.phase = "finished";
    d.activePlayerId = null;
    d.sizeRequirement = null;
    d.deadline = null;
    d.pendingPieceId = null;
    d.simulatorId = null;
    d.winnerId = winner?.id ?? null;
    d.ranking = ranking;
    d.matchId = this.deps.uuid();
    this.fx.alarm = null;

    this.fx.match = {
      id: d.matchId,
      roomCode: d.code,
      playerCount: d.players.length,
      totalTurns: d.turn,
      winnerPlayerIndex: winner?.index ?? null,
      winnerName: winner?.name ?? null,
      startedAt: d.startedAt ?? now,
      endedAt: now,
      results: ranking
        .map((id, i) => ({ p: this.player(id)!, rank: i + 1 }))
        .filter(({ p }) => p)
        .map(({ p, rank }) => ({
          playerIndex: p.index,
          playerName: p.name,
          color: PLAYER_COLORS[p.index].hex,
          rank,
          piecesPlaced: p.piecesPlaced,
          eliminatedTurn: p.eliminatedAtTurn,
        })),
    };
    this.fx.send.push({ to: { kind: "all" }, msg: { type: "GAME_OVER", winnerId: d.winnerId, ranking, matchId: d.matchId } });
  }

  // ---- ヘルパー ---------------------------------------------------------------

  private run(fn: () => string | null | void): { effects: Effects; playerId: string | null } {
    this.fx = emptyEffects();
    const result = fn();
    const effects = this.fx;
    effects.dirty = true;
    this.fx = emptyEffects();
    return { effects, playerId: typeof result === "string" ? result : null };
  }

  private replyError(code: ErrorCode): null {
    this.fx.reply.push({ type: "ERROR", code, message: ERROR_TEXT[code] });
    return null;
  }

  private alarmTimeFor(phase: RoomPhase, deadline: number): number | null {
    if (phase === "drawing" || phase === "placing") return deadline + SERVER_GRACE_MS;
    if (phase === "settling") return deadline;
    return null;
  }

  private player(id: string): PlayerRecord | undefined {
    return this.data.players.find((p) => p.id === id);
  }

  private pieceData(p: PieceRecord): PieceData {
    return { ...p, pose: this.data.poses[p.id] ?? null };
  }

  snapshot(): RoomSnapshot {
    const d = this.data;
    return {
      code: d.code,
      phase: d.phase,
      hostId: d.hostId,
      players: d.players.map(
        (p): PublicPlayer => ({ id: p.id, name: p.name, index: p.index, connected: p.connected, eliminated: p.eliminated }),
      ),
      turn: d.turn,
      activePlayerId: d.activePlayerId,
      sizeRequirement: d.sizeRequirement,
      deadline: d.deadline,
      pendingPieceId: d.pendingPieceId,
      simulatorId: d.simulatorId,
      winnerId: d.winnerId,
      ranking: d.ranking,
    };
  }

  private welcome(playerId: string): ServerMessage {
    return {
      type: "WELCOME",
      playerId,
      serverTime: this.deps.now(),
      room: this.snapshot(),
      pieces: [...this.pieces.values()].map((p) => this.pieceData(p)),
      lastPreview: this.data.lastPreview,
    };
  }

  private broadcastRoomState(exceptId?: string) {
    this.fx.send.push({
      to: exceptId ? { kind: "except", playerId: exceptId } : { kind: "all" },
      msg: { type: "ROOM_STATE", serverTime: this.deps.now(), room: this.snapshot() },
    });
  }
}

function clampX(x: number): number {
  return Math.max(WORLD.minX, Math.min(WORLD.maxX, x));
}
