// お絵描きの提出処理（Sandbox と対戦画面で共用）
import { DRAW_CANVAS_SIZE, PIECE_MAX_VERTICES } from "../../shared/constants";
import { evaluateSize, type SizeRequirement } from "../../shared/sizeRule";
import { tracePiece, type TracedPiece } from "../utils/contourTracer";
import { fallbackBlock, upscaleDrawing } from "../utils/sizeFallback";

export function traceCanvas(canvas: HTMLCanvasElement): TracedPiece | null {
  const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  return tracePiece(data, { maxVertices: PIECE_MAX_VERTICES });
}

export function meetsRequirement(traced: TracedPiece, req: SizeRequirement): boolean {
  const { minX, minY, maxX, maxY } = traced.bounds;
  return evaluateSize({ width: maxX - minX, height: maxY - minY, area: traced.area }, req).ok;
}

export interface PreparedPiece {
  /** ピースの絵（拡大や代わりのブロックに差し替わっている場合がある） */
  source: HTMLCanvasElement;
  traced: TracedPiece;
  /** none: そのまま / fallback: 何も描かれていなかったので代わりのブロック / upscaled: サイズ不足を拡大 */
  adjusted: "none" | "fallback" | "upscaled";
}

/**
 * DrawingPad の提出を物理ピースにできる形に整える。
 * 完成ボタンで規定未達・空の場合は null（ボタンが押せないので通常は来ない）。
 * 時間切れの場合は止めずに、空なら代わりのブロック、サイズ不足なら比率を保って拡大する。
 */
export function preparePiece(
  canvas: HTMLCanvasElement,
  reason: "button" | "timeout",
  traced: TracedPiece | null,
  req: SizeRequirement,
  color: string,
): PreparedPiece | null {
  if (!traced) {
    if (reason === "button") return null;
    const source = fallbackBlock(color, req, DRAW_CANVAS_SIZE);
    const t = traceCanvas(source);
    return t ? { source, traced: t, adjusted: "fallback" } : null;
  }
  if (meetsRequirement(traced, req)) return { source: canvas, traced, adjusted: "none" };
  if (reason === "button") return null;
  const upscaled = upscaleDrawing(canvas, traced, req);
  const retraced = traceCanvas(upscaled);
  return retraced ? { source: upscaled, traced: retraced, adjusted: "upscaled" } : { source: canvas, traced, adjusted: "none" };
}
