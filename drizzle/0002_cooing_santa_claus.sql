CREATE TABLE `backups` (
	`id` int AUTO_INCREMENT NOT NULL,
	`backupKey` varchar(512) NOT NULL,
	`userId` int,
	`module` varchar(64) NOT NULL,
	`vin` varchar(64),
	`didCount` int DEFAULT 0,
	`tx` int,
	`rx` int,
	`timestamp` varchar(64),
	`checksum` varchar(128),
	`snapshotKind` varchar(64),
	`preWriteKey` varchar(512),
	`payload` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `backups_id` PRIMARY KEY(`id`),
	CONSTRAINT `backups_backupKey_unique` UNIQUE(`backupKey`)
);
--> statement-breakpoint
CREATE TABLE `sec16_sync_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vin` varchar(64),
	`platform` varchar(64),
	`actionId` varchar(128),
	`target` varchar(32),
	`recipeId` varchar(128),
	`verified` varchar(32),
	`operator` varchar(256),
	`notes` text,
	`detail` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sec16_sync_events_id` PRIMARY KEY(`id`)
);
