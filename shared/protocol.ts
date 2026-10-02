// クライアント ⇔ Durable Object の WebSocket メッセージ定義
import { DRAW_CANVAS_SIZE } from "./constants";
import type { SizeRequirement } from "./sizeRule";

export interface Vec2 {
  x: number;
  y: number;
}

/** ワールド座標でのピースの位置・角度（x, y はボディの原点 = 描いたキャンバスの中心） */
export interface Pose {
  id: string;
  x: number;
  y: number;
  angle: number;
}

export type RoomPhase = "lobby" | "drawing" | "placing" | "settling" | "finished";

export interface PublicPlayer {
  id: string;
  name: string;
  /** 0〜3（P1〜P4、色の番号） */
  index: number;
  connected: boolean;
  eliminated: boolean;
}

export interface PieceData {
  id: string;
  ownerId: string;
  ownerIndex: number;
  /** キャンバス座標 (0〜256) の輪郭ポリゴン */
  polygons: Vec2[][];
  /** 描いた絵の PNG data URL。サーバーが代わりに出したブロックは null（各クライアントが色で塗る） */
  image: string | null;
  /** 確定した位置。配置中・落下中のピースは null */
  pose: Omit<Pose, "id"> | null;
}

export interface RoomSnapshot {
  code: string;
  phase: RoomPhase;
  hostId: string | null;
  players: PublicPlayer[];
  turn: number;
  activePlayerId: string | null;
  sizeRequirement: SizeRequirement | null;
  /** 現在フェーズの締切（サーバー時刻 ms） */
  deadline: number | null;
  pendingPieceId: string | null;
  simulatorId: string | null;
  winnerId: string | null;
  /** 順位順の playerId（試合終了後のみ） */
  ranking: string[] | null;
}

// ---------------------------------------------------------------------------
// サーバー → クライアント
// ---------------------------------------------------------------------------

export interface WelcomeMessage {
  type: "WELCOME";
  playerId: string;
  serverTime: number;
  room: RoomSnapshot;
  /** 盤面の全ピース（再接続時の復元用） */
  pieces: PieceData[];
  lastPreview: { x: number; angle: number } | null;
}

export interface RoomStateMessage {
  type: "ROOM_STATE";
  serverTime: number;
  room: RoomSnapshot;
}

/** ターン開始。サーバーがサイズ規定を抽選して全員に配る */
export interface TurnStartMessage {
  type: "TURN_START";
  turn: number;
  activePlayerId: string;
  sizeRequirement: SizeRequirement;
  /** お絵描きフェーズの制限時間 (ms) */
  timeLimit: number;
  /** お絵描きの締切（サーバー時刻 ms） */
  deadline: number;
}

export interface PieceSubmittedMessage {
  type: "PIECE_SUBMITTED";
  piece: PieceData;
  /** 配置の締切 */
  deadline: number;
}

export interface PreviewMessage {
  type: "PREVIEW";
  x: number;
  angle: number;
}

export interface DroppedMessage {
  type: "DROPPED";
  pieceId: string;
  x: number;
  angle: number;
  /** 物理を回して STATE_STREAM / SETTLED を送る担当（いなければ null） */
  simulatorId: string | null;
  /** 静止確定の締切 */
  deadline: number;
}

export interface StateStreamMessage {
  type: "STATE_STREAM";
  frame: Pose[];
}

export interface TurnResultMessage {
  type: "TURN_RESULT";
  snapshot: Pose[];
  /** 盤面から取り除くピース（落下したもの。物理担当不在で無効になった投下ピースも含む） */
  fallen: string[];
  /** 落下で脱落した手番プレイヤー */
  eliminatedPlayerId: string | null;
}

export interface PlayerEliminatedMessage {
  type: "PLAYER_ELIMINATED";
  playerId: string;
  reason: "disconnected";
}

export interface GameOverMessage {
  type: "GAME_OVER";
  winnerId: string | null;
  ranking: string[];
  matchId: string;
}

export type ErrorCode =
  | "BAD_MESSAGE"
  | "NOT_JOINED"
  | "ROOM_FULL"
  | "ROOM_IN_PROGRESS"
  | "NOT_HOST"
  | "NOT_ENOUGH_PLAYERS"
  | "WRONG_PHASE"
  | "NOT_YOUR_TURN"
  | "SIZE_TOO_SMALL";

