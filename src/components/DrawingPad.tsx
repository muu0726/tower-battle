import { Eraser } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { DRAW_CANVAS_SIZE, PIECE_MAX_VERTICES } from "../../shared/constants";
import { evaluateSize, SIZE_CLASSES, type SizeEvaluation, type SizeRequirement } from "../../shared/sizeRule";
import { tracePiece, type TracedPiece } from "../utils/contourTracer";
import { TimerBar } from "./TimerBar";
import { useCountdown } from "./useCountdown";

export type SubmitReason = "button" | "timeout";

interface Props {
  /** プレイヤーのテーマカラー（メインのペン色） */
  color: string;
  /** このターンのサイズ規定 */
  requirement: SizeRequirement;
  /** null ならタイマーなし */
  timeLimitMs: number | null;
  /** 変わるとキャンバスをクリアしてタイマーを再開 */
  resetKey: unknown;
  /** traced は送信時点の輪郭抽出結果（何も描かれていなければ null） */
  onSubmit(canvas: HTMLCanvasElement, reason: SubmitReason, traced: TracedPiece | null): void;
}

type Tool = "theme" | "white" | "black" | "eraser";

const TOOLS: Tool[] = ["theme", "white", "black", "eraser"];
const TOOL_LABEL: Record<Tool, string> = { theme: "テーマ色", white: "白", black: "黒", eraser: "消しゴム" };
const OK_COLOR = "#22c55e";
const NG_COLOR = "#ef4444";
const TRACE_OPTIONS = { maxVertices: PIECE_MAX_VERTICES };

interface Measure {
  traced: TracedPiece | null;
  evaluation: SizeEvaluation | null;
}

const EMPTY: Measure = { traced: null, evaluation: null };

function ctxOf(canvas: HTMLCanvasElement) {
  return canvas.getContext("2d", { willReadFrequently: true })!;
}

