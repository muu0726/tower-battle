// 時間切れでサイズ規定を満たせなかった時の自動補正（Canvas 依存）
import { computeUpscaleFactor, type SizeRequirement } from "../../shared/sizeRule";
import type { TracedPiece } from "./contourTracer";

function newCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c;
}

/**
 * 描いた絵の外接枠を切り出し、比率を保ったまま規定サイズまで拡大してキャンバス中央に描き直す。
 * 呼び出し側で再トレースすれば、見た目と物理形状が一致したまま大きくなる。
 */
export function upscaleDrawing(
  source: HTMLCanvasElement,
  traced: TracedPiece,
  req: SizeRequirement,
): HTMLCanvasElement {
  const size = source.width;
  const { minX, minY, maxX, maxY } = traced.bounds;
  const w = maxX - minX;
  const h = maxY - minY;
  const f = computeUpscaleFactor({ width: w, height: h, area: traced.area }, req, size);

  const out = newCanvas(size);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, minX, minY, w, h, (size - w * f) / 2, (size - h * f) / 2, w * f, h * f);
  return out;
}

/** 何も描かれずに時間切れになった時の代わりのブロック（規定ぴったり + 少し余裕） */
export function fallbackBlock(color: string, req: SizeRequirement, size: number): HTMLCanvasElement {
  const side = Math.min(size * 0.9, Math.max(req.minWidth, Math.sqrt(req.minPixels)) * 1.08);
  const out = newCanvas(size);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect((size - side) / 2, (size - side) / 2, side, side);
  return out;
}
