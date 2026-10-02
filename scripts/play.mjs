#!/usr/bin/env node
/**
 * 友達と遊ぶ用のワンコマンド起動（完全無料）
 *
 *   npm run play          本番ビルド → ローカルでサーバー起動 → Cloudflare Tunnel で公開 URL を発行
 *   npm run tunnel        起動中の開発サーバー (npm run dev, 5173) にトンネルだけ張る
 *
 * Worker・Durable Object・D1 はすべてこの Mac の中（workerd）で動き、cloudflared の無料 Quick Tunnel で
 * https://xxxx.trycloudflare.com を発行する。Cloudflare のアカウントや有料プランは不要。
 * Ctrl+C でサーバーとトンネルをまとめて止める。
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
const DEV = args.has("--dev");
const SKIP_BUILD = args.has("--skip-build");
const PORT = DEV ? 5173 : Number(process.env.PORT ?? 4173);
const LOCAL_URL = `http://localhost:${PORT}`;

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const log = (msg) => console.log(`${c.cyan("[play]")} ${msg}`);

const children = [];
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("サーバーとトンネルを止めています…");
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function run(cmd, cmdArgs, label) {
  log(`${label}: ${c.dim([cmd, ...cmdArgs].join(" "))}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(c.red(`${label} に失敗しました`));
    process.exit(r.status ?? 1);
  }
}

async function waitForHealth(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${LOCAL_URL}/api/health`);
      if (res.ok) return true;
    } catch {
      // まだ起動中
    }
    await sleep(300);
  }
  return false;
}

function printShare(url) {
  const line = "━".repeat(Math.max(48, url.length + 8));
  console.log(`\n${c.green(line)}`);
  console.log(c.bold("  友達にこの URL を送ってください（LINE / Discord など）"));
  console.log(`\n    ${c.bold(c.yellow(url))}\n`);
  console.log(`  ${c.dim("同じ合言葉を入れた人どうしが同じ部屋で対戦できます。")}`);
  console.log(`  ${c.dim("スマホなら下の QR コードをカメラで読み取るだけで開けます。")}`);
  console.log(c.green(line));
  try {
    require("qrcode-terminal").generate(url, { small: true });
  } catch {
    // QR が出せなくても URL で共有できる
  }
  console.log(c.dim(`  ローカル: ${LOCAL_URL}`));
  console.log(c.dim("  終了するには Ctrl+C\n"));
}

// ---------------------------------------------------------------------------

// 1. cloudflared の確認
if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).error) {
  console.error(c.red("cloudflared が見つかりません。"));
  console.error(`Mac なら ${c.bold("brew install cloudflared")} でインストールしてから、もう一度実行してください。`);
  console.error(c.dim("その他の OS: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"));
  process.exit(1);
}

if (DEV) {
  // 開発サーバーは別ターミナルで起動済みの前提
  if (!(await waitForHealth(3_000))) {
    console.error(c.red(`${LOCAL_URL} に開発サーバーが見つかりません。先に npm run dev を起動してください。`));
    process.exit(1);
  }
} else {
  // 2. ローカル D1 のマイグレーション（適用済みなら何もしない）
  run("npx", ["wrangler", "d1", "migrations", "apply", "tower-battle-db", "--local"], "D1 マイグレーション");

  // 3. ビルド → プレビューサーバー（workerd 上で Worker / DO / D1 が動く）
  if (!SKIP_BUILD) run("npx", ["vite", "build"], "ビルド");
  log(`サーバーを起動しています（${LOCAL_URL}）…`);
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(server);
  server.stdout.on("data", (d) => process.stdout.write(c.dim(String(d))));
  server.stderr.on("data", (d) => process.stderr.write(c.dim(String(d))));
  server.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(c.red(`サーバーが終了しました (code ${code})`));
      shutdown(1);
    }
  });
  if (!(await waitForHealth())) {
    console.error(c.red("サーバーが起動しませんでした"));
    shutdown(1);
  }
}

// 4. Cloudflare Tunnel（Quick Tunnel: アカウント不要・無料）
log("Cloudflare Tunnel を開いています…");
const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", LOCAL_URL], { stdio: ["ignore", "pipe", "pipe"] });
children.push(tunnel);
let shared = false;
const onTunnelOutput = (data) => {
  const text = String(data);
  const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !shared) {
    shared = true;
    printShare(m[0]);
  }
  if (/ERR|error/i.test(text) && !/Cannot determine default origin certificate path/.test(text)) {
    process.stderr.write(c.dim(text));
  }
};
tunnel.stdout.on("data", onTunnelOutput);
tunnel.stderr.on("data", onTunnelOutput);
tunnel.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(c.red(`トンネルが終了しました (code ${code})`));
    shutdown(1);
  }
});
