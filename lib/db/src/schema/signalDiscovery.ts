import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  real,
  boolean,
  index,
  uuid,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Signal Discovery (Task #625).
 *
 * Ports the TUMFTM "Holistic Approach for Automated Reverse Engineering of UDS
 * Data" methodology (DOI 10.3390/wevj16070384, Apache-2.0). Three workflows:
 *
 *   1. Sweep   — enumerate ECUs / sessions / DIDs on a vehicle bus.
 *   2. Record  — drive the car while capturing DID samples + ground-truth
 *                OBD-II PIDs into time-series experiments.
 *   3. Match   — correlation analysis to label DIDs by candidate decode.
 *
 * Everything is scoped per-VIN so a multi-vehicle bench stays clean.
 */

export const discoverySweepsTable = pgTable(
  "discovery_sweeps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vin: text("vin").notNull().default(""),
    label: text("label"),
    status: text("status").notNull().default("pending"),
    cursor: jsonb("cursor"),
    config: jsonb("config"),
    summary: jsonb("summary"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    vinIdx: index("discovery_sweeps_vin_idx").on(t.vin),
    startedAtIdx: index("discovery_sweeps_started_at_idx").on(t.startedAt),
  }),
);

export const discoveredEcusTable = pgTable(
  "discovered_ecus",
  {
    sweepId: uuid("sweep_id")
      .notNull()
      .references(() => discoverySweepsTable.id, { onDelete: "cascade" }),
    tx: integer("tx").notNull(),
    rx: integer("rx").notNull(),
    label: text("label"),
    sessions: jsonb("sessions"),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sweepId, t.tx, t.rx] }),
    txIdx: index("discovered_ecus_tx_idx").on(t.tx),
  }),
);

export const discoveredDidsTable = pgTable(
  "discovered_dids",
  {
    sweepId: uuid("sweep_id")
      .notNull()
      .references(() => discoverySweepsTable.id, { onDelete: "cascade" }),
    tx: integer("tx").notNull(),
    rx: integer("rx").notNull(),
    did: integer("did").notNull(),
    session: integer("session").notNull().default(0x01),
    length: integer("length"),
    sample: text("sample"),
    nrc: integer("nrc"),
    label: text("label"),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.sweepId, t.tx, t.rx, t.did, t.session],
    }),
    didIdx: index("discovered_dids_did_idx").on(t.did),
  }),
);

export const experimentsTable = pgTable(
  "discovery_experiments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vin: text("vin").notNull().default(""),
    name: text("name").notNull(),
    description: text("description"),
    targetTx: integer("target_tx").notNull(),
    targetRx: integer("target_rx").notNull(),
    didList: jsonb("did_list").notNull(),
    pidList: jsonb("pid_list").notNull(),
    pollIntervalMs: integer("poll_interval_ms").notNull().default(200),
    sampleCount: integer("sample_count").notNull().default(0),
    status: text("status").notNull().default("idle"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    vinIdx: index("discovery_experiments_vin_idx").on(t.vin),
  }),
);

export const experimentSamplesTable = pgTable(
  "discovery_experiment_samples",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experimentsTable.id, { onDelete: "cascade" }),
    tMs: integer("t_ms").notNull(),
    didValues: jsonb("did_values").notNull(),
    pidValues: jsonb("pid_values").notNull(),
  },
  (t) => ({
    expIdx: index("discovery_experiment_samples_exp_idx").on(t.experimentId),
    expTIdx: index("discovery_experiment_samples_exp_t_idx").on(
      t.experimentId,
      t.tMs,
    ),
  }),
);

export const didCatalogTable = pgTable(
  "discovery_did_catalog",
  {
    vin: text("vin").notNull().default(""),
    tx: integer("tx").notNull(),
    did: integer("did").notNull(),
    label: text("label").notNull(),
    decoder: text("decoder"),
    byteOffset: integer("byte_offset"),
    scale: real("scale"),
    offset: real("offset"),
    units: text("units"),
    sourceExperimentId: uuid("source_experiment_id").references(
      () => experimentsTable.id,
      { onDelete: "set null" },
    ),
    sourcePid: text("source_pid"),
    rSquared: real("r_squared"),
    confirmed: boolean("confirmed").notNull().default(false),
    notes: text("notes"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.vin, t.tx, t.did] }),
  }),
);

export type DiscoverySweep = typeof discoverySweepsTable.$inferSelect;
export type DiscoveredEcu = typeof discoveredEcusTable.$inferSelect;
export type DiscoveredDid = typeof discoveredDidsTable.$inferSelect;
export type DiscoveryExperiment = typeof experimentsTable.$inferSelect;
export type DiscoveryExperimentSample =
  typeof experimentSamplesTable.$inferSelect;
export type DiscoveryDidCatalogEntry = typeof didCatalogTable.$inferSelect;
