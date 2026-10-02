import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAW_TIME_LIMIT_MS,
  PLACE_TIME_LIMIT_MS,
  SERVER_GRACE_MS,
  SETTLE_TIMEOUT_MS,
  WORLD,
} from "../../shared/constants";
import type { ClientMessage, ServerMessage, Vec2 } from "../../shared/protocol";
import { createRoomData, RoomEngine, type Effects } from "./engine";

// ---- テスト用の決定的な依存 ----
let clock = 1_000_000;
let ids = 0;
let rand = 0.5; // MEDIUM

function makeEngine() {
  return new RoomEngine(createRoomData("ねこ"), [], {
    now: () => clock,
    random: () => rand,
    uuid: () => `id${++ids}`,
  });
}

/** 効果から特定プレイヤーに届くメッセージを取り出す */
function deliveredTo(fx: Effects, playerId: string): ServerMessage[] {
  return fx.send
    .filter(({ to }) => to.kind === "all" || (to.kind === "only" ? to.playerId === playerId : to.playerId !== playerId))
    .map(({ msg }) => msg);
}

const types = (msgs: ServerMessage[]) => msgs.map((m) => m.type);
const allTypes = (fx: Effects) => fx.send.map(({ msg }) => msg.type);

function square(side: number): Vec2[][] {
  const lo = (256 - side) / 2;
  const hi = lo + side;
  return [
    [
      { x: lo, y: lo },
      { x: hi, y: lo },
      { x: hi, y: hi },
      { x: lo, y: hi },
    ],
  ];
}

const IMG = "data:image/png;base64,AAAA";
const submitOk: ClientMessage = { type: "DRAW_SUBMIT", polygons: square(130), image: IMG, reason: "button" };

/** n 人入室させて開始まで進める */
function startedRoom(n = 3) {
  const engine = makeEngine();
  const players: string[] = [];
  for (let i = 0; i < n; i++) players.push(engine.join({ type: "JOIN", name: `p${i}` }).playerId!);
  const fx = engine.handle(players[0], { type: "START" });
  return { engine, players, fx };
}

/** 手番の人が提出 → DROP まで進め、DROPPED の効果を返す */
function playToDrop(engine: RoomEngine, active: string) {
  engine.handle(active, submitOk);
  return engine.handle(active, { type: "DROP", x: 400, angle: 0 });
}

beforeEach(() => {
  clock = 1_000_000;
  ids = 0;
  rand = 0.5;
});

describe("入室", () => {
  it("入室順に P1〜P4 の番号が付き、最初の人がホスト。5 人目は満員", () => {
    const e = makeEngine();
    const results = [0, 1, 2, 3].map((i) => e.join({ type: "JOIN", name: `p${i}` }));
    expect(e.data.players.map((p) => p.index)).toEqual([0, 1, 2, 3]);
    expect(e.data.hostId).toBe(results[0].playerId);
    expect(types(results[0].effects.reply)).toEqual(["WELCOME"]);

    const fifth = e.join({ type: "JOIN", name: "p4" });
    expect(fifth.playerId).toBeNull();
    expect(fifth.effects.reply[0]).toMatchObject({ type: "ERROR", code: "ROOM_FULL" });
  });

  it("名前は整形され、空なら P 番号になる", () => {
    const e = makeEngine();
    e.join({ type: "JOIN", name: "  ａｂｃ  　def  " });
    e.join({ type: "JOIN", name: "   " });
    e.join({ type: "JOIN", name: "とても長い名前のプレイヤーです！" });
    expect(e.data.players.map((p) => p.name)).toEqual(["abc def", "P2", "とても長い名前のプレイヤ"]);
  });

  it("ロビーで抜けると番号が空き、ホストは次の人へ。次の入室者は空いた番号を使う", () => {
    const e = makeEngine();
    const [a, b] = [0, 1].map((i) => e.join({ type: "JOIN", name: `p${i}` }).playerId!);
    const fx = e.disconnect(a);
    expect(allTypes(fx)).toEqual(["ROOM_STATE"]);
    expect(e.data.hostId).toBe(b);
    const c = e.join({ type: "JOIN", name: "c" }).playerId!;
    expect(e.data.players.find((p) => p.id === c)!.index).toBe(0);
  });

  it("対戦中は新規入室できないが、playerId があれば再接続できて盤面ごと復元される", () => {
    const { engine, players } = startedRoom(2);
    playToDrop(engine, players[0]);
    engine.handle(players[0], { type: "SETTLED", snapshot: [{ id: "id3", x: 400, y: 850, angle: 0 }], fallen: [] });

    expect(engine.join({ type: "JOIN", name: "x" }).effects.reply[0]).toMatchObject({ code: "ROOM_IN_PROGRESS" });

    engine.disconnect(players[0]);
    expect(engine.data.players[0].connected).toBe(false);
    const re = engine.join({ type: "JOIN", name: "x", playerId: players[0] });
    expect(re.playerId).toBe(players[0]);
    const welcome = re.effects.reply[0];
    expect(welcome.type).toBe("WELCOME");
    if (welcome.type === "WELCOME") {
      expect(welcome.pieces).toHaveLength(1);
      expect(welcome.pieces[0].pose).toEqual({ x: 400, y: 850, angle: 0 });
      expect(welcome.room.phase).toBe("drawing");
    }
  });
});

