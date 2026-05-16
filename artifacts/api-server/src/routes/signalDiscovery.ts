import { Router, type IRouter, type Response } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
// Import the generated Zod schemas directly because the api-zod barrel
// also re-exports `./generated/types` which collides on a few `*Body`
// names (TS2308) and hides the runtime schemas.
import {
  CreateDiscoverySweepBody,
  UpdateDiscoverySweepBody,
  AppendDiscoveredEcusBody,
  AppendDiscoveredDidsBody,
  CreateDiscoveryExperimentBody,
  UpdateDiscoveryExperimentBody,
  AppendDiscoveryExperimentSamplesBody,
  UpsertDiscoveryCatalogEntryBody,
} from "@workspace/api-zod/schemas";
import {
  db,
  discoverySweepsTable,
  discoveredEcusTable,
  discoveredDidsTable,
  experimentsTable,
  experimentSamplesTable,
  didCatalogTable,
  type DiscoverySweep,
  type DiscoveredEcu,
  type DiscoveredDid,
  type DiscoveryExperiment,
  type DiscoveryExperimentSample,
  type DiscoveryDidCatalogEntry,
} from "@workspace/db";

/** Validate a request body against a Zod schema; on failure, write a 400
 * response with `{ error, issues }` and return null so the caller can
 * early-exit. Centralised so every route gets the same shape. */
function parseBody<T>(
  schema: z.ZodSchema<T>,
  raw: unknown,
  res: Response,
): T | null {
  const r = schema.safeParse(raw);
  if (!r.success) {
    res.status(400).json({ error: "invalid body", issues: r.error.issues });
    return null;
  }
  return r.data;
}

/**
 * Signal Discovery routes (Task #625).
 *
 * Persistence for the TUMFTM "Holistic Approach" port: sweeps + their
 * discovered ECUs/DIDs, recorded experiments + samples, and the resulting
 * labelled DID catalog. All scoped per VIN.
 */

const router: IRouter = Router();

const MAX_VIN_LEN = 32;
const MAX_LABEL_LEN = 128;
const MAX_LIST = 500;
const MAX_BATCH = 1000;

function normVin(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.toUpperCase().replace(/\s+/g, "").slice(0, MAX_VIN_LEN);
}

function coerceU16(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  if (n < 0 || n > 0xffff) return null;
  return n;
}

function coerceU8(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  if (n < 0 || n > 0xff) return null;
  return n;
}

