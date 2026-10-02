import { WORLD } from "../../shared/constants";
import type { Vec2 } from "../utils/contourTracer";

export interface Viewport {
  /** CSS px */
  width: number;
  height: number;
  dpr: number;
}

export interface Camera {
  /** 画面中央に映すワールド座標 */
  x: number;
  y: number;
  /** CSS px / ワールド単位 */
  zoom: number;
  ready: boolean;
}

/** 浮島の下に見せておく Death Zone の高さ */
const BOTTOM_MARGIN = 260;
/** 注目点（プレビュー上端など）の上に空ける余白 */
const TOP_MARGIN = 80;
/** 追従の速さ (1/s) */
const FOLLOW_RATE = 3;

export function createCamera(): Camera {
  return { x: WORLD.width / 2, y: WORLD.islandY / 2, zoom: 1, ready: false };
}

/**
 * focusTopY（画面に必ず入れたい最も高い位置）から目標カメラを計算する。
 * 浮島を画面下部に固定し、タワーが伸びるほど上方向にパンしつつズームアウトする。
 */
export function cameraTarget(focusTopY: number, view: Viewport): Omit<Camera, "ready"> {
  const bottom = WORLD.islandY + BOTTOM_MARGIN;
  const top = Math.min(0, focusTopY - TOP_MARGIN);
  const zoom = Math.min(view.width / WORLD.width, view.height / (bottom - top));
  const visibleH = view.height / zoom;
  return { x: WORLD.width / 2, y: bottom - visibleH / 2, zoom };
}

export function updateCamera(cam: Camera, target: Omit<Camera, "ready">, dtMs: number): void {
  if (!cam.ready) {
    Object.assign(cam, target, { ready: true });
    return;
  }
  const k = 1 - Math.exp((-dtMs / 1000) * FOLLOW_RATE);
  cam.x += (target.x - cam.x) * k;
  cam.y += (target.y - cam.y) * k;
  cam.zoom += (target.zoom - cam.zoom) * k;
}

export function applyCamera(ctx: CanvasRenderingContext2D, view: Viewport, cam: Camera): void {
  const s = view.dpr * cam.zoom;
  ctx.setTransform(
    s,
    0,
    0,
    s,
    view.dpr * (view.width / 2 - cam.x * cam.zoom),
    view.dpr * (view.height / 2 - cam.y * cam.zoom),
  );
}

export function screenToWorld(cam: Camera, view: Viewport, sx: number, sy: number): Vec2 {
  return {
    x: (sx - view.width / 2) / cam.zoom + cam.x,
    y: (sy - view.height / 2) / cam.zoom + cam.y,
  };
}

export function visibleWorldRect(cam: Camera, view: Viewport) {
  const hw = view.width / 2 / cam.zoom;
  const hh = view.height / 2 / cam.zoom;
  return { left: cam.x - hw, right: cam.x + hw, top: cam.y - hh, bottom: cam.y + hh };
}
