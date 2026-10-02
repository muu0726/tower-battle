import { Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DRAW_CANVAS_SIZE,
  DRAW_TIME_LIMIT_MS,
  PIECE_SCALE,
  PLACE_TIME_LIMIT_MS,
  PLAYER_COLORS,
  WORLD,
} from "../../shared/constants";
import type { TurnStartMessage } from "../../shared/protocol";
import {
  rollSizeRequirement,
  SIZE_CLASSES,
  sizeRequirementOf,
  type SizeClass,
  type SizeRequirement,
} from "../../shared/sizeRule";
import { DrawingPad, type SubmitReason } from "../components/DrawingPad";
import { GameCanvas } from "../components/GameCanvas";
import { PlacementControls } from "../components/PlacementControls";
import { preparePiece } from "../game/piecePrep";
import { createPieceBody } from "../game/physics";
import { bakePieceSprite } from "../game/renderer";
import { SandboxScene, type SandboxEvents, type SandboxPhase } from "../game/sandboxScene";
import type { TracedPiece } from "../utils/contourTracer";
import { haptic } from "../utils/haptics";

interface Toast {
  id: number;
  text: string;
  color: string;
}

interface TraceStats {
  polygons: number;
  vertices: number;
  parts: number;
  ms: number;
}

type SizeOverride = "RANDOM" | SizeClass;

let spriteSeq = 0;
let toastSeq = 0;

function pickRequirement(override: SizeOverride): SizeRequirement {
  return override === "RANDOM" ? rollSizeRequirement() : sizeRequirementOf(override);
}

/**
 * Sandbox ではクライアントが TURN_START を自作する。
 * ステップ4ではこれを DO からのメッセージに差し替える（同じ rollSizeRequirement を DO が使う）。
 */
function makeTurnStart(turn: number, activeIndex: number, override: SizeOverride): TurnStartMessage {
  return {
    type: "TURN_START",
    turn,
    activePlayerId: PLAYER_COLORS[activeIndex].label,
    sizeRequirement: pickRequirement(override),
    timeLimit: DRAW_TIME_LIMIT_MS,
    deadline: Date.now() + DRAW_TIME_LIMIT_MS,
  };
}

