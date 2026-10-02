# お絵描きタワーバトル

2〜4 人でリアルタイム対戦する、動物タワーバトル風の物理積み上げゲーム。
手番ごとにその場で絵を描き、その絵が即座に物理ピースになってタワーに落とされる。落とした人から脱落、最後の 1 人が勝ち。

## 友達と遊ぶ（完全無料）

サーバー（Worker・Durable Object・D1）は**自分の Mac の中**で動かし、無料の **Cloudflare Tunnel** で一時的な公開 URL を発行して友達に共有する。
Cloudflare のアカウント登録や有料プランは不要。

### 1. 準備（初回だけ）

```bash
brew install cloudflared   # Cloudflare Tunnel のクライアント
npm install
```

Node.js 22 以上が必要（v24 で動作確認済み）。

### 2. 起動

```bash
npm run play
```

ビルド → ローカルでサーバー起動 → トンネル接続まで自動で行い、次のように共有用の URL と QR コードが表示される。

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  友達にこの URL を送ってください（LINE / Discord など）

    https://xxxx-xxxx-xxxx.trycloudflare.com
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
（QR コード）
```

### 3. 遊ぶ

1. 自分もその URL を開き、名前と**合言葉**（例: `ねこぞう42`、🎲 ボタンで自動生成）を入れて部屋に入る
2. ロビーの「招待 URL をコピー」で部屋の URL を友達に送る（合言葉を伝えてトップから入ってもらっても同じ）
3. 2〜4 人そろったら、ホスト（最初に入った人）が「ゲーム開始」
4. 遊び終わったら、起動したターミナルで **Ctrl+C**（サーバーとトンネルがまとめて止まる）

**注意**

- URL は `npm run play` のたびに変わる。前回の URL は使えない
- 遊んでいる間は Mac をスリープさせない（スリープするとサーバーも止まる）
- URL を知っている人は誰でもアクセスできるので、共有は遊ぶ相手だけに。終わったら Ctrl+C で閉じる
- 開発中に実機で試すなら、`npm run dev` を起動した状態で別ターミナルから `npm run tunnel`（開発サーバーにトンネルだけ張る）

### 遊び方

| 場面 | 操作 |
| --- | --- |
| お絵描き（15 秒） | テーマ色 / 白 / 黒 / 消しゴム、太さスライダー。サイズ規定（🐭 小 / 🐶 中 / 🐘 大）の枠より大きく描いて「完成！」 |
| 配置（12 秒） | 盤面を左右にドラッグ（動かした分だけ動く）、◀ ▶（押しっぱなしで連続）、回転ボタン（15° 単位）。PC は ← → / A D、Q / E も可 |
| 落下 | DROP（PC は Space / Enter / ↓）。タワーが完全に止まるまで次の人へは進まない |

- ピースが落ちたら、その手番の人が脱落。最後の 1 人が勝ち
- 時間切れでも止まらない：描けていなければ代わりのブロック、小さすぎれば自動で拡大、配置は自動で DROP
- 接続が切れても同じタブなら自動で復帰。自分の手番までに戻れなければ脱落
- 他の人の手番中は、描いている様子のタイマー・ピースの移動・落下がそのまま見える

## 構成

| 役割 | 実装 |
| --- | --- |
| フロントエンド | Vite + React + TypeScript + Tailwind CSS v4 + Lucide アイコン（Worker の Static Assets として配信） |
| API / WebSocket | `worker/index.ts`（`/api/*` だけ Worker を先に通す） |
| ルーム / ターン制御 | Durable Object `GameRoom`（合言葉 1 つにつき 1 インスタンス） |
| 対戦ログ | D1 + Drizzle ORM（`matches`, `match_results`） |
| 物理 | planck.js（Box2D の JavaScript 版。本家と同じ Box2D 系）+ poly-decomp（手番プレイヤーのクライアントが権威） |
| 公開 | Cloudflare Tunnel（Quick Tunnel、無料・アカウント不要） |

`wrangler.toml` 1 枚に全バインディングを定義している。ローカルでは `@cloudflare/vite-plugin` が Worker / DO / D1 を workerd 上で動かす（Cloudflare 本番と同じランタイム）。
WebSocket の接続先は `location.origin` から組み立てるので、`http://localhost` なら `ws://`、トンネルの `https://…trycloudflare.com` なら `wss://` に自動で切り替わる（`src/net/roomClient.ts`）。

```
shared/constants.ts        プレイヤーカラー・ワールド寸法・制限時間・静止判定閾値など
shared/protocol.ts         WebSocket メッセージの型とバリデータ
shared/sizeRule.ts         サイズ規定（抽選・判定・拡大倍率）
worker/                    Worker 本体 / GameRoom DO / Drizzle スキーマ
worker/room/engine.ts      部屋のゲーム進行（入室・ターン・脱落・勝敗）。I/O なしの純粋なロジック
src/net/                   クライアント接続層（自動再接続・状態の組み立て・React フック）
src/utils/contourTracer.ts キャンバス → 輪郭ポリゴン
src/game/pieceShape.ts     輪郭ポリゴン → Box2D 用の凸パーツ（12 頂点以内）
src/game/                  物理・カメラ・描画・対戦シーン（onlineScene）・Sandbox シーン
src/components/            お絵描きパッド・配置操作・ゲームキャンバス・ロビー / 勝敗モーダルなど
src/pages/                 トップ・対戦部屋・Sandbox
scripts/play.mjs           npm run play / npm run tunnel
```

## ローカル開発

```bash
npm install
npm run db:generate        # worker/db/schema.ts → drizzle/migrations/*.sql
npm run db:migrate:local   # ローカル D1 (.wrangler/state) に適用
npm run dev                # http://localhost:5173
```

- `http://localhost:5173/sandbox` で「描く → プレイヤー色付きでピース化 → 浮島に落として積む」を 1 画面で試せる
- `http://localhost:5173/api/health` で Worker の疎通確認
- `npm test` でユニットテスト（輪郭抽出・サイズ規定・ゲーム進行・クライアント状態）、`npm run typecheck` で型チェック

`npm run dev` は `@cloudflare/vite-plugin` により Worker / Durable Object / D1 も workerd 上でローカル実行される。

### Sandbox の操作

| 操作 | 内容 |
| --- | --- |
| お絵描き | テーマ色 / 白 / 黒 / 消しゴム、太さスライダー、「完成！」で確定（15 秒で自動確定） |
| 移動 | 盤面を左右にドラッグ（動かした分だけ動く相対移動）、◀ ▶（押しっぱなしで連続）、← → / A D（Shift で大きく） |
| 回転 | Q / E、または回転ボタン（15° 単位） |
| 落下 | DROP ボタン、Space / Enter / ↓ |

ピースが Death Zone に落ちると、その時の手番プレイヤーが脱落する。「デバッグ表示」で凸分解後のパーツと頂点を確認できる。
スマホ（縦画面）では上にゲーム画面、下にお絵描きパッド / 操作ボタンが並び、設定は歯車メニューにまとまる。

### サイズ規定（ターンごとの最小サイズ抽選）

極小の点を描くズルを防ぐため、ターン開始時に描くべきサイズが抽選される（`shared/sizeRule.ts`）。

| クラス | 長い辺 | 塗り面積 | 抽選確率 |
| --- | --- | --- | --- |
| 🐭 SMALL | 60px 以上 | 1,500px² 以上 | 35% |
| 🐶 MEDIUM | 120px 以上 | 5,000px² 以上 | 40% |
| 🐘 LARGE | 180px 以上 | 11,000px² 以上 | 25% |

- 判定は「幅か高さのどちらかが規定以上」かつ「塗り面積が規定以上」。横長・縦長の絵は OK、細い棒は面積で弾かれる
- 判定には物理ボディと同じ `tracePiece` の結果を使う（ペンを離すたびに再計測）
- 未達成の間は「完成！」が押せず、ガイド枠が赤。達成すると緑になる
- 時間切れで未達成なら、描いた絵を比率を保ったまま規定サイズまで自動拡大して続行する
- ターン開始は `shared/protocol.ts` の `TURN_START` メッセージで表す。Sandbox ではクライアントが自作し、対戦では DO が抽選して配信する（ステップ 4）

## 対戦サーバー（Durable Object）

合言葉 1 つにつき `GameRoom` が 1 つ立ち、`/api/rooms/<合言葉>/ws` の WebSocket で 2〜4 人をつなぐ。
ルールは `worker/room/engine.ts`（`RoomEngine`）にまとめてあり、DO はメッセージの受け渡し・保存・アラーム・D1 記録だけを担当する。

**1 ターンの流れ**

1. `TURN_START` — サーバーがサイズ規定を抽選して全員に配る（締切つき）
2. 手番の人が `DRAW_SUBMIT`（輪郭ポリゴン + 絵の PNG）→ 全員に `PIECE_SUBMITTED`
3. 手番の人の `PREVIEW`（移動・回転）を他の全員へ中継 → `DROP` で全員に `DROPPED`
4. 物理担当（基本は手番の人）が物理を回して `STATE_STREAM` を約 20Hz で配信 → 静止したら `SETTLED`
5. サーバーが位置を確定して `TURN_RESULT`。1 つでも落ちていれば手番の人が脱落 → 次の人へ。残り 1 人で `GAME_OVER`、D1 に記録

**時間切れと切断**

- 締切を過ぎるとサーバーが代行する：お絵描き → 規定サイズのブロック、配置 → 最後の位置で自動 DROP、静止待ち → 最後に届いたフレームで確定
- 切断しても再接続（同じタブなら自動）すれば続行。自分の手番が来た時点でまだ切断中なら脱落
- 部屋の状態は DO ストレージに保存しているので、DO が休止しても続きから再開できる

**物理エンジン（`src/game/physics.ts`）**

本家どうぶつタワーバトル（Unity 製）と同じ Box2D 系の **planck.js** を使っている。着地したら弾まずに引っかかり、止まったタワーは勝手にじわじわ動かない。
挙動は `src/game/physics.lab.test.ts`（物理ラボ）で数値を測って調整・回帰チェックしている。移行前（Matter.js）との比較：

| 指標 | Matter.js（移行前） | planck.js（現在） |
| --- | --- | --- |
| 20° の斜面に置いた箱が 3 秒で滑る距離 | 17.5 | 0.27 |
| 静止したタワーがその後 10 秒で動く距離（最大） | 15〜53 | 0.07 |
| 6 段タワーが静止するまで（平均 / 最大） | 6.0 秒 / 12 秒 | 2.7 秒 / 4.8 秒 |
| 落下の速さ（200 単位） | 0.63 秒 | 0.63 秒（同じ） |

**物理の同期（`src/game/onlineScene.ts`）**

- 普段はどの画面でも物理を止め、確定済みピースはサーバーの位置に固定する（各自で物理を回すと画面ごとに結果がずれるため）
- DROP 後は物理担当の画面だけが物理を進めて姿勢を配信し、他の画面はそれを補間して表示する
- 物理担当の計算は描画ループではなく専用タイマーで回すので、タブを裏に回しても（スマホでアプリを切り替えても）落下の確定は止まらない

**通しの動作確認**

```bash
npm run dev     # 別ターミナルで起動しておく
npm run smoke   # 仮想プレイヤー 3 人で 1 試合（切断・再接続・脱落・D1 記録まで）

# トンネル越しでも同じ確認ができる
SMOKE_URL=https://xxxx.trycloudflare.com npm run smoke

# 本番に向けて流す（試合結果は本番 D1 で確認。テスト用の試合が 1 件記録される）
SMOKE_URL=https://tower-battle.<サブドメイン>.workers.dev SMOKE_D1=remote npm run smoke
```

## Cloudflare に本番公開する（任意）

`npm run play` は自分の Mac が起動している間だけ遊べる。Mac を起動しておかなくてもいつでも遊べるようにしたい場合は、Cloudflare 本番にデプロイする。
この構成（Workers + Static Assets + SQLite バックエンドの Durable Object + D1）は **Workers Free プランで動く**（2026 年 10 月時点の公式ドキュメントで確認）。

> 依頼当初は Cloudflare Pages を想定していたが、Pages では Durable Object を定義できず、別の Worker を立ててバインドする必要がある（公式の Pages → Workers 移行ガイドの互換性表より）。そのため 1 つの Worker で静的ファイル・WebSocket・DO・D1 をまとめて扱う **Workers + Static Assets** を採用している。

### 無料プランで足りるか（目安）

| 項目 | Free プランの上限 | このゲームでの使い方 |
| --- | --- | --- |
| Worker リクエスト | 10 万 / 日（静的ファイルは数えない） | 入室時の WebSocket 接続ごとに 1 回 |
| Worker CPU 時間 | 10ms / 回 | メッセージ 1 件の処理は 1ms 未満の想定 |
| DO リクエスト | 10 万 / 日 | 受信 WebSocket メッセージは **20 件で 1 リクエスト**換算。送信は無料 |
| DO 実行時間 | 13,000 GB 秒 / 日 | Hibernation API を使っているので、待ち時間には課金されない |
| DO の SQLite 書き込み | 10 万行 / 日 | ターンごとに数行（部屋の状態・ピースの保存） |
| D1 | 読み取り 500 万行 / 日・書き込み 10 万行 / 日・5GB | 1 試合ごとに数行（試合結果） |

ざっくりの見積もり：1 試合（4 人・20 ターン）で受信メッセージは最大 1 万件弱（配置プレビュー約 30 回 / 秒、落下中の姿勢約 20 回 / 秒）なので、DO リクエスト換算で 500 前後。**1 日に数十〜100 試合程度なら無料枠に収まる**。
上限を超えるとその日（UTC 0 時まで）は処理がエラーになるだけで、Free プランのまま勝手に課金されることはない。

### A. 自分の Mac からデプロイする（いちばん簡単）

初回だけ：

```bash
npx wrangler login                        # ブラウザが開くので Cloudflare アカウントでログイン（無料登録で OK）
npx wrangler d1 create tower-battle-db    # 本番の D1 データベースを作る
```

`d1 create` の出力に出る `database_id` を [wrangler.toml](wrangler.toml) の `database_id` に書き込む（本番では必須）。
ローカルの D1 はこの ID ごとに別のファイルになるので、書き換えた後は `npm run db:migrate:local` をもう一度実行しておく（`npm run play` は自動で行う）。

```bash
npm run db:migrate:remote                 # 本番 D1 にテーブルを作る
npm run deploy                            # vite build → wrangler deploy
```

完了すると `https://tower-battle.<あなたのサブドメイン>.workers.dev` が表示される。この URL を友達に送れば、トンネルなしでいつでも遊べる。
2 回目以降は `npm run deploy` だけでよい（DB のテーブル構成を変えたときだけ `npm run db:migrate:remote` も）。

デプロイ前の確認には、何もアップロードせずにビルド結果とバインディングだけ確かめる `npx wrangler deploy --dry-run` が使える。

### B. GitHub に push したら自動デプロイ（Workers Builds）

1. このフォルダを GitHub リポジトリにする（`git init` → GitHub に push）
2. 先に **A の手順で 1 回デプロイ**しておく（D1 の作成とテーブル作成は手元から行う）
3. Cloudflare ダッシュボード → **Workers & Pages** → `tower-battle` → **Settings** → **Builds** → **Connect** でリポジトリを接続
4. ビルド設定を次のようにする

| 設定 | 値 |
| --- | --- |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy`（既定値のまま） |
| Root directory | 空欄（リポジトリ直下） |

以降は main ブランチに push するたびに自動でビルド・デプロイされる。

> このリポジトリ（[muu0726/tower-battle](https://github.com/muu0726/tower-battle)）は接続済み。main に push すると Workers Builds が自動でビルドして https://tower-battle.u-muta180726.workers.dev に反映する。ビルドの結果は GitHub のコミット横のチェックマークか、Cloudflare ダッシュボードの tower-battle → Deployments で確認できる。

- ダッシュボードの Worker 名と `wrangler.toml` の `name`（`tower-battle`）が一致していないとビルドが失敗する
- ビルド環境の Node.js バージョンは `.node-version`（`24`）で指定している
- Free プランのビルド枠は月 3,000 分・同時 1 本・1 回 20 分まで
- D1 のマイグレーションは自動では流れない。テーブル構成を変えた push の前に、手元で `npm run db:migrate:remote` を実行しておく

### マイグレーション（D1 と Durable Object）

**D1（試合結果のテーブル）** は Drizzle のスキーマから SQL を生成して適用する。

```bash
# 1. worker/db/schema.ts を編集
npm run db:generate        # drizzle/migrations/ に新しい SQL ファイルができる
npm run db:migrate:local   # ローカルで確認
npm run db:migrate:remote  # 本番に適用（適用済みのファイルはスキップされる）
npm run deploy
```

**Durable Object** はクラスの追加・改名・削除のときだけ `wrangler.toml` の `[[migrations]]` にタグを**追記**する（既存のタグは書き換えない）。

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["GameRoom"]       # ← 既存。触らない

# 例: クラスを改名する場合
[[migrations]]
tag = "v2"
renamed_classes = [{ from = "GameRoom", to = "Room" }]
```

- 新しいクラスは Free プランでは `new_sqlite_classes`（SQLite バックエンド）で追加する
- 部屋の中身（RoomData）の形を変えただけなら DO マイグレーションは不要。ただし対戦中の部屋は古い形のデータを読むので、デプロイは誰も遊んでいない時間に行うのが無難

### 運用メモ

```bash
npx wrangler tail                                                    # 本番のログをリアルタイムで見る
npx wrangler d1 execute tower-battle-db --remote \
  --command "SELECT winner_name, player_count, total_turns FROM matches ORDER BY ended_at DESC LIMIT 10"
npx wrangler deployments list                                        # デプロイ履歴
npx wrangler rollback                                                # 1 つ前のバージョンに戻す
```

公開 URL を知っていれば誰でもアクセスできる（ログイン機能はない）。部屋に入るには合言葉が必要なので、友達以外に入られたくない場合は推測されにくい合言葉を使う。
