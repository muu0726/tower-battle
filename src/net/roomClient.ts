// 合言葉ルームへの WebSocket 接続（自動再接続・送信間引き付き）
import type { ClientMessage, ErrorCode, Pose, ServerMessage } from "../../shared/protocol";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface RoomClientOptions {
  code: string;
  name: string;
  /** 例: "http://localhost:5173"。省略時は現在のページのオリジン */
  baseUrl?: string;
  /** playerId の保存先。省略時は sessionStorage（タブごとに別プレイヤー） */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/** これを受けたら再接続しても無駄なエラー */
const FATAL_ERRORS: ErrorCode[] = ["ROOM_FULL", "ROOM_IN_PROGRESS"];
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5000;
const HEARTBEAT_MS = 20_000;
const PREVIEW_INTERVAL_MS = 33; // ~30Hz
const STREAM_INTERVAL_MS = 50; // ~20Hz

type Listener<T> = (value: T) => void;

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function defaultStorage() {
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    // プライベートモード等で使えない場合
  }
  return memoryStorage();
}

/** 最後の値を必ず送る間引き送信 */
class Throttle<T> {
  private last = 0;
  private pending: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly interval: number,
    private readonly flush: (v: T) => void,
  ) {}

  push(v: T) {
    const now = Date.now();
    if (now - this.last >= this.interval && !this.timer) {
      this.last = now;
      this.flush(v);
      return;
    }
    this.pending = v;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.last = Date.now();
      if (this.pending !== null) this.flush(this.pending);
      this.pending = null;
    }, this.interval - (now - this.last));
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

export class RoomClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "closed";
  private attempts = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly messageListeners = new Set<Listener<ServerMessage>>();
  private readonly statusListeners = new Set<Listener<ConnectionStatus>>();
  private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  private readonly previewThrottle = new Throttle<{ x: number; angle: number }>(PREVIEW_INTERVAL_MS, (v) =>
    this.send({ type: "PREVIEW", ...v }),
  );
  private readonly streamThrottle = new Throttle<Pose[]>(STREAM_INTERVAL_MS, (frame) =>
    this.send({ type: "STATE_STREAM", frame }),
  );

  constructor(private readonly opts: RoomClientOptions) {
    this.storage = opts.storage ?? defaultStorage();
  }

  get playerId(): string | null {
    return this.storage.getItem(this.storageKey);
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  private get storageKey() {
    return `tb:player:${this.opts.code}`;
  }

  private get url() {
    const base = this.opts.baseUrl ?? location.origin;
    const u = new URL(`/api/rooms/${encodeURIComponent(this.opts.code)}/ws`, base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  /** 明示的に退室する（再接続しない） */
  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, "bye");
    this.ws = null;
    this.setStatus("closed");
  }

  /** 自分の意思で部屋を出る。保存した playerId も消すので、次に入る時は新しいプレイヤーになる */
  leave(): void {
    this.storage.removeItem(this.storageKey);
    this.close();
  }

  /** 回線断を再現する（自動再接続の確認用） */
  simulateNetworkDrop(): void {
    this.ws?.close(4000, "simulated drop");
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** 配置プレビュー（~30Hz に間引き、最後の位置は必ず届く） */
  sendPreview(x: number, angle: number): void {
    this.previewThrottle.push({ x, angle });
  }

  /** 物理担当の姿勢フレーム（~20Hz に間引き） */
  sendStream(frame: Pose[]): void {
    this.streamThrottle.push(frame);
  }

  /** DROP の前に溜まっているプレビューを捨てる（DROP 後に古いプレビューが届かないように） */
  drop(x: number, angle: number): boolean {
    this.previewThrottle.cancel();
    return this.send({ type: "DROP", x, angle });
  }

  /** SETTLED の前に溜まっているフレームを捨てる */
  settle(snapshot: Pose[], fallen: string[]): boolean {
    this.streamThrottle.cancel();
    return this.send({ type: "SETTLED", snapshot, fallen });
  }

  onMessage(fn: Listener<ServerMessage>): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onStatus(fn: Listener<ConnectionStatus>): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  // ---------------------------------------------------------------------------

  private open() {
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      const playerId = this.playerId;
      ws.send(JSON.stringify({ type: "JOIN", name: this.opts.name, ...(playerId ? { playerId } : {}) } satisfies ClientMessage));
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, HEARTBEAT_MS);
    });

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "WELCOME") {
        this.attempts = 0;
        this.storage.setItem(this.storageKey, msg.playerId);
        this.setStatus("open");
      }
      if (msg.type === "ERROR" && FATAL_ERRORS.includes(msg.code)) {
        // 満員・対戦中で入れなかった。保存済み ID も無効なので消して、再接続せずに閉じる
        this.storage.removeItem(this.storageKey);
        this.stopped = true;
        for (const fn of this.messageListeners) fn(msg);
        ws.close(1000, msg.code);
        // 閉じ終わるのを待たずに終了扱いにする（回線が遅いとクローズ完了まで時間がかかる）
        this.clearTimers();
        this.setStatus("closed");
        return;
      }
      for (const fn of this.messageListeners) fn(msg);
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.clearTimers();
      this.ws = null;
      if (this.stopped) {
        this.setStatus("closed");
        return;
      }
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempts);
      this.attempts++;
      this.setStatus("reconnecting");
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    });
  }

  private clearTimers() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.previewThrottle.cancel();
    this.streamThrottle.cancel();
  }

  private setStatus(s: ConnectionStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }
}
