CREATE TABLE `bridge_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`bridge_id` text NOT NULL,
	`session_id` text NOT NULL,
	`room_id` text NOT NULL,
	`agent_member_id` text NOT NULL,
	`requester_member_id` text NOT NULL,
	`backend_type` text NOT NULL,
	`backend_thread_id` text NOT NULL,
	`output_message_id` text NOT NULL,
	`prompt` text NOT NULL,
	`context_payload` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`assigned_at` text,
	`accepted_at` text,
	`completed_at` text,
	`failed_at` text,
	FOREIGN KEY (`bridge_id`) REFERENCES `local_bridges`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bridge_tasks_bridge_id_idx` ON `bridge_tasks` (`bridge_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bridge_tasks_session_id_unique_idx` ON `bridge_tasks` (`session_id`);--> statement-breakpoint
CREATE INDEX `bridge_tasks_status_idx` ON `bridge_tasks` (`status`);