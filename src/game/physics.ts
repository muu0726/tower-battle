/**
 * 物理ワールド（planck.js = Box2D の JavaScript 版）
 *
 * 本家どうぶつタワーバトルは Unity 製で、2D 物理は Box2D 系。Matter.js から乗り換えたのは、
 * 静止摩擦がきちんと効く（斜面で止まる・止まったタワーがじわじわ動かない）ことと、揺れが早く収まるため。
 * 比較の数値は physics.lab.test.ts を参照。
 *
 * ゲーム側は「1 単位 = 1px」の座標系で考え、ここで Box2D のメートル単位（SCALE 単位 = 1m）と変換する。
 * 描画やシーンは planck に直接触らず、GameBody 越しに位置・角度・外接枠を扱う。
 */
import * as planck from "planck";
import {
  REST_ANGULAR_THRESHOLD,
  REST_SPEED_THRESHOLD,
  REST_STEPS_REQUIRED,
  WORLD,
} from "../../shared/constants";
import type { Vec2 } from "../utils/contourTracer";
import { toConvexParts } from "./pieceShape";

/** 固定タイムステップ (60Hz) */
export const PHYSICS_STEP_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 4;

/** ゲーム座標 SCALE 単位 = Box2D の 1m（Box2D が安定する 0.1〜10m の範囲にピースが収まる） */
const SCALE = 50;
/** 重力（単位/s²）。物理エンジン移行前と同じ落下の速さ */
const GRAVITY = 1000;
/** ソルバーの反復回数。Box2D の既定 (8/3) より多めにして、積み上がったタワーを安定させる（ピース数は多くても数十） */
const VELOCITY_ITERATIONS = 20;
const POSITION_ITERATIONS = 10;

/** ピースの材質。反発なし・強い摩擦で「着地したらピタッと引っかかる」 */
const PIECE_MATERIAL = { density: 1, friction: 1, restitution: 0 };
/** 揺れを早く収めるための減衰（落下の速さにはほとんど影響しない程度。値は physics.lab.test.ts で比較して決めた） */
const PIECE_DAMPING = 0.2;
const ISLAND_FRICTION = 1;

const toM = (v: number) => v / SCALE;
const toU = (v: number) => v * SCALE;

/** ピースの見た目・持ち主の情報 */
export interface PieceMeta {
  ownerIndex: number;
  color: string;
  /** 描画用スプライトのキー（renderer 側のレジストリ参照） */
  spriteKey: string;
  /** キャンバス 1px あたりのワールド単位 */
  spriteScale: number;
  canvasSize: number;
  /** ボディ座標系（原点 = キャンバス中心）での輪郭ポリゴン（アウトライン描画用） */
  outline: Vec2[][];
}

export interface Bounds {
  min: Vec2;
  max: Vec2;
}

/** planck.Body をゲームの単位系で扱う薄いラッパー。原点はキャンバス中心（スプライトの中心）に一致する */
export class GameBody {
  constructor(
    readonly body: planck.Body,
    /** ボディ座標系（ゲーム単位）での凸パーツ */
    readonly parts: Vec2[][],
    readonly meta: PieceMeta | null,
  ) {}

  get position(): Vec2 {
    const p = this.body.getPosition();
    return { x: toU(p.x), y: toU(p.y) };
  }

  get angle(): number {
    return this.body.getAngle();
  }

  /** 速さ（単位/s） */
  get speed(): number {
    const v = this.body.getLinearVelocity();
    return toU(Math.hypot(v.x, v.y));
  }

  /** 角速度の大きさ（rad/s） */
  get angularSpeed(): number {
    return Math.abs(this.body.getAngularVelocity());
  }

  get isAwake(): boolean {
    return this.body.isAwake();
  }

  /** 物理ワールドに参加しているか（配置プレビュー中は不参加） */
  get isActive(): boolean {
    return this.body.isActive();
  }

  /** 位置・角度を設定する（速度はそのまま） */
  setTransform(x: number, y: number, angle = this.angle): void {
    this.body.setTransform(planck.Vec2(toM(x), toM(y)), angle);
  }

  setPosition(x: number, y: number): void {
    this.setTransform(x, y);
  }

  setAngle(angle: number): void {
    const p = this.position;
    this.setTransform(p.x, p.y, angle);
  }

  /** 位置・角度を設定して静止させる（サーバーの確定位置を当てはめるとき） */
  setPose(x: number, y: number, angle: number): void {
    this.setTransform(x, y, angle);
    this.stop();
  }

  stop(): void {
    this.body.setLinearVelocity(planck.Vec2(0, 0));
    this.body.setAngularVelocity(0);
  }

  /** ワールド座標での各パーツの頂点 */
  worldParts(): Vec2[][] {
    const { x, y } = this.position;
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    return this.parts.map((part) => part.map((p) => ({ x: x + p.x * c - p.y * s, y: y + p.x * s + p.y * c })));
  }

  get bounds(): Bounds {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const part of this.worldParts()) {
      for (const p of part) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
  }

  /** 重心（ワールド座標） */
  get centerOfMass(): Vec2 {
    const c = this.body.getWorldCenter();
    return { x: toU(c.x), y: toU(c.y) };
  }
}

export interface PhysicsWorld {
  world: planck.World;
  island: GameBody;
  /** ワールドに投入済みのピース */
  pieces: GameBody[];
  accumulator: number;
}

