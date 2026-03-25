CREATE TABLE `local_bridges` (
	`id` text PRIMARY KEY NOT NULL,
	`bridge_name` text NOT NULL,
	`bridge_token` text NOT NULL,
	`status` text NOT NULL,
	`platform` text,
	`version` text,
	`metadata` text,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_bridges_bridge_token_unique_idx` ON `local_bridges` (`bridge_token`);--> statement-breakpoint
CREATE INDEX `local_bridges_status_idx` ON `local_bridges` (`status`);--> statement-breakpoint
CREATE INDEX `local_bridges_last_seen_at_idx` ON `local_bridges` (`last_seen_at`);