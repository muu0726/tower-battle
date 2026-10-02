import { Dices, LogIn, PencilRuler } from "lucide-react";
import { useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH, PLAYER_COLORS } from "../../shared/constants";
import type { Navigate } from "../App";
import { cleanName, loadName, randomRoomCode, saveName } from "../utils/playerName";

/** サーバーと同じ正規化（全角/半角・大文字小文字の揺れを吸収） */
function normalizeCode(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase().slice(0, 32);
}

export default function Home({ navigate }: { navigate: Navigate }) {
  const [name, setName] = useState(loadName);
  const [code, setCode] = useState("");

  const ready = cleanName(name).length > 0 && normalizeCode(code).length > 0;

  const join = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    saveName(cleanName(name));
    navigate(`/room/${encodeURIComponent(normalizeCode(code))}`);
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-4xl font-black tracking-tight md:text-5xl">
          {"お絵描きタワーバトル".split("").map((ch, i) => (
            <span key={i} style={{ color: PLAYER_COLORS[i % PLAYER_COLORS.length].hex }}>
              {ch}
            </span>
          ))}
        </h1>
        <p className="mt-3 text-slate-400">描いた絵がそのまま積み木になる。落とした人から脱落、最後の 1 人が勝ち。</p>
      </div>

      <form onSubmit={join} className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-slate-900 p-6 shadow-2xl">
        <label className="flex flex-col gap-1.5 text-sm text-slate-300">
          あなたの名前
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH * 2}
            placeholder="例: たろう"
            autoComplete="nickname"
            className="h-12 rounded-lg bg-slate-800 px-3 text-base text-slate-100 outline-none ring-sky-400 focus:ring-2"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-slate-300">
          合言葉（同じ合言葉の人と同じ部屋に入ります）
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={32}
              placeholder="例: ねこぞう42"
              autoCapitalize="off"
              className="h-12 min-w-0 flex-1 rounded-lg bg-slate-800 px-3 text-base text-slate-100 outline-none ring-sky-400 focus:ring-2"
            />
            <button
              type="button"
              onClick={() => setCode(randomRoomCode())}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700"
              aria-label="合言葉をランダムに作る"
              title="合言葉をランダムに作る"
            >
              <Dices size={20} />
            </button>
          </div>
        </label>
        <button
          type="submit"
          disabled={!ready}
          className="flex h-12 items-center justify-center gap-2 rounded-xl bg-sky-500 font-bold text-white shadow-lg transition enabled:hover:bg-sky-400 disabled:opacity-40"
        >
          <LogIn size={18} />
          部屋に入る
        </button>
      </form>

      <a href="/sandbox" className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
        <PencilRuler size={16} />
        ひとりで練習（Sandbox）
      </a>
    </div>
  );
}