export function createPhysics(): PhysicsWorld {
  const world = new planck.World({ gravity: planck.Vec2(0, toM(GRAVITY)) });
  const hw = WORLD.islandWidth / 2;
  const hh = WORLD.islandHeight / 2;
  const body = world.createBody({ type: "static", position: planck.Vec2(toM(WORLD.islandX), toM(WORLD.islandY)) });
  body.createFixture({ shape: planck.Box(toM(hw), toM(hh)), friction: ISLAND_FRICTION });
  const islandParts = [
    [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ],
  ];
  return { world, island: new GameBody(body, islandParts, null), pieces: [], accumulator: 0 };
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
}

/**
 * トレース済みポリゴン（キャンバス座標）からピースのボディを作る。
 * 作った直後は物理に参加しない（配置プレビュー用）。addPiece で落下を始める。
 * ボディの原点はキャンバス中心なので、同じポリゴンからは全クライアントで同じボディになり、
 * サーバーに保存する位置・角度はこの原点の値になる。
 */
export function createPieceBody(world: PhysicsWorld, polygons: Vec2[][], opts: CreatePieceOptions): GameBody | null {
  const canvasSize = opts.canvasSize ?? 256;
  const half = canvasSize / 2;
  const s = opts.scale;
  const outline = polygons
    .filter((p) => p.length >= 3)
    .map((poly) => poly.map((p) => ({ x: (p.x - half) * s, y: (p.y - half) * s })));
  const parts = toConvexParts(outline);
  if (parts.length === 0) return null;

  const body = world.world.createBody({
    type: "dynamic",
    position: planck.Vec2(toM(opts.x), toM(opts.y)),
    active: false,
    linearDamping: PIECE_DAMPING,
    angularDamping: PIECE_DAMPING,
  });
  for (const part of parts) {
    body.createFixture({ shape: planck.Polygon(part.map((p) => planck.Vec2(toM(p.x), toM(p.y)))), ...PIECE_MATERIAL });
  }
  return new GameBody(body, parts, {
    ownerIndex: opts.ownerIndex,
    color: opts.color,
    spriteKey: opts.spriteKey,
    spriteScale: s,
    canvasSize,
    outline,
  });
}

/** ピースを物理に参加させる（静止状態から落下・積み上がり開始） */
export function addPiece(world: PhysicsWorld, piece: GameBody): void {
  piece.stop();
  piece.body.setActive(true);
  piece.body.setAwake(true);
  if (!world.pieces.includes(piece)) world.pieces.push(piece);
}

/** ピースをワールドから完全に取り除く */
export function removePiece(world: PhysicsWorld, piece: GameBody): void {
  world.world.destroyBody(piece.body);
  world.pieces = world.pieces.filter((b) => b !== piece);
}

/** まだ物理に参加していないピース（配置プレビュー）を破棄する */
export function discardPiece(world: PhysicsWorld, piece: GameBody): void {
  if (world.pieces.includes(piece)) removePiece(world, piece);
  else world.world.destroyBody(piece.body);
}

export function clearPieces(world: PhysicsWorld): void {
  for (const b of world.pieces) world.world.destroyBody(b.body);
  world.pieces = [];
  world.accumulator = 0;
}

/**
 * 経過時間ぶん固定ステップで進める。各ステップ後に onStep を呼ぶ（静止判定のカウント用）。
 * maxSteps は 1 回で追いつく上限（描画ループでは小さく、タイマーが間引かれる裏タブでは大きくする）。
 * 戻り値は実行したステップ数。
 */
export function stepPhysics(
  world: PhysicsWorld,
  dtMs: number,
  onStep?: () => void,
  maxSteps = MAX_STEPS_PER_FRAME,
): number {
  world.accumulator = Math.min(world.accumulator + dtMs, PHYSICS_STEP_MS * maxSteps);
  let steps = 0;
  while (world.accumulator >= PHYSICS_STEP_MS) {
    world.world.step(PHYSICS_STEP_MS / 1000, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
    world.accumulator -= PHYSICS_STEP_MS;
    steps++;
    onStep?.();
  }
  return steps;
}

/** 中心が Death Zone (deathY) より下に落ちたピース */
export function findFallenPieces(world: PhysicsWorld): GameBody[] {
  return world.pieces.filter((b) => b.position.y > WORLD.deathY);
}

/** タワー最上部の y（ピースが無ければ浮島の上面）。落下中で浮島より下にあるピースは無視 */
export function towerTopY(world: PhysicsWorld): number {
  let top = WORLD.islandY - WORLD.islandHeight / 2;
  for (const b of world.pieces) {
    if (b.position.y > WORLD.islandY) continue;
    const y = b.bounds.min.y;
    if (y < top) top = y;
  }
  return top;
}

/**
 * 全ピースが「眠っている（Box2D が静止と判断）」か「速度・角速度が閾値以下」の状態が
 * REST_STEPS_REQUIRED ステップ連続したら静止
 */
export class RestDetector {
  private calmSteps = 0;

  reset(): void {
    this.calmSteps = 0;
  }

  /** 物理ステップごとに呼ぶ */
  step(bodies: readonly GameBody[]): void {
    const calm = bodies.every(
      (b) => !b.isAwake || (b.speed < REST_SPEED_THRESHOLD && b.angularSpeed < REST_ANGULAR_THRESHOLD),
    );
    this.calmSteps = calm ? this.calmSteps + 1 : 0;
  }

  get atRest(): boolean {
    return this.calmSteps >= REST_STEPS_REQUIRED;
  }

  /** 0〜1 の静止進捗（UI 表示用） */
  get progress(): number {
    return Math.min(1, this.calmSteps / REST_STEPS_REQUIRED);
  }
}
