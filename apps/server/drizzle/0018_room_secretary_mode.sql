ALTER TABLE `rooms` ADD `secretary_member_id` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `secretary_mode` text DEFAULT 'off' NOT NULL;
