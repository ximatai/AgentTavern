ALTER TABLE `rooms` ADD `owner_member_id` text;--> statement-breakpoint
CREATE INDEX `rooms_owner_member_id_idx` ON `rooms` (`owner_member_id`);
