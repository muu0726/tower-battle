/**
 * 物理ラボ: DROP 後の挙動を数値で測る回帰テスト（本家どうぶつタワーバトルに近い「引っかかる・止まる」挙動の確認）
 *
 * 実際のピース生成経路（キャンバス → tracePiece → createPieceBody）で作った形を使う。
 * 数値を見たいときは: npx vitest run src/game/physics.lab.test.ts --disableConsoleIntercept
 *
 * Matter.js 時代（2026-10 に planck.js へ移行する前）の同じ測定値: 斜面の滑り 17.5 / 静止後 10 秒の移動 最大 15〜53 /
 * 静止まで 平均 6.0 秒・最大 12 秒（静止判定タイムアウト超え）
 */
import * as planck from "planck";
import { beforeAll, describe, expect, it } from "vitest";
import { PIECE_SCALE, REST_TIMEOUT_MS, SPAWN_CLEARANCE, WORLD } from "../../shared/constants";
import { tracePiece, type ImageLike, type Vec2 } from "../utils/contourTracer";
import {
  addPiece,
  createPhysics,
  createPieceBody,
  findFallenPieces,
  removePiece,
  RestDetector,
  stepPhysics,
  towerTopY,
  type GameBody,
  type PhysicsWorld,
} from "./physics";

const SIZE = 256;
const FRAME = 1000 / 60;
/** physics.ts と同じ（Box2D 1m = 50 単位） */
const M = 50;

function shape(pred: (x: number, y: number) => boolean): Vec2[][] {
  const img: ImageLike & { data: Uint8ClampedArray } = { width: SIZE, height: SIZE, data: new Uint8ClampedArray(SIZE * SIZE * 4) };
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (pred(x, y)) img.data[(y * SIZE + x) * 4 + 3] = 255;
  return tracePiece(img)!.polygons;
}
const BOX = shape((x, y) => x >= 78 && x < 178 && y >= 78 && y < 178);
const WIDE = shape((x, y) => x >= 38 && x < 218 && y >= 98 && y < 158);
const BLOB = shape((x, y) => (x - 128) ** 2 / 90 ** 2 + (y - 128) ** 2 / 60 ** 2 <= 1);
const SHAPES = [WIDE, BOX, BLOB];

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shapeOf = new WeakMap<GameBody, Vec2[][]>();
function piece(w: PhysicsWorld, polys: Vec2[][], x: number = WORLD.islandX, y = 0, angle = 0) {
  const b = createPieceBody(w, polys, { x, y, scale: PIECE_SCALE, ownerIndex: 0, color: "#fff", spriteKey: "k" })!;
  b.setAngle(angle);
  shapeOf.set(b, polys);
  return b;
}

const frames = (w: PhysicsWorld, n: number) => {
  for (let i = 0; i < n; i++) stepPhysics(w, FRAME);
};

/** ゲームと同じく、ピースの下端がタワー上端から SPAWN_CLEARANCE 上になる位置から落とす */
function dropAboveTower(w: PhysicsWorld, b: GameBody, x: number) {
  b.setPosition(x, b.position.y);
  b.setPosition(x, towerTopY(w) - SPAWN_CLEARANCE - (b.bounds.max.y - b.position.y));
  addPiece(w, b);
}

/** 静止するまで進める（Death Zone に落ちたピースは取り除く）。戻り値は [フレーム数, 落ちた数] */
function settle(w: PhysicsWorld, maxFrames = 1200): [number, number] {
  const rest = new RestDetector();
  let fallen = 0;
  for (let f = 0; f < maxFrames; f++) {
    stepPhysics(w, FRAME, () => rest.step(w.pieces));
    for (const b of findFallenPieces(w)) {
      removePiece(w, b);
      fallen++;
    }
    if (rest.atRest) return [f, fallen];
  }
  return [maxFrames, fallen];
}

