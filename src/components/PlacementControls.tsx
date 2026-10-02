import { ChevronLeft, ChevronRight, RotateCcw, RotateCw } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { ROTATE_STEP_DEG, WORLD } from "../../shared/constants";
import { TimerBar } from "./TimerBar";
import { useCountdown } from "./useCountdown";

interface Props {
  color: string;
  x: number;
  timeLimitMs: number | null;
  onX(x: number): void;
  onRotate(deg: number): void;
  onDrop(): void;
}

const MOVE_STEP = 12;
/** 押しっぱなし移動: 1 tick あたりの移動量と間隔 */
const HOLD_STEP = 6;
const HOLD_INTERVAL_MS = 30;
const HOLD_DELAY_MS = 250;

/** 配置フェーズの操作。マウント中だけキーボード操作 (←→/AD 移動, Q/E 回転, Space/Enter/↓ DROP) が有効 */
export function PlacementControls({ color, x, timeLimitMs, onX, onRotate, onDrop }: Props) {
  const remaining = useCountdown(timeLimitMs, null, onDrop);
  const latest = useRef({ x, onX, onRotate, onDrop });
  latest.current = { x, onX, onRotate, onDrop };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { x, onX, onRotate, onDrop } = latest.current;
      const step = e.shiftKey ? MOVE_STEP * 3 : MOVE_STEP;
      switch (e.key) {
        case "ArrowLeft":
        case "a":
          onX(x - step);
          break;
        case "ArrowRight":
        case "d":
          onX(x + step);
          break;
        case "q":
          onRotate(-ROTATE_STEP_DEG);
          break;
        case "e":
          onRotate(ROTATE_STEP_DEG);
          break;
        case " ":
        case "Enter":
        case "ArrowDown":
          if (!e.repeat) onDrop();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** タップで 1 段、押しっぱなしで連続移動 */
  const move = (dir: -1 | 1) => {
    latest.current.onX(latest.current.x + dir * MOVE_STEP * 2);
    let interval = 0;
    const delay = window.setTimeout(() => {
      interval = window.setInterval(() => latest.current.onX(latest.current.x + dir * HOLD_STEP), HOLD_INTERVAL_MS);
    }, HOLD_DELAY_MS);
    return () => {
      window.clearTimeout(delay);
      window.clearInterval(interval);
    };
  };

  return (
    <div className="flex w-full flex-col gap-2 md:max-w-[320px] md:gap-3">
      {remaining != null && timeLimitMs != null && (
        <TimerBar remainingMs={remaining} totalMs={timeLimitMs} color={color} />
      )}
      <p className="hidden text-sm text-slate-400 md:block">盤面をドラッグ / スライダー / ←→ で移動、Q・E で回転</p>
      <p className="text-center text-xs text-slate-400 md:hidden">盤面を左右にドラッグして狙いを調整</p>
      <input
        type="range"
        min={WORLD.minX}
        max={WORLD.maxX}
        value={x}
        onChange={(e) => onX(Number(e.target.value))}
        className="hidden md:block"
        style={{ accentColor: color }}
      />

      {/* スマホ: [◀][⟲][DROP][⟳][▶] の 1 行 / md 以上: 4 ボタン + 大きな DROP */}
      <div className="flex items-stretch gap-2">
        <HoldButton label="左へ" onHold={() => move(-1)}>
          <ChevronLeft size={26} />
        </HoldButton>
        <ControlButton label="左回転" onClick={() => onRotate(-ROTATE_STEP_DEG)}>
          <RotateCcw size={22} />
        </ControlButton>
        <DropButton color={color} onDrop={onDrop} className="flex-1 md:hidden" />
        <div className="hidden flex-1 md:block" />
        <ControlButton label="右回転" onClick={() => onRotate(ROTATE_STEP_DEG)}>
          <RotateCw size={22} />
        </ControlButton>
        <HoldButton label="右へ" onHold={() => move(1)}>
          <ChevronRight size={26} />
        </HoldButton>
      </div>
      <DropButton color={color} onDrop={onDrop} className="hidden md:block" />
    </div>
  );
}

const BTN =
  "flex h-14 w-12 shrink-0 select-none items-center justify-center rounded-xl bg-slate-800 text-xl text-slate-100 hover:bg-slate-700 active:scale-95 active:bg-slate-600 md:h-11";

function ControlButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} className={BTN} onClick={onClick}>
      {children}
    </button>
  );
}

/** pointerdown で開始し、up / cancel / leave で止める（onHold は停止関数を返す） */
function HoldButton({ label, onHold, children }: { label: string; onHold(): () => void; children: ReactNode }) {
  const stopRef = useRef<(() => void) | null>(null);
  const stop = () => {
    stopRef.current?.();
    stopRef.current = null;
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      aria-label={label}
      className={BTN}
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        stop();
        stopRef.current = onHold();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}

function DropButton({ color, onDrop, className }: { color: string; onDrop(): void; className: string }) {
  return (
    <button
      type="button"
      onClick={onDrop}
      className={`h-14 rounded-xl text-xl font-black tracking-widest text-white shadow-lg hover:brightness-110 active:scale-[0.98] ${className}`}
      style={{ backgroundColor: color, boxShadow: `0 0 24px ${color}88` }}
    >
      DROP
    </button>
  );
}
