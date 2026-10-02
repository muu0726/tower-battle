import { REST_TIMEOUT_MS, SPAWN_CLEARANCE, WORLD } from "../../shared/constants";
import type { Vec2 } from "../utils/contourTracer";
import {
  addPiece,
  clearPieces,
  createPhysics,
  discardPiece,
  findFallenPieces,
  removePiece,
  RestDetector,
  stepPhysics,
  towerTopY,
  type GameBody,
  type PhysicsWorld,
} from "./physics";
import type { RenderState, SpriteRegistry } from "./renderer";

/** GameCanvas が駆動するシーンの共通インターフェース（ステップ5の対戦画面でも使う） */
export interface Scene {
  readonly sprites: SpriteRegistry;
  update(dtMs: number): void;
  renderState(): RenderState;
  /** カメラが画面内に収めるべき最も高い y */
  focusTopY(): number;
  onPointer?(world: Vec2, phase: "down" | "move" | "up"): void;
}

export type SandboxPhase = "draw" | "place" | "settling";

export interface SandboxEvents {
  onPhase(phase: SandboxPhase): void;
  /** 落下後に盤面が静止した */
  onRest(info: { forced: boolean }): void;
  /** ピースが Death Zone に落ちた。blamed = その時の手番（DTB ルールで脱落する人） */
  onFall(info: { ownerIndex: number; blamedIndex: number }): void;
  onPreviewX(x: number): void;
}

/** 1 画面で「描く → ピース化 → 落として積む」を確認するためのローカル専用シーン */
export class SandboxScene implements Scene {
  readonly sprites: SpriteRegistry = new Map();
  readonly physics: PhysicsWorld = createPhysics();
  readonly rest = new RestDetector();
  debug = false;

  private phase: SandboxPhase = "draw";
  private preview: GameBody | null = null;
  private droppedBy = -1;
  private settleElapsed = 0;
  private drag: { startX: number; pieceX: number } | null = null;

  constructor(private readonly events: SandboxEvents) {}

  get currentPhase(): SandboxPhase {
    return this.phase;
  }

  private setPhase(phase: SandboxPhase) {
    this.phase = phase;
    this.events.onPhase(phase);
  }

  /** トレース済みピース（このシーンの physics で createPieceBody したもの）を画面上部に出す */
  spawnPreview(body: GameBody): void {
    this.preview = body;
    body.setPosition(WORLD.width / 2, body.position.y);
    this.placePreviewAboveTower();
    this.events.onPreviewX(body.position.x);
    this.setPhase("place");
  }

  /** プレビュー下端がタワー最上部から SPAWN_CLEARANCE 上に来るよう y を合わせる */
  private placePreviewAboveTower() {
    const body = this.preview;
    if (!body) return;
    const bottomOffset = body.bounds.max.y - body.position.y;
    const y = towerTopY(this.physics) - SPAWN_CLEARANCE - bottomOffset;
    body.setPosition(body.position.x, y);
  }

  setPreviewX(x: number): void {
    if (!this.preview || this.phase !== "place") return;
    const clamped = Math.max(WORLD.minX, Math.min(WORLD.maxX, x));
    this.preview.setPosition(clamped, this.preview.position.y);
  }

  rotatePreview(deg: number): void {
    if (!this.preview || this.phase !== "place") return;
    this.preview.setAngle(this.preview.angle + (deg * Math.PI) / 180);
    this.placePreviewAboveTower();
  }

  drop(): void {
    const body = this.preview;
    if (!body || this.phase !== "place") return;
    this.preview = null;
    this.droppedBy = body.meta?.ownerIndex ?? -1;
    addPiece(this.physics, body);
    this.rest.reset();
    this.settleElapsed = 0;
    this.setPhase("settling");
  }

  reset(): void {
    clearPieces(this.physics);
    if (this.preview) discardPiece(this.physics, this.preview);
    this.preview = null;
    this.sprites.clear();
    this.rest.reset();
    this.setPhase("draw");
  }

  update(dtMs: number): void {
    stepPhysics(this.physics, dtMs, () => this.rest.step(this.physics.pieces));

    for (const body of findFallenPieces(this.physics)) {
      removePiece(this.physics, body);
      const ownerIndex = body.meta?.ownerIndex ?? -1;
      this.events.onFall({ ownerIndex, blamedIndex: this.phase === "settling" ? this.droppedBy : ownerIndex });
    }

    if (this.phase === "settling") {
      this.settleElapsed += dtMs;
      const forced = this.settleElapsed >= REST_TIMEOUT_MS;
      if (this.rest.atRest || forced) {
        this.setPhase("draw");
        this.events.onRest({ forced });
      }
    }
  }

  renderState(): RenderState {
    return {
      pieces: this.physics.pieces,
      island: this.physics.island,
      preview: this.preview,
      debug: this.debug,
    };
  }

  focusTopY(): number {
    if (this.preview) return this.preview.bounds.min.y;
    // 次のピースが出てくる高さ（~140 はピースの最大高さの目安）を先回りして映しておく
    return towerTopY(this.physics) - SPAWN_CLEARANCE - 140;
  }

  /** 盤面ドラッグは相対移動（指を動かした分だけ動く。タッチで指がピースを隠さない） */
  onPointer(world: Vec2, phase: "down" | "move" | "up"): void {
    if (phase === "down") {
      this.drag = this.phase === "place" && this.preview ? { startX: world.x, pieceX: this.preview.position.x } : null;
      return;
    }
    if (phase === "up") {
      this.drag = null;
      return;
    }
    if (!this.drag || !this.preview) return;
    this.setPreviewX(this.drag.pieceX + (world.x - this.drag.startX));
    this.events.onPreviewX(this.preview.position.x);
  }
}
