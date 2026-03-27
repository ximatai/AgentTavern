ALTER TABLE `assistant_invites` ADD `accepted_private_assistant_id` text REFERENCES `private_assistants`(`id`);--> statement-breakpoint
CREATE INDEX `assistant_invites_accepted_private_assistant_id_idx` ON `assistant_invites` (`accepted_private_assistant_id`);
