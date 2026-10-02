import { describe, expect, it } from "vitest";
import { WORLD } from "../../shared/constants";
import { polygonArea, polygonBounds, type Vec2 } from "../utils/contourTracer";
import { addPiece, createPhysics, createPieceBody, RestDetector, stepPhysics } from "./physics";
import { MAX_PART_VERTICES, toConvexParts } from "./pieceShape";

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];
const L_SHAPE: Vec2[] = [
  { x: 40, y: 40 },
  { x: 216, y: 40 },
  { x: 216, y: 100 },
  { x: 100, y: 100 },
  { x: 100, y: 216 },
  { x: 40, y: 216 },
];
const circle = (n: number, r: number): Vec2[] =>
  Array.from({ length: n }, (_, i) => ({ x: 128 + r * Math.cos((i / n) * Math.PI * 2), y: 128 + r * Math.sin((i / n) * Math.PI * 2) }));

function isConvex(poly: Vec2[]) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [a, b, c] = [poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

const totalArea = (parts: Vec2[][]) => parts.reduce((s, p) => s + Math.abs(polygonArea(p)), 0);

describe("toConvexParts", () => {
  it("凸多角形はそのまま 1 パーツ", () => {
    const parts = toConvexParts([rect(0, 0, 100, 50)]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(4);
  });

  it("凹多角形 (L 字) は凸パーツに分解され、面積が保たれる", () => {
    const parts = toConvexParts([L_SHAPE]);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(isConvex(p)).toBe(true);
    expect(totalArea(parts)).toBeCloseTo(Math.abs(polygonArea(L_SHAPE)), 0);
  });

  it("頂点が多い凸多角形は 12 頂点以内に切り分けられ、面積が保たれる", () => {
    const c = circle(30, 100);
    const parts = toConvexParts([c]);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(MAX_PART_VERTICES);
      expect(isConvex(p)).toBe(true);
    }
    expect(totalArea(parts)).toBeCloseTo(Math.abs(polygonArea(c)), 0);
  });

  it("潰れた形・小さすぎる破片は捨てる", () => {
    expect(toConvexParts([[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0.01 }]])).toEqual([]);
    expect(toConvexParts([rect(0, 0, 2, 2)])).toEqual([]);
  });
});

describe("createPieceBody", () => {
  const opts = { scale: 0.5, ownerIndex: 2, color: "#10B981", spriteKey: "k" };

  it("作った直後は物理に参加せず、原点 = 指定位置（キャンバス中心）", () => {
    const w = createPhysics();
    const body = createPieceBody(w, [L_SHAPE], { ...opts, x: 300, y: 200 })!;
    expect(body.isActive).toBe(false);
    expect(body.position.x).toBeCloseTo(300);
    expect(body.position.y).toBeCloseTo(200);
    expect(body.parts.length).toBeGreaterThan(1);
    expect(body.meta).toMatchObject({ ownerIndex: 2, color: "#10B981", spriteKey: "k", spriteScale: 0.5, canvasSize: 256 });
  });

  it("外接枠はキャンバス座標の輪郭をスケールしてずらしたものと一致する", () => {
    const w = createPhysics();
    const body = createPieceBody(w, [L_SHAPE], { ...opts, x: 300, y: 200 })!;
    const b = polygonBounds(L_SHAPE);
    expect(body.bounds.min.x).toBeCloseTo(300 + (b.minX - 128) * 0.5);
    expect(body.bounds.min.y).toBeCloseTo(200 + (b.minY - 128) * 0.5);
    expect(body.bounds.max.x).toBeCloseTo(300 + (b.maxX - 128) * 0.5);
    expect(body.bounds.max.y).toBeCloseTo(200 + (b.maxY - 128) * 0.5);
  });

  it("描けていない形（全部が破片）は null", () => {
    expect(createPieceBody(createPhysics(), [rect(0, 0, 3, 3)], { ...opts, x: 0, y: 0 })).toBeNull();
  });

  it("addPiece で落下を始め、浮島の上に着地して静止する", () => {
    const w = createPhysics();
    const body = createPieceBody(w, [rect(78, 78, 178, 178)], { ...opts, scale: 0.55, x: WORLD.islandX, y: 600 })!;
    addPiece(w, body);
    expect(body.isActive).toBe(true);
    const rest = new RestDetector();
    for (let i = 0; i < 300 && !rest.atRest; i++) stepPhysics(w, 1000 / 60, () => rest.step(w.pieces));
    expect(rest.atRest).toBe(true);
    // 箱の下端が浮島の上面に乗る。Box2D は多角形ごとに 0.5 単位の「皮」を持つので、隙間は 1 単位前後（画面では見えない）
    const gap = WORLD.islandY - WORLD.islandHeight / 2 - body.bounds.max.y;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(1.5);
    expect(Math.abs(body.angle)).toBeLessThan(0.01);
  });
});