export interface ErrorMessage {
  type: "ERROR";
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | RoomStateMessage
  | TurnStartMessage
  | PieceSubmittedMessage
  | PreviewMessage
  | DroppedMessage
  | StateStreamMessage
  | TurnResultMessage
  | PlayerEliminatedMessage
  | GameOverMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// クライアント → サーバー
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: "JOIN"; name: string; playerId?: string }
  | { type: "START" }
  | { type: "DRAW_SUBMIT"; polygons: Vec2[][]; image: string; reason: "button" | "timeout" }
  | { type: "PREVIEW"; x: number; angle: number }
  | { type: "DROP"; x: number; angle: number }
  | { type: "STATE_STREAM"; frame: Pose[] }
  | { type: "SETTLED"; snapshot: Pose[]; fallen: string[] }
  | { type: "RESTART" };

export const PROTOCOL_LIMITS = {
  maxPolygons: 4,
  minVertices: 3,
  maxVertices: 64,
  maxImageLength: 200_000,
  maxPoses: 200,
  maxIdLength: 64,
} as const;

// ---------------------------------------------------------------------------
// バリデータ（依存ライブラリなしの手書き）
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= PROTOCOL_LIMITS.maxIdLength;

function parsePolygons(v: unknown): Vec2[][] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > PROTOCOL_LIMITS.maxPolygons) return null;
  const out: Vec2[][] = [];
  for (const poly of v) {
    if (!Array.isArray(poly) || poly.length < PROTOCOL_LIMITS.minVertices || poly.length > PROTOCOL_LIMITS.maxVertices) {
      return null;
    }
    const pts: Vec2[] = [];
    for (const p of poly) {
      if (!isObj(p) || !isNum(p.x) || !isNum(p.y)) return null;
      if (p.x < 0 || p.y < 0 || p.x > DRAW_CANVAS_SIZE || p.y > DRAW_CANVAS_SIZE) return null;
      pts.push({ x: p.x, y: p.y });
    }
    out.push(pts);
  }
  return out;
}

function parsePoses(v: unknown): Pose[] | null {
  if (!Array.isArray(v) || v.length > PROTOCOL_LIMITS.maxPoses) return null;
  const out: Pose[] = [];
  for (const p of v) {
    if (!isObj(p) || !isId(p.id) || !isNum(p.x) || !isNum(p.y) || !isNum(p.angle)) return null;
    out.push({ id: p.id, x: p.x, y: p.y, angle: p.angle });
  }
  return out;
}

function parseIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > PROTOCOL_LIMITS.maxPoses || !v.every(isId)) return null;
  return v as string[];
}

/** 受信した JSON を検査して ClientMessage にする。不正なら null */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObj(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "JOIN": {
      if (typeof raw.name !== "string" || raw.name.length > 100) return null;
      if (raw.playerId !== undefined && !isId(raw.playerId)) return null;
      return { type: "JOIN", name: raw.name, ...(raw.playerId ? { playerId: raw.playerId as string } : {}) };
    }
    case "START":
    case "RESTART":
      return { type: raw.type };
    case "DRAW_SUBMIT": {
      const polygons = parsePolygons(raw.polygons);
      const image = raw.image;
      if (!polygons || typeof image !== "string") return null;
      if (!image.startsWith("data:image/") || image.length > PROTOCOL_LIMITS.maxImageLength) return null;
      if (raw.reason !== "button" && raw.reason !== "timeout") return null;
      return { type: "DRAW_SUBMIT", polygons, image, reason: raw.reason };
    }
    case "PREVIEW":
    case "DROP":
      if (!isNum(raw.x) || !isNum(raw.angle)) return null;
      return { type: raw.type, x: raw.x, angle: raw.angle };
    case "STATE_STREAM": {
      const frame = parsePoses(raw.frame);
      return frame ? { type: "STATE_STREAM", frame } : null;
    }
    case "SETTLED": {
      const snapshot = parsePoses(raw.snapshot);
      const fallen = parseIds(raw.fallen);
      return snapshot && fallen ? { type: "SETTLED", snapshot, fallen } : null;
    }
    default:
      return null;
  }
}