export default function Sandbox() {
  const [sizeOverride, setSizeOverride] = useState<SizeOverride>("RANDOM");
  const [turnStart, setTurnStart] = useState<TurnStartMessage>(() => makeTurnStart(1, 0, "RANDOM"));
  const [eliminated, setEliminated] = useState<number[]>([]);
  const [winner, setWinner] = useState<number | null>(null);
  const [phase, setPhase] = useState<SandboxPhase>("draw");
  const [previewX, setPreviewX] = useState<number>(WORLD.width / 2);
  const [autoRotate, setAutoRotate] = useState(true);
  const [useTimer, setUseTimer] = useState(true);
  const [debug, setDebug] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stats, setStats] = useState<TraceStats | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const active = Math.max(0, PLAYER_COLORS.findIndex((p) => p.label === turnStart.activePlayerId));
  const color = PLAYER_COLORS[active].hex;
  const requirement = turnStart.sizeRequirement;
  const sizeInfo = SIZE_CLASSES[requirement.class];

  const pushToast = useCallback((text: string, color = "#e2e8f0") => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, text, color }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
  }, []);

  const beginTurn = useCallback((activeIndex: number, override: SizeOverride) => {
    setTurnStart((prev) => makeTurnStart(prev.turn + 1, activeIndex, override));
  }, []);

  // scene のコールバックから常に最新の state を見るための ref
  const live = useRef({ active, eliminated, autoRotate, sizeOverride });
  live.current = { active, eliminated, autoRotate, sizeOverride };

  const events = useRef<SandboxEvents>({
    onPhase: () => {},
    onRest: () => {},
    onFall: () => {},
    onPreviewX: () => {},
  });
  events.current = {
    onPhase: setPhase,
    onPreviewX: setPreviewX,
    onRest: ({ forced }) => {
      if (forced) pushToast("静止判定タイムアウト（強制的にターン交代）", "#fbbf24");
      const { autoRotate, eliminated, active, sizeOverride } = live.current;
      let next = active;
      if (autoRotate) {
        for (let i = 1; i <= PLAYER_COLORS.length; i++) {
          const candidate = (active + i) % PLAYER_COLORS.length;
          if (!eliminated.includes(candidate)) {
            next = candidate;
            break;
          }
        }
      }
      beginTurn(next, sizeOverride);
    },
    onFall: ({ ownerIndex, blamedIndex }) => {
      const blamed = PLAYER_COLORS[blamedIndex];
      const owner = PLAYER_COLORS[ownerIndex];
      if (!blamed) return;
      haptic([60, 40, 120]);
      pushToast(`${blamed.label} 脱落！（${owner?.label ?? "?"} のピースが落下）`, blamed.hex);
      setEliminated((prev) => {
        if (prev.includes(blamedIndex)) return prev;
        const next = [...prev, blamedIndex];
        const alive = PLAYER_COLORS.map((_, i) => i).filter((i) => !next.includes(i));
        if (alive.length === 1) setWinner(alive[0]);
        return next;
      });
    },
  };

  const scene = useMemo(
    () =>
      new SandboxScene({
        onPhase: (p) => events.current.onPhase(p),
        onRest: (i) => events.current.onRest(i),
        onFall: (i) => events.current.onFall(i),
        onPreviewX: (x) => events.current.onPreviewX(x),
      }),
    [],
  );

  useEffect(() => {
    scene.debug = debug;
  }, [scene, debug]);

  const handleSubmit = useCallback(
    (canvas: HTMLCanvasElement, reason: SubmitReason, traced: TracedPiece | null) => {
      if (scene.currentPhase !== "draw") return;
      const t0 = performance.now();
      const prepared = preparePiece(canvas, reason, traced, requirement, color);
      if (!prepared) return;
      if (prepared.adjusted === "fallback") pushToast("時間切れ：代わりのブロックを出します", color);
      if (prepared.adjusted === "upscaled") pushToast(`時間切れ：${sizeInfo.label}まで自動で拡大しました`, color);
      const { source, traced: piece } = prepared;
      const ms = performance.now() - t0;

      const spriteKey = `piece-${++spriteSeq}`;
      const body = createPieceBody(scene.physics, piece.polygons, {
        x: WORLD.width / 2,
        y: 0,
        scale: PIECE_SCALE,
        ownerIndex: active,
        color,
        spriteKey,
        canvasSize: DRAW_CANVAS_SIZE,
      });
      if (!body) {
        pushToast("形状の生成に失敗しました。もう一度描いてください", "#f87171");
        return;
      }
      scene.sprites.set(spriteKey, bakePieceSprite(source, piece.polygons, color));
      scene.spawnPreview(body);
      setStats({
        polygons: piece.polygons.length,
        vertices: piece.vertexCount,
        parts: body.parts.length,
        ms,
      });
    },
    [scene, active, color, requirement, sizeInfo, pushToast],
  );

  const resetAll = () => {
    scene.reset();
    setEliminated([]);
    setWinner(null);
    beginTurn(0, sizeOverride);
    setStats(null);
    setMenuOpen(false);
  };

  const changeSizeOverride = (o: SizeOverride) => {
    setSizeOverride(o);
    // 描いている途中でも即反映（テスト用）
    if (phase === "draw") setTurnStart((t) => ({ ...t, sizeRequirement: pickRequirement(o) }));
  };

  const selectPlayer = (i: number) => {
    setTurnStart((t) => ({ ...t, activePlayerId: PLAYER_COLORS[i].label }));
  };

  const settings = (
    <>
      <Toggle checked={autoRotate} onChange={setAutoRotate}>
        手番を自動で回す
      </Toggle>
      <Toggle checked={useTimer} onChange={setUseTimer}>
        制限時間
      </Toggle>
      <Toggle checked={debug} onChange={setDebug}>
        デバッグ表示
      </Toggle>
      <label className="flex items-center gap-1.5">
        サイズ
        <select
          value={sizeOverride}
          onChange={(e) => changeSizeOverride(e.target.value as SizeOverride)}
          className="rounded-md bg-slate-800 px-2 py-1 text-slate-100"
        >
          <option value="RANDOM">ランダム</option>
          {(Object.keys(SIZE_CLASSES) as SizeClass[]).map((c) => (
            <option key={c} value={c}>
              {SIZE_CLASSES[c].icon} {SIZE_CLASSES[c].label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={resetAll} className="rounded-lg bg-slate-800 px-3 py-1.5 hover:bg-slate-700">
        リセット
      </button>
    </>
  );

  const banner =
    phase === "draw"
      ? `${sizeInfo.icon} ${sizeInfo.label}を描こう`
      : phase === "place"
        ? "狙いを定めて DROP"
        : "静止判定中…";

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="relative flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2 md:gap-3 md:px-4 md:py-3">
        <a href="/" className="whitespace-nowrap text-sm text-slate-400 hover:text-slate-200" aria-label="トップへ戻る">
          ←<span className="hidden md:inline"> トップ</span>
        </a>
        <h1 className="hidden text-lg font-bold sm:block">Sandbox</h1>
        <div className="flex gap-1 md:gap-1.5">
          {PLAYER_COLORS.map((p, i) => {
            const out = eliminated.includes(i);
            return (
              <button
                key={p.label}
                type="button"
                disabled={phase !== "draw"}
                onClick={() => selectPlayer(i)}
                className={`rounded-full px-2.5 py-1 text-xs font-bold transition md:px-3 md:text-sm ${out ? "line-through opacity-40" : ""} ${
                  active === i ? "text-white ring-2 ring-white/80" : "text-white/80 opacity-60 hover:opacity-100"
                }`}
                style={{ backgroundColor: p.hex }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto hidden items-center gap-4 whitespace-nowrap text-sm text-slate-300 lg:flex">{settings}</div>
        <button
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800 text-lg lg:hidden"
          aria-label="設定"
          aria-expanded={menuOpen}
        >
          <Settings size={18} />
        </button>
        {menuOpen && (
          <div className="absolute right-2 top-full z-30 mt-1 flex w-56 flex-col items-start gap-3 rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-200 shadow-2xl lg:hidden">
            {settings}
          </div>
        )}
      </header>

      <main className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-[30dvh] flex-1">
          <GameCanvas scene={scene} className="absolute inset-0 h-full w-full" />

          <div
            className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-bold text-white shadow-lg md:top-3 md:text-sm"
            style={{ backgroundColor: color, boxShadow: `0 0 20px ${color}88` }}
          >
            {PLAYER_COLORS[active].label} の番 — {banner}
          </div>

          <div className="pointer-events-none absolute left-2 right-2 top-11 flex flex-col items-center gap-2 md:left-auto md:right-3 md:top-14 md:items-end">
            {toasts.map((t) => (
              <div
                key={t.id}
                className="rounded-lg bg-slate-900/90 px-3 py-2 text-xs font-bold shadow-lg md:text-sm"
                style={{ color: t.color, border: `1px solid ${t.color}` }}
              >
                {t.text}
              </div>
            ))}
          </div>

          {winner != null && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70">
              <div className="flex flex-col items-center gap-4 rounded-2xl bg-slate-900 p-8 shadow-2xl">
                <p className="text-3xl font-black" style={{ color: PLAYER_COLORS[winner].hex }}>
                  {PLAYER_COLORS[winner].label} の勝ち！
                </p>
                <button type="button" onClick={resetAll} className="rounded-lg bg-slate-100 px-5 py-2 font-bold text-slate-900">
                  もう一度
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="flex min-h-0 flex-col items-center gap-3 overflow-y-auto border-t border-slate-800 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:w-[360px] md:shrink-0 md:border-l md:border-t-0 md:p-4">
          {phase === "draw" && (
            <DrawingPad
              color={color}
              requirement={requirement}
              timeLimitMs={useTimer && winner == null ? turnStart.timeLimit : null}
              resetKey={`${turnStart.turn}-${active}`}
              onSubmit={handleSubmit}
            />
          )}
          {phase === "place" && (
            <PlacementControls
              color={color}
              x={previewX}
              timeLimitMs={useTimer ? PLACE_TIME_LIMIT_MS : null}
              onX={(x) => {
                scene.setPreviewX(x);
                setPreviewX(Math.max(WORLD.minX, Math.min(WORLD.maxX, x)));
              }}
              onRotate={(deg) => scene.rotatePreview(deg)}
              onDrop={() => {
                haptic(15);
                scene.drop();
              }}
            />
          )}
          {phase === "settling" && (
            <div className="flex w-full items-center justify-center gap-3 py-3 text-sm text-slate-300 md:flex-col md:py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-4 border-slate-600 md:h-8 md:w-8" style={{ borderTopColor: color }} />
              <p>タワーが完全に止まるまで待機中…</p>
            </div>
          )}

          {stats && (
            <dl
              className={`${debug ? "grid" : "hidden md:grid"} w-full grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-slate-900 p-3 text-xs text-slate-400 md:max-w-[320px]`}
            >
              <dt>ポリゴン数</dt>
              <dd className="text-right tabular-nums text-slate-200">{stats.polygons}</dd>
              <dt>頂点数</dt>
              <dd className="text-right tabular-nums text-slate-200">{stats.vertices}</dd>
              <dt>凸分解パーツ数</dt>
              <dd className="text-right tabular-nums text-slate-200">{stats.parts}</dd>
              <dt>ピース生成時間</dt>
              <dd className="text-right tabular-nums text-slate-200">{stats.ms.toFixed(1)} ms</dd>
            </dl>
          )}
        </aside>
      </main>
    </div>
  );
}

function Toggle({ checked, onChange, children }: { checked: boolean; onChange(v: boolean): void; children: ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}
