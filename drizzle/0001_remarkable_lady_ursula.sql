CREATE TABLE `audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`sessionId` int,
	`action` varchar(128) NOT NULL,
	`description` text NOT NULL,
	`metadata` json,
	`ipAddress` varchar(45),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` int NOT NULL,
	`userId` int NOT NULL,
	`opType` enum('inspect','generate_candidate','export_candidate','sec16_sync','diff_compute','three_way_compare') NOT NULL,
	`sourceUploadId` int,
	`targetUploadId` int,
	`inputParams` json,
	`resultSummary` json,
	`success` boolean NOT NULL,
	`errorMessage` text,
	`candidateStorageKey` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `operations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`title` varchar(255),
	`status` enum('active','completed','archived') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` int NOT NULL,
	`userId` int NOT NULL,
	`slotType` enum('RFHUB','BCM','PCM') NOT NULL,
	`filename` varchar(512) NOT NULL,
	`fileSize` int NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`storageUrl` varchar(1024) NOT NULL,
	`detectedType` varchar(32),
	`parsedVin` varchar(17),
	`parsedSec16` varchar(64),
	`parseResult` json,
	`checksumsValid` boolean,
	`purpose` enum('source','candidate','readback_pre','readback_post') NOT NULL DEFAULT 'source',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `uploads_id` PRIMARY KEY(`id`)
);
