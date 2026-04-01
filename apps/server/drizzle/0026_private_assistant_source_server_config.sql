ALTER TABLE `private_assistants` ADD `source_server_config_id` text REFERENCES `server_configs`(`id`);
