import { Crown, WifiOff } from "lucide-react";
import { PLAYER_COLORS } from "../../../shared/constants";
import type { RoomSnapshot } from "../../../shared/protocol";

interface Props {
  room: RoomSnapshot;
  me: string | null;
}

/** プレイヤー帯: 色・名前・ホスト・手番・脱落・切断 */
export function PlayerBar({ room, me }: Props) {
  return (
    <div className="flex min-w-0 gap-1 overflow-x-auto md:gap-1.5">
      {room.players.map((p) => {
        const color = PLAYER_COLORS[p.index].hex;
        const active = room.activePlayerId === p.id;
        return (
          <div
            key={p.id}
            className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold text-white transition md:text-sm ${
              p.eliminated ? "opacity-35" : ""
            } ${active ? "ring-2 ring-white" : ""}`}
            style={{ backgroundColor: color, boxShadow: active ? `0 0 14px ${color}` : undefined }}
            title={`${PLAYER_COLORS[p.index].label} ${p.name}${p.id === me ? "（あなた）" : ""}`}
          >
            {room.hostId === p.id && <Crown size={12} aria-label="ホスト" />}
            <span className={`max-w-[6.5em] truncate ${p.eliminated ? "line-through" : ""}`}>
              {p.name}
              {p.id === me && <span className="font-normal opacity-80">（自分）</span>}
            </span>
            {!p.connected && <WifiOff size={12} aria-label="切断中" />}
          </div>
        );
      })}
    </div>
  );
}
