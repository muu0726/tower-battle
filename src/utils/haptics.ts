/** 対応端末（主に Android）だけ振動させる。iOS Safari では何もしない */
export function haptic(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 権限やポリシーで拒否されても無視
  }
}
