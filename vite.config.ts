import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Cloudflare Tunnel (cloudflared) の一時 URL からのアクセスを許可する。
// Vite は DNS リバインディング対策で、知らないホスト名からのリクエストを既定で拒否するため。
const allowedHosts = [".trycloudflare.com"];

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  server: { allowedHosts },
  preview: { allowedHosts },
});