describe("開始", () => {
  it("ホスト以外・1 人だけでは開始できない", () => {
    const e = makeEngine();
    const a = e.join({ type: "JOIN", name: "a" }).playerId!;
    expect(e.handle(a, { type: "START" }).reply[0]).toMatchObject({ code: "NOT_ENOUGH_PLAYERS" });
    const b = e.join({ type: "JOIN", name: "b" }).playerId!;
    expect(e.handle(b, { type: "START" }).reply[0]).toMatchObject({ code: "NOT_HOST" });
  });

  it("TURN_START に抽選したサイズ規定と締切が入り、アラームが張られる", () => {
    rand = 0.9; // LARGE
    const { engine, players, fx } = startedRoom(2);
    const ts = fx.send.find(({ msg }) => msg.type === "TURN_START")!.msg;
    expect(ts).toMatchObject({
      type: "TURN_START",
      turn: 1,
      activePlayerId: players[0],
      sizeRequirement: { class: "LARGE", minWidth: 180, minHeight: 180, minPixels: 11000 },
      timeLimit: DRAW_TIME_LIMIT_MS,
      deadline: clock + DRAW_TIME_LIMIT_MS,
    });
    expect(fx.alarm).toBe(clock + DRAW_TIME_LIMIT_MS + SERVER_GRACE_MS);
    expect(engine.data.phase).toBe("drawing");
  });
});

describe("手番の操作", () => {
  it("手番以外の提出・DROP は拒否、プレビューは無視される", () => {
    const { engine, players } = startedRoom(2);
    expect(engine.handle(players[1], submitOk).reply[0]).toMatchObject({ code: "NOT_YOUR_TURN" });
    engine.handle(players[0], submitOk);
    expect(engine.handle(players[1], { type: "PREVIEW", x: 100, angle: 0 }).send).toHaveLength(0);
    expect(engine.handle(players[1], { type: "DROP", x: 100, angle: 0 }).reply[0]).toMatchObject({ code: "NOT_YOUR_TURN" });
  });

  it("サイズ規定未達の提出（完成ボタン）は SIZE_TOO_SMALL、時間切れなら受け入れる", () => {
    const { engine, players } = startedRoom(2); // MEDIUM (120px / 5000px²)
    const small: ClientMessage = { type: "DRAW_SUBMIT", polygons: square(40), image: IMG, reason: "button" };
    expect(engine.handle(players[0], small).reply[0]).toMatchObject({ code: "SIZE_TOO_SMALL" });
    expect(engine.data.phase).toBe("drawing");

    const fx = engine.handle(players[0], { ...small, reason: "timeout" } as ClientMessage);
    expect(allTypes(fx)).toEqual(["PIECE_SUBMITTED"]);
    expect(engine.data.phase).toBe("placing");
  });

  it("提出 → PIECE_SUBMITTED（全員）、PREVIEW は送信者以外へ中継", () => {
    const { engine, players } = startedRoom(3);
    const fx = engine.handle(players[0], submitOk);
    expect(fx.send[0].to).toEqual({ kind: "all" });
    expect(fx.send[0].msg).toMatchObject({ type: "PIECE_SUBMITTED", deadline: clock + PLACE_TIME_LIMIT_MS });
    expect(fx.putPieces).toHaveLength(1);

    const pv = engine.handle(players[0], { type: "PREVIEW", x: 9999, angle: 0.5 });
    expect(pv.send).toEqual([{ to: { kind: "except", playerId: players[0] }, msg: { type: "PREVIEW", x: WORLD.maxX, angle: 0.5 } }]);
    expect(pv.dirty).toBe(false);
  });

  it("DROP → DROPPED で手番の人が物理担当。STATE_STREAM は担当以外へ中継", () => {
    const { engine, players } = startedRoom(3);
    const fx = playToDrop(engine, players[0]);
    expect(fx.send[0].msg).toMatchObject({ type: "DROPPED", x: 400, angle: 0, simulatorId: players[0] });
    expect(fx.alarm).toBe(clock + SETTLE_TIMEOUT_MS);

    const pieceId = engine.data.pendingPieceId!;
    const st = engine.handle(players[0], { type: "STATE_STREAM", frame: [{ id: pieceId, x: 400, y: 300, angle: 0 }] });
    expect(types(deliveredTo(st, players[1]))).toEqual(["STATE_STREAM"]);
    expect(deliveredTo(st, players[0])).toHaveLength(0);
    // 担当以外のストリームは無視
    expect(engine.handle(players[1], { type: "STATE_STREAM", frame: [] }).send).toHaveLength(0);
  });
});

