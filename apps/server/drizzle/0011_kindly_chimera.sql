CREATE TABLE `principals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`login_key` text NOT NULL,
	`global_display_name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `principals_kind_login_key_unique_idx` ON `principals` (`kind`,`login_key`);
--> statement-breakpoint
CREATE INDEX `principals_status_idx` ON `principals` (`status`);
--> statement-breakpoint
ALTER TABLE `members` ADD `principal_id` text REFERENCES principals(id);
--> statement-breakpoint
ALTER TABLE `members` ADD `source_private_assistant_id` text;
--> statement-breakpoint
CREATE INDEX `members_principal_id_idx` ON `members` (`principal_id`);
--> statement-breakpoint
CREATE TABLE `private_assistants` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_principal_id` text NOT NULL REFERENCES principals(id),
	`name` text NOT NULL,
	`backend_type` text NOT NULL,
	`backend_thread_id` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `private_assistants_owner_principal_id_idx` ON `private_assistants` (`owner_principal_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_assistants_owner_name_unique_idx` ON `private_assistants` (`owner_principal_id`,`name`);
