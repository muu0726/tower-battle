/**
 * 輪郭ポリゴン → Box2D (planck.js) に渡せる凸多角形パーツに分ける（純関数）
 *
 * Box2D のポリゴン形状は「凸」かつ「頂点 12 個まで」なので、
 *   1. 凹多角形は poly-decomp で凸多角形に分解
 *   2. 頂点が多すぎる凸多角形は扇形に切り分け（凸多角形の扇形分割は必ず凸）
 *   3. 面積が極端に小さい破片は捨てる（Box2D は潰れた形を黙って受け入れて不安定になるため）
 */
import decomp from "poly-decomp";
import type { Vec2 } from "../utils/contourTracer";

/** planck.Settings.maxPolygonVertices と同じ値 */
export const MAX_PART_VERTICES = 12;
/** これ未満の面積（ワールド単位²）のパーツは捨てる */
export const MIN_PART_AREA = 6;

type Pt = [number, number];

function signedArea(poly: readonly Pt[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return s / 2;
}

function isConvex(poly: readonly Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function clean(poly: Pt[]): Pt[] {
  const pts = poly.map((p) => [p[0], p[1]] as Pt);
  decomp.makeCCW(pts);
  decomp.removeDuplicatePoints(pts, 0.01);
  decomp.removeCollinearPoints(pts, 0.01);
  return pts;
}

/** 頂点数が上限を超える凸多角形を、頂点 0 を共有する扇形に切り分ける */
function splitFan(poly: Pt[], maxVertices: number): Pt[][] {
  if (poly.length <= maxVertices) return [poly];
  const out: Pt[][] = [];
  let i = 1;
  for (;;) {
    const j = Math.min(i + maxVertices - 2, poly.length - 1);
    out.push([poly[0], ...poly.slice(i, j + 1)]);
    if (j === poly.length - 1) return out;
    i = j;
  }
}

/** 輪郭ポリゴン群（任意の座標系）を、凸・頂点数上限以内・面積下限以上のパーツに分ける */
export function toConvexParts(
  polygons: readonly (readonly Vec2[])[],
  maxVertices = MAX_PART_VERTICES,
  minArea = MIN_PART_AREA,
): Vec2[][] {
  const parts: Vec2[][] = [];
  for (const poly of polygons) {
    const pts = clean(poly.map((p) => [p.x, p.y] as Pt));
    if (pts.length < 3) continue;
    const convex = isConvex(pts) ? [pts] : decomp.quickDecomp(pts);
    for (const raw of convex) {
      const part = clean(raw);
      if (part.length < 3) continue;
      for (const chunk of splitFan(part, maxVertices)) {
        if (Math.abs(signedArea(chunk)) >= minArea) parts.push(chunk.map(([x, y]) => ({ x, y })));
      }
    }
  }
  return parts;
}
