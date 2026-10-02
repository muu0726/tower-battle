import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** 1 試合 = 1 行 */
export const matches = sqliteTable(
  "matches",
  {
    id: text("id").primaryKey(), // crypto.randomUUID()
    roomCode: text("room_code").notNull(),
    playerCount: integer("player_count").notNull(),
    totalTurns: integer("total_turns").notNull(),
    /** 0〜3。全員同時脱落などで勝者なしの場合は null */
    winnerPlayerIndex: integer("winner_player_index"),
    winnerName: text("winner_name"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("matches_ended_at_idx").on(t.endedAt)],
);

/** 試合ごとの各プレイヤー成績 */
export const matchResults = sqliteTable(
  "match_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    playerIndex: integer("player_index").notNull(),
    playerName: text("player_name").notNull(),
    color: text("color").notNull(),
    /** 1 = 勝者。脱落が早いほど大きい */
    rank: integer("rank").notNull(),
    piecesPlaced: integer("pieces_placed").notNull().default(0),
    /** 脱落したターン番号。勝者は null */
    eliminatedTurn: integer("eliminated_turn"),
  },
  (t) => [index("match_results_match_id_idx").on(t.matchId)],
);

export type Match = typeof matches.$inferSelect;
export type NewMatch = typeof matches.$inferInsert;
export type MatchResult = typeof matchResults.$inferSelect;
export type NewMatchResult = typeof matchResults.$inferInsert;
