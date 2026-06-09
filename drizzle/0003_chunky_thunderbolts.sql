CREATE TABLE `cdaj2534_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int,
	`moduleName` varchar(64) NOT NULL,
	`txId` varchar(16) NOT NULL,
	`rxId` varchar(16) NOT NULL,
	`profileId` varchar(64),
	`adapterName` varchar(256),
	`servicesRun` json,
	`udsLog` json,
	`outcome` enum('ok','error','partial') NOT NULL DEFAULT 'ok',
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cdaj2534_sessions_id` PRIMARY KEY(`id`)
);
