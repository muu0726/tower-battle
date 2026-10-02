// サーバーメッセージ → 画面用の部屋の状態（純関数）
import type {
  ErrorMessage,
  GameOverMessage,
  PieceData,
  Pose,
  RoomSnapshot,
  ServerMessage,
  TurnResultMessage,
  TurnStartMessage,
} from "../../shared/protocol";

export interface RoomView {
  /** 自分の playerId（WELCOME を受けるまで null） */
  me: string | null;
  /** サーバー時刻 - ローカル時刻 (ms)。締切の残り時間計算に使う */
  serverOffset: number;
  room: RoomSnapshot | null;
  /** 盤面のピース（配置中・落下中のピースも含む） */
  pieces: Record<string, PieceData>;
  /** 最新の TURN_START（サイズ規定・制限時間） */
  turnStart: TurnStartMessage | null;
  /** 手番プレイヤーの配置プレビュー */
  preview: { x: number; angle: number } | null;
  /** 物理担当から届いた最新の姿勢フレーム */
  frame: Pose[] | null;
  lastResult: TurnResultMessage | null;
  gameOver: GameOverMessage | null;
  error: ErrorMessage | null;
}

export const initialRoomView: RoomView = {
  me: null,
  serverOffset: 0,
  room: null,
  pieces: {},
  turnStart: null,
  preview: null,
  frame: null,
  lastResult: null,
  gameOver: null,
  error: null,
};

export function reduceRoom(view: RoomView, msg: ServerMessage, localNow = Date.now()): RoomView {
  if (msg.type === "WELCOME") {
    return {
      ...initialRoomView,
      me: msg.playerId,
      serverOffset: msg.serverTime - localNow,
      room: msg.room,
      pieces: Object.fromEntries(msg.pieces.map((p) => [p.id, p])),
      preview: msg.lastPreview,
    };
  }
  if (msg.type === "ERROR") return { ...view, error: msg };

  const room = view.room;
  if (!room) return view;

  switch (msg.type) {
    case "ROOM_STATE": {
      // ロビーに戻った（RESTART）なら盤面と試合結果を消す
      const back = msg.room.phase === "lobby" && room.phase !== "lobby";
      return {
        ...view,
        serverOffset: msg.serverTime - localNow,
        room: msg.room,
        ...(back ? { pieces: {}, turnStart: null, preview: null, frame: null, lastResult: null, gameOver: null } : {}),
      };
    }
    case "TURN_START": {
      // 新しい試合の最初のターンなら前の試合の盤面を消す
      const fresh = msg.turn === 1;
      return {
        ...view,
        room: {
          ...room,
          phase: "drawing",
          turn: msg.turn,
          activePlayerId: msg.activePlayerId,
          sizeRequirement: msg.sizeRequirement,
          deadline: msg.deadline,
          pendingPieceId: null,
          simulatorId: null,
          ...(fresh ? { winnerId: null, ranking: null } : {}),
        },
        pieces: fresh ? {} : view.pieces,
        turnStart: msg,
        preview: null,
        frame: null,
        gameOver: fresh ? null : view.gameOver,
        lastResult: fresh ? null : view.lastResult,
        error: null,
      };
    }
    case "PIECE_SUBMITTED":
      return {
        ...view,
        room: { ...room, phase: "placing", deadline: msg.deadline, pendingPieceId: msg.piece.id },
        pieces: { ...view.pieces, [msg.piece.id]: msg.piece },
        preview: null,
      };
    case "PREVIEW":
      return { ...view, preview: { x: msg.x, angle: msg.angle } };
    case "DROPPED":
      return {
        ...view,
        room: { ...room, phase: "settling", deadline: msg.deadline, simulatorId: msg.simulatorId },
        preview: { x: msg.x, angle: msg.angle },
        frame: null,
      };
    case "STATE_STREAM":
      return { ...view, frame: msg.frame };
    case "TURN_RESULT": {
      const pieces = { ...view.pieces };
      for (const id of msg.fallen) delete pieces[id];
      for (const p of msg.snapshot) {
        if (pieces[p.id]) pieces[p.id] = { ...pieces[p.id], pose: { x: p.x, y: p.y, angle: p.angle } };
      }
      return {
        ...view,
        room: {
          ...markEliminated(room, msg.eliminatedPlayerId),
          pendingPieceId: null,
          simulatorId: null,
        },
        pieces,
        frame: null,
        preview: null,
        lastResult: msg,
      };
    }
    case "PLAYER_ELIMINATED":
      return { ...view, room: markEliminated(room, msg.playerId) };
    case "GAME_OVER":
      return {
        ...view,
        room: {
          ...room,
          phase: "finished",
          activePlayerId: null,
          deadline: null,
          winnerId: msg.winnerId,
          ranking: msg.ranking,
        },
        gameOver: msg,
      };
  }
}

function markEliminated(room: RoomSnapshot, playerId: string | null): RoomSnapshot {
  if (!playerId) return room;
  return { ...room, players: room.players.map((p) => (p.id === playerId ? { ...p, eliminated: true } : p)) };
}

/** 締切までの残り時間 (ms)。サーバーとの時計のずれを補正する */
export function remainingMs(view: RoomView, deadline: number | null | undefined, localNow = Date.now()): number | null {
  if (deadline == null) return null;
  return Math.max(0, deadline - (localNow + view.serverOffset));
}
