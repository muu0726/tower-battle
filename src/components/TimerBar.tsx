interface Props {
  remainingMs: number;
  totalMs: number;
  color: string;
}

export function TimerBar({ remainingMs, totalMs, color }: Props) {
  const ratio = Math.max(0, Math.min(1, remainingMs / totalMs));
  const urgent = remainingMs < 3000;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-700">
        <div
          className={`h-full rounded-full transition-[width] duration-100 ${urgent ? "animate-pulse" : ""}`}
          style={{ width: `${ratio * 100}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-10 text-right font-mono text-sm tabular-nums" style={{ color }}>
        {(remainingMs / 1000).toFixed(1)}
      </span>
    </div>
  );
}
