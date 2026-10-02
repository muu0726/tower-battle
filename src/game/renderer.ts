import type Matter from "matter-js";
import { WORLD } from "../../shared/constants";
import { getPieceMeta, type Vec2 } from "../utils/contourTracer";
import { applyCamera, visibleWorldRect, type Camera, type Viewport } from "./camera";

/** spriteKey → 焼き込み済みスプライト（キャンバス + 四辺に SPRITE_PAD の余白） */
export type SpriteRegistry = Map<string, HTMLCanvasElement>;

/** 光彩のはみ出し分の余白（キャンバス px） */
const SPRITE_PAD = 28;

export interface RenderState {
  pieces: readonly Matter.Body[];
  island: Matter.Body;
  /** 配置中のピース（物理ワールド外） */
  preview: Matter.Body | null;
  debug: boolean;
}

/**
 * ピースのスプライトを一度だけ焼き込む。毎フレームの shadowBlur はモバイルで重いので、
 * プレイヤーカラーの光彩付き輪郭 → 輪郭でクリップした絵 → 細い輪郭 の順にここで描いておく。
 * クリップで物理形状の外側（捨てた点ゴミなど）を消し、見た目と当たり判定を一致させる。
 */
export function bakePieceSprite(source: HTMLCanvasElement, polygons: Vec2[][], color: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width + SPRITE_PAD * 2;
  canvas.height = source.height + SPRITE_PAD * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(SPRITE_PAD, SPRITE_PAD);

  const outline = () => {
    ctx.beginPath();
    for (const poly of polygons) tracePath(ctx, poly);
  };

  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.lineWidth = 9;
  outline();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  ctx.fill();

  ctx.save();
  outline();
  ctx.clip();
  ctx.drawImage(source, 0, 0);
  ctx.restore();

  ctx.lineWidth = 3.5;
  outline();
  ctx.stroke();
  return canvas;
}

function tracePath(ctx: CanvasRenderingContext2D, poly: readonly Vec2[]) {
  if (poly.length === 0) return;
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  view: Viewport,
  cam: Camera,
  state: RenderState,
  sprites: SpriteRegistry,
): void {
  // 背景（スクリーン座標）
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const sky = ctx.createLinearGradient(0, 0, 0, view.height);
  sky.addColorStop(0, "#0b1023");
  sky.addColorStop(1, "#1d3557");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, view.width, view.height);

  applyCamera(ctx, view, cam);
  const rect = visibleWorldRect(cam, view);

  drawAbyss(ctx, rect, cam.zoom);
  drawIsland(ctx, state.island);

  for (const body of state.pieces) drawPiece(ctx, body, sprites, 1);

  if (state.preview) {
    drawDropGuide(ctx, state.preview, cam.zoom);
    drawPiece(ctx, state.preview, sprites, 0.92);
  }

  if (state.debug) {
    for (const body of state.pieces) drawDebug(ctx, body, cam.zoom);
    if (state.preview) drawDebug(ctx, state.preview, cam.zoom);
  }
}

function drawAbyss(ctx: CanvasRenderingContext2D, rect: ReturnType<typeof visibleWorldRect>, zoom: number) {
  const top = WORLD.islandY + 120;
  const g = ctx.createLinearGradient(0, top, 0, WORLD.deathY + 200);
  g.addColorStop(0, "rgba(15, 23, 42, 0)");
  g.addColorStop(1, "rgba(127, 29, 29, 0.55)");
  ctx.fillStyle = g;
  ctx.fillRect(rect.left, top, rect.right - rect.left, Math.max(0, rect.bottom - top));

  ctx.save();
  ctx.strokeStyle = "rgba(248, 113, 113, 0.8)";
  ctx.lineWidth = 2 / zoom;
  ctx.setLineDash([12 / zoom, 8 / zoom]);
  ctx.beginPath();
  ctx.moveTo(rect.left, WORLD.deathY);
  ctx.lineTo(rect.right, WORLD.deathY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(248, 113, 113, 0.9)";
  ctx.font = `bold ${14 / zoom}px system-ui, sans-serif`;
  ctx.fillText("DEATH ZONE", rect.left + 12 / zoom, WORLD.deathY - 8 / zoom);
  ctx.restore();
}

function drawIsland(ctx: CanvasRenderingContext2D, island: Matter.Body) {
  const { min, max } = island.bounds;
  const w = max.x - min.x;
  // 見た目だけの岩肌（物理は上面の細い矩形のみ）
  ctx.fillStyle = "#57534e";
  ctx.beginPath();
  ctx.moveTo(min.x + 6, max.y - 2);
  ctx.lineTo(max.x - 6, max.y - 2);
  ctx.lineTo(min.x + w * 0.72, max.y + 60);
  ctx.lineTo(min.x + w * 0.55, max.y + 95);
  ctx.lineTo(min.x + w * 0.38, max.y + 70);
  ctx.closePath();
  ctx.fill();
  // 地面と草
  ctx.fillStyle = "#78350f";
  ctx.beginPath();
  tracePath(ctx, island.vertices);
  ctx.fill();
  ctx.fillStyle = "#4ade80";
  ctx.fillRect(min.x + 4, min.y, w - 8, 7);
}

function drawPiece(ctx: CanvasRenderingContext2D, body: Matter.Body, sprites: SpriteRegistry, alpha: number) {
  const meta = getPieceMeta(body);
  const sprite = meta && sprites.get(meta.spriteKey);
  if (!meta || !sprite) return;
  // 輪郭・光彩は bakePieceSprite で焼き込み済みなので drawImage 1 回だけ
  const pad = (sprite.width - meta.canvasSize) / 2;
  const half = (meta.canvasSize / 2 + pad) * meta.spriteScale;
  const size = sprite.width * meta.spriteScale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(body.position.x, body.position.y);
  ctx.rotate(body.angle);
  ctx.drawImage(sprite, meta.spriteOffset.x - half, meta.spriteOffset.y - half, size, size);
  ctx.restore();
}

function drawDropGuide(ctx: CanvasRenderingContext2D, preview: Matter.Body, zoom: number) {
  const meta = getPieceMeta(preview);
  if (!meta) return;
  const { min, max } = preview.bounds;
  ctx.save();
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = meta.color;
  ctx.fillRect(min.x, max.y, max.x - min.x, WORLD.deathY - max.y);
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = meta.color;
  ctx.lineWidth = 2 / zoom;
  ctx.setLineDash([10 / zoom, 8 / zoom]);
  ctx.beginPath();
  ctx.moveTo(preview.position.x, max.y);
  ctx.lineTo(preview.position.x, WORLD.deathY);
  ctx.stroke();
  ctx.restore();
}

function drawDebug(ctx: CanvasRenderingContext2D, body: Matter.Body, zoom: number) {
  const parts = body.parts.length > 1 ? body.parts.slice(1) : [body];
  ctx.save();
  ctx.lineWidth = 1 / zoom;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fillStyle = "#fde047";
  for (const part of parts) {
    ctx.beginPath();
    tracePath(ctx, part.vertices);
    ctx.stroke();
    for (const v of part.vertices) {
      ctx.beginPath();
      ctx.arc(v.x, v.y, 2.5 / zoom, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = "#f472b6";
  ctx.beginPath();
  ctx.arc(body.position.x, body.position.y, 4 / zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
