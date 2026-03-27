CREATE TABLE `private_assistant_invites` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_principal_id` text NOT NULL,
  `name` text NOT NULL,
  `backend_type` text NOT NULL,
  `invite_token` text NOT NULL,
  `status` text NOT NULL,
  `accepted_private_assistant_id` text,
  `created_at` text NOT NULL,
  `expires_at` text,
  `accepted_at` text,
  FOREIGN KEY (`owner_principal_id`) REFERENCES `principals`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`accepted_private_assistant_id`) REFERENCES `private_assistants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `private_assistant_invites_owner_principal_id_idx` ON `private_assistant_invites` (`owner_principal_id`);
--> statement-breakpoint
CREATE INDEX `private_assistant_invites_status_idx` ON `private_assistant_invites` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `private_assistant_invites_invite_token_unique_idx` ON `private_assistant_invites` (`invite_token`);
