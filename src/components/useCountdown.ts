import { useEffect, useRef, useState } from "react";

/**
 * limitMs から 0 までカウントダウンし、0 になったら onExpire を 1 回呼ぶ。
 * limitMs が null なら無効。resetKey が変わると最初からやり直す。
 */
export function useCountdown(limitMs: number | null, resetKey: unknown, onExpire: () => void): number | null {
  const [remaining, setRemaining] = useState<number | null>(limitMs);
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    if (limitMs == null) {
      setRemaining(null);
      return;
    }
    const start = performance.now();
    setRemaining(limitMs);
    const id = window.setInterval(() => {
      const left = Math.max(0, limitMs - (performance.now() - start));
      setRemaining(left);
      if (left === 0) {
        window.clearInterval(id);
        expireRef.current();
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [limitMs, resetKey]);

  return remaining;
}