function coerceLabel(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  return v.slice(0, MAX_LABEL_LEN);
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

/* ──────────────────────────── Sweeps ───────────────────────────── */

function sweepToJson(row: DiscoverySweep) {
  return {
    id: row.id,
    vin: row.vin,
    label: row.label,
    status: row.status,
    cursor: row.cursor,
    config: row.config,
    summary: row.summary,
    startedAt:
      row.startedAt instanceof Date
        ? row.startedAt.toISOString()
        : row.startedAt,
    finishedAt:
      row.finishedAt instanceof Date
        ? row.finishedAt.toISOString()
        : row.finishedAt,
  };
}

router.get("/signal-discovery/sweeps", async (req, res, next) => {
  try {
    const vinFilter =
      typeof req.query["vin"] === "string" ? normVin(req.query["vin"]) : null;
    const base = db.select().from(discoverySweepsTable);
    const rows = vinFilter
      ? await base
          .where(eq(discoverySweepsTable.vin, vinFilter))
          .orderBy(desc(discoverySweepsTable.startedAt))
          .limit(MAX_LIST)
      : await base
          .orderBy(desc(discoverySweepsTable.startedAt))
          .limit(MAX_LIST);
    res.json({ sweeps: rows.map(sweepToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/signal-discovery/sweeps", async (req, res, next) => {
  try {
    const body = parseBody(CreateDiscoverySweepBody, req.body, res);
    if (!body) return;
    const vin = normVin(body.vin);
    const label = coerceLabel(body.label);
    const config = body.config ?? null;
    const [row] = await db
      .insert(discoverySweepsTable)
      .values({ vin, label, config, status: "pending" })
      .returning();
    if (!row) {
      res.status(500).json({ error: "insert failed" });
      return;
    }
    res.status(201).json(sweepToJson(row));
  } catch (err) {
    next(err);
  }
});

router.get("/signal-discovery/sweeps/:id", async (req, res, next) => {
  try {
    const id = req.params["id"];
    if (!id || !isUuid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const [sweep] = await db
      .select()
      .from(discoverySweepsTable)
      .where(eq(discoverySweepsTable.id, id))
      .limit(1);
    if (!sweep) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const ecus = await db
      .select()
      .from(discoveredEcusTable)
      .where(eq(discoveredEcusTable.sweepId, id));
    const dids = await db
      .select()
      .from(discoveredDidsTable)
      .where(eq(discoveredDidsTable.sweepId, id));
    res.json({
      sweep: sweepToJson(sweep),
      ecus: ecus.map((e: DiscoveredEcu) => ({
        sweepId: e.sweepId,
        tx: e.tx,
        rx: e.rx,
        label: e.label,
        sessions: e.sessions,
        detectedAt:
          e.detectedAt instanceof Date
            ? e.detectedAt.toISOString()
            : e.detectedAt,
      })),
      dids: dids.map((d: DiscoveredDid) => ({
        sweepId: d.sweepId,
        tx: d.tx,
        rx: d.rx,
        did: d.did,
        session: d.session,
        length: d.length,
        sample: d.sample,
        nrc: d.nrc,
        label: d.label,
        detectedAt:
          d.detectedAt instanceof Date
            ? d.detectedAt.toISOString()
            : d.detectedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/signal-discovery/sweeps/:id", async (req, res, next) => {
  try {
    const id = req.params["id"];
    if (!id || !isUuid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const body = parseBody(UpdateDiscoverySweepBody, req.body, res);
    if (!body) return;
    const patch: Partial<DiscoverySweep> = {};
    if (typeof body.status === "string") patch.status = body.status.slice(0, 32);
    if (body.cursor !== undefined) patch.cursor = body.cursor;
    if (body.summary !== undefined) patch.summary = body.summary;
    if (body.finishedAt) patch.finishedAt = new Date(body.finishedAt);
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "nothing to update" });
      return;
    }
    const [row] = await db
      .update(discoverySweepsTable)
      .set(patch)
      .where(eq(discoverySweepsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(sweepToJson(row));
  } catch (err) {
    next(err);
  }
});

router.delete("/signal-discovery/sweeps/:id", async (req, res, next) => {
  try {
    const id = req.params["id"];
    if (!id || !isUuid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db.delete(discoverySweepsTable).where(eq(discoverySweepsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/signal-discovery/sweeps/:id/ecus", async (req, res, next) => {
  try {
    const id = req.params["id"];
    if (!id || !isUuid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const body = parseBody(AppendDiscoveredEcusBody, req.body, res);
    if (!body) return;
    const incoming = body.ecus;
    if (incoming.length === 0) {
      res.json({ ok: true, inserted: 0 });
      return;
    }
    if (incoming.length > MAX_BATCH) {
      res.status(400).json({ error: `max ${MAX_BATCH} per batch` });
      return;
    }
    const rows = incoming.map((e) => ({
      sweepId: id,
      tx: e.tx,
      rx: e.rx,
      label: coerceLabel(e.label) ?? null,
      sessions: e.sessions ?? null,
    }));
    if (rows.length === 0) {
      res.json({ ok: true, inserted: 0 });
      return;
    }
    // Use Postgres `excluded.*` so each conflicting row updates from
    // its own incoming values, not the first row's. Drizzle exposes
    // this via the `sql` builder.
    await db
      .insert(discoveredEcusTable)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          discoveredEcusTable.sweepId,
          discoveredEcusTable.tx,
          discoveredEcusTable.rx,
        ],
        set: {
          label: sql`excluded.label`,
          sessions: sql`excluded.sessions`,
          detectedAt: new Date(),
        },
      });
    res.json({ ok: true, inserted: rows.length });
  } catch (err) {
    next(err);
  }
});

router.post("/signal-discovery/sweeps/:id/dids", async (req, res, next) => {
  try {
    const id = req.params["id"];
    if (!id || !isUuid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const body = parseBody(AppendDiscoveredDidsBody, req.body, res);
    if (!body) return;
    const incoming = body.dids;
    if (incoming.length === 0) {
      res.json({ ok: true, inserted: 0 });
      return;
    }
    if (incoming.length > MAX_BATCH) {
      res.status(400).json({ error: `max ${MAX_BATCH} per batch` });
      return;
    }
    let inserted = 0;
    for (const e of incoming) {
      const tx = e.tx;
      const rx = e.rx;
      const did = e.did;
      const session = e.session ?? 0x01;
      const length = e.length ?? null;
      const sample = e.sample ?? null;
      const nrc = e.nrc ?? null;
      const label = coerceLabel(e.label) ?? null;
      await db
        .insert(discoveredDidsTable)
        .values({
          sweepId: id,
          tx,
          rx,
          did,
          session,
          length,
          sample,
          nrc,
          label,
        })
        .onConflictDoUpdate({
          target: [
            discoveredDidsTable.sweepId,
            discoveredDidsTable.tx,
            discoveredDidsTable.rx,
            discoveredDidsTable.did,
            discoveredDidsTable.session,
          ],
          set: { length, sample, nrc, label, detectedAt: new Date() },
        });
      inserted++;
    }
    res.json({ ok: true, inserted });
  } catch (err) {
    next(err);
  }
});

/* ─────────────────────────── Experiments ───────────────────────── */

function expToJson(row: DiscoveryExperiment) {
  return {
    id: row.id,
    vin: row.vin,
    name: row.name,
    description: row.description,
    targetTx: row.targetTx,
    targetRx: row.targetRx,
    didList: row.didList,
    pidList: row.pidList,
    pollIntervalMs: row.pollIntervalMs,
    sampleCount: row.sampleCount,
    status: row.status,
    startedAt:
      row.startedAt instanceof Date
        ? row.startedAt.toISOString()
        : row.startedAt,
    finishedAt:
      row.finishedAt instanceof Date
        ? row.finishedAt.toISOString()
        : row.finishedAt,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.createdAt,
  };
}

router.get("/signal-discovery/experiments", async (req, res, next) => {
  try {
    const vinFilter =
      typeof req.query["vin"] === "string" ? normVin(req.query["vin"]) : null;
    const base = db.select().from(experimentsTable);
    const rows = vinFilter
      ? await base
          .where(eq(experimentsTable.vin, vinFilter))
          .orderBy(desc(experimentsTable.createdAt))
          .limit(MAX_LIST)
      : await base
          .orderBy(desc(experimentsTable.createdAt))
          .limit(MAX_LIST);
    res.json({ experiments: rows.map(expToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/signal-discovery/experiments", async (req, res, next) => {
  try {
    const body = parseBody(CreateDiscoveryExperimentBody, req.body, res);
    if (!body) return;
    const name = body.name.slice(0, 128);
    const targetTx = body.targetTx;
    const targetRx = body.targetRx;
    const didList = body.didList ?? [];
    const pidList = body.pidList ?? [];
    const pollIntervalMs = body.pollIntervalMs
      ? Math.min(60000, Math.trunc(body.pollIntervalMs))
      : 200;
    const [row] = await db
      .insert(experimentsTable)
      .values({
        vin: normVin(body.vin),
        name,
        description: body.description ? body.description.slice(0, 1024) : null,
        targetTx,
        targetRx,
        didList,
        pidList,
        pollIntervalMs,
      })
      .returning();
    if (!row) {
      res.status(500).json({ error: "insert failed" });
      return;
    }
    res.status(201).json(expToJson(row));
  } catch (err) {
    next(err);
  }
});

router.get("/signal-discovery/experiments/:id", async (req, res, next) => {
  try {
    const id = req.params["id"];
    if (!id || !isUuid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const [exp] = await db
      .select()
      .from(experimentsTable)
      .where(eq(experimentsTable.id, id))
      .limit(1);
    if (!exp) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const samples = await db
      .select()
      .from(experimentSamplesTable)
      .where(eq(experimentSamplesTable.experimentId, id))
      .orderBy(experimentSamplesTable.tMs);
    res.json({
      experiment: expToJson(exp),
      samples: samples.map((s: DiscoveryExperimentSample) => ({
        id: s.id,
        experimentId: s.experimentId,
        tMs: s.tMs,
        didValues: s.didValues,
        pidValues: s.pidValues,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/signal-discovery/experiments/:id", async (req, res, next) => {
  try {
    const id = req.params["id"];
    if (!id || !isUuid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const body = parseBody(UpdateDiscoveryExperimentBody, req.body, res);
    if (!body) return;
    const patch: Partial<DiscoveryExperiment> = {};
    if (typeof body.status === "string") patch.status = body.status.slice(0, 32);
    if (body.startedAt) patch.startedAt = new Date(body.startedAt);
    if (body.finishedAt) patch.finishedAt = new Date(body.finishedAt);
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "nothing to update" });
      return;
    }
    const [row] = await db
      .update(experimentsTable)
      .set(patch)
      .where(eq(experimentsTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(expToJson(row));
  } catch (err) {
    next(err);
  }
});

router.delete("/signal-discovery/experiments/:id", async (req, res, next) => {
  try {
    const id = req.params["id"];
    if (!id || !isUuid(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db.delete(experimentsTable).where(eq(experimentsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/signal-discovery/experiments/:id/samples",
  async (req, res, next) => {
    try {
      const id = req.params["id"];
      if (!id || !isUuid(id)) {
        res.status(400).json({ error: "invalid id" });
        return;
      }
      const body = parseBody(AppendDiscoveryExperimentSamplesBody, req.body, res);
      if (!body) return;
      const incoming = body.samples;
      if (incoming.length === 0) {
        res.json({ ok: true, inserted: 0 });
        return;
      }
      if (incoming.length > MAX_BATCH) {
        res.status(400).json({ error: `max ${MAX_BATCH} per batch` });
        return;
      }
      const rows = incoming.map((s) => ({
        experimentId: id,
        tMs: Math.trunc(s.tMs),
        didValues: s.didValues ?? {},
        pidValues: s.pidValues ?? {},
      }));
      if (rows.length === 0) {
        res.json({ ok: true, inserted: 0 });
        return;
      }
      await db.insert(experimentSamplesTable).values(rows);
      // Bump cached sample count.
      await db
        .update(experimentsTable)
        .set({ sampleCount: (await countSamples(id)) })
        .where(eq(experimentsTable.id, id));
      res.json({ ok: true, inserted: rows.length });
    } catch (err) {
      next(err);
    }
  },
);

async function countSamples(experimentId: string): Promise<number> {
  const rows = await db
    .select()
    .from(experimentSamplesTable)
    .where(eq(experimentSamplesTable.experimentId, experimentId));
  return rows.length;
}

/* ───────────────────────── DID Catalog ─────────────────────────── */

function catToJson(row: DiscoveryDidCatalogEntry) {
  return {
    vin: row.vin,
    tx: row.tx,
    did: row.did,
    label: row.label,
    decoder: row.decoder,
    byteOffset: row.byteOffset,
    scale: row.scale,
    offset: row.offset,
    units: row.units,
    sourceExperimentId: row.sourceExperimentId,
    sourcePid: row.sourcePid,
    rSquared: row.rSquared,
    confirmed: row.confirmed,
    notes: row.notes,
    updatedAt:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : row.updatedAt,
  };
}

router.get("/signal-discovery/catalog", async (req, res, next) => {
  try {
    const vinFilter =
      typeof req.query["vin"] === "string" ? normVin(req.query["vin"]) : null;
    const base = db.select().from(didCatalogTable);
    const rows = vinFilter
      ? await base.where(eq(didCatalogTable.vin, vinFilter)).limit(MAX_LIST)
      : await base.limit(MAX_LIST);
    res.json({ entries: rows.map(catToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/signal-discovery/catalog", async (req, res, next) => {
  try {
    const body = parseBody(UpsertDiscoveryCatalogEntryBody, req.body, res);
    if (!body) return;
    const tx = body.tx;
    const did = body.did;
    const label = body.label.slice(0, MAX_LABEL_LEN);
    const vin = normVin(body.vin);
    const values = {
      vin,
      tx,
      did,
      label,
      decoder: body.decoder ? body.decoder.slice(0, 32) : null,
      byteOffset:
        typeof body.byteOffset === "number" ? Math.trunc(body.byteOffset) : null,
      scale: typeof body.scale === "number" ? body.scale : null,
      offset: typeof body.offset === "number" ? body.offset : null,
      units: body.units ? body.units.slice(0, 32) : null,
      sourceExperimentId:
        body.sourceExperimentId && isUuid(body.sourceExperimentId)
          ? body.sourceExperimentId
          : null,
      sourcePid: body.sourcePid ? body.sourcePid.slice(0, 32) : null,
      rSquared: typeof body.rSquared === "number" ? body.rSquared : null,
      confirmed: body.confirmed === true,
      notes: body.notes ? body.notes.slice(0, 1024) : null,
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(didCatalogTable)
      .values(values)
      .onConflictDoUpdate({
        target: [didCatalogTable.vin, didCatalogTable.tx, didCatalogTable.did],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    if (!row) {
      res.status(500).json({ error: "upsert failed" });
      return;
    }
    res.json(catToJson(row));
  } catch (err) {
    next(err);
  }
});

export default router;
