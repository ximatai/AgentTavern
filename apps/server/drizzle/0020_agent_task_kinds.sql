ALTER TABLE `agent_sessions` ADD `kind` text DEFAULT 'message_reply' NOT NULL;--> statement-breakpoint
ALTER TABLE `bridge_tasks` ADD `kind` text DEFAULT 'message_reply' NOT NULL;