describe("ターンの確定と脱落", () => {
  it("落下なし → 位置を確定して次の人の TURN_START", () => {
    const { engine, players } = startedRoom(3);
    playToDrop(engine, players[0]);
    const id = engine.data.pendingPieceId!;
    const fx = engine.handle(players[0], { type: "SETTLED", snapshot: [{ id, x: 400, y: 850, angle: 0.1 }], fallen: [] });
    expect(allTypes(fx)).toEqual(["TURN_RESULT", "TURN_START"]);
    expect(fx.send[0].msg).toMatchObject({ eliminatedPlayerId: null, fallen: [] });
    expect(fx.send[1].msg).toMatchObject({ activePlayerId: players[1], turn: 2 });
    expect(engine.data.poses[id]).toEqual({ x: 400, y: 850, angle: 0.1 });
  });

  it("落下あり → 手番の人が脱落し、以降の手番から外れる", () => {
    const { engine, players } = startedRoom(3);
    playToDrop(engine, players[0]);
    const id = engine.data.pendingPieceId!;
    const fx = engine.handle(players[0], { type: "SETTLED", snapshot: [], fallen: [id] });
    expect(fx.send[0].msg).toMatchObject({ type: "TURN_RESULT", fallen: [id], eliminatedPlayerId: players[0] });
    expect(fx.deletePieceIds).toEqual([id]);

    // P2 → P3 → (P1 は脱落なので飛ばして) P2
    for (const p of [players[1], players[2]]) {
      expect(engine.data.activePlayerId).toBe(p);
      playToDrop(engine, p);
      engine.handle(p, { type: "SETTLED", snapshot: [{ id: engine.data.pendingPieceId!, x: 400, y: 850, angle: 0 }], fallen: [] });
    }
    expect(engine.data.activePlayerId).toBe(players[1]);
  });

  it("最後の 1 人になったら GAME_OVER と D1 記録、順位は脱落が遅い順", () => {
    const { engine, players } = startedRoom(3);
    const fall = (p: string) => {
      playToDrop(engine, p);
      return engine.handle(p, { type: "SETTLED", snapshot: [], fallen: [engine.data.pendingPieceId!] });
    };
    fall(players[0]);
    clock += 60_000;
    const fx = fall(players[1]);
    expect(allTypes(fx)).toEqual(["TURN_RESULT", "GAME_OVER"]);
    expect(fx.send[1].msg).toMatchObject({ winnerId: players[2], ranking: [players[2], players[1], players[0]] });
    expect(fx.alarm).toBeNull();
    expect(fx.match).toMatchObject({
      roomCode: "ねこ",
      playerCount: 3,
      totalTurns: 2,
      winnerPlayerIndex: 2,
      startedAt: 1_000_000,
      endedAt: 1_060_000,
    });
    expect(fx.match!.results.map((r) => [r.playerIndex, r.rank, r.piecesPlaced, r.eliminatedTurn])).toEqual([
      [2, 1, 0, null],
      [1, 2, 1, 2],
      [0, 3, 1, 1],
    ]);
    expect(engine.data.phase).toBe("finished");
  });

  it("RESTART でロビーに戻り、盤面は消える（ホストのみ・終了後のみ）", () => {
    const { engine, players } = startedRoom(2);
    expect(engine.handle(players[0], { type: "RESTART" }).reply[0]).toMatchObject({ code: "WRONG_PHASE" });
    playToDrop(engine, players[0]);
    engine.handle(players[0], { type: "SETTLED", snapshot: [], fallen: [engine.data.pendingPieceId!] });
    expect(engine.data.phase).toBe("finished");
    expect(engine.handle(players[1], { type: "RESTART" }).reply[0]).toMatchObject({ code: "NOT_HOST" });

    const fx = engine.handle(players[0], { type: "RESTART" });
    expect(engine.data.phase).toBe("lobby");
    expect(fx.clearPieces).toBe(true);
    expect(engine.data.players.every((p) => !p.eliminated)).toBe(true);
    expect(engine.handle(players[0], { type: "START" }).send.some(({ msg }) => msg.type === "TURN_START")).toBe(true);
  });
});

