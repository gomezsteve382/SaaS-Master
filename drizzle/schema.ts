import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, json, boolean } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Work sessions — groups related uploads and operations into a logical unit.
 */
export const sessions = mysqlTable("sessions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  title: varchar("title", { length: 255 }),
  status: mysqlEnum("status", ["active", "completed", "archived"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/**
 * File uploads — stores metadata and S3 references for each uploaded binary.
 */
export const uploads = mysqlTable("uploads", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: int("sessionId").notNull(),
  userId: int("userId").notNull(),
  /** Module slot: RFHUB, BCM, or PCM */
  slotType: mysqlEnum("slotType", ["RFHUB", "BCM", "PCM"]).notNull(),
  /** Original filename */
  filename: varchar("filename", { length: 512 }).notNull(),
  /** File size in bytes */
  fileSize: int("fileSize").notNull(),
  /** SHA-256 hash of the raw binary */
  sha256: varchar("sha256", { length: 64 }).notNull(),
  /** S3 storage key */
  storageKey: varchar("storageKey", { length: 512 }).notNull(),
  /** S3 storage URL */
  storageUrl: varchar("storageUrl", { length: 1024 }).notNull(),
  /** Detected module type from parser */
  detectedType: varchar("detectedType", { length: 32 }),
  /** Parsed VIN (primary/first valid) */
  parsedVin: varchar("parsedVin", { length: 17 }),
  /** Parsed SEC16 hex string */
  parsedSec16: varchar("parsedSec16", { length: 64 }),
  /** Full parse result as JSON */
  parseResult: json("parseResult"),
  /** Whether checksums are all valid */
  checksumsValid: boolean("checksumsValid"),
  /** Upload purpose: source, candidate, readback_pre, readback_post */
  purpose: mysqlEnum("purpose", ["source", "candidate", "readback_pre", "readback_post"]).default("source").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Upload = typeof uploads.$inferSelect;
export type InsertUpload = typeof uploads.$inferInsert;

/**
 * Operations — records each write/export action with full context.
 */
export const operations = mysqlTable("operations", {
  id: int("id").autoincrement().primaryKey(),
  sessionId: int("sessionId").notNull(),
  userId: int("userId").notNull(),
  /** Operation type */
  opType: mysqlEnum("opType", [
    "inspect",
    "generate_candidate",
    "export_candidate",
    "sec16_sync",
    "diff_compute",
    "three_way_compare",
  ]).notNull(),
  /** Source upload ID */
  sourceUploadId: int("sourceUploadId"),
  /** Target upload ID (if applicable) */
  targetUploadId: int("targetUploadId"),
  /** Operation input parameters as JSON */
  inputParams: json("inputParams"),
  /** Operation result summary as JSON */
  resultSummary: json("resultSummary"),
  /** Whether the operation succeeded */
  success: boolean("success").notNull(),
  /** Error message if failed */
  errorMessage: text("errorMessage"),
  /** Generated candidate storage key (if applicable) */
  candidateStorageKey: varchar("candidateStorageKey", { length: 512 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Operation = typeof operations.$inferSelect;
export type InsertOperation = typeof operations.$inferInsert;

/**
 * Audit log — immutable timestamped record of every significant action.
 */
export const auditLogs = mysqlTable("audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  sessionId: int("sessionId"),
  /** Action category */
  action: varchar("action", { length: 128 }).notNull(),
  /** Human-readable description */
  description: text("description").notNull(),
  /** Structured metadata (offsets changed, checksums, etc.) */
  metadata: json("metadata"),
  /** IP address of the request */
  ipAddress: varchar("ipAddress", { length: 45 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;
