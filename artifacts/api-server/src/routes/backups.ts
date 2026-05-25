import { Router, type IRouter } from "express";
import { sql, desc, eq } from "drizzle-orm";
import { db, moduleBackupsTable, patternLibraryTable, kgNodesTable, kgEdgesTable } from "@workspace/db";
import { extractFromAnalysis } from "../lib/patternExtractor";

const router: IRouter = Router();

/**
 * Module backup snapshots.
 * Persists pre-write DID snapshots so backup history survives across browsers,
 * cleared site data, and multi-technician shop setups. The Backups tab in
 * srt-lab is the primary consumer; localStorage is used as an offline cache
 * that mirrors the server state.
 */

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_LIST = 200;
const MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB per backup

router.get("/backups", async (req, res, next) => {
  try {
    const moduleFilter = typeof req.query["module"] === "string" ? req.query["module"] : null;

    const baseQuery = db
      .select({
        id: moduleBackupsTable.id,
        module: moduleBackupsTable.module,
        vin: moduleBackupsTable.vin,
        didCount: moduleBackupsTable.didCount,
        tx: moduleBackupsTable.tx,
        rx: moduleBackupsTable.rx,
        timestamp: moduleBackupsTable.timestamp,
        checksum: moduleBackupsTable.checksum,
        snapshotKind: moduleBackupsTable.snapshotKind,
        preWriteKey: moduleBackupsTable.preWriteKey,
      })
      .from(moduleBackupsTable);

    const rows = moduleFilter
      ? await baseQuery
          .where(eq(moduleBackupsTable.module, moduleFilter))
          .orderBy(desc(moduleBackupsTable.timestamp))
          .limit(MAX_LIST)
      : await baseQuery
          .orderBy(desc(moduleBackupsTable.timestamp))
          .limit(MAX_LIST);

    res.json({
      backups: rows.map((r) => ({
        id: r.id,
        key: r.id,
        module: r.module,
        vin: r.vin,
        didCount: r.didCount,
        tx: r.tx,
        rx: r.rx,
        timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
        checksum: r.checksum ?? null,
        snapshotKind: r.snapshotKind ?? null,
        preWriteKey: r.preWriteKey ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/backups/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const rows = await db
      .select()
      .from(moduleBackupsTable)
      .where(eq(moduleBackupsTable.id, id))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: "not found" });
      return;
    }

    const row = rows[0]!;
    res.json({
      id: row.id,
      key: row.id,
      module: row.module,
      vin: row.vin,
      didCount: row.didCount,
      tx: row.tx,
      rx: row.rx,
      timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
      checksum: row.checksum ?? null,
      snapshotKind: row.snapshotKind ?? null,
      preWriteKey: row.preWriteKey ?? null,
      payload: row.payload,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/backups", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const id = typeof body.id === "string" ? body.id : typeof body.key === "string" ? body.key : "";
    const payload = body.payload ?? body.backup ?? null;

    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    if (!payload || typeof payload !== "object") {
      res.status(400).json({ error: "missing payload" });
      return;
    }

    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      res.status(413).json({ error: "payload too large" });
      return;
    }

    const moduleType =
      typeof body.module === "string" ? body.module :
      typeof payload.module === "string" ? payload.module : "UNKNOWN";
    const vin = typeof body.vin === "string" ? body.vin : "unknown";
    const didCount = Number.isFinite(body.didCount)
      ? Number(body.didCount)
      : (payload.dids && typeof payload.dids === "object"
          ? Object.values(payload.dids).filter((d: unknown) => {
              const dd = d as { bytes?: unknown[]; missing?: boolean } | null;
              return !!dd && !dd.missing && Array.isArray(dd.bytes) && dd.bytes.length > 0;
            }).length
          : 0);
    const tx = Number.isFinite(body.tx) ? Number(body.tx) :
              Number.isFinite(payload.tx) ? Number(payload.tx) : null;
    const rx = Number.isFinite(body.rx) ? Number(body.rx) :
              Number.isFinite(payload.rx) ? Number(payload.rx) : null;
    const tsRaw = body.timestamp ?? payload.timestamp ?? null;
    const ts = tsRaw ? new Date(tsRaw) : new Date();
    const timestamp = Number.isNaN(ts.getTime()) ? new Date() : ts;

    const checksum = typeof body.checksum === "string" ? body.checksum : null;
    const snapshotKind = typeof body.snapshotKind === "string" ? body.snapshotKind : null;
    const preWriteKey = typeof body.preWriteKey === "string" ? body.preWriteKey : null;

    await db
      .insert(moduleBackupsTable)
      .values({
        id,
        module: moduleType,
        vin,
        didCount,
        tx,
        rx,
        timestamp,
        payload,
        checksum,
        snapshotKind,
        preWriteKey,
      })
      .onConflictDoUpdate({
        target: moduleBackupsTable.id,
        set: {
          module: moduleType,
          vin,
          didCount,
          tx,
          rx,
          timestamp,
          payload,
          checksum,
          snapshotKind,
          preWriteKey,
        },
      });

    res.json({ id, key: id, ok: true });

    // Fire-and-forget: extract patterns + KG nodes/edges from the saved backup.
    // Runs after the response is sent so it never delays the client.
    setImmediate(async () => {
      try {
        const { patterns, nodes, edges } = extractFromAnalysis(
          { module: moduleType, vin, tx: tx ?? undefined, rx: rx ?? undefined, ...(payload as Record<string, unknown>) },
          id,
        );

        // Upsert patterns (dedup on category + signatureHash)
        const sourceIds = [id];
        for (const p of patterns) {
          await db
            .insert(patternLibraryTable)
            .values({
              category: p.category,
              label: p.label,
              signatureBytes: p.signatureBytes,
              signatureHash: p.signatureHash,
              confidence: p.confidence,
              notes: p.notes,
              sourceAnalysisIds: sourceIds,
            })
            .onConflictDoUpdate({
              target: [patternLibraryTable.category, patternLibraryTable.signatureHash],
              set: {
                confidence: p.confidence,
                updatedAt: new Date(),
                sourceAnalysisIds: sql`
                  (SELECT jsonb_agg(DISTINCT elem)
                   FROM jsonb_array_elements(
                     ${patternLibraryTable.sourceAnalysisIds}::jsonb || ${JSON.stringify(sourceIds)}::jsonb
                   ) AS elem)
                `,
              },
            });
        }

        // Upsert KG nodes and build a label→id map for edge insertion
        const nodeMap = new Map<string, string>();
        for (const n of nodes) {
          const existing = await db
            .select()
            .from(kgNodesTable)
            .where(sql`${kgNodesTable.nodeType} = ${n.nodeType} AND ${kgNodesTable.label} = ${n.label}`)
            .limit(1);
          let nodeId: string;
          if (existing.length > 0) {
            nodeId = existing[0]!.id;
          } else {
            const [ins] = await db
              .insert(kgNodesTable)
              .values({ nodeType: n.nodeType, label: n.label, metadata: n.metadata ?? {} })
              .returning();
            nodeId = ins!.id;
          }
          nodeMap.set(`${n.nodeType}:${n.label}`, nodeId);
        }

        // Insert KG edges (skip if either node wasn't upserted)
        for (const e of edges) {
          const fromId = nodeMap.get(`${e.fromType}:${e.fromLabel}`);
          const toId = nodeMap.get(`${e.toType}:${e.toLabel}`);
          if (!fromId || !toId) continue;
          const prior = await db
            .select()
            .from(kgEdgesTable)
            .where(eq(kgEdgesTable.fromNodeId, fromId))
            .limit(50);
          const dup = prior.some(
            (x) => x.toNodeId === toId && x.edgeType === e.edgeType,
          );
          if (!dup) {
            await db
              .insert(kgEdgesTable)
              .values({ fromNodeId: fromId, toNodeId: toId, edgeType: e.edgeType, meta: e.meta ?? {} });
          }
        }
      } catch (_err) {
        // Extraction errors must never affect the backup save response
      }
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/backups/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db.delete(moduleBackupsTable).where(eq(moduleBackupsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/backups", async (_req, res, next) => {
  try {
    await db.execute(sql`DELETE FROM ${moduleBackupsTable}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
