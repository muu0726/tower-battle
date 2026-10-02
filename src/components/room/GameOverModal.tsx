import { Crown, LogOut, RotateCcw } from "lucide-react";
import { PLAYER_COLORS } from "../../../shared/constants";
import type { RoomSnapshot } from "../../../shared/protocol";

interface Props {
  room: RoomSnapshot;
  me: string | null;
  onRestart(): void;
  onLeave(): void;
}

export function GameOverModal({ room, me, onRestart, onLeave }: Props) {
  const winner = room.players.find((p) => p.id === room.winnerId);
  const ranking = (room.ranking ?? []).map((id) => room.players.find((p) => p.id === id)).filter((p) => p !== undefined);
  const isHost = room.hostId === me;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl bg-slate-900 p-6 shadow-2xl">
        {winner ? (
          <div className="flex flex-col items-center gap-1">
            <Crown size={40} className="text-amber-400" />
            <p className="text-3xl font-black" style={{ color: PLAYER_COLORS[winner.index].hex }}>
              {winner.name} の勝ち！
            </p>
            {winner.id === me && <p className="text-sm text-amber-300">おめでとう！</p>}
          </div>
        ) : (
          <p className="text-2xl font-black">引き分け</p>
        )}

        <ol className="flex w-full flex-col gap-1.5">
          {ranking.map((p, i) => (
            <li key={p.id} className="flex items-center gap-3 rounded-lg bg-slate-800 px-3 py-2">
              <span className="w-6 text-center font-black text-slate-400">{i + 1}</span>
              <span className="h-3 w-3 rounded-full" style={{ backgroundColor: PLAYER_COLORS[p.index].hex }} />
              <span className="min-w-0 flex-1 truncate font-bold">
                {p.name}
                {p.id === me && <span className="ml-1 text-xs font-normal text-slate-400">（あなた）</span>}
              </span>
            </li>
          ))}
        </ol>

        <div className="flex w-full flex-col gap-2">
          {isHost ? (
            <button
              type="button"
              onClick={onRestart}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-sky-500 font-bold text-white hover:bg-sky-400"
            >
              <RotateCcw size={18} />
              もう一度（ロビーへ）
            </button>
          ) : (
            <p className="text-center text-sm text-slate-400">ホストの「もう一度」を待っています…</p>
          )}
          <button
            type="button"
            onClick={onLeave}
            className="flex h-11 items-center justify-center gap-2 rounded-xl bg-slate-800 text-slate-200 hover:bg-slate-700"
          >
            <LogOut size={16} />
            部屋を出る
          </button>
        </div>
      </div>
    </div>
  );
}
