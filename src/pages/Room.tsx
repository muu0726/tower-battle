import { CircleAlert, Home as HomeIcon, Loader2, LogOut, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DRAW_TIME_LIMIT_MS, PLACE_TIME_LIMIT_MS, PLAYER_COLORS } from "../../shared/constants";
import { PROTOCOL_LIMITS } from "../../shared/protocol";
import { SIZE_CLASSES } from "../../shared/sizeRule";
import type { Navigate } from "../App";
import { DrawingPad, type SubmitReason } from "../components/DrawingPad";
import { GameCanvas } from "../components/GameCanvas";
import { PlacementControls } from "../components/PlacementControls";
import { GameOverModal } from "../components/room/GameOverModal";
import { Lobby } from "../components/room/Lobby";
import { NamePrompt } from "../components/room/NamePrompt";
import { PlayerBar } from "../components/room/PlayerBar";
import { TimerBar } from "../components/TimerBar";
import { OnlineScene } from "../game/onlineScene";
import { preparePiece } from "../game/piecePrep";
import { remainingMs } from "../net/roomStore";
import { useRoom } from "../net/useRoom";
import type { TracedPiece } from "../utils/contourTracer";
import { haptic } from "../utils/haptics";
import { loadName, saveName } from "../utils/playerName";

interface Props {
  code: string;
  navigate: Navigate;
}

export default function Room({ code, navigate }: Props) {
  const [name, setName] = useState(loadName);
  if (!name) {
    return (
      <NamePrompt
        code={code}
        onSubmit={(n) => {
          saveName(n);
          setName(n);
        }}
      />
    );
  }
  return <RoomSession code={code} name={name} navigate={navigate} />;
}

/** 締切までの残り時間を 100ms ごとに更新 */
function useRemaining(deadline: number | null | undefined, offset: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [deadline]);
  return deadline == null ? null : Math.max(0, deadline - (now + offset));
}

/** PNG が大きすぎる場合は WebP に落とす（透明度は保たれる） */
function encodeImage(canvas: HTMLCanvasElement): string {
  const png = canvas.toDataURL("image/png");
  if (png.length <= PROTOCOL_LIMITS.maxImageLength) return png;
  return canvas.toDataURL("image/webp", 0.8);
}

