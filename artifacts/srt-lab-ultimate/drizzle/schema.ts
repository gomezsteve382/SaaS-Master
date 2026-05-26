/**
 * Postgres-port of the original MySQL/TiDB schema.
 *
 * Original `mysqlEnum` columns are stored as `varchar` here to avoid creating
 * many top-level Postgres enum types; the application code already validates
 * the allowed values at the call sites.
 */
import {
  pgTable,
  text,
  integer,
  real,
  jsonb,
  bigint,
  varchar,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Users ──────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: varchar("id", { length: 36 }).primaryKey(),
  openId: varchar("open_id", { length: 255 }).notNull().unique(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 16 }).default("user"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// ─── Uploaded Binaries ──────────────────────────────────────────────────
export const uploadedBinaries = pgTable("uploaded_binaries", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  filename: varchar("filename", { length: 500 }).notNull(),
  fileHash: varchar("file_hash", { length: 64 }).notNull(),
  fileSize: integer("file_size").notNull(),
  s3Key: varchar("s3_key", { length: 500 }).notNull(),
  s3Url: varchar("s3_url", { length: 1000 }).notNull(),
  detectedModule: varchar("detected_module", { length: 100 }),
  uploadedAt: bigint("uploaded_at", { mode: "number" }).notNull(),
});

// ─── Analysis Results ───────────────────────────────────────────────────
export const analysisResults = pgTable("analysis_results", {
  id: varchar("id", { length: 36 }).primaryKey(),
  binaryId: varchar("binary_id", { length: 36 }),
  userId: varchar("user_id", { length: 36 }),
  filename: varchar("filename", { length: 500 }).notNull(),
  fileSize: integer("file_size").notNull(),
  fileType: varchar("file_type", { length: 100 }),
  detectedModule: varchar("detected_module", { length: 100 }),
  entropy: real("entropy"),
  confidence: real("confidence"),
  algorithmCount: integer("algorithm_count").default(0),
  seedKeyCount: integer("seed_key_count").default(0),
  canAddressCount: integer("can_address_count").default(0),
  checksumCount: integer("checksum_count").default(0),
  securityByteCount: integer("security_byte_count").default(0),
  stringCount: integer("string_count").default(0),
  summary: text("summary"),
  analysisData: jsonb("analysis_data"),
  status: varchar("status", { length: 16 }).default("running"),
  errorMessage: text("error_message"),
  analyzedAt: bigint("analyzed_at", { mode: "number" }).notNull(),
});

