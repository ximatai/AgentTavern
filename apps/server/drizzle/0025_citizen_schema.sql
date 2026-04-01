ALTER TABLE `principals` RENAME TO `citizens`;
--> statement-breakpoint

DROP INDEX IF EXISTS `principals_kind_login_key_unique_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `principals_status_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `citizens_kind_login_key_unique_idx` ON `citizens` (`kind`,`login_key`);
--> statement-breakpoint
CREATE INDEX `citizens_status_idx` ON `citizens` (`status`);
--> statement-breakpoint

ALTER TABLE `members` RENAME COLUMN `principal_id` TO `citizen_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `members_principal_id_idx`;
--> statement-breakpoint
CREATE INDEX `members_citizen_id_idx` ON `members` (`citizen_id`);
--> statement-breakpoint

ALTER TABLE `private_assistants` RENAME COLUMN `owner_principal_id` TO `owner_citizen_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `private_assistants_owner_principal_id_idx`;
--> statement-breakpoint
CREATE INDEX `private_assistants_owner_citizen_id_idx` ON `private_assistants` (`owner_citizen_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `private_assistants_owner_name_unique_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `private_assistants_owner_name_unique_idx` ON `private_assistants` (`owner_citizen_id`,`name`);
--> statement-breakpoint

ALTER TABLE `private_assistant_invites` RENAME COLUMN `owner_principal_id` TO `owner_citizen_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `private_assistant_invites_owner_principal_id_idx`;
--> statement-breakpoint
CREATE INDEX `private_assistant_invites_owner_citizen_id_idx` ON `private_assistant_invites` (`owner_citizen_id`);
--> statement-breakpoint

ALTER TABLE `server_configs` RENAME COLUMN `owner_principal_id` TO `owner_citizen_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `server_configs_owner_principal_id_idx`;
--> statement-breakpoint
CREATE INDEX `server_configs_owner_citizen_id_idx` ON `server_configs` (`owner_citizen_id`);
--> statement-breakpoint
DROP INDEX IF EXISTS `server_configs_owner_name_unique_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `server_configs_owner_name_unique_idx` ON `server_configs` (`owner_citizen_id`,`name`);
--> statement-breakpoint

ALTER TABLE `agent_bindings` RENAME COLUMN `principal_id` TO `citizen_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `agent_bindings_principal_id_unique_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_bindings_citizen_id_unique_idx` ON `agent_bindings` (`citizen_id`);
