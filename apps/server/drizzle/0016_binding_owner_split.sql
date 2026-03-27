PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text REFERENCES `principals`(`id`),
	`private_assistant_id` text REFERENCES `private_assistants`(`id`),
	`bridge_id` text REFERENCES `local_bridges`(`id`),
	`backend_type` text NOT NULL,
	`backend_thread_id` text NOT NULL,
	`cwd` text,
	`status` text NOT NULL,
	`attached_at` text NOT NULL,
	`detached_at` text
);--> statement-breakpoint
INSERT INTO `__new_agent_bindings` (
  `id`,
  `principal_id`,
  `private_assistant_id`,
  `bridge_id`,
  `backend_type`,
  `backend_thread_id`,
  `cwd`,
  `status`,
  `attached_at`,
  `detached_at`
)
SELECT
  ab.`id`,
  m.`principal_id`,
  m.`source_private_assistant_id`,
  ab.`bridge_id`,
  ab.`backend_type`,
  ab.`backend_thread_id`,
  ab.`cwd`,
  ab.`status`,
  ab.`attached_at`,
  ab.`detached_at`
FROM `agent_bindings` ab
JOIN `members` m ON m.`id` = ab.`member_id`;--> statement-breakpoint
DROP TABLE `agent_bindings`;--> statement-breakpoint
ALTER TABLE `__new_agent_bindings` RENAME TO `agent_bindings`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_bindings_principal_id_unique_idx` ON `agent_bindings` (`principal_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_bindings_private_assistant_id_unique_idx` ON `agent_bindings` (`private_assistant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_bindings_backend_thread_id_unique_idx` ON `agent_bindings` (`backend_thread_id`);--> statement-breakpoint
CREATE INDEX `agent_bindings_bridge_id_idx` ON `agent_bindings` (`bridge_id`);--> statement-breakpoint
CREATE INDEX `agent_bindings_status_idx` ON `agent_bindings` (`status`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
