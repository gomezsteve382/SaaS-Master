CREATE TABLE `module_map_scans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int,
	`vin` varchar(17),
	`vehicleLabel` varchar(255),
	`adapterUrl` varchar(256),
	`moduleList` json NOT NULL,
	`rawResponses` json,
	`equippedCount` int NOT NULL DEFAULT 0,
	`notEquippedCount` int NOT NULL DEFAULT 0,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `module_map_scans_id` PRIMARY KEY(`id`)
);
