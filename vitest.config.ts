import { defineConfig } from "vitest/config";

// テストは Cloudflare プラグイン抜きの素の Node 環境で回す（contourTracer は DOM 非依存）
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "shared/**/*.test.ts", "worker/**/*.test.ts"],
  },
});
