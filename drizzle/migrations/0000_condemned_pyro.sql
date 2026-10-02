CREATE TABLE `match_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` text NOT NULL,
	`player_index` integer NOT NULL,
	`player_name` text NOT NULL,
	`color` text NOT NULL,
	`rank` integer NOT NULL,
	`pieces_placed` integer DEFAULT 0 NOT NULL,
	`eliminated_turn` integer,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `match_results_match_id_idx` ON `match_results` (`match_id`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`player_count` integer NOT NULL,
	`total_turns` integer NOT NULL,
	`winner_player_index` integer,
	`winner_name` text,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `matches_ended_at_idx` ON `matches` (`ended_at`);