CREATE TABLE `algorithms` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`name` text NOT NULL,
	`offset` integer,
	`size` integer,
	`type` text,
	`confidence` real
);
--> statement-breakpoint
CREATE TABLE `analysis_results` (
	`id` text PRIMARY KEY NOT NULL,
	`binary_id` text NOT NULL,
	`user_id` text NOT NULL,
	`detected_module` text,
	`entropy` real,
	`confidence` real,
	`algorithm_count` integer DEFAULT 0,
	`seed_key_count` integer DEFAULT 0,
	`can_address_count` integer DEFAULT 0,
	`checksum_count` integer DEFAULT 0,
	`security_byte_count` integer DEFAULT 0,
	`string_count` integer DEFAULT 0,
	`analysis_data` text,
	`analyzed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `can_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`address` text NOT NULL,
	`module` text,
	`description` text,
	`confidence` real
);
--> statement-breakpoint
CREATE TABLE `checksums` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`name` text NOT NULL,
	`offset` integer,
	`algorithm` text,
	`confidence` real
);
--> statement-breakpoint
CREATE TABLE `extracted_strings` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`value` text NOT NULL,
	`offset` integer
);
--> statement-breakpoint
CREATE TABLE `search_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`query` text NOT NULL,
	`results_count` integer DEFAULT 0,
	`searched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `security_bytes` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`name` text NOT NULL,
	`offset` integer,
	`value` text,
	`purpose` text,
	`confidence` real
);
--> statement-breakpoint
CREATE TABLE `seed_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`name` text NOT NULL,
	`offset` integer,
	`size` integer,
	`key_type` text,
	`value` text,
	`confidence` real
);
--> statement-breakpoint
CREATE TABLE `uploaded_binaries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`filename` text NOT NULL,
	`file_hash` text NOT NULL,
	`file_size` integer NOT NULL,
	`s3_key` text NOT NULL,
	`s3_url` text NOT NULL,
	`detected_module` text,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`open_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'user',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_open_id_unique` ON `users` (`open_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `vault_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`module` text,
	`category` text,
	`value` text,
	`offset` integer,
	`description` text,
	`source` text,
	`source_id` text,
	`created_at` integer NOT NULL
);
