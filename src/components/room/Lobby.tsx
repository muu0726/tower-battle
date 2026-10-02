import { Check, Copy, Crown, LogOut, Play, Share2, UserPlus, WifiOff } from "lucide-react";
import { useState } from "react";
import { MAX_PLAYERS, MIN_PLAYERS, PLAYER_COLORS } from "../../../shared/constants";
import type { RoomSnapshot } from "../../../shared/protocol";
import { roomUrl } from "../../utils/playerName";

interface Props {
  room: RoomSnapshot;
  me: string | null;
  onStart(): void;
  onLeave(): void;
}

export function Lobby({ room, me, onStart, onLeave }: Props) {
  const [copied, setCopied] = useState(false);
  const url = roomUrl(room.code);
  const isHost = room.hostId === me;
  const ready = room.players.filter((p) => p.connected).length >= MIN_PLAYERS;
  const canShare = typeof navigator.share === "function";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("この URL をコピーして友達に送ってください", url);
    }
  };

  const share = () => {
    navigator.share({ title: "お絵描きタワーバトル", text: `合言葉「${room.code}」で対戦しよう！`, url }).catch(() => {});
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-md rounded-2xl bg-slate-900 p-5 shadow-2xl md:p-6">
        <p className="text-sm text-slate-400">合言葉</p>
        <p className="mt-0.5 break-all text-3xl font-black tracking-wide">{room.code}</p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={copy}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-slate-800 text-sm font-bold hover:bg-slate-700"
          >
            {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
            {copied ? "コピーしました" : "招待 URL をコピー"}
          </button>
          {canShare && (
            <button
              type="button"
              onClick={share}
              className="flex h-11 w-11 items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700"
              aria-label="共有"
            >
              <Share2 size={18} />
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-slate-500">この URL を LINE や Discord で送ると、友達がそのまま同じ部屋に入れます</p>

        <ul className="mt-5 flex flex-col gap-2">
          {Array.from({ length: MAX_PLAYERS }, (_, slot) => {
            const p = room.players.find((x) => x.index === slot);
            const color = PLAYER_COLORS[slot];
            return (
              <li
                key={slot}
                className={`flex h-12 items-center gap-3 rounded-xl px-3 ${p ? "bg-slate-800" : "border border-dashed border-slate-700"}`}
              >
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-black text-white"
                  style={{ backgroundColor: p ? color.hex : "transparent", border: p ? undefined : `2px dashed ${color.hex}` }}
                >
                  {color.label}
                </span>
                {p ? (
                  <>
                    <span className="min-w-0 flex-1 truncate font-bold">
                      {p.name}
                      {p.id === me && <span className="ml-1 text-xs font-normal text-slate-400">（あなた）</span>}
                    </span>
                    {room.hostId === p.id && <Crown size={16} className="text-amber-400" aria-label="ホスト" />}
                    {!p.connected && <WifiOff size={16} className="text-slate-500" aria-label="切断中" />}
                  </>
                ) : (
                  <span className="flex items-center gap-1.5 text-sm text-slate-500">
                    <UserPlus size={14} />
                    参加待ち
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-5">
          {isHost ? (
            <button
              type="button"
              onClick={onStart}
              disabled={!ready}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-sky-500 text-lg font-black text-white shadow-lg transition enabled:hover:bg-sky-400 disabled:opacity-40"
            >
              <Play size={20} />
              {ready ? "ゲーム開始" : `あと ${MIN_PLAYERS - room.players.length} 人で開始できます`}
            </button>
          ) : (
            <p className="py-3 text-center text-sm text-slate-400">ホストがゲームを開始するのを待っています…</p>
          )}
        </div>
      </div>

      <button type="button" onClick={onLeave} className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
        <LogOut size={16} />
        部屋を出る
      </button>
    </div>
  );
}