function RoomSession({ code, name, navigate }: { code: string; name: string; navigate: Navigate }) {
  const { view, status, client } = useRoom(code, name);
  const room = view.room;
  const me = view.me;

  const [previewX, setPreviewX] = useState(400);
  const [submittedTurn, setSubmittedTurn] = useState<number | null>(null);
  const [droppedTurn, setDroppedTurn] = useState<number | null>(null);
  const [banner, setBanner] = useState<{ playerId: string; reason: "fall" | "disconnected" } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const clientRef = useRef(client);
  clientRef.current = client;

  const scene = useMemo(
    () =>
      new OnlineScene({
        onLocalPreview: (x, angle) => {
          setPreviewX(x);
          clientRef.current?.sendPreview(x, angle);
        },
      }),
    [],
  );

  useEffect(() => scene.attach(client), [scene, client]);
  useEffect(() => () => scene.dispose(), [scene]);
  useEffect(() => scene.sync(view), [scene, view]);

  // 脱落の演出・エラー表示
  useEffect(() => {
    if (!client) return;
    let timer = 0;
    const show = (playerId: string, reason: "fall" | "disconnected") => {
      setBanner({ playerId, reason });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBanner(null), 2600);
    };
    const off = client.onMessage((msg) => {
      if (msg.type === "TURN_RESULT" && msg.eliminatedPlayerId) show(msg.eliminatedPlayerId, "fall");
      if (msg.type === "PLAYER_ELIMINATED") show(msg.playerId, "disconnected");
      if ((msg.type === "TURN_RESULT" && msg.eliminatedPlayerId === me) || (msg.type === "PLAYER_ELIMINATED" && msg.playerId === me)) {
        haptic([80, 50, 160]);
      }
      if (msg.type === "TURN_START" && msg.activePlayerId === me) haptic(30);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [client, me]);

  useEffect(() => {
    if (!view.error || view.error.code === "ROOM_FULL" || view.error.code === "ROOM_IN_PROGRESS") return;
    setToast(view.error.message);
    const t = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(t);
  }, [view.error]);

  const leave = useCallback(() => {
    client?.leave();
    navigate("/");
  }, [client, navigate]);

  const handleSubmit = useCallback(
    (canvas: HTMLCanvasElement, reason: SubmitReason, traced: TracedPiece | null) => {
      if (!room || !client || !room.sizeRequirement || submittedTurn === room.turn) return;
      const me_ = room.players.find((p) => p.id === me);
      if (!me_) return;
      const prepared = preparePiece(canvas, reason, traced, room.sizeRequirement, PLAYER_COLORS[me_.index].hex);
      if (!prepared) return;
      const sent = client.send({
        type: "DRAW_SUBMIT",
        polygons: prepared.traced.polygons,
        image: encodeImage(prepared.source),
        reason,
      });
      if (sent) setSubmittedTurn(room.turn);
    },
    [room, client, me, submittedTurn],
  );

  const remaining = useRemaining(room?.deadline, view.serverOffset);
  // 自分の手番の制限時間はターン開始時点の残り時間から数える（途中で再接続しても締切は同じ）
  const turnKey = `${room?.turn}-${room?.phase}`;
  // ターンかフェーズが変わった時だけ計算し直す（毎レンダーで減っていくと DrawingPad のタイマーが再スタートしてしまう）
  const localLimit = useMemo(() => remainingMs(view, room?.deadline), [turnKey]);

  // ---- 入れなかった ----
  if (view.error && (view.error.code === "ROOM_FULL" || view.error.code === "ROOM_IN_PROGRESS")) {
    return (
      <CenterCard>
        <CircleAlert size={36} className="text-amber-400" />
        <p className="text-lg font-bold">{view.error.message}</p>
        <p className="text-sm text-slate-400">別の合言葉で部屋を作るか、試合が終わってから入り直してください。</p>
        <HomeButton onClick={() => navigate("/")} />
      </CenterCard>
    );
  }

  if (!room || !me) {
    return (
      <CenterCard>
        <Loader2 size={32} className="animate-spin text-sky-400" />
        <p className="text-slate-300">{status === "reconnecting" ? "サーバーに再接続しています…" : "部屋に接続しています…"}</p>
        <HomeButton onClick={() => navigate("/")} />
      </CenterCard>
    );
  }

  if (room.phase === "lobby") {
    return (
      <>
        <ConnectionBanner status={status} />
        <Lobby room={room} me={me} onStart={() => client?.send({ type: "START" })} onLeave={leave} />
      </>
    );
  }

  const active = room.players.find((p) => p.id === room.activePlayerId);
  const activeColor = active ? PLAYER_COLORS[active.index].hex : "#64748b";
  const myPlayer = room.players.find((p) => p.id === me);
  const myColor = myPlayer ? PLAYER_COLORS[myPlayer.index].hex : "#64748b";
  const myTurn = room.activePlayerId === me;
  const size = room.sizeRequirement ? SIZE_CLASSES[room.sizeRequirement.class] : null;

  let bannerText = "";
  if (room.phase === "drawing") bannerText = `${myTurn ? "あなた" : active?.name} の番 — ${size ? `${size.icon} ${size.label}` : ""}`;
  else if (room.phase === "placing") bannerText = myTurn ? "狙いを定めて DROP" : `${active?.name} が狙いを定めています`;
  else if (room.phase === "settling") bannerText = "静止判定中…";

  const eliminatedPlayer = banner ? room.players.find((p) => p.id === banner.playerId) : null;

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <ConnectionBanner status={status} />
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2 md:px-4">
        <button
          type="button"
          onClick={leave}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          aria-label="部屋を出る"
          title="部屋を出る"
        >
          <LogOut size={18} />
        </button>
        <PlayerBar room={room} me={me} />
        <span className="ml-auto hidden shrink-0 text-xs text-slate-500 sm:block">合言葉: {room.code}</span>
      </header>

      <main className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-[30dvh] flex-1">
          <GameCanvas scene={scene} className="absolute inset-0 h-full w-full" />

          {bannerText && (
            <div
              className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-bold text-white shadow-lg md:top-3 md:text-sm"
              style={{ backgroundColor: activeColor, boxShadow: `0 0 20px ${activeColor}88` }}
            >
              {bannerText}
            </div>
          )}

          {toast && (
            <div className="pointer-events-none absolute left-1/2 top-12 -translate-x-1/2 rounded-lg border border-red-400 bg-slate-900/90 px-3 py-2 text-xs font-bold text-red-300">
              {toast}
            </div>
          )}

          {eliminatedPlayer && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
              <div
                className="animate-[pulse_0.8s_ease-in-out_2] rounded-2xl bg-slate-950/85 px-8 py-5 text-center shadow-2xl"
                style={{ border: `3px solid ${PLAYER_COLORS[eliminatedPlayer.index].hex}` }}
              >
                <p className="text-3xl font-black md:text-4xl" style={{ color: PLAYER_COLORS[eliminatedPlayer.index].hex }}>
                  {eliminatedPlayer.id === me ? "あなた" : eliminatedPlayer.name} 脱落！
                </p>
                <p className="mt-1 text-sm text-slate-300">
                  {banner?.reason === "disconnected" ? "手番までに戻ってきませんでした" : "ピースが落ちてしまった…"}
                </p>
              </div>
            </div>
          )}

          {room.phase === "finished" && (
            <GameOverModal room={room} me={me} onRestart={() => client?.send({ type: "RESTART" })} onLeave={leave} />
          )}
        </div>

        <aside className="flex min-h-0 flex-col items-center gap-3 overflow-y-auto border-t border-slate-800 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:w-[360px] md:shrink-0 md:border-l md:border-t-0 md:p-4">
          {room.phase === "drawing" && myTurn && submittedTurn !== room.turn && room.sizeRequirement && (
            <DrawingPad
              color={myColor}
              requirement={room.sizeRequirement}
              timeLimitMs={localLimit}
              resetKey={room.turn}
              onSubmit={handleSubmit}
            />
          )}
          {room.phase === "drawing" && myTurn && submittedTurn === room.turn && <Waiting color={myColor} text="送信中…" />}

          {room.phase === "placing" && myTurn && droppedTurn !== room.turn && (
            <PlacementControls
              color={myColor}
              x={previewX}
              timeLimitMs={localLimit ?? PLACE_TIME_LIMIT_MS}
              onX={(x) => {
                scene.setPreviewX(x);
                const p = scene.previewPose;
                if (!p) return;
                setPreviewX(p.x);
                client?.sendPreview(p.x, p.angle);
              }}
              onRotate={(deg) => {
                scene.rotatePreview(deg);
                const p = scene.previewPose;
                if (p) client?.sendPreview(p.x, p.angle);
              }}
              onDrop={() => {
                const p = scene.previewPose;
                if (!p || !client) return;
                haptic(15);
                if (client.drop(p.x, p.angle)) setDroppedTurn(room.turn);
              }}
            />
          )}

          {!myTurn && (room.phase === "drawing" || room.phase === "placing") && active && (
            <Waiting
              color={activeColor}
              text={
                room.phase === "drawing"
                  ? `${active.name} が描いています${size ? `（${size.icon} ${size.label}）` : ""}`
                  : `${active.name} が置く場所を選んでいます`
              }
              remaining={remaining}
              total={room.phase === "drawing" ? (view.turnStart?.timeLimit ?? DRAW_TIME_LIMIT_MS) : PLACE_TIME_LIMIT_MS}
            />
          )}
          {room.phase === "settling" && (
            <Waiting
              color={activeColor}
              text={scene.isSimulating ? "タワーが止まるまで計算中…" : "タワーが止まるまで待機中…"}
            />
          )}
          {room.phase === "finished" && <p className="py-3 text-sm text-slate-400">試合終了</p>}
          {myPlayer?.eliminated && room.phase !== "finished" && (
            <p className="text-xs text-slate-500">あなたは脱落しました。最後まで観戦できます</p>
          )}
        </aside>
      </main>
    </div>
  );
}

function Waiting({ color, text, remaining, total }: { color: string; text: string; remaining?: number | null; total?: number }) {
  return (
    <div className="flex w-full flex-col gap-3 py-2 md:max-w-[320px] md:py-6">
      {remaining != null && total != null && <TimerBar remainingMs={remaining} totalMs={total} color={color} />}
      <div className="flex items-center justify-center gap-3 text-sm text-slate-300">
        <Loader2 size={20} className="shrink-0 animate-spin" style={{ color }} />
        <p>{text}</p>
      </div>
    </div>
  );
}

function ConnectionBanner({ status }: { status: string }) {
  if (status !== "reconnecting") return null;
  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-amber-500 py-1.5 text-xs font-bold text-slate-950">
      <WifiOff size={14} />
      接続が切れました。再接続しています…
    </div>
  );
}

function CenterCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl bg-slate-900 p-6 text-center shadow-2xl">
        {children}
      </div>
    </div>
  );
}

function HomeButton({ onClick }: { onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
      <HomeIcon size={16} />
      トップへ戻る
    </button>
  );
}
