CREATE TABLE `agent_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`owner_member_id` text NOT NULL,
	`requester_member_id` text NOT NULL,
	`agent_member_id` text NOT NULL,
	`grant_duration` text NOT NULL,
	`remaining_uses` integer,
	`expires_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_authorizations_room_id_idx` ON `agent_authorizations` (`room_id`);--> statement-breakpoint
CREATE INDEX `agent_authorizations_owner_member_id_idx` ON `agent_authorizations` (`owner_member_id`);--> statement-breakpoint
CREATE INDEX `agent_authorizations_requester_member_id_idx` ON `agent_authorizations` (`requester_member_id`);--> statement-breakpoint
CREATE INDEX `agent_authorizations_agent_member_id_idx` ON `agent_authorizations` (`agent_member_id`);--> statement-breakpoint
CREATE INDEX `agent_authorizations_active_tuple_idx` ON `agent_authorizations` (`room_id`,`owner_member_id`,`requester_member_id`,`agent_member_id`,`revoked_at`);--> statement-breakpoint
ALTER TABLE `approvals` ADD `grant_duration` text DEFAULT 'once' NOT NULL;