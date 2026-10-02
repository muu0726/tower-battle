/**
 * contourTracer — お絵描きキャンバス → 物理ポリゴン → Matter.js ボディ
 *
 * パイプライン:
 *   1. buildMask       アルファ値を二値化しつつ downsample（max-pooling なので細線も消えない）
 *   2. closeMask       膨張→収縮で細い隙間をつなぐ
 *   3. fillHoles       外周から到達できない背景を塗る（輪郭だけ描いた円も中身ありの塊になる）
 *   4. labelComponents 4 近傍で連結成分に分け、点ゴミを捨てる
 *   5. traceOutline    Marching Squares で各成分の外周を一周たどる
 *   6. simplifyToBudget RDP 法の epsilon を二分探索して頂点数を上限以下に間引く
 *   7. 単純多角形チェック → ダメなら epsilon を上げて再試行 → 最後は凸包にフォールバック
 *   8. createPieceBody poly-decomp で凹多角形を凸分解し、複数成分は compound body にまとめる
 *
 * 1〜7 は DOM 非依存の純関数（ImageData 互換の {width, height, data} を受け取る）なので
 * Node 上の vitest でそのままテストできる。
 */
import Matter from "matter-js";
import decomp from "poly-decomp";

Matter.Common.setDecomp(decomp);

export interface Vec2 {
  x: number;
  y: number;
}

/** ImageData 互換 (RGBA 8bit) */
export interface ImageLike {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/** 0/1 の二値グリッド */
export interface BinaryMask {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface TraceOptions {
  /** この値以上のアルファを「描かれている」とみなす */
  alphaThreshold?: number;
  /** マスクの縮小率。2 なら 256px → 128 セル */
  downsample?: number;
  /** closing の半径（セル単位） */
  closeRadius?: number;
  /** これ未満の面積 (キャンバス px²) の成分は捨てる */
  minComponentArea?: number;
  /** 残す成分の最大数（大きい順） */
  maxComponents?: number;
  /** ピース全体の頂点数上限（成分が複数なら周長比で配分） */
  maxVertices?: number;
  /** RDP の最小 epsilon (キャンバス px)。階段状のギザギザを消すため downsample 以上を推奨 */
  minEpsilon?: number;
}

const DEFAULTS: Required<TraceOptions> = {
  alphaThreshold: 32,
  downsample: 2,
  closeRadius: 1,
  minComponentArea: 48,
  maxComponents: 4,
  maxVertices: 30,
  minEpsilon: 2,
};

export interface TracedPiece {
  /** キャンバス座標系の単純多角形（成分ごと） */
  polygons: Vec2[][];
  vertexCount: number;
  /** 塗りつぶし面積 (キャンバス px²) */
  area: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

// ---------------------------------------------------------------------------
// 1. マスク生成
// ---------------------------------------------------------------------------

export function buildMask(img: ImageLike, alphaThreshold: number, downsample: number): BinaryMask {
  const ds = Math.max(1, Math.floor(downsample));
  const w = Math.ceil(img.width / ds);
  const h = Math.ceil(img.height / ds);
  const out = new Uint8Array(w * h);
  const { data, width, height } = img;
  for (let py = 0; py < height; py++) {
    const row = ((py / ds) | 0) * w;
    for (let px = 0; px < width; px++) {
      if (data[(py * width + px) * 4 + 3] >= alphaThreshold) out[row + ((px / ds) | 0)] = 1;
    }
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// 2. モルフォロジー
// ---------------------------------------------------------------------------

function morph(mask: BinaryMask, r: number, mode: "dilate" | "erode"): BinaryMask {
  const { width: w, height: h, data } = mask;
  const out = new Uint8Array(w * h);
  // dilate: 近傍に 1 が 1 つでもあれば 1 / erode: 近傍に 0 が 1 つでもあれば 0
  // erode では画面外を 1 扱いにして、キャンバス端に触れた絵が削れないようにする
  const hit = mode === "dilate" ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1 - hit;
      search: for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (data[ny * w + nx] === hit) {
            v = hit;
            break search;
          }
        }
      }
      out[y * w + x] = v;
    }
  }
  return { width: w, height: h, data: out };
}

export function closeMask(mask: BinaryMask, radius: number): BinaryMask {
  if (radius <= 0) return mask;
  return morph(morph(mask, radius, "dilate"), radius, "erode");
}

// ---------------------------------------------------------------------------
// 3. 穴埋め
// ---------------------------------------------------------------------------

/**
 * 外周から 8 近傍で背景を flood fill し、到達できなかった背景（=穴）を 1 にする。
 * 前景は 4 連結で扱うので、背景は双対の 8 連結にしないとトポロジーが食い違う。
 */
export function fillHoles(mask: BinaryMask): BinaryMask {
  const { width: w, height: h, data } = mask;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (data[i] || outside[i]) return;
    outside[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx !== 0 || dy !== 0) push(x + dx, y + dy);
      }
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// 4. 連結成分
// ---------------------------------------------------------------------------

export interface Component {
  label: number;
  /** セル数 */
  area: number;
  /** ラスタ順で最初に見つかったセル（=最上段の最左セル）。輪郭追跡の始点 */
  startX: number;
  startY: number;
}

export function labelComponents(mask: BinaryMask): { labels: Int32Array; components: Component[] } {
  const { width: w, height: h, data } = mask;
  const labels = new Int32Array(w * h);
  const components: Component[] = [];
  const stack: number[] = [];
  let next = 1;
  for (let i = 0; i < data.length; i++) {
    if (!data[i] || labels[i]) continue;
    const label = next++;
    const comp: Component = { label, area: 0, startX: i % w, startY: (i / w) | 0 };
    labels[i] = label;
    stack.push(i);
    while (stack.length > 0) {
      const j = stack.pop()!;
      comp.area++;
      const x = j % w;
      const y = (j / w) | 0;
      if (x > 0 && data[j - 1] && !labels[j - 1]) (labels[j - 1] = label), stack.push(j - 1);
      if (x < w - 1 && data[j + 1] && !labels[j + 1]) (labels[j + 1] = label), stack.push(j + 1);
      if (y > 0 && data[j - w] && !labels[j - w]) (labels[j - w] = label), stack.push(j - w);
      if (y < h - 1 && data[j + w] && !labels[j + w]) (labels[j + w] = label), stack.push(j + w);
    }
    components.push(comp);
  }
  return { labels, components };
}

// ---------------------------------------------------------------------------
// 5. Marching Squares
// ---------------------------------------------------------------------------

const UP = 0;
const RIGHT = 1;
const DOWN = 2;
const LEFT = 3;
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/**
 * 格子点 (x, y)（= セル (x, y) の左上の角）を巡回して外周をたどる。
 * 周囲 4 セルの状態 TL=1, TR=2, BL=4, BR=8 から進行方向を決め、常に前景を左手に見て進む。
 * サドル (6, 9) は斜めに接するセルを「非連結」として分離する（4 連結ラベリングと整合）。
 * 始点は成分の最上段最左セルの左上角で、ここは必ずケース 8 なので外周だけを 1 周する。
 * 方向が変わる角だけを出力する。
 */
export function traceOutline(
  labels: Int32Array,
  width: number,
  height: number,
  label: number,
  startX: number,
  startY: number,
): Vec2[] {
  const filled = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] === label;

