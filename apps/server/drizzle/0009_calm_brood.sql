CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`uploader_member_id` text NOT NULL,
	`message_id` text,
	`storage_path` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploader_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `message_attachments_room_id_idx` ON `message_attachments` (`room_id`);--> statement-breakpoint
CREATE INDEX `message_attachments_uploader_member_id_idx` ON `message_attachments` (`uploader_member_id`);--> statement-breakpoint
CREATE INDEX `message_attachments_message_id_idx` ON `message_attachments` (`message_id`);
