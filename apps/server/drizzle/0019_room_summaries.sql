CREATE TABLE `room_summaries` (
  `room_id` text PRIMARY KEY NOT NULL REFERENCES `rooms`(`id`),
  `summary_text` text NOT NULL,
  `generated_by_member_id` text NOT NULL REFERENCES `members`(`id`),
  `source_message_id` text REFERENCES `messages`(`id`),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `room_summaries_generated_by_member_id_idx` ON `room_summaries` (`generated_by_member_id`);--> statement-breakpoint
CREATE INDEX `room_summaries_source_message_id_idx` ON `room_summaries` (`source_message_id`);