const posesOf = (w: PhysicsWorld) => w.pieces.map((b) => b.position);
const maxMove = (a: Vec2[], b: Vec2[]) => Math.max(0, ...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

/** 平らな面を上にして積める形で 5 段 → 6 個目を落とし、静止・その後 10 秒・次の手番での再開を測る */
function tower(seed: number) {
  const rand = rng(seed);
  const pick = () => SHAPES[Math.floor(rand() * SHAPES.length)];
  const w = createPhysics();
  let fallen = 0;
  for (let i = 0; i < 5; i++) {
    dropAboveTower(w, piece(w, pick()), WORLD.islandX + (rand() - 0.5) * 50);
    fallen += settle(w)[1];
  }
  dropAboveTower(w, piece(w, pick()), WORLD.islandX + (rand() - 0.5) * 70);
  const [restFrames, lastFallen] = settle(w);
  fallen += lastFallen;

  // 静止とみなした後も 10 秒回す
  const settled = [...w.pieces];
  const before = posesOf(w);
  frames(w, 600);
  const late = settled.filter((b) => b.position.y > WORLD.deathY).length;
  const creep = late ? Infinity : maxMove(before, posesOf(w));

  // 次の手番の物理担当: 同じ形を別ワールドに作り、サーバーの確定位置を当てはめて 1 秒
  const w2 = createPhysics();
  for (const b of w.pieces) {
    const nb = piece(w2, shapeOf.get(b)!);
    nb.setPose(b.position.x, b.position.y, b.angle);
    addPiece(w2, nb);
  }
  const restart0 = posesOf(w2);
  frames(w2, 60);
  const restartPop = maxMove(restart0, posesOf(w2));
  return { restMs: (restFrames * 1000) / 60, fallen, creep, late, restartPop };
}

let m: { fallMs: number; bounce: number; slopeSlide: number; landSlide: number; towers: ReturnType<typeof tower>[] };

beforeAll(() => {
  const islandTop = WORLD.islandY - WORLD.islandHeight / 2;

  // 落下時間と跳ね: 箱を浮島の上から落とす
  let w = createPhysics();
  let b = piece(w, BOX);
  dropAboveTower(w, b, WORLD.islandX);
  let touch = -1;
  const bottoms: number[] = [];
  for (let f = 0; f < 180; f++) {
    frames(w, 1);
    bottoms.push(b.bounds.max.y);
    if (touch < 0 && b.bounds.max.y >= islandTop - 1.5) touch = f;
  }
  const fallMs = (touch * 1000) / 60;
  const bounce = Math.max(0, bottoms.at(-1)! - Math.min(...bottoms.slice(touch + 1)));

  // 斜面 20° に置いた箱が 3 秒で滑る距離
  w = createPhysics();
  const ang = (20 * Math.PI) / 180;
  const ramp = w.world.createBody({ type: "static", position: planck.Vec2(400 / M, 700 / M), angle: ang });
  ramp.createFixture({ shape: planck.Box(300 / M, 15 / M), friction: 1 });
  b = piece(w, BOX, 400, 700, ang);
  const halfSide = 27.5; // 100px × 0.55 の箱の半辺
  b.setPosition(400 - Math.sin(-ang) * 0 + Math.sin(ang) * (15 + halfSide + 1), 700 - Math.cos(ang) * (15 + halfSide + 1));
  addPiece(w, b);
  const s0 = b.position;
  frames(w, 180);
  const slopeSlide = Math.hypot(b.position.x - s0.x, b.position.y - s0.y);

  // 横向き 240 単位/s で浮島に着地した箱の移動距離（摩擦 1 なら物理的には v²/2μg ≈ 29）
  w = createPhysics();
  b = piece(w, BOX, WORLD.islandX - 60, islandTop - 30);
  addPiece(w, b);
  b.body.setLinearVelocity(planck.Vec2(240 / M, 0));
  const x0 = b.position.x;
  frames(w, 180);
  const landSlide = b.position.x - x0;

  m = { fallMs, bounce, slopeSlide, landSlide, towers: [1, 2, 3, 4, 5, 6, 7, 8].map(tower) };
  console.table({
    fallMs: Math.round(fallMs),
    bounce: +bounce.toFixed(2),
    slopeSlide: +slopeSlide.toFixed(2),
    landSlide: +landSlide.toFixed(1),
    restAvgMs: Math.round(m.towers.reduce((s, t) => s + t.restMs, 0) / m.towers.length),
    restMaxMs: Math.round(Math.max(...m.towers.map((t) => t.restMs))),
    fallen: m.towers.reduce((s, t) => s + t.fallen, 0),
    creepMax: +Math.max(...m.towers.map((t) => t.creep)).toFixed(2),
    lateFalls: m.towers.reduce((s, t) => s + t.late, 0),
    restartMax: +Math.max(...m.towers.map((t) => t.restartPop)).toFixed(2),
  });
}, 60_000);

describe("物理ラボ（DROP 後の挙動）", () => {
  it("落下の速さは移行前と同じ（200 単位を約 0.63 秒）", () => {
    expect(m.fallMs).toBeGreaterThan(560);
    expect(m.fallMs).toBeLessThan(720);
  });

  it("着地しても跳ねない", () => {
    expect(m.bounce).toBeLessThan(0.5);
  });

  it("20° の斜面に置いた箱は滑らない（静止摩擦が効く）", () => {
    expect(m.slopeSlide).toBeLessThan(1);
  });

  it("横向きに勢いのある着地は物理どおり減速して止まる", () => {
    expect(m.landSlide).toBeGreaterThan(10);
    expect(m.landSlide).toBeLessThan(40);
  });

  it("タワーは静止判定タイムアウトよりずっと早く止まる", () => {
    const avg = m.towers.reduce((s, t) => s + t.restMs, 0) / m.towers.length;
    expect(avg).toBeLessThan(3500);
    // 崩れかけのタワーは倒れきるまで時間がかかるので、最悪でもタイムアウトの 8 割以内
    for (const t of m.towers) expect(t.restMs).toBeLessThan(REST_TIMEOUT_MS * 0.8);
  });

  it("静止したタワーはその後 10 秒じわじわ動かない・崩れない", () => {
    for (const t of m.towers) {
      expect(t.late).toBe(0);
      expect(t.creep).toBeLessThan(1);
    }
  });

  it("次の手番で確定位置から物理を再開しても、タワーがピクッと動かない", () => {
    for (const t of m.towers) expect(t.restartPop).toBeLessThan(1);
  });
});
