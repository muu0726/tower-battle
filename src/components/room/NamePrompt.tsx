import { LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH } from "../../../shared/constants";
import { cleanName } from "../../utils/playerName";

/** 招待 URL から直接来た人に名前だけ聞く */
export function NamePrompt({ code, onSubmit }: { code: string; onSubmit(name: string): void }) {
  const [name, setName] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = cleanName(name);
    if (n) onSubmit(n);
  };
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-2xl bg-slate-900 p-6 shadow-2xl">
        <p className="text-sm text-slate-400">合言葉「{code}」の部屋に招待されています</p>
        <label className="flex flex-col gap-1.5 text-sm text-slate-300">
          あなたの名前
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH * 2}
            placeholder="例: たろう"
            autoComplete="nickname"
            className="h-12 rounded-lg bg-slate-800 px-3 text-base text-slate-100 outline-none ring-sky-400 focus:ring-2"
          />
        </label>
        <button
          type="submit"
          disabled={!cleanName(name)}
          className="flex h-12 items-center justify-center gap-2 rounded-xl bg-sky-500 font-bold text-white enabled:hover:bg-sky-400 disabled:opacity-40"
        >
          <LogIn size={18} />
          入室する
        </button>
      </form>
    </div>
  );
}