export function DrawingPad({ color, requirement, timeLimitMs, resetKey, onSubmit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<Tool>("theme");
  const [lineWidth, setLineWidth] = useState(12);
  const [measure, setMeasure] = useState<Measure>(EMPTY);

  /** 物理ボディ生成と同じ tracePiece で計測するので、判定と実際のピースが必ず一致する */
  const measureNow = useCallback((): Measure => {
    const canvas = canvasRef.current;
    if (!canvas) return EMPTY;
    const traced = tracePiece(ctxOf(canvas).getImageData(0, 0, canvas.width, canvas.height), TRACE_OPTIONS);
    if (!traced) return EMPTY;
    const { minX, minY, maxX, maxY } = traced.bounds;
    return { traced, evaluation: evaluateSize({ width: maxX - minX, height: maxY - minY, area: traced.area }, requirement) };
  }, [requirement]);

  const remeasure = useCallback(() => setMeasure(measureNow()), [measureNow]);

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) ctxOf(canvas).clearRect(0, 0, canvas.width, canvas.height);
    setMeasure(EMPTY);
  }, []);

  useEffect(() => {
    clear();
    setTool("theme");
  }, [resetKey, clear]);

  // 規定が変わったら（Sandbox のサイズ固定切替など）描いた絵を再評価
  useEffect(() => {
    remeasure();
  }, [remeasure]);

  const remaining = useCountdown(timeLimitMs, resetKey, () => {
    // 時間切れは規定未達でも止めずに送る（呼び出し側で自動拡大する）
    const canvas = canvasRef.current;
    if (canvas) onSubmit(canvas, "timeout", measureNow().traced);
  });

  const submit = () => {
    const canvas = canvasRef.current;
    if (canvas && measure.evaluation?.ok) onSubmit(canvas, "button", measure.traced);
  };

  const toCanvas = (clientX: number, clientY: number, rect: DOMRect) => ({
    x: ((clientX - rect.left) * DRAW_CANVAS_SIZE) / rect.width,
    y: ((clientY - rect.top) * DRAW_CANVAS_SIZE) / rect.height,
  });

  const strokeTo = (to: { x: number; y: number }) => {
    const canvas = canvasRef.current;
    const from = lastRef.current;
    if (!canvas || !from) return;
    const ctx = ctxOf(canvas);
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = tool === "theme" ? color : tool === "white" ? "#ffffff" : "#111111";
    ctx.lineWidth = tool === "eraser" ? lineWidth * 1.8 : lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    // 始点と同じ座標でも点が打たれるようにわずかにずらす
    ctx.lineTo(to.x + (to.x === from.x && to.y === from.y ? 0.01 : 0), to.y);
    ctx.stroke();
    lastRef.current = to;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toCanvas(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    lastRef.current = p;
    strokeTo(p);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!lastRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // 一部ブラウザでは空配列が返るので、その場合はイベント自身を使う
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const events = coalesced.length > 0 ? coalesced : [e.nativeEvent];
    for (const ev of events) strokeTo(toCanvas(ev.clientX, ev.clientY, rect));
  };

  const onPointerUp = () => {
    if (!lastRef.current) return;
    lastRef.current = null;
    remeasure();
  };

  const info = SIZE_CLASSES[requirement.class];
  const ev = measure.evaluation;
  const ok = !!ev?.ok;
  const guideColor = ok ? OK_COLOR : NG_COLOR;
  const guide = requirement.minWidth;
  const b = measure.traced?.bounds;

  let hint = `点線の枠より大きく描こう（長い辺 ${requirement.minWidth}px 以上）`;
  if (ok) hint = "OK！ このサイズで出せます";
  else if (ev && !ev.sideOk) hint = "もっと大きく描いてください！";
  else if (ev && !ev.areaOk) hint = "細すぎます！ 太く・塗りつぶして面積を増やそう";

  const swatch = (t: Tool) => (t === "theme" ? color : t === "white" ? "#ffffff" : "#111111");

  return (
    <div className="flex w-full flex-col gap-2 md:max-w-[320px] md:gap-3">
      {remaining != null && timeLimitMs != null && (
        <TimerBar remainingMs={remaining} totalMs={timeLimitMs} color={color} />
      )}

      {/* サイズ規定インジケーター */}
      <div className="flex items-center gap-2 rounded-lg bg-slate-900 px-2.5 py-1.5">
        <span className="text-2xl leading-none" aria-hidden>
          {info.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold leading-tight">
            {info.label}
            <span className="ml-1.5 text-xs font-normal text-slate-400">長い辺 {requirement.minWidth}px 以上</span>
          </p>
          <div className="mt-1 flex gap-2 text-[10px] text-slate-400">
            <Meter label="長辺" ratio={ev?.sideRatio ?? 0} text={`${Math.round(ev?.longSide ?? 0)}/${requirement.minWidth}`} />
            <Meter label="面積" ratio={ev?.areaRatio ?? 0} text={`${Math.min(999, Math.round((ev?.areaRatio ?? 0) * 100))}%`} />
          </div>
        </div>
      </div>

      <div className="relative mx-auto aspect-square w-[min(100%,36dvh)] md:w-full">
        <canvas
          ref={canvasRef}
          width={DRAW_CANVAS_SIZE}
          height={DRAW_CANVAS_SIZE}
          className="h-full w-full cursor-crosshair rounded-xl border-2"
          style={{
            borderColor: color,
            touchAction: "none",
            // 白ペン・黒ペンどちらも見えるよう市松模様の背景（キャンバス自体は透明）
            backgroundColor: "#64748b",
            backgroundImage:
              "linear-gradient(45deg,#475569 25%,transparent 25%,transparent 75%,#475569 75%),linear-gradient(45deg,#475569 25%,transparent 25%,transparent 75%,#475569 75%)",
            backgroundSize: "24px 24px",
            backgroundPosition: "0 0, 12px 12px",
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {/* ガイド枠（キャンバスのアルファには描かないので輪郭抽出に影響しない） */}
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${DRAW_CANVAS_SIZE} ${DRAW_CANVAS_SIZE}`}
          aria-hidden
        >
          <rect
            x={(DRAW_CANVAS_SIZE - guide) / 2}
            y={(DRAW_CANVAS_SIZE - guide) / 2}
            width={guide}
            height={guide}
            rx={6}
            fill="none"
            stroke={guideColor}
            strokeOpacity={ok ? 0.9 : 0.7}
            strokeWidth={2}
            strokeDasharray={ok ? undefined : "8 6"}
          />
          {b && (
            <rect
              x={b.minX}
              y={b.minY}
              width={b.maxX - b.minX}
              height={b.maxY - b.minY}
              fill="none"
              stroke={guideColor}
              strokeOpacity={0.5}
              strokeWidth={1}
            />
          )}
        </svg>
      </div>

      <p className="text-center text-xs font-bold" style={{ color: ok ? OK_COLOR : ev ? NG_COLOR : "#94a3b8" }}>
        {hint}
      </p>

      <div className="flex items-center gap-1.5">
        {TOOLS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTool(t)}
            aria-label={TOOL_LABEL[t]}
            title={TOOL_LABEL[t]}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
              tool === t ? "bg-slate-100" : "bg-slate-800 hover:bg-slate-700"
            }`}
          >
            {t === "eraser" ? (
              <Eraser size={20} className={tool === t ? "text-slate-900" : "text-slate-200"} />
            ) : (
              <span className="h-5 w-5 rounded-full border border-slate-400" style={{ backgroundColor: swatch(t) }} />
            )}
          </button>
        ))}
        <input
          type="range"
          min={4}
          max={32}
          value={lineWidth}
          onChange={(e) => setLineWidth(Number(e.target.value))}
          aria-label="太さ"
          className="min-w-0 flex-1"
          style={{ accentColor: color }}
        />
        <span className="w-6 text-right text-xs tabular-nums text-slate-400">{lineWidth}</span>
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={clear} className="h-11 rounded-lg bg-slate-800 px-4 text-slate-200 hover:bg-slate-700">
          クリア
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!ok}
          className="h-11 flex-1 rounded-lg px-4 font-bold text-white shadow-lg transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ backgroundColor: color }}
        >
          完成！
        </button>
      </div>
    </div>
  );
}

function Meter({ label, ratio, text }: { label: string; ratio: number; text: string }) {
  const done = ratio >= 1;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <span className="shrink-0">{label}</span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-700">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(1, ratio) * 100}%`, backgroundColor: done ? OK_COLOR : NG_COLOR }}
        />
      </div>
      <span className={`shrink-0 tabular-nums ${done ? "text-green-400" : ""}`}>{text}</span>
    </div>
  );
}
