/**
 * OnlineScene — サーバーの部屋状態（RoomView）を物理ワールドと描画に反映する対戦用シーン
 *
 * 物理は「手番クライアント権威」:
 * - 普段はどの画面でも物理を止め、確定済みピースはサーバーの位置に固定する
 * - DROP 後は物理担当（simulatorId）の画面だけが物理を進め、姿勢を STATE_STREAM で配信し、静止したら SETTLED を送る
 * - それ以外の画面は届いた姿勢フレームへ補間して表示する
 * - TURN_RESULT で全員がサーバーの確定位置に揃う
 */
import { PIECE_SCALE, PLAYER_COLORS, REST_TIMEOUT_MS, SPAWN_CLEARANCE, WORLD } from "../../shared/constants";
import type { PieceData, Pose } from "../../shared/protocol";
import type { RoomClient } from "../net/roomClient";
import type { RoomView } from "../net/roomStore";
import type { Vec2 } from "../utils/contourTracer";
import {
  addPiece,
  createPhysics,
  createPieceBody,
  discardPiece,
  findFallenPieces,
  removePiece,
  RestDetector,
  stepPhysics,
  towerTopY,
  type GameBody,
  type PhysicsWorld,
} from "./physics";
import { bakePieceSprite, type RenderState, type SpriteRegistry } from "./renderer";
import type { Scene } from "./sandboxScene";

/** 他人の操作・姿勢フレームへの追従の速さ (1/s) */
const FOLLOW_RATE = 18;
/**
 * 物理担当の計算は描画ループ（requestAnimationFrame）ではなく専用タイマーで回す。
 * 裏タブやスマホでアプリを切り替えると rAF は止まるが、タイマーは間引かれつつも動くので、
 * 1 回で最大 1 秒分（60 ステップ）まで追いつけば落下の確定が止まらない。
 */
const SIM_INTERVAL_MS = 16;
const SIM_MAX_CATCHUP_STEPS = 60;

