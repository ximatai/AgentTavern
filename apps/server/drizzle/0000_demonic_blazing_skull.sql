CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`agent_member_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`requester_member_id` text NOT NULL,
	`approval_id` text,
	`approval_required` integer NOT NULL,
	`status` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_sessions_room_id_idx` ON `agent_sessions` (`room_id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_agent_member_id_idx` ON `agent_sessions` (`agent_member_id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_status_idx` ON `agent_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`requester_member_id` text NOT NULL,
	`owner_member_id` text NOT NULL,
	`agent_member_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approvals_room_id_idx` ON `approvals` (`room_id`);--> statement-breakpoint
CREATE INDEX `approvals_owner_member_id_idx` ON `approvals` (`owner_member_id`);--> statement-breakpoint
CREATE INDEX `approvals_agent_member_id_idx` ON `approvals` (`agent_member_id`);--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`type` text NOT NULL,
	`role_kind` text NOT NULL,
	`display_name` text NOT NULL,
	`owner_member_id` text,
	`presence_status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `members_room_id_idx` ON `members` (`room_id`);--> statement-breakpoint
CREATE INDEX `members_owner_member_id_idx` ON `members` (`owner_member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_room_display_name_unique_idx` ON `members` (`room_id`,`display_name`);--> statement-breakpoint
CREATE TABLE `mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`target_member_id` text NOT NULL,
	`trigger_text` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mentions_message_id_idx` ON `mentions` (`message_id`);--> statement-breakpoint
CREATE INDEX `mentions_target_member_id_idx` ON `mentions` (`target_member_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`sender_member_id` text NOT NULL,
	`message_type` text NOT NULL,
	`content` text NOT NULL,
	`reply_to_message_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_room_id_idx` ON `messages` (`room_id`);--> statement-breakpoint
CREATE INDEX `messages_sender_member_id_idx` ON `messages` (`sender_member_id`);--> statement-breakpoint
CREATE INDEX `messages_created_at_idx` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`invite_token` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_invite_token_unique_idx` ON `rooms` (`invite_token`);