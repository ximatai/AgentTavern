ALTER TABLE `bridge_tasks` ADD `assigned_instance_id` text;--> statement-breakpoint
ALTER TABLE `bridge_tasks` ADD `accepted_instance_id` text;--> statement-breakpoint
ALTER TABLE `local_bridges` ADD `current_instance_id` text;