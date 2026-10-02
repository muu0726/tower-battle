import { describe, expect, it } from "vitest";
import {
  createPieceBody,
  getPieceMeta,
  isSimplePolygon,
  polygonArea,
  polygonBounds,
  tracePiece,
  type ImageLike,
} from "./contourTracer";

const SIZE = 256;

function blank(): ImageLike & { data: Uint8ClampedArray } {
  return { width: SIZE, height: SIZE, data: new Uint8ClampedArray(SIZE * SIZE * 4) };
}

function paint(img: { data: Uint8ClampedArray }, pred: (x: number, y: number) => boolean) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (pred(x, y)) img.data[(y * SIZE + x) * 4 + 3] = 255;
    }
  }
}

function disc(cx: number, cy: number, r: number) {
  return (x: number, y: number) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r;
}

/** 再現性のある擬似乱数 (mulberry32) */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("tracePiece", () => {
  it("空のキャンバスは null", () => {
    expect(tracePiece(blank())).toBeNull();
  });

  it("塗りつぶし正方形は 4 頂点前後の単純多角形になる", () => {
    const img = blank();
    paint(img, (x, y) => x >= 80 && x < 176 && y >= 80 && y < 176);
    const piece = tracePiece(img)!;
    expect(piece.polygons).toHaveLength(1);
    expect(piece.vertexCount).toBeGreaterThanOrEqual(4);
    expect(piece.vertexCount).toBeLessThanOrEqual(8);
    expect(piece.area).toBeCloseTo(96 * 96, -2);
    expect(isSimplePolygon(piece.polygons[0])).toBe(true);
  });

  it("円は 30 頂点以内に間引かれ、面積もほぼ保たれる", () => {
    const img = blank();
    paint(img, disc(128, 128, 90));
    const piece = tracePiece(img)!;
    expect(piece.polygons).toHaveLength(1);
    expect(piece.vertexCount).toBeGreaterThanOrEqual(8);
    expect(piece.vertexCount).toBeLessThanOrEqual(30);
    const expected = Math.PI * 90 * 90;
    expect(Math.abs(piece.area - expected) / expected).toBeLessThan(0.1);
    expect(isSimplePolygon(piece.polygons[0])).toBe(true);
  });

  it("輪郭だけ描いた円（リング）は中身ありの 1 ポリゴンになる", () => {
    const img = blank();
    paint(img, (x, y) => disc(128, 128, 80)(x, y) && !disc(128, 128, 70)(x, y));
    const piece = tracePiece(img)!;
    expect(piece.polygons).toHaveLength(1);
    const expected = Math.PI * 80 * 80;
    expect(Math.abs(piece.area - expected) / expected).toBeLessThan(0.12);
  });

  it("離れた 2 つの塊は 2 ポリゴン、小さな点ゴミは捨てられる", () => {
    const img = blank();
    paint(img, disc(60, 128, 40));
    paint(img, disc(196, 128, 40));
    paint(img, (x, y) => x >= 126 && x < 129 && y >= 20 && y < 23); // 3x3 の点
    const piece = tracePiece(img)!;
    expect(piece.polygons).toHaveLength(2);
    expect(piece.vertexCount).toBeLessThanOrEqual(30);
    for (const poly of piece.polygons) expect(isSimplePolygon(poly)).toBe(true);
  });

  it("ノイズの多い落書きでも頂点数上限と単純性を守る", () => {
    for (const seed of [1, 7, 42, 1234]) {
      const rand = rng(seed);
      const img = blank();
      let x = 128;
      let y = 128;
      const brush: [number, number][] = [];
      for (let i = 0; i < 400; i++) {
        x = Math.max(20, Math.min(236, x + (rand() - 0.5) * 14));
        y = Math.max(20, Math.min(236, y + (rand() - 0.5) * 14));
        brush.push([x, y]);
      }
      paint(img, (px, py) => brush.some(([bx, by]) => (px - bx) ** 2 + (py - by) ** 2 <= 36));
      const piece = tracePiece(img)!;
      expect(piece).not.toBeNull();
      expect(piece.vertexCount).toBeLessThanOrEqual(30);
      expect(piece.area).toBeGreaterThan(0);
      for (const poly of piece.polygons) expect(isSimplePolygon(poly)).toBe(true);
    }
  });

  it("キャンバス端に触れた絵も削れずに抽出できる", () => {
    const img = blank();
    paint(img, (x, y) => x < 100 && y < 100);
    const piece = tracePiece(img)!;
    const b = piece.bounds;
    expect(b.minX).toBe(0);
    expect(b.minY).toBe(0);
    expect(b.maxX).toBe(100);
    expect(b.maxY).toBe(100);
  });
});

describe("createPieceBody", () => {
  const baseOpts = { scale: 0.5, ownerIndex: 2, color: "#10B981", spriteKey: "t" };

  it("凹形状 (L 字) は凸分解され compound body になる", () => {
    const img = blank();
    paint(img, (x, y) => (x >= 40 && x < 216 && y >= 40 && y < 100) || (x >= 40 && x < 100 && y >= 40 && y < 216));
    const piece = tracePiece(img)!;
    expect(polygonArea(piece.polygons[0])).not.toBe(0);

    const body = createPieceBody(piece.polygons, { ...baseOpts, x: 300, y: 200 })!;
    expect(body).not.toBeNull();
    expect(body.parts.length).toBeGreaterThan(2); // parts[0] は親自身
    expect(body.position.x).toBeCloseTo(300);
    expect(body.position.y).toBeCloseTo(200);
  });

  it("outline + spriteOffset がボディの実際の形と一致する", () => {
    const img = blank();
    paint(img, (x, y) => (x >= 40 && x < 216 && y >= 40 && y < 100) || (x >= 40 && x < 100 && y >= 40 && y < 216));
    const piece = tracePiece(img)!;
    const body = createPieceBody(piece.polygons, { ...baseOpts, x: 0, y: 0 })!;
    const meta = getPieceMeta(body)!;
    expect(meta.ownerIndex).toBe(2);
    expect(meta.color).toBe("#10B981");

    const ob = polygonBounds(meta.outline.flat());
    expect(ob.minX + body.position.x).toBeCloseTo(body.bounds.min.x, 0);
    expect(ob.minY + body.position.y).toBeCloseTo(body.bounds.min.y, 0);
    expect(ob.maxX + body.position.x).toBeCloseTo(body.bounds.max.x, 0);
    expect(ob.maxY + body.position.y).toBeCloseTo(body.bounds.max.y, 0);

    // キャンバス左上 (40,40) の角はスプライト原点 + offset から計算した位置に来る
    const corner = {
      x: body.position.x + meta.spriteOffset.x + (40 - 128) * 0.5,
      y: body.position.y + meta.spriteOffset.y + (40 - 128) * 0.5,
    };
    expect(corner.x).toBeCloseTo(body.bounds.min.x, 0);
    expect(corner.y).toBeCloseTo(body.bounds.min.y, 0);
  });

  it("複数成分は 1 つの compound body にまとまる", () => {
    const img = blank();
    paint(img, disc(60, 128, 40));
    paint(img, disc(196, 128, 40));
    const piece = tracePiece(img)!;
    const body = createPieceBody(piece.polygons, { ...baseOpts, x: 0, y: 0 })!;
    expect(body.parts.length).toBeGreaterThanOrEqual(3);
    expect(getPieceMeta(body)!.outline).toHaveLength(2);
  });
});