export interface OnlineSceneHooks {
  /** 自分の配置プレビューが盤面ドラッグで動いた（スライダー表示とサーバー送信用） */
  onLocalPreview?(x: number, angle: number): void;
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export class OnlineScene implements Scene {
  readonly sprites: SpriteRegistry = new Map();
  debug = false;

  private readonly physics: PhysicsWorld = createPhysics();
  private readonly rest = new RestDetector();
  private readonly bodies = new Map<string, GameBody>();
  /** 最後に当てはめたサーバー確定位置（参照が変わったら当て直す） */
  private readonly appliedPose = new Map<string, PieceData["pose"]>();
  /** 他人の画面: 補間の目標 */
  private readonly targets = new Map<string, Omit<Pose, "id">>();
  private client: RoomClient | null = null;
  private view: RoomView | null = null;

  private pendingId: string | null = null;
  private droppedId: string | null = null;
  private previewTarget: { x: number; angle: number } | null = null;
  private simulating = false;
  private simElapsed = 0;
  private fallen: string[] = [];
  private simTimer: ReturnType<typeof setInterval> | null = null;
  private lastSimTick = 0;
  private drag: { startX: number; pieceX: number } | null = null;

  constructor(private readonly hooks: OnlineSceneHooks = {}) {}

  attach(client: RoomClient | null): void {
    this.client = client;
  }

  private get me() {
    return this.view?.me ?? null;
  }

  private get isMyPlacement() {
    const room = this.view?.room;
    return room?.phase === "placing" && room.activePlayerId === this.me;
  }

  /** 物理担当として落下を計算中か */
  get isSimulating(): boolean {
    return this.simulating;
  }

  /** 自分の配置プレビューの現在位置 */
  get previewPose(): { x: number; angle: number } | null {
    const body = this.pendingId ? this.bodies.get(this.pendingId) : undefined;
    return body ? { x: body.position.x, angle: body.angle } : null;
  }

  // ---------------------------------------------------------------------------
  // サーバー状態との同期
  // ---------------------------------------------------------------------------

  sync(view: RoomView): void {
    this.view = view;
    const room = view.room;

    // 消えたピース（落下・新しい試合）を取り除く
    for (const id of [...this.bodies.keys()]) {
      if (!view.pieces[id]) this.forget(id);
    }
    // 新しいピースを作る
    for (const piece of Object.values(view.pieces)) {
      if (!this.bodies.has(piece.id)) this.create(piece);
    }
    if (!room) return;

    // 確定位置の反映（物理担当として計算中は自分の結果を優先）
    if (!this.simulating) {
      for (const piece of Object.values(view.pieces)) {
        if (!piece.pose || this.appliedPose.get(piece.id) === piece.pose) continue;
        const body = this.bodies.get(piece.id)!;
        body.setPose(piece.pose.x, piece.pose.y, piece.pose.angle);
        this.appliedPose.set(piece.id, piece.pose);
        this.targets.delete(piece.id);
        if (!this.physics.pieces.includes(body)) addPiece(this.physics, body);
      }
    }

    // 配置中のピース
    const pending = room.pendingPieceId;
    if (pending !== this.pendingId) {
      this.pendingId = pending;
      this.previewTarget = null;
      const body = pending ? this.bodies.get(pending) : undefined;
      if (body && room.phase === "placing") {
        body.setPose(view.preview?.x ?? WORLD.islandX, body.position.y, view.preview?.angle ?? 0);
        this.placeAboveTower(body);
        if (this.isMyPlacement) this.hooks.onLocalPreview?.(body.position.x, body.angle);
      }
    }
    if (room.phase === "placing" && !this.isMyPlacement) this.previewTarget = view.preview;

    // DROP（落下開始）
    if (room.phase === "settling" && pending && this.droppedId !== pending) {
      this.droppedId = pending;
      this.startDrop(pending, view.preview ?? { x: WORLD.islandX, angle: 0 }, room.simulatorId === this.me);
    }

    // 他人が物理担当: 姿勢フレームを補間の目標にする
    if (room.phase === "settling" && !this.simulating && view.frame) {
      for (const p of view.frame) this.targets.set(p.id, { x: p.x, y: p.y, angle: p.angle });
    }

    // ターン確定・試合終了で計算を止める
    if (room.phase !== "settling") {
      this.simulating = false;
      this.stopSimLoop();
      this.droppedId = null;
    }
  }

  private create(piece: PieceData) {
    const color = PLAYER_COLORS[piece.ownerIndex]?.hex ?? "#ffffff";
    const body = createPieceBody(this.physics, piece.polygons, {
      x: WORLD.islandX,
      y: -10_000,
      scale: PIECE_SCALE,
      ownerIndex: piece.ownerIndex,
      color,
      spriteKey: piece.id,
    });
    if (!body) return;
    this.bodies.set(piece.id, body);
    this.loadSprite(piece, color);
  }

  /** 絵（data URL）を読み込んで色付き輪郭を焼き込む。画像なし（代わりのブロック）は色で塗る */
  private loadSprite(piece: PieceData, color: string) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    const bake = () => {
      if (this.bodies.has(piece.id)) this.sprites.set(piece.id, bakePieceSprite(canvas, piece.polygons, color));
    };
    if (!piece.image) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const poly of piece.polygons) {
        poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
      }
      ctx.fill();
      bake();
      return;
    }
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, 256, 256);
      bake();
    };
    img.src = piece.image;
  }

  private forget(id: string) {
    const body = this.bodies.get(id);
    if (body) discardPiece(this.physics, body);
    this.bodies.delete(id);
    this.sprites.delete(id);
    this.appliedPose.delete(id);
    this.targets.delete(id);
  }

  /** プレビュー下端がタワー最上部から SPAWN_CLEARANCE 上に来るよう y を合わせる（全員同じ盤面なので同じ高さになる） */
  private placeAboveTower(body: GameBody) {
    const bottomOffset = body.bounds.max.y - body.position.y;
    const y = towerTopY(this.physics) - SPAWN_CLEARANCE - bottomOffset;
    body.setPosition(body.position.x, y);
  }

  private startDrop(id: string, pose: { x: number; angle: number }, simulate: boolean) {
    const body = this.bodies.get(id);
    if (!body) return;
    body.setPose(pose.x, body.position.y, pose.angle);
    this.placeAboveTower(body);
    if (!this.physics.pieces.includes(body)) addPiece(this.physics, body);
    this.simulating = simulate;
    if (simulate) {
      for (const b of this.physics.pieces) b.stop();
      this.rest.reset();
      this.simElapsed = 0;
      this.fallen = [];
      this.physics.accumulator = 0;
      this.startSimLoop();
    }
  }

  private startSimLoop() {
    this.stopSimLoop();
    this.lastSimTick = performance.now();
    this.simTimer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(now - this.lastSimTick, 1000);
      this.lastSimTick = now;
      if (this.simulating) this.simulate(dt);
      else this.stopSimLoop();
    }, SIM_INTERVAL_MS);
  }

  private stopSimLoop() {
    if (this.simTimer) clearInterval(this.simTimer);
    this.simTimer = null;
  }

  /** 画面を離れるときに呼ぶ */
  dispose(): void {
    this.simulating = false;
    this.stopSimLoop();
  }

  // ---------------------------------------------------------------------------
  // 自分の配置操作
  // ---------------------------------------------------------------------------

  setPreviewX(x: number): void {
    const body = this.pendingId ? this.bodies.get(this.pendingId) : undefined;
    if (!body || !this.isMyPlacement) return;
    body.setPosition(Math.max(WORLD.minX, Math.min(WORLD.maxX, x)), body.position.y);
  }

  rotatePreview(deg: number): void {
    const body = this.pendingId ? this.bodies.get(this.pendingId) : undefined;
    if (!body || !this.isMyPlacement) return;
    body.setAngle(body.angle + (deg * Math.PI) / 180);
    this.placeAboveTower(body);
  }

  onPointer(world: Vec2, phase: "down" | "move" | "up"): void {
    const body = this.pendingId ? this.bodies.get(this.pendingId) : undefined;
    if (phase === "down") {
      this.drag = this.isMyPlacement && body ? { startX: world.x, pieceX: body.position.x } : null;
      return;
    }
    if (phase === "up") {
      this.drag = null;
      return;
    }
    if (!this.drag || !body) return;
    this.setPreviewX(this.drag.pieceX + (world.x - this.drag.startX));
    this.hooks.onLocalPreview?.(body.position.x, body.angle);
  }

  // ---------------------------------------------------------------------------
  // 毎フレーム
  // ---------------------------------------------------------------------------

  update(dtMs: number): void {
    const k = 1 - Math.exp((-dtMs / 1000) * FOLLOW_RATE);

    // 物理担当の計算は専用タイマー（startSimLoop）で進むので、ここでは他人の落下の補間だけ行う
    if (!this.simulating && this.targets.size > 0) {
      // 他人の落下を補間表示
      for (const [id, t] of this.targets) {
        const body = this.bodies.get(id);
        if (!body) continue;
        const p = body.position;
        body.setTransform(p.x + (t.x - p.x) * k, p.y + (t.y - p.y) * k, lerpAngle(body.angle, t.angle, k));
      }
    }

    // 他人の配置プレビューを追従
    const body = this.pendingId ? this.bodies.get(this.pendingId) : undefined;
    if (body && this.previewTarget && this.view?.room?.phase === "placing") {
      const p = body.position;
      body.setPosition(p.x + (this.previewTarget.x - p.x) * k, p.y);
      const angle = lerpAngle(body.angle, this.previewTarget.angle, k);
      if (Math.abs(angle - body.angle) > 1e-4) {
        body.setAngle(angle);
        this.placeAboveTower(body);
      }
    }
  }

  private simulate(dtMs: number) {
    stepPhysics(this.physics, dtMs, () => this.rest.step(this.physics.pieces), SIM_MAX_CATCHUP_STEPS);
    for (const b of findFallenPieces(this.physics)) {
      removePiece(this.physics, b);
      const id = [...this.bodies].find(([, body]) => body === b)?.[0];
      if (id) this.fallen.push(id);
    }
    const poses = this.currentPoses();
    this.client?.sendStream(poses);

    this.simElapsed += dtMs;
    if (this.rest.atRest || this.simElapsed >= REST_TIMEOUT_MS) {
      this.simulating = false;
      this.stopSimLoop();
      this.client?.settle(poses, this.fallen);
    }
  }

  private currentPoses(): Pose[] {
    const out: Pose[] = [];
    for (const [id, body] of this.bodies) {
      if (!this.physics.pieces.includes(body)) continue;
      out.push({ id, x: body.position.x, y: body.position.y, angle: body.angle });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------

  renderState(): RenderState {
    const room = this.view?.room;
    const pending = this.pendingId ? this.bodies.get(this.pendingId) : undefined;
    const preview = room?.phase === "placing" && pending ? pending : null;
    return {
      pieces: this.physics.pieces,
      island: this.physics.island,
      preview,
      debug: this.debug,
    };
  }

  focusTopY(): number {
    const pending = this.pendingId ? this.bodies.get(this.pendingId) : undefined;
    if (pending && this.view?.room?.phase === "placing") return pending.bounds.min.y;
    return towerTopY(this.physics) - SPAWN_CLEARANCE - 140;
  }
}
