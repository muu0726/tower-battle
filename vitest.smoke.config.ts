import { defineConfig } from "vitest/config";

// 開発サーバー (npm run dev) に本物の WebSocket でつなぐ通し確認。通常の npm test には含めない
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
