CREATE TABLE `agent_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`backend_type` text NOT NULL,
	`backend_thread_id` text NOT NULL,
	`cwd` text,
	`status` text NOT NULL,
	`attached_at` text NOT NULL,
	`detached_at` text,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_bindings_member_id_unique_idx` ON `agent_bindings` (`member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_bindings_backend_thread_id_unique_idx` ON `agent_bindings` (`backend_thread_id`);--> statement-breakpoint
CREATE INDEX `agent_bindings_status_idx` ON `agent_bindings` (`status`);--> statement-breakpoint
CREATE TABLE `assistant_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`owner_member_id` text NOT NULL,
	`preset_display_name` text,
	`backend_type` text NOT NULL,
	`invite_token` text NOT NULL,
	`status` text NOT NULL,
	`accepted_member_id` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`accepted_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_invites_room_id_idx` ON `assistant_invites` (`room_id`);--> statement-breakpoint
CREATE INDEX `assistant_invites_owner_member_id_idx` ON `assistant_invites` (`owner_member_id`);--> statement-breakpoint
CREATE INDEX `assistant_invites_status_idx` ON `assistant_invites` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_invites_invite_token_unique_idx` ON `assistant_invites` (`invite_token`);