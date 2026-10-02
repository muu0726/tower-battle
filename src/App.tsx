import { useCallback, useEffect, useState } from "react";
import Home from "./pages/Home";
import Room from "./pages/Room";
import Sandbox from "./pages/Sandbox";

export type Navigate = (to: string) => void;

/** ルーター代わりの最小実装（pathname + history API） */
function usePath(): [string, Navigate] {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback<Navigate>((to) => {
    if (to !== window.location.pathname) window.history.pushState(null, "", to);
    setPath(to);
  }, []);
  return [path, navigate];
}

export default function App() {
  const [path, navigate] = usePath();

  if (path.startsWith("/sandbox")) return <Sandbox />;

  const room = path.match(/^\/room\/([^/]+)\/?$/);
  if (room) {
    let code = "";
    try {
      code = decodeURIComponent(room[1]);
    } catch {
      // 壊れた URL はトップへ
    }
    if (code) return <Room key={code} code={code} navigate={navigate} />;
  }
  return <Home navigate={navigate} />;
}
