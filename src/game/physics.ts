import Matter from "matter-js";
import {
  REST_ANGULAR_THRESHOLD,
  REST_SPEED_THRESHOLD,
  REST_STEPS_REQUIRED,
  WORLD,
} from "../../shared/constants";

const { Bodies, Composite, Engine } = Matter;

/** 固定タイムステップ (60Hz) */
export const PHYSICS_STEP_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 4;

export interface PhysicsWorld {
  engine: Matter.Engine;
  island: Matter.Body;
  /** ワールドに投入済みのピース */
  pieces: Matter.Body[];
  accumulator: number;
}

export function createPhysics(): PhysicsWorld {
  const engine = Engine.create({ positionIterations: 10, velocityIterations: 8 });
  engine.gravity.y = 1;
  // 静止判定は自前で行うので sleeping は使わない（寝たボディが起きない事故を避ける）
  engine.enableSleeping = false;

  const island = Bodies.rectangle(WORLD.islandX, WORLD.islandY, WORLD.islandWidth, WORLD.islandHeight, {
    isStatic: true,
    friction: 1,
    frictionStatic: 1.5,
    label: "island",
    chamfer: { radius: 6 },
  });
  Composite.add(engine.world, island);
  return { engine, island, pieces: [], accumulator: 0 };
}

export function addPiece(world: PhysicsWorld, body: Matter.Body): void {
  Matter.Body.setVelocity(body, { x: 0, y: 0 });
  Matter.Body.setAngularVelocity(body, 0);
  Composite.add(world.engine.world, body);
  world.pieces.push(body);
}

export function removePiece(world: PhysicsWorld, body: Matter.Body): void {
  Composite.remove(world.engine.world, body);
  world.pieces = world.pieces.filter((b) => b !== body);
}

export function clearPieces(world: PhysicsWorld): void {
  for (const b of world.pieces) Composite.remove(world.engine.world, b);
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
    Engine.update(world.engine, PHYSICS_STEP_MS);
    world.accumulator -= PHYSICS_STEP_MS;
    steps++;
    onStep?.();
  }
  return steps;
}

/** 中心が Death Zone (deathY) より下に落ちたピース */
export function findFallenPieces(world: PhysicsWorld): Matter.Body[] {
  return world.pieces.filter((b) => b.position.y > WORLD.deathY);
}

/** タワー最上部の y（ピースが無ければ浮島の上面）。落下中で浮島より下にあるピースは無視 */
export function towerTopY(world: PhysicsWorld): number {
  let top = WORLD.islandY - WORLD.islandHeight / 2;
  for (const b of world.pieces) {
    if (b.position.y > WORLD.islandY) continue;
    if (b.bounds.min.y < top) top = b.bounds.min.y;
  }
  return top;
}

/** 全ピースの速度・角速度が閾値以下の状態が REST_STEPS_REQUIRED ステップ連続したら静止 */
export class RestDetector {
  private calmSteps = 0;

  reset(): void {
    this.calmSteps = 0;
  }

  /** 物理ステップごとに呼ぶ */
  step(bodies: readonly Matter.Body[]): void {
    const calm = bodies.every(
      (b) => b.isStatic || (b.speed < REST_SPEED_THRESHOLD && Math.abs(b.angularVelocity) < REST_ANGULAR_THRESHOLD),
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
