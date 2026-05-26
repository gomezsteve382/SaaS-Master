CREATE TABLE IF NOT EXISTS "agent_metrics" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"analysis_id" varchar(36) NOT NULL,
	"agent_id" varchar(50) NOT NULL,
	"codename" varchar(50) NOT NULL,
	"specialty" varchar(200),
	"duration_ms" integer NOT NULL,
	"tool_call_count" integer NOT NULL,
	"iterations" integer NOT NULL,
	"findings_count" integer DEFAULT 0,
	"error" text,
	"accuracy_score" real DEFAULT 0.5,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_files" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"analysis_id" varchar(36) NOT NULL,
	"file_index" integer DEFAULT 0 NOT NULL,
	"filename" varchar(500) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"file_size" integer NOT NULL,
	"s3_key" varchar(500) NOT NULL,
	"s3_url" varchar(1000) NOT NULL,
	"file_type" varchar(100),
	"uploaded_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analysis_results" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"binary_id" varchar(36),
	"user_id" varchar(36),
	"filename" varchar(500) NOT NULL,
	"file_size" integer NOT NULL,
	"file_type" varchar(100),
	"detected_module" varchar(100),
	"entropy" real,
	"confidence" real,
	"algorithm_count" integer DEFAULT 0,
	"seed_key_count" integer DEFAULT 0,
	"can_address_count" integer DEFAULT 0,
	"checksum_count" integer DEFAULT 0,
	"security_byte_count" integer DEFAULT 0,
	"string_count" integer DEFAULT 0,
	"summary" text,
	"analysis_data" jsonb,
	"status" varchar(16) DEFAULT 'running',
	"error_message" text,
	"analyzed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "batch_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"batch_id" varchar(36) NOT NULL,
	"filename" varchar(500) NOT NULL,
	"file_size" integer NOT NULL,
	"s3_key" varchar(500) NOT NULL,
	"status" varchar(16) DEFAULT 'queued',
	"analysis_id" varchar(36),
	"error" text,
	"started_at" bigint,
	"completed_at" bigint,
	"order_index" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "batch_jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"status" varchar(16) DEFAULT 'pending',
	"total_files" integer NOT NULL,
	"completed_files" integer DEFAULT 0,
	"failed_files" integer DEFAULT 0,
	"created_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_messages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"analysis_id" varchar(36) NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "finding_ratings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"analysis_id" varchar(36) NOT NULL,
	"agent_id" varchar(50) NOT NULL,
	"finding_index" integer NOT NULL,
	"finding_category" varchar(100) NOT NULL,
	"rating" varchar(8) NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "key_finding_dismissals" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"analysis_id" varchar(36) NOT NULL,
	"finding_id" varchar(200) NOT NULL,
	"user_id" varchar(36),
	"dismissed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kg_edges" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"from_node_id" varchar(36) NOT NULL,
	"to_node_id" varchar(36) NOT NULL,
	"edge_type" varchar(32) NOT NULL,
	"weight" real DEFAULT 1,
	"properties" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kg_nodes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"node_type" varchar(32) NOT NULL,
	"label" varchar(500) NOT NULL,
	"properties" jsonb,
	"source_analysis_id" varchar(36),
	"source_pattern_id" varchar(36),
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pattern_library" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"source_analysis_id" varchar(36),
	"category" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"pattern_data" text NOT NULL,
	"metadata" jsonb,
	"match_count" integer DEFAULT 1,
	"tags" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_link_views" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"link_id" varchar(36) NOT NULL,
	"viewed_at" bigint NOT NULL,
	"ip_hash" varchar(64),
	"user_agent" varchar(500),
	"country" varchar(10)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_links" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"token" varchar(64) NOT NULL,
	"analysis_id" varchar(36) NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"label" varchar(255),
	"expires_at" bigint,
	"reminder_window_days" integer DEFAULT 3,
	"last_reminder_sent_at" bigint,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "share_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "uploaded_binaries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"filename" varchar(500) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"file_size" integer NOT NULL,
	"s3_key" varchar(500) NOT NULL,
	"s3_url" varchar(1000) NOT NULL,
	"detected_module" varchar(100),
	"uploaded_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"open_id" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" varchar(16) DEFAULT 'user',
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "users_open_id_unique" UNIQUE("open_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "yara_rules" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"filename" varchar(255) NOT NULL,
	"file_size" integer NOT NULL,
	"rule_count" integer DEFAULT 0 NOT NULL,
	"storage_key" varchar(500),
	"created_at" bigint NOT NULL
);
