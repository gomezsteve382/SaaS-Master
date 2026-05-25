import {
  pgTable,
  text,
  real,
  timestamp,
  jsonb,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Pattern Library + Knowledge Graph (Task #695).
 *
 * `pattern_library` — deduplicated DB of byte-level signatures discovered
 * across every dump the bench has seen: VIN encodings, seed-key polynomial
 * constants, SKIM pairing layouts, calibration IDs, CRC tables, XOR keys.
 *
 * `kg_nodes` / `kg_edges` — knowledge-graph nodes (VINs, modules, algos,
 * CAN IDs, calibration IDs) and edges (seen-together, patched-from,
 * shares-secret-with). Lets the operator answer "where else have I seen
 * this VIN / constant?" without grepping the vault by hand.
 *
 * Dedup key: (category, signature_hash) — inserting a pattern with the
 * same hash within a category is an upsert.
 */

export const patternLibraryTable = pgTable(
  "pattern_library",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    category: text("category").notNull(),
    label: text("label").notNull(),
    signatureBytes: text("signature_bytes"),
    signatureHash: text("signature_hash").notNull(),
    sourceAnalysisIds: jsonb("source_analysis_ids").notNull().default([]),
    confidence: real("confidence").notNull().default(1.0),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    categoryIdx: index("pattern_library_category_idx").on(t.category),
    dedupIdx: uniqueIndex("pattern_library_dedup_idx").on(
      t.category,
      t.signatureHash,
    ),
    createdAtIdx: index("pattern_library_created_at_idx").on(t.createdAt),
  }),
);

export const kgNodesTable = pgTable(
  "kg_nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nodeType: text("node_type").notNull(),
    label: text("label").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nodeTypeIdx: index("kg_nodes_node_type_idx").on(t.nodeType),
    labelIdx: index("kg_nodes_label_idx").on(t.label),
  }),
);

export const kgEdgesTable = pgTable(
  "kg_edges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromNodeId: uuid("from_node_id")
      .notNull()
      .references(() => kgNodesTable.id, { onDelete: "cascade" }),
    toNodeId: uuid("to_node_id")
      .notNull()
      .references(() => kgNodesTable.id, { onDelete: "cascade" }),
    edgeType: text("edge_type").notNull(),
    meta: jsonb("meta").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    fromIdx: index("kg_edges_from_idx").on(t.fromNodeId),
    toIdx: index("kg_edges_to_idx").on(t.toNodeId),
    edgeTypeIdx: index("kg_edges_edge_type_idx").on(t.edgeType),
  }),
);

export type PatternLibraryEntry = typeof patternLibraryTable.$inferSelect;
export type KgNode = typeof kgNodesTable.$inferSelect;
export type KgEdge = typeof kgEdgesTable.$inferSelect;