describe("締切（アラーム）", () => {
  it("締切前に発火したら張り直すだけ", () => {
    const { engine } = startedRoom(2);
    clock += 1000;
    const fx = engine.alarm();
    expect(fx.send).toHaveLength(0);
    expect(fx.alarm).toBe(1_000_000 + DRAW_TIME_LIMIT_MS + SERVER_GRACE_MS);
  });

  it("お絵描き締切 → 規定を満たす代わりのブロック（画像なし）で配置へ", () => {
    rand = 0.9; // LARGE
    const { engine } = startedRoom(2);
    clock += DRAW_TIME_LIMIT_MS + SERVER_GRACE_MS;
    const fx = engine.alarm();
    const msg = fx.send[0].msg;
    expect(msg.type).toBe("PIECE_SUBMITTED");
    if (msg.type === "PIECE_SUBMITTED") {
      expect(msg.piece.image).toBeNull();
      const xs = msg.piece.polygons[0].map((p) => p.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(180);
    }
    expect(engine.data.phase).toBe("placing");
  });

  it("配置締切 → 最後のプレビュー位置で自動 DROP", () => {
    const { engine, players } = startedRoom(2);
    engine.handle(players[0], submitOk);
    engine.handle(players[0], { type: "PREVIEW", x: 250, angle: 0.3 });
    clock += PLACE_TIME_LIMIT_MS + SERVER_GRACE_MS;
    const fx = engine.alarm();
    expect(fx.send[0].msg).toMatchObject({ type: "DROPPED", x: 250, angle: 0.3 });
  });

  it("静止待ち締切 → 最後のフレームで確定（Death Zone より下は落下扱い）", () => {
    const { engine, players } = startedRoom(2);
    playToDrop(engine, players[0]);
    const id = engine.data.pendingPieceId!;
    engine.handle(players[0], { type: "STATE_STREAM", frame: [{ id, x: 400, y: WORLD.deathY + 50, angle: 0 }] });
    clock += SETTLE_TIMEOUT_MS;
    const fx = engine.alarm();
    expect(fx.send[0].msg).toMatchObject({ type: "TURN_RESULT", fallen: [id], eliminatedPlayerId: players[0] });
  });

  it("静止待ち締切でフレームが 1 つも無ければ投下ピースを無効化し、脱落は出さない", () => {
    const { engine, players } = startedRoom(2);
    playToDrop(engine, players[0]);
    const id = engine.data.pendingPieceId!;
    clock += SETTLE_TIMEOUT_MS;
    const fx = engine.alarm();
    expect(fx.send[0].msg).toMatchObject({ type: "TURN_RESULT", fallen: [id], eliminatedPlayerId: null });
    expect(fx.send[1].msg).toMatchObject({ type: "TURN_START", activePlayerId: players[1] });
  });
});

describe("切断", () => {
  it("自分の手番が来た時点で切断中なら脱落して次の人へ", () => {
    const { engine, players } = startedRoom(3);
    engine.disconnect(players[1]);
    playToDrop(engine, players[0]);
    const fx = engine.handle(players[0], {
      type: "SETTLED",
      snapshot: [{ id: engine.data.pendingPieceId!, x: 400, y: 850, angle: 0 }],
      fallen: [],
    });
    expect(allTypes(fx)).toEqual(["TURN_RESULT", "PLAYER_ELIMINATED", "TURN_START"]);
    expect(fx.send[1].msg).toMatchObject({ playerId: players[1], reason: "disconnected" });
    expect(fx.send[2].msg).toMatchObject({ activePlayerId: players[2] });
  });

  it("手番までに再接続すれば脱落しない", () => {
    const { engine, players } = startedRoom(3);
    engine.disconnect(players[1]);
    engine.join({ type: "JOIN", name: "", playerId: players[1] });
    playToDrop(engine, players[0]);
    const fx = engine.handle(players[0], {
      type: "SETTLED",
      snapshot: [{ id: engine.data.pendingPieceId!, x: 400, y: 850, angle: 0 }],
      fallen: [],
    });
    expect(fx.send[1].msg).toMatchObject({ type: "TURN_START", activePlayerId: players[1] });
  });

  it("手番の人が切断中に自動 DROP されたら、接続中の生存者が物理担当になる", () => {
    const { engine, players } = startedRoom(3);
    engine.handle(players[0], submitOk);
    engine.disconnect(players[0]);
    clock += PLACE_TIME_LIMIT_MS + SERVER_GRACE_MS;
    const fx = engine.alarm();
    expect(fx.send[0].msg).toMatchObject({ type: "DROPPED", simulatorId: players[1] });
  });
});
