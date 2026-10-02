import type { Env } from "./env";

export { GameRoom } from "./GameRoom";

const ROOM_WS_PATH = /^\/api\/rooms\/([^/]+)\/ws$/;

/** 合言葉を正規化（全角/半角・大文字小文字の揺れを吸収） */
function normalizeRoomCode(raw: string): string | null {
  let code: string;
  try {
    code = decodeURIComponent(raw);
  } catch {
    return null;
  }
  code = code.normalize("NFKC").trim().toLowerCase();
  if (code.length === 0 || code.length > 32) return null;
  return code;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, time: Date.now() });
    }

    const match = url.pathname.match(ROOM_WS_PATH);
    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const code = normalizeRoomCode(match[1]);
      if (!code) return new Response("Invalid room code", { status: 400 });

      // 同じ合言葉 → 同じ DO インスタンス。DO は自分の名前を知らないのでヘッダーで渡す
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const headers = new Headers(request.headers);
      headers.set("X-Room-Code", code);
      return stub.fetch(new Request(request, { headers }));
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
