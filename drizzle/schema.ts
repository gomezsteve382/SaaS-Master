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

/**
 * Backups — module backup snapshots persisted from the client-side audit system.
 */
export const backups = mysqlTable("backups", {
  id: int("id").autoincrement().primaryKey(),
  backupKey: varchar("backupKey", { length: 512 }).notNull().unique(),
  userId: int("userId"),
  module: varchar("module", { length: 64 }).notNull(),
  vin: varchar("vin", { length: 64 }),
  didCount: int("didCount").default(0),
  tx: int("tx"),
  rx: int("rx"),
  timestamp: varchar("timestamp", { length: 64 }),
  checksum: varchar("checksum", { length: 128 }),
  snapshotKind: varchar("snapshotKind", { length: 64 }),
  preWriteKey: varchar("preWriteKey", { length: 512 }),
  payload: json("payload"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Backup = typeof backups.$inferSelect;
export type InsertBackup = typeof backups.$inferInsert;

/**
 * SEC16 Sync Events — immutable audit trail of every SEC16 sync operation
 * fired from the Module Sync tab (logSec16Sync helper, /api/sec16-sync-events).
 */
export const sec16SyncEvents = mysqlTable("sec16_sync_events", {
  id: int("id").autoincrement().primaryKey(),
  vin: varchar("vin", { length: 64 }),
  platform: varchar("platform", { length: 64 }),
  actionId: varchar("actionId", { length: 128 }),
  target: varchar("target", { length: 32 }),
  recipeId: varchar("recipeId", { length: 128 }),
  verified: varchar("verified", { length: 32 }),
  operator: varchar("operator", { length: 256 }),
  notes: text("notes"),
  detail: json("detail"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Sec16SyncEvent = typeof sec16SyncEvents.$inferSelect;
export type InsertSec16SyncEvent = typeof sec16SyncEvents.$inferInsert;

/**
 * CDA J2534 Sessions — records each live diagnostic session with module,
 * profile used, services run, and the full UDS log.
 */
export const cdaj2534Sessions = mysqlTable("cdaj2534_sessions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId"),
  /** Module name (ECM, BCM, RFHUB, etc.) */
  moduleName: varchar("moduleName", { length: 64 }).notNull(),
  /** TX CAN ID (hex string, e.g. "0x750") */
  txId: varchar("txId", { length: 16 }).notNull(),
  /** RX CAN ID (hex string) */
  rxId: varchar("rxId", { length: 16 }).notNull(),
  /** Profile ID used (e.g. "bcm", "ecm") */
  profileId: varchar("profileId", { length: 64 }),
  /** Adapter name/DLL used */
  adapterName: varchar("adapterName", { length: 256 }),
  /** Services executed as JSON array of {name, did, response, ok} */
  servicesRun: json("servicesRun"),
  /** Full UDS frame log as JSON array of {t, dir, hex} */
  udsLog: json("udsLog"),
  /** Session outcome: ok, error, partial */
  outcome: mysqlEnum("outcome", ["ok", "error", "partial"]).default("ok").notNull(),
  /** Error message if outcome != ok */
  errorMessage: text("errorMessage"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Cdaj2534Session = typeof cdaj2534Sessions.$inferSelect;
export type InsertCdaj2534Session = typeof cdaj2534Sessions.$inferInsert;
