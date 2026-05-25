/**
 * Investigation Swarm routes.
 *
 * POST /anthropic/investigation/runs
 *   Start a new swarm run. Body: { dumpBase64, referenceName?, referenceBase64?, scope?, dumpName? }
 *   Returns: { id } — the run id for the SSE stream.
 *
 * GET  /anthropic/investigation/runs/:id/stream
 *   SSE stream of SwarmEvents for the given run.
 *   Close the connection to cancel the run.
 *
 * GET  /anthropic/investigation/runs
 *   List runs. Optional ?scope= filter.
 *
 * GET  /anthropic/investigation/runs/:id
 *   Fetch a single run (status, summary, findings).
 */

import { Router } from "express";
import { db } from "@workspace/db";
import {
  investigationRunsTable,
  investigationAgentFindingsTable,
} from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { runSwarm } from "./coordinator";
import { toSseFrame, type SwarmEvent } from "./sse";

const router = Router();

/* ── POST /anthropic/investigation/runs ─────────────────────────────── */

router.post("/investigation/runs", async (req, res) => {
  const {
    dumpBase64,
    dumpName,
    referenceBase64,
    referenceName,
    scope,
  } = req.body as {
    dumpBase64?: string;
    dumpName?: string;
    referenceBase64?: string;
    referenceName?: string;
    scope?: string;
  };

  if (!dumpBase64) {
    res.status(400).json({ error: "dumpBase64 is required" });
    return;
  }

  const primaryBuf = Buffer.from(dumpBase64, "base64");
  if (primaryBuf.length === 0) {
    res.status(400).json({ error: "dumpBase64 decoded to an empty buffer" });
    return;
  }

  const referenceBuf = referenceBase64
    ? Buffer.from(referenceBase64, "base64")
    : null;

  const [run] = await db
    .insert(investigationRunsTable)
    .values({
      scope: scope ?? null,
      dumpName: dumpName ?? "unknown.bin",
      dumpSize: primaryBuf.length,
      referenceName: referenceName ?? null,
      referenceSize: referenceBuf ? referenceBuf.length : null,
      status: "pending",
    })
    .returning();

  // Store the buffers in memory keyed by run id so the SSE stream can
  // retrieve them without re-parsing the request.
  pendingBuffers.set(run.id, {
    primary: primaryBuf,
    reference: referenceBuf,
  });

  res.status(201).json({ id: run.id });
});

/* ── In-memory buffer store (short-lived — cleared after stream ends) ── */

const pendingBuffers = new Map<
  string,
  { primary: Buffer; reference: Buffer | null }
>();

/* ── GET /anthropic/investigation/runs/:id/stream ───────────────────── */

router.get("/investigation/runs/:id/stream", async (req, res) => {
  const runId = req.params.id;

  const [run] = await db
    .select()
    .from(investigationRunsTable)
    .where(eq(investigationRunsTable.id, runId));

  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const bufs = pendingBuffers.get(runId);
  if (!bufs) {
    res.status(409).json({ error: "Run already started or buffer expired" });
    return;
  }

  pendingBuffers.delete(runId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const ac = new AbortController();
  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
    ac.abort();
  });

  const emit = (event: SwarmEvent) => {
    if (!clientGone) {
      res.write(toSseFrame(event));
    }
  };

  // Mark as running
  await db
    .update(investigationRunsTable)
    .set({ status: "running" })
    .where(eq(investigationRunsTable.id, runId));

  const binaries: Record<string, Buffer> = {};
  if (bufs.reference) binaries["reference"] = bufs.reference;

  try {
    const { findings, report } = await runSwarm(
      runId,
      bufs.primary,
      binaries,
      ac.signal,
      emit,
    );

    // Persist findings
    if (findings.length > 0) {
      await db.insert(investigationAgentFindingsTable).values(
        findings.map((f) => ({
          runId,
          agent: f.agent,
          findingType: f.findingType,
          description: f.description,
          offsets: f.offsets ?? null,
          confidence: f.confidence,
          status: f.status,
          raw: f as never,
        })),
      );
    }

    // Mark done
    const finalStatus = ac.signal.aborted ? "cancelled" : "completed";
    await db
      .update(investigationRunsTable)
      .set({
        status: finalStatus,
        summary: report as never,
        finishedAt: new Date(),
      })
      .where(eq(investigationRunsTable.id, runId));

    emit({ type: "done", runId, status: finalStatus });
    if (!clientGone) res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(investigationRunsTable)
      .set({ status: "error", finishedAt: new Date() })
      .where(eq(investigationRunsTable.id, runId));
    emit({ type: "error", runId, error: msg });
    if (!clientGone) res.end();
  }
});

/* ── GET /anthropic/investigation/runs ──────────────────────────────── */

router.get("/investigation/runs", async (req, res) => {
  const scope =
    typeof req.query.scope === "string" ? req.query.scope : undefined;
  const rows = scope
    ? await db
        .select()
        .from(investigationRunsTable)
        .where(eq(investigationRunsTable.scope, scope))
        .orderBy(desc(investigationRunsTable.startedAt))
    : await db
        .select()
        .from(investigationRunsTable)
        .orderBy(desc(investigationRunsTable.startedAt));
  res.json(rows);
});

/* ── GET /anthropic/investigation/runs/:id ──────────────────────────── */

router.get("/investigation/runs/:id", async (req, res) => {
  const runId = req.params.id;
  const [run] = await db
    .select()
    .from(investigationRunsTable)
    .where(eq(investigationRunsTable.id, runId));
  if (!run) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const findings = await db
    .select()
    .from(investigationAgentFindingsTable)
    .where(eq(investigationAgentFindingsTable.runId, runId));
  res.json({ ...run, findings });
});

/* ── DELETE /anthropic/investigation/runs/:id ───────────────────────── */

router.delete("/investigation/runs/:id", async (req, res) => {
  const runId = req.params.id;
  // Cancel in-flight run if its buffer is still pending
  pendingBuffers.delete(runId);
  const deleted = await db
    .delete(investigationRunsTable)
    .where(eq(investigationRunsTable.id, runId))
    .returning();
  if (!deleted.length) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

export default router;
