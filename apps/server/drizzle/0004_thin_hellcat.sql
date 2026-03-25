ALTER TABLE `agent_bindings` ADD `bridge_id` text REFERENCES local_bridges(id);--> statement-breakpoint
CREATE INDEX `agent_bindings_bridge_id_idx` ON `agent_bindings` (`bridge_id`);