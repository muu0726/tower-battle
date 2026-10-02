import { defineConfig } from "drizzle-kit";

// マイグレーション SQL を生成するだけなので driver 指定は不要。
// 適用は wrangler 側で行う: npm run db:migrate:local / db:migrate:remote
export default defineConfig({
  schema: "./worker/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
});
