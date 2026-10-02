// クライアント / Worker 共通の定数

export interface PlayerColor {
  /** 表示ラベル (P1〜P4) */
  label: string;
  name: string;
  hex: string;
}

/** ルーム入室順 (index 0〜3) に割り当てるテーマカラー */
export const PLAYER_COLORS: readonly PlayerColor[] = [
  { label: "P1", name: "レッド", hex: "#EF4444" },
  { label: "P2", name: "ブルー", hex: "#3B82F6" },
  { label: "P3", name: "グリーン", hex: "#10B981" },
  { label: "P4", name: "イエロー", hex: "#F59E0B" },
];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

// ---- ターン制御 ----
export const DRAW_TIME_LIMIT_MS = 15_000;
export const PLACE_TIME_LIMIT_MS = 12_000;

// ---- お絵描き ----
/** お絵描きキャンバスの一辺 (px) */
export const DRAW_CANVAS_SIZE = 256;
/** 1 ピースあたりの物理ポリゴン頂点数の上限 */
export const PIECE_MAX_VERTICES = 30;

// ---- 物理ワールド（ゲーム座標: 1 単位 = 1px、y は下向き。Box2D のメートル単位への変換は src/game/physics.ts） ----
export const WORLD = {
  width: 800,
  /** 浮島（土台）中心 */
  islandX: 400,
  islandY: 900,
  islandWidth: 340,
  islandHeight: 28,
  /** ピース中心がこの y を超えたら Death Zone 落下 */
  deathY: 1120,
  /** 配置プレビューで動かせる x 範囲 */
  minX: 60,
  maxX: 740,
} as const;

/** 256px キャンバス → ワールド座標の縮尺（最大 ~140 ワールド単位のピースになる） */
export const PIECE_SCALE = 0.55;
/** 配置プレビューの下端とタワー最上部の間隔 */
export const SPAWN_CLEARANCE = 200;
/** 回転ボタン 1 回あたりの角度 */
export const ROTATE_STEP_DEG = 15;

// ---- 静止判定 ----
/** 速さ（単位/s）。1 秒に 3px 未満なら止まっているとみなす */
export const REST_SPEED_THRESHOLD = 3;
/** 角速度（rad/s）。1 秒に約 7° 未満 */
export const REST_ANGULAR_THRESHOLD = 0.12;
/** 上記閾値を連続で下回る必要がある物理ステップ数 (60Hz で 0.5 秒) */
export const REST_STEPS_REQUIRED = 30;
/** 微振動が永遠に止まらないケースの保険。これを超えたら静止とみなす */
export const REST_TIMEOUT_MS = 10_000;

// ---- サーバー（Durable Object）側の期限 ----
/** クライアント側の時間切れ処理を待つ猶予。締切 + これでサーバーが代行する */
export const SERVER_GRACE_MS = 3_000;
/** DROP から確定 (SETTLED) までの最大待ち時間 */
export const SETTLE_TIMEOUT_MS = REST_TIMEOUT_MS + 5_000;
/** プレイヤー名の最大文字数 */
export const MAX_NAME_LENGTH = 12;