// ─── Pattern Library ────────────────────────────────────────────────────
export const patternLibrary = pgTable("pattern_library", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  sourceAnalysisId: varchar("source_analysis_id", { length: 36 }),
  category: varchar("category", { length: 32 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  patternData: text("pattern_data").notNull(),
  metadata: jsonb("metadata"),
  matchCount: integer("match_count").default(1),
  tags: jsonb("tags"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// ─── Knowledge Graph ────────────────────────────────────────────────────
export const kgNodes = pgTable("kg_nodes", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  nodeType: varchar("node_type", { length: 32 }).notNull(),
  label: varchar("label", { length: 500 }).notNull(),
  properties: jsonb("properties"),
  sourceAnalysisId: varchar("source_analysis_id", { length: 36 }),
  sourcePatternId: varchar("source_pattern_id", { length: 36 }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const kgEdges = pgTable("kg_edges", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  fromNodeId: varchar("from_node_id", { length: 36 }).notNull(),
  toNodeId: varchar("to_node_id", { length: 36 }).notNull(),
  edgeType: varchar("edge_type", { length: 32 }).notNull(),
  weight: real("weight").default(1.0),
  properties: jsonb("properties"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── Chat / Agents ──────────────────────────────────────────────────────
export const chatMessages = pgTable("chat_messages", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  role: varchar("role", { length: 20 }).notNull(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const agentMetrics = pgTable("agent_metrics", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 50 }).notNull(),
  codename: varchar("codename", { length: 50 }).notNull(),
  specialty: varchar("specialty", { length: 200 }),
  durationMs: integer("duration_ms").notNull(),
  toolCallCount: integer("tool_call_count").notNull(),
  iterations: integer("iterations").notNull(),
  findingsCount: integer("findings_count").default(0),
  error: text("error"),
  accuracyScore: real("accuracy_score").default(0.5),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const findingRatings = pgTable("finding_ratings", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 50 }).notNull(),
  findingIndex: integer("finding_index").notNull(),
  findingCategory: varchar("finding_category", { length: 100 }).notNull(),
  rating: varchar("rating", { length: 8 }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── Relations ──────────────────────────────────────────────────────────
export const binaryRelations = relations(uploadedBinaries, ({ many }) => ({
  analyses: many(analysisResults),
}));

export const analysisRelations = relations(analysisResults, ({ one }) => ({
  binary: one(uploadedBinaries, {
    fields: [analysisResults.binaryId],
    references: [uploadedBinaries.id],
  }),
}));

export const patternLibraryRelations = relations(patternLibrary, ({ one }) => ({
  sourceAnalysis: one(analysisResults, {
    fields: [patternLibrary.sourceAnalysisId],
    references: [analysisResults.id],
  }),
}));

export const kgNodeRelations = relations(kgNodes, ({ many }) => ({
  outgoingEdges: many(kgEdges, { relationName: "fromNode" }),
  incomingEdges: many(kgEdges, { relationName: "toNode" }),
}));

export const kgEdgeRelations = relations(kgEdges, ({ one }) => ({
  fromNode: one(kgNodes, {
    fields: [kgEdges.fromNodeId],
    references: [kgNodes.id],
    relationName: "fromNode",
  }),
  toNode: one(kgNodes, {
    fields: [kgEdges.toNodeId],
    references: [kgNodes.id],
    relationName: "toNode",
  }),
}));

// ─── Batch ──────────────────────────────────────────────────────────────
export const batchJobs = pgTable("batch_jobs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  status: varchar("status", { length: 16 }).default("pending"),
  totalFiles: integer("total_files").notNull(),
  completedFiles: integer("completed_files").default(0),
  failedFiles: integer("failed_files").default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  completedAt: bigint("completed_at", { mode: "number" }),
});

export const batchItems = pgTable("batch_items", {
  id: varchar("id", { length: 36 }).primaryKey(),
  batchId: varchar("batch_id", { length: 36 }).notNull(),
  filename: varchar("filename", { length: 500 }).notNull(),
  fileSize: integer("file_size").notNull(),
  s3Key: varchar("s3_key", { length: 500 }).notNull(),
  status: varchar("status", { length: 16 }).default("queued"),
  analysisId: varchar("analysis_id", { length: 36 }),
  error: text("error"),
  startedAt: bigint("started_at", { mode: "number" }),
  completedAt: bigint("completed_at", { mode: "number" }),
  orderIndex: integer("order_index").notNull(),
});

export const batchJobRelations = relations(batchJobs, ({ many }) => ({
  items: many(batchItems),
}));

export const batchItemRelations = relations(batchItems, ({ one }) => ({
  batch: one(batchJobs, {
    fields: [batchItems.batchId],
    references: [batchJobs.id],
  }),
  analysis: one(analysisResults, {
    fields: [batchItems.analysisId],
    references: [analysisResults.id],
  }),
}));

// ─── Share Links ────────────────────────────────────────────────────────
export const shareLinks = pgTable("share_links", {
  id: varchar("id", { length: 36 }).primaryKey(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  label: varchar("label", { length: 255 }),
  expiresAt: bigint("expires_at", { mode: "number" }),
  reminderWindowDays: integer("reminder_window_days").default(3),
  lastReminderSentAt: bigint("last_reminder_sent_at", { mode: "number" }),
  revokedAt: bigint("revoked_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const shareLinkViews = pgTable("share_link_views", {
  id: varchar("id", { length: 36 }).primaryKey(),
  linkId: varchar("link_id", { length: 36 }).notNull(),
  viewedAt: bigint("viewed_at", { mode: "number" }).notNull(),
  ipHash: varchar("ip_hash", { length: 64 }),
  userAgent: varchar("user_agent", { length: 500 }),
  country: varchar("country", { length: 10 }),
});

export const keyFindingDismissals = pgTable("key_finding_dismissals", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  findingId: varchar("finding_id", { length: 200 }).notNull(),
  userId: varchar("user_id", { length: 36 }),
  dismissedAt: bigint("dismissed_at", { mode: "number" }).notNull(),
});

// ─── AI Learning ────────────────────────────────────────────────────────
export const userProfile = pgTable("user_profile", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull().unique(),
  totalSessions: integer("total_sessions").notNull().default(0),
  knownModules: jsonb("known_modules"),
  knownAlgorithms: jsonb("known_algorithms"),
  knownPatterns: jsonb("known_patterns"),
  expertiseSummary: text("expertise_summary"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const analysisGoals = pgTable("analysis_goals", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull().unique(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  userInstructions: text("user_instructions"),
  summary: text("summary"),
  keyFindings: jsonb("key_findings"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── YARA + Analysis Files ──────────────────────────────────────────────
export const yaraRules = pgTable("yara_rules", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  fileSize: integer("file_size").notNull(),
  ruleCount: integer("rule_count").notNull().default(0),
  storageKey: varchar("storage_key", { length: 500 }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const analysisFiles = pgTable("analysis_files", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  fileIndex: integer("file_index").notNull().default(0),
  filename: varchar("filename", { length: 500 }).notNull(),
  fileHash: varchar("file_hash", { length: 64 }).notNull(),
  fileSize: integer("file_size").notNull(),
  s3Key: varchar("s3_key", { length: 500 }).notNull(),
  s3Url: varchar("s3_url", { length: 1000 }).notNull(),
  fileType: varchar("file_type", { length: 100 }),
  uploadedAt: bigint("uploaded_at", { mode: "number" }).notNull(),
});