  const points: Vec2[] = [];
  let x = startX;
  let y = startY;
  let prev = -1;
  const maxSteps = 4 * (width + 1) * (height + 1);
  for (let step = 0; step < maxSteps; step++) {
    const idx =
      (filled(x - 1, y - 1) ? 1 : 0) |
      (filled(x, y - 1) ? 2 : 0) |
      (filled(x - 1, y) ? 4 : 0) |
      (filled(x, y) ? 8 : 0);
    let dir: number;
    switch (idx) {
      case 1:
      case 5:
      case 13:
        dir = UP;
        break;
      case 2:
      case 3:
      case 7:
        dir = RIGHT;
        break;
      case 4:
      case 12:
      case 14:
        dir = LEFT;
        break;
      case 8:
      case 10:
      case 11:
        dir = DOWN;
        break;
      case 6: // TR + BL
        dir = prev === UP ? LEFT : RIGHT;
        break;
      case 9: // TL + BR
        dir = prev === RIGHT ? UP : DOWN;
        break;
      default:
        // 0 / 15 は境界上ではありえない
        return points;
    }
    if (dir !== prev) points.push({ x, y });
    x += DX[dir];
    y += DY[dir];
    prev = dir;
    if (x === startX && y === startY) break;
  }
  return points;
}

// ---------------------------------------------------------------------------
// 6. RDP 間引き
// ---------------------------------------------------------------------------

function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function segmentDistSq(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len = vx * vx + vy * vy;
  if (len === 0) return distSq(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len));
  return distSq(p, { x: a.x + t * vx, y: a.y + t * vy });
}

