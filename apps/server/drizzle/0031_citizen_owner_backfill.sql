UPDATE `citizens` SET `owner_citizen_id` = `id` WHERE `kind` = 'human' AND `owner_citizen_id` IS NULL;
