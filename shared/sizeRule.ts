// ターンごとのサイズ規定（最小サイズ抽選）。DOM 非依存なので DO 側の検証にも使える。
//
// 判定ルール: 「幅 ≥ minWidth または 高さ ≥ minHeight（= 長い辺が規定以上）」かつ「塗り面積 ≥ minPixels」
// 横長・縦長の絵は OK。細い棒で長さだけ稼ぐズルは面積条件で弾く。

export type SizeClass = "SMALL" | "MEDIUM" | "LARGE";

export interface SizeRequirement {
  class: SizeClass;
  minWidth: number;
  minHeight: number;
  minPixels: number;
}

export interface SizeClassInfo extends SizeRequirement {
  label: string;
  icon: string;
  /** 抽選の重み */
  weight: number;
}

/** 256px キャンバス基準。面積は外接枠の約 1/3（円・三角・L 字は通り、棒は落ちる） */
export const SIZE_CLASSES: Record<SizeClass, SizeClassInfo> = {
  SMALL: { class: "SMALL", minWidth: 60, minHeight: 60, minPixels: 1_500, label: "小サイズ", icon: "🐭", weight: 35 },
  MEDIUM: { class: "MEDIUM", minWidth: 120, minHeight: 120, minPixels: 5_000, label: "中サイズ", icon: "🐶", weight: 40 },
  LARGE: { class: "LARGE", minWidth: 180, minHeight: 180, minPixels: 11_000, label: "大サイズ", icon: "🐘", weight: 25 },
};

const ORDER: SizeClass[] = ["SMALL", "MEDIUM", "LARGE"];

export function sizeRequirementOf(cls: SizeClass): SizeRequirement {
  const { minWidth, minHeight, minPixels } = SIZE_CLASSES[cls];
  return { class: cls, minWidth, minHeight, minPixels };
}

/** 重み付き抽選。random は [0, 1) を返す関数（テスト用に注入可能） */
export function rollSizeRequirement(random: () => number = Math.random): SizeRequirement {
  const total = ORDER.reduce((s, c) => s + SIZE_CLASSES[c].weight, 0);
  let r = random() * total;
  for (const cls of ORDER) {
    r -= SIZE_CLASSES[cls].weight;
    if (r < 0) return sizeRequirementOf(cls);
  }
  return sizeRequirementOf(ORDER[ORDER.length - 1]);
}

export interface SizeMetrics {
  width: number;
  height: number;
  /** 塗りつぶし面積 (キャンバス px²) */
  area: number;
}

export interface SizeEvaluation {
  ok: boolean;
  sideOk: boolean;
  areaOk: boolean;
  longSide: number;
  /** 長辺の達成率（1 以上で達成） */
  sideRatio: number;
  /** 面積の達成率（1 以上で達成） */
  areaRatio: number;
}

export function evaluateSize(m: SizeMetrics, req: SizeRequirement): SizeEvaluation {
  const sideRatio = Math.max(m.width / req.minWidth, m.height / req.minHeight);
  const areaRatio = m.area / req.minPixels;
  const sideOk = sideRatio >= 1;
  const areaOk = areaRatio >= 1;
  return { ok: sideOk && areaOk, sideOk, areaOk, longSide: Math.max(m.width, m.height), sideRatio, areaRatio };
}

/**
 * 規定を満たすのに必要な拡大倍率（比率維持）。面積は倍率の 2 乗で増える。
 * キャンバスに収まる倍率で頭打ちにするので、戻り値で拡大しても規定に届かない場合がある。
 */
export function computeUpscaleFactor(m: SizeMetrics, req: SizeRequirement, canvasSize: number): number {
  if (m.width <= 0 || m.height <= 0) return 1;
  const sideFactor = 1 / Math.max(m.width / req.minWidth, m.height / req.minHeight);
  const areaFactor = m.area > 0 ? Math.sqrt(req.minPixels / m.area) : 1;
  // 輪郭抽出の誤差で境界ぎりぎりにならないよう少しだけ上乗せ
  const needed = Math.max(sideFactor, areaFactor, 1) * 1.04;
  const fit = (canvasSize * 0.96) / Math.max(m.width, m.height);
  return Math.max(1, Math.min(needed, fit));
}

/** 輪郭ポリゴン（キャンバス座標）から外接枠と塗り面積を求める。サーバー側の規定チェック用 */
export function measurePolygons(polygons: readonly (readonly { x: number; y: number }[])[]): SizeMetrics {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let area = 0;
  for (const poly of polygons) {
    let s = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const p = poly[i];
      s += poly[j].x * p.y - p.x * poly[j].y;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    area += Math.abs(s) / 2;
  }
  if (!Number.isFinite(minX)) return { width: 0, height: 0, area: 0 };
  return { width: maxX - minX, height: maxY - minY, area };
}
