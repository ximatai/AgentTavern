ALTER TABLE `messages` ADD `sender_display_name` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_type` text;
--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_role_kind` text;
--> statement-breakpoint
UPDATE `messages`
SET
  `sender_display_name` = (
    SELECT `display_name`
    FROM `members`
    WHERE `members`.`id` = `messages`.`sender_member_id`
  ),
  `sender_type` = (
    SELECT `type`
    FROM `members`
    WHERE `members`.`id` = `messages`.`sender_member_id`
  ),
  `sender_role_kind` = (
    SELECT `role_kind`
    FROM `members`
    WHERE `members`.`id` = `messages`.`sender_member_id`
  )
WHERE `sender_display_name` IS NULL;
