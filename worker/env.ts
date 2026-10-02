import type { GameRoom } from "./GameRoom";

export interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
  DB: D1Database;
}
