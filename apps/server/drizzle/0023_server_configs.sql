CREATE TABLE `server_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_principal_id` text NOT NULL REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
	`name` text NOT NULL,
	`backend_type` text NOT NULL,
	`config_payload` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `server_configs_owner_principal_id_idx` ON `server_configs` (`owner_principal_id`);
--> statement-breakpoint
CREATE INDEX `server_configs_visibility_idx` ON `server_configs` (`visibility`);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_configs_owner_name_unique_idx` ON `server_configs` (`owner_principal_id`,`name`);
