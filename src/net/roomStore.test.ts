import { describe, expect, it } from "vitest";
import type { PieceData, RoomSnapshot, ServerMessage } from "../../shared/protocol";
import { initialRoomView, reduceRoom, remainingMs, type RoomView } from "./roomStore";

const room: RoomSnapshot = {
  code: "ねこ",
  phase: "lobby",
  hostId: "a",
  players: [
    { id: "a", name: "A", index: 0, connected: true, eliminated: false },
    { id: "b", name: "B", index: 1, connected: true, eliminated: false },
  ],
  turn: 0,
  activePlayerId: null,
  sizeRequirement: null,
  deadline: null,
  pendingPieceId: null,
  simulatorId: null,
  winnerId: null,
  ranking: null,
};

const piece = (id: string): PieceData => ({
  id,
  ownerId: "a",
  ownerIndex: 0,
  polygons: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]],
  image: null,
  pose: null,
});

const req = { class: "SMALL" as const, minWidth: 60, minHeight: 60, minPixels: 1500 };

function run(msgs: ServerMessage[], start: RoomView = initialRoomView): RoomView {
  return msgs.reduce((v, m) => reduceRoom(v, m, 10_000), start);
}

describe("reduceRoom", () => {
  it("WELCOME で自分の ID・時計のずれ・盤面を取り込む", () => {
    const v = run([
      { type: "WELCOME", playerId: "a", serverTime: 12_500, room, pieces: [piece("p1")], lastPreview: null },
    ]);
    expect(v.me).toBe("a");
    expect(v.serverOffset).toBe(2_500);
    expect(Object.keys(v.pieces)).toEqual(["p1"]);
    expect(remainingMs(v, 20_000, 10_000)).toBe(7_500);
  });

  it("WELCOME 前のメッセージは無視する", () => {
    expect(run([{ type: "PREVIEW", x: 1, angle: 0 }])).toBe(initialRoomView);
  });

  it("1 ターン分の流れ（開始 → 提出 → プレビュー → DROP → ストリーム → 確定）", () => {
    const v = run([
      { type: "WELCOME", playerId: "b", serverTime: 10_000, room, pieces: [], lastPreview: null },
      { type: "TURN_START", turn: 1, activePlayerId: "a", sizeRequirement: req, timeLimit: 15_000, deadline: 25_000 },
      { type: "PIECE_SUBMITTED", piece: piece("p1"), deadline: 30_000 },
      { type: "PREVIEW", x: 300, angle: 0.2 },
    ]);
    expect(v.room!.phase).toBe("placing");
    expect(v.room!.pendingPieceId).toBe("p1");
    expect(v.preview).toEqual({ x: 300, angle: 0.2 });
    expect(v.turnStart!.sizeRequirement).toEqual(req);

    const v2 = run(
      [
        { type: "DROPPED", pieceId: "p1", x: 310, angle: 0.2, simulatorId: "a", deadline: 40_000 },
        { type: "STATE_STREAM", frame: [{ id: "p1", x: 310, y: 500, angle: 0.2 }] },
      ],
      v,
    );
    expect(v2.room!.phase).toBe("settling");
    expect(v2.room!.simulatorId).toBe("a");
    expect(v2.frame).toHaveLength(1);

    const v3 = run([{ type: "TURN_RESULT", snapshot: [{ id: "p1", x: 310, y: 850, angle: 0.25 }], fallen: [], eliminatedPlayerId: null }], v2);
    expect(v3.pieces.p1.pose).toEqual({ x: 310, y: 850, angle: 0.25 });
    expect(v3.frame).toBeNull();
    expect(v3.room!.pendingPieceId).toBeNull();
  });

  it("落下でピースが消え、脱落者に印が付き、GAME_OVER で終了状態になる", () => {
    const v = run([
      { type: "WELCOME", playerId: "b", serverTime: 10_000, room: { ...room, phase: "settling" }, pieces: [piece("p1"), piece("p2")], lastPreview: null },
      { type: "TURN_RESULT", snapshot: [], fallen: ["p2"], eliminatedPlayerId: "a" },
      { type: "GAME_OVER", winnerId: "b", ranking: ["b", "a"], matchId: "m1" },
    ]);
    expect(Object.keys(v.pieces)).toEqual(["p1"]);
    expect(v.room!.players.find((p) => p.id === "a")!.eliminated).toBe(true);
    expect(v.room!.phase).toBe("finished");
    expect(v.room!.winnerId).toBe("b");
    expect(v.gameOver!.matchId).toBe("m1");
  });

  it("RESTART でロビーに戻ると盤面と結果が消える", () => {
    const v = run([
      { type: "WELCOME", playerId: "b", serverTime: 10_000, room: { ...room, phase: "finished" }, pieces: [piece("p1")], lastPreview: null },
      { type: "GAME_OVER", winnerId: "b", ranking: ["b", "a"], matchId: "m1" },
      { type: "ROOM_STATE", serverTime: 10_000, room },
    ]);
    expect(v.pieces).toEqual({});
    expect(v.gameOver).toBeNull();
    expect(v.room!.phase).toBe("lobby");
  });

  it("ERROR は保持し、次の TURN_START で消える", () => {
    const v = run([
      { type: "WELCOME", playerId: "a", serverTime: 10_000, room, pieces: [], lastPreview: null },
      { type: "ERROR", code: "NOT_YOUR_TURN", message: "x" },
    ]);
    expect(v.error!.code).toBe("NOT_YOUR_TURN");
    const v2 = run([{ type: "TURN_START", turn: 2, activePlayerId: "a", sizeRequirement: req, timeLimit: 1, deadline: 1 }], v);
    expect(v2.error).toBeNull();
  });
});