/** 開いた折れ線の RDP（反復版） */
function rdpOpen(points: Vec2[], epsilon: number): Vec2[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const epsSq = epsilon * epsilon;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segmentDistSq(points[i], points[s], points[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > epsSq) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** 閉じた多角形の RDP。始点と最遠点で 2 本の折れ線に割って処理する */
export function simplifyClosed(polygon: Vec2[], epsilon: number): Vec2[] {
  if (polygon.length <= 3) return polygon.slice();
  let far = 0;
  let farD = -1;
  for (let i = 1; i < polygon.length; i++) {
    const d = distSq(polygon[0], polygon[i]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = rdpOpen(polygon.slice(0, far + 1), epsilon);
  const b = rdpOpen([...polygon.slice(far), polygon[0]], epsilon);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** 頂点数が maxVertices 以下になる最小の epsilon を二分探索する */
export function simplifyToBudget(
  polygon: Vec2[],
  maxVertices: number,
  minEpsilon: number,
): { points: Vec2[]; epsilon: number } {
  const first = simplifyClosed(polygon, minEpsilon);
  if (first.length <= maxVertices) return { points: first, epsilon: minEpsilon };

  const b = polygonBounds(polygon);
  let lo = minEpsilon;
  let hi = Math.max(b.maxX - b.minX, b.maxY - b.minY, minEpsilon * 2);
  let best = { points: simplifyClosed(polygon, hi), epsilon: hi };
  for (let i = 0; i < 24 && hi - lo > 0.05; i++) {
    const mid = (lo + hi) / 2;
    const pts = simplifyClosed(polygon, mid);
    if (pts.length <= maxVertices) {
      best = { points: pts, epsilon: mid };
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 7. 幾何ユーティリティ & 後処理
// ---------------------------------------------------------------------------

/** 符号付き面積（y 下向き座標で時計回りが正） */
export function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += (poly[j].x * poly[i].y - poly[i].x * poly[j].y);
  }
  return s / 2;
}

export function polygonBounds(poly: Vec2[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function perimeter(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += Math.sqrt(distSq(poly[i], poly[j]));
  return s;
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** 3 点がほぼ一直線（三角形面積 < tolerance）の中間点と重複点を取り除く */
export function removeCollinear(poly: Vec2[], tolerance = 0.5): Vec2[] {
  let pts = poly.slice();
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      if (Math.abs(cross(prev, cur, next)) / 2 < tolerance || distSq(prev, cur) < 1e-6) {
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return pts;
}

function onSegment(p: Vec2, q: Vec2, r: Vec2): boolean {
  return (
    Math.min(p.x, r.x) <= q.x && q.x <= Math.max(p.x, r.x) && Math.min(p.y, r.y) <= q.y && q.y <= Math.max(p.y, r.y)
  );
}

function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(p3, p1, p4)) return true;
  if (d2 === 0 && onSegment(p3, p2, p4)) return true;
  if (d3 === 0 && onSegment(p1, p3, p2)) return true;
  if (d4 === 0 && onSegment(p1, p4, p2)) return true;
  return false;
}

/** 隣接しない辺どうしが交差しないか（n ≤ 30 程度なので O(n²) で十分） */
export function isSimplePolygon(poly: Vec2[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i];
    const a2 = poly[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // 隣接辺（共有頂点を持つ）はスキップ
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(a1, a2, poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Andrew の monotone chain による凸包 */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 3) return pts;
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** 頂点数予算内の単純多角形にする。どうしても自己交差が残る場合は凸包に落とす */
function finalizePolygon(raw: Vec2[], maxVertices: number, minEpsilon: number): Vec2[] | null {
  const budget = Math.max(3, maxVertices);
  let { points, epsilon } = simplifyToBudget(raw, budget, minEpsilon);
  points = removeCollinear(points);
  for (let tries = 0; tries < 8 && points.length >= 3 && !isSimplePolygon(points); tries++) {
    epsilon *= 1.4;
    points = removeCollinear(simplifyClosed(raw, epsilon));
  }
  if (points.length < 3 || !isSimplePolygon(points)) {
    const hull = convexHull(raw);
    if (hull.length < 3) return null;
    points = removeCollinear(simplifyToBudget(hull, budget, minEpsilon).points);
  }
  if (points.length < 3 || Math.abs(polygonArea(points)) < 1) return null;
  return points;
}

// ---------------------------------------------------------------------------
// 公開 API: キャンバス → ポリゴン
// ---------------------------------------------------------------------------

export function tracePiece(img: ImageLike, options: TraceOptions = {}): TracedPiece | null {
  const o = { ...DEFAULTS, ...options };
  const ds = Math.max(1, Math.floor(o.downsample));

  const mask = fillHoles(closeMask(buildMask(img, o.alphaThreshold, ds), o.closeRadius));
  const { labels, components } = labelComponents(mask);

  const minCells = o.minComponentArea / (ds * ds);
  const kept = components
    .filter((c) => c.area >= minCells)
    .sort((a, b) => b.area - a.area)
    .slice(0, o.maxComponents);
  if (kept.length === 0) return null;

  const outlines = kept.map((c) =>
    traceOutline(labels, mask.width, mask.height, c.label, c.startX, c.startY).map((p) => ({
      x: p.x * ds,
      y: p.y * ds,
    })),
  );

  // 頂点予算を周長比で配分（各成分最低 6 頂点）
  const perims = outlines.map(perimeter);
  const totalPerim = perims.reduce((a, b) => a + b, 0) || 1;
  const minEpsilon = Math.max(o.minEpsilon, ds);

  const polygons: Vec2[][] = [];
  outlines.forEach((raw, i) => {
    const budget =
      outlines.length === 1 ? o.maxVertices : Math.max(6, Math.floor((o.maxVertices * perims[i]) / totalPerim));
    const poly = finalizePolygon(raw, budget, minEpsilon);
    if (poly) polygons.push(poly);
  });
  if (polygons.length === 0) return null;

  const all = polygons.flat();
  return {
    polygons,
    vertexCount: all.length,
    area: polygons.reduce((s, p) => s + Math.abs(polygonArea(p)), 0),
    bounds: polygonBounds(all),
  };
}

// ---------------------------------------------------------------------------
// 公開 API: ポリゴン → Matter.js ボディ
// ---------------------------------------------------------------------------

/** body.plugin.piece に載せるメタ情報 */
export interface PieceMeta {
  ownerIndex: number;
  color: string;
  /** 描画用スプライトのキー（renderer 側のレジストリ参照） */
  spriteKey: string;
  /** ボディ座標系（position 原点・angle 0）でのキャンバス中心の位置 */
  spriteOffset: Vec2;
  /** キャンバス 1px あたりのワールド単位 */
  spriteScale: number;
  canvasSize: number;
  /** ボディ座標系での輪郭ポリゴン（分解前の見た目どおりの形。アウトライン描画用） */
  outline: Vec2[][];
}

export interface CreatePieceOptions {
  x: number;
  y: number;
  /** キャンバス px → ワールド単位 */
  scale: number;
  ownerIndex: number;
  color: string;
  spriteKey: string;
  canvasSize?: number;
  bodyOptions?: Matter.IBodyDefinition;
}

const PIECE_BODY_DEFAULTS: Matter.IBodyDefinition = {
  friction: 0.9,
  frictionStatic: 1.2,
  frictionAir: 0.01,
  restitution: 0.02,
  density: 0.0015,
};

export function getPieceMeta(body: Matter.Body): PieceMeta | undefined {
  return (body.plugin as { piece?: PieceMeta } | undefined)?.piece;
}

/**
 * トレース済みポリゴンから Matter.js ボディを作る。
 * - 凹多角形は poly-decomp で凸分解（Bodies.fromVertices）
 * - 複数成分は 1 つの compound body にまとめる
 * - fromVertices は重心を原点に寄せるので、そのずれを spriteOffset として保存し
 *   renderer がスプライトと輪郭を正しい位置に描けるようにする
 */
export function createPieceBody(polygons: Vec2[][], opts: CreatePieceOptions): Matter.Body | null {
  const canvasSize = opts.canvasSize ?? 256;
  const half = canvasSize / 2;
  const s = opts.scale;

  // キャンバス中心を原点としたワールドスケールの頂点
  const local = polygons
    .filter((p) => p.length >= 3)
    .map((poly) => poly.map((p) => ({ x: (p.x - half) * s, y: (p.y - half) * s })));
  if (local.length === 0) return null;
  const localBounds = polygonBounds(local.flat());

  const body = Matter.Bodies.fromVertices(
    0,
    0,
    local.map((poly) => poly.map((p) => ({ ...p }))),
    { ...PIECE_BODY_DEFAULTS, ...opts.bodyOptions },
    false,
    0.01,
    4,
  );
  if (!body || !body.vertices || body.vertices.length < 3 || !Number.isFinite(body.mass) || body.mass <= 0) {
    return null;
  }

  // 生成直後 (angle 0) は「元の頂点 + 平行移動」なので、bounds の差から移動量を復元できる
  const shift = { x: body.bounds.min.x - localBounds.minX, y: body.bounds.min.y - localBounds.minY };
  const spriteOffset = { x: shift.x - body.position.x, y: shift.y - body.position.y };

  const meta: PieceMeta = {
    ownerIndex: opts.ownerIndex,
    color: opts.color,
    spriteKey: opts.spriteKey,
    spriteOffset,
    spriteScale: s,
    canvasSize,
    outline: local.map((poly) => poly.map((p) => ({ x: p.x + spriteOffset.x, y: p.y + spriteOffset.y }))),
  };
  body.plugin = { ...(body.plugin ?? {}), piece: meta };
  body.label = `piece:${opts.spriteKey}`;
  Matter.Body.setPosition(body, { x: opts.x, y: opts.y });
  return body;
}
