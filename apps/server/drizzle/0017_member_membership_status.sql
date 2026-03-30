ALTER TABLE `members` ADD `membership_status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `members` ADD `left_at` text;--> statement-breakpoint
DROP INDEX `members_room_display_name_unique_idx`;--> statement-breakpoint
CREATE INDEX `members_membership_status_idx` ON `members` (`membership_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_room_active_display_name_unique_idx` ON `members` (`room_id`,`display_name`) WHERE `membership_status` = 'active';
