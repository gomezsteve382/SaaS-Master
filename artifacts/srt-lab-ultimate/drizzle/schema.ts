import { mysqlTable, text, int, float, json, bigint, varchar, mysqlEnum } from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm";

// ─── Users Table ──────────────────────────────────────────────────────

export const users = mysqlTable("users", {
  id: varchar("id", { length: 36 }).primaryKey(),
  openId: varchar("open_id", { length: 255 }).notNull().unique(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  role: mysqlEnum("role", ["admin", "user"]).default("user"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// ─── Uploaded Binaries Table ──────────────────────────────────────────

export const uploadedBinaries = mysqlTable("uploaded_binaries", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  filename: varchar("filename", { length: 500 }).notNull(),
  fileHash: varchar("file_hash", { length: 64 }).notNull(),
  fileSize: int("file_size").notNull(),
  s3Key: varchar("s3_key", { length: 500 }).notNull(),
  s3Url: varchar("s3_url", { length: 1000 }).notNull(),
  detectedModule: varchar("detected_module", { length: 100 }),
  uploadedAt: bigint("uploaded_at", { mode: "number" }).notNull(),
});

// ─── Analysis Results Table ───────────────────────────────────────────

export const analysisResults = mysqlTable("analysis_results", {
  id: varchar("id", { length: 36 }).primaryKey(),
  binaryId: varchar("binary_id", { length: 36 }),
  userId: varchar("user_id", { length: 36 }),
  filename: varchar("filename", { length: 500 }).notNull(),
  fileSize: int("file_size").notNull(),
  fileType: varchar("file_type", { length: 100 }),
  detectedModule: varchar("detected_module", { length: 100 }),
  entropy: float("entropy"),
  confidence: float("confidence"),
  algorithmCount: int("algorithm_count").default(0),
  seedKeyCount: int("seed_key_count").default(0),
  canAddressCount: int("can_address_count").default(0),
  checksumCount: int("checksum_count").default(0),
  securityByteCount: int("security_byte_count").default(0),
  stringCount: int("string_count").default(0),
  summary: text("summary"),
  analysisData: json("analysis_data"), // Full parsed result as JSON
  status: mysqlEnum("status", ["running", "complete", "failed"]).default("running"),
  errorMessage: text("error_message"),
  analyzedAt: bigint("analyzed_at", { mode: "number" }).notNull(),
});

// ─── Pattern Library Table ────────────────────────────────────────────
// Stores reusable patterns extracted from analyses (crypto constants,
// seed-key algorithms, CAN IDs, protocol sequences, etc.)

export const patternLibrary = mysqlTable("pattern_library", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  // Source analysis that first produced this pattern
  sourceAnalysisId: varchar("source_analysis_id", { length: 36 }),
  // Pattern classification
  category: mysqlEnum("category", [
    "crypto_algorithm",
    "seed_key",
    "can_id",
    "uds_service",
    "checksum",
    "memory_map",
    "string_pattern",
    "byte_sequence",
    "function_signature",
    "protocol_sequence",
    "other",
  ]).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  // The actual pattern data (hex bytes, regex, algorithm code, etc.)
  patternData: text("pattern_data").notNull(),
  // Optional metadata (offsets, confidence, module type, etc.)
  metadata: json("metadata"),
  // How many analyses have matched this pattern
  matchCount: int("match_count").default(1),
  // Tags for filtering (e.g. "chrysler", "aes128", "j2534")
  tags: json("tags"), // string[]
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// ─── Knowledge Graph Nodes Table ─────────────────────────────────────
// Each node is a discovered entity: a binary, an algorithm, a CAN ID,
// a seed-key function, a module type, etc.

export const kgNodes = mysqlTable("kg_nodes", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  nodeType: mysqlEnum("node_type", [
    "binary",
    "algorithm",
    "seed_key",
    "can_id",
    "module_type",
    "string",
    "function",
    "protocol",
    "checksum",
    "pattern",
  ]).notNull(),
  label: varchar("label", { length: 500 }).notNull(),
  properties: json("properties"), // arbitrary key-value metadata
  // Optional link back to source analysis or pattern
  sourceAnalysisId: varchar("source_analysis_id", { length: 36 }),
  sourcePatternId: varchar("source_pattern_id", { length: 36 }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── Knowledge Graph Edges Table ─────────────────────────────────────
// Directed relationships between nodes

export const kgEdges = mysqlTable("kg_edges", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  fromNodeId: varchar("from_node_id", { length: 36 }).notNull(),
  toNodeId: varchar("to_node_id", { length: 36 }).notNull(),
  // Relationship type
  edgeType: mysqlEnum("edge_type", [
    "contains",
    "uses",
    "implements",
    "matches",
    "derived_from",
    "similar_to",
    "communicates_with",
    "depends_on",
  ]).notNull(),
  weight: float("weight").default(1.0), // similarity/confidence score
  properties: json("properties"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── Relations ────────────────────────────────────────────────────

// ─── Chat Messages Table ────────────────────────────────────────────────
// Persists per-analysis chat history for the VENOM chat interface

export const chatMessages = mysqlTable("chat_messages", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  role: varchar("role", { length: 20 }).notNull(),
  content: text("content").notNull(),
  toolCalls: json("tool_calls"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── Agent Metrics Table ─────────────────────────────────────────────
// Stores per-agent performance data for each analysis run

export const agentMetrics = mysqlTable("agent_metrics", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 50 }).notNull(),
  codename: varchar("codename", { length: 50 }).notNull(),
  specialty: varchar("specialty", { length: 200 }),
  durationMs: int("duration_ms").notNull(),
  toolCallCount: int("tool_call_count").notNull(),
  iterations: int("iterations").notNull(),
  findingsCount: int("findings_count").default(0),
  error: text("error"),
  // Accuracy score derived from user feedback (0.0 - 1.0)
  accuracyScore: float("accuracy_score").default(0.5),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── Finding Ratings Table ───────────────────────────────────────────
// User feedback on individual findings (thumbs up/down)

export const findingRatings = mysqlTable("finding_ratings", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  agentId: varchar("agent_id", { length: 50 }).notNull(),
  findingIndex: int("finding_index").notNull(),
  findingCategory: varchar("finding_category", { length: 100 }).notNull(),
  rating: mysqlEnum("rating", ["up", "down"]).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

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

// ─── Batch Analysis Jobs ─────────────────────────────────────────────

export const batchJobs = mysqlTable("batch_jobs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  status: mysqlEnum("status", ["pending", "running", "complete", "failed"]).default("pending"),
  totalFiles: int("total_files").notNull(),
  completedFiles: int("completed_files").default(0),
  failedFiles: int("failed_files").default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  completedAt: bigint("completed_at", { mode: "number" }),
});

export const batchItems = mysqlTable("batch_items", {
  id: varchar("id", { length: 36 }).primaryKey(),
  batchId: varchar("batch_id", { length: 36 }).notNull(),
  filename: varchar("filename", { length: 500 }).notNull(),
  fileSize: int("file_size").notNull(),
  s3Key: varchar("s3_key", { length: 500 }).notNull(),
  status: mysqlEnum("status", ["queued", "running", "complete", "failed"]).default("queued"),
  analysisId: varchar("analysis_id", { length: 36 }),
  error: text("error"),
  startedAt: bigint("started_at", { mode: "number" }),
  completedAt: bigint("completed_at", { mode: "number" }),
  orderIndex: int("order_index").notNull(),
});

// ─── Share Links Table ──────────────────────────────────────────────
// Shareable links for analysis results with optional expiry
export const shareLinks = mysqlTable("share_links", {
  id: varchar("id", { length: 36 }).primaryKey(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  label: varchar("label", { length: 255 }),
  expiresAt: bigint("expires_at", { mode: "number" }),
  reminderWindowDays: int("reminder_window_days").default(3),
  lastReminderSentAt: bigint("last_reminder_sent_at", { mode: "number" }),
  revokedAt: bigint("revoked_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── Share Link Views Table ───────────────────────────────────────────
// Tracks each time a share link is accessed
export const shareLinkViews = mysqlTable("share_link_views", {
  id: varchar("id", { length: 36 }).primaryKey(),
  linkId: varchar("link_id", { length: 36 }).notNull(),
  viewedAt: bigint("viewed_at", { mode: "number" }).notNull(),
  ipHash: varchar("ip_hash", { length: 64 }),
  userAgent: varchar("user_agent", { length: 500 }),
  country: varchar("country", { length: 10 }),
});

// ─── Key Finding Dismissals Table ───────────────────────────────────
// Tracks which key/secret findings the user has dismissed per analysis
export const keyFindingDismissals = mysqlTable("key_finding_dismissals", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  findingId: varchar("finding_id", { length: 200 }).notNull(),
  userId: varchar("user_id", { length: 36 }),
  dismissedAt: bigint("dismissed_at", { mode: "number" }).notNull(),
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

// ─── YARA Rules Table ─────────────────────────────────────────────────
// User-uploaded custom YARA rule sets for pattern matching during analysis
export const yaraRules = mysqlTable("yara_rules", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 36 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  fileSize: int("file_size").notNull(),
  ruleCount: int("rule_count").notNull().default(0),
  storageKey: varchar("storage_key", { length: 500 }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── Analysis Files Table ─────────────────────────────────────────────
// Tracks additional files attached to an existing analysis session.
// The primary file is stored in uploaded_binaries; extra files go here.
export const analysisFiles = mysqlTable("analysis_files", {
  id: varchar("id", { length: 36 }).primaryKey(),
  analysisId: varchar("analysis_id", { length: 36 }).notNull(),
  fileIndex: int("file_index").notNull().default(0), // 0 = first additional, 1 = second, etc.
  filename: varchar("filename", { length: 500 }).notNull(),
  fileHash: varchar("file_hash", { length: 64 }).notNull(),
  fileSize: int("file_size").notNull(),
  s3Key: varchar("s3_key", { length: 500 }).notNull(),
  s3Url: varchar("s3_url", { length: 1000 }).notNull(),
  fileType: varchar("file_type", { length: 100 }),
  uploadedAt: bigint("uploaded_at", { mode: "number" }).notNull(),
});
