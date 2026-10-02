import { useEffect, useReducer, useState } from "react";
import type { ServerMessage } from "../../shared/protocol";
import { RoomClient, type ConnectionStatus } from "./roomClient";
import { initialRoomView, reduceRoom } from "./roomStore";

/** 合言葉ルームに接続し、部屋の状態を React で購読する。code が null の間は接続しない */
export function useRoom(code: string | null, name: string) {
  const [view, dispatch] = useReducer((v: typeof initialRoomView, msg: ServerMessage) => reduceRoom(v, msg), initialRoomView);
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [client, setClient] = useState<RoomClient | null>(null);

  useEffect(() => {
    if (!code) return;
    const c = new RoomClient({ code, name });
    const offMsg = c.onMessage(dispatch);
    const offStatus = c.onStatus(setStatus);
    c.connect();
    setClient(c);
    return () => {
      offMsg();
      offStatus();
      c.close();
      setClient(null);
    };
    // 名前の変更では再接続しない（入室時の名前だけ使う）
  }, [code]);

  return { view, status, client };
}
