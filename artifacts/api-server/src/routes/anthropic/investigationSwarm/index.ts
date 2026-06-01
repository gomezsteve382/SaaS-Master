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
  investigationRunPublicColumns,
} from "@workspace/db";
import { eq, desc, and, lt, isNotNull } from "drizzle-orm";
import { runSwarm } from "./coordinator";
import { toSseFrame, type SwarmEvent } from "./sse";
import { logger } from "../../../lib/logger";

const router = Router();

/* ── Durable buffer storage (Task #937) ─────────────────────────────────
 *
 * Uploaded dump buffers used to live in an in-memory `Map`. If the API
 * server restarted between the POST that created a run and the SSE GET that
 * consumes it, the buffer was lost and the run failed silently. Buffers are
 * now persisted on the `investigation_runs` row as `bytea` with a TTL, so a
 * run survives a restart. The buffers are cleared once the run finishes or
 * after the TTL passes.
 */

/** How long an uploaded buffer is retained before the TTL sweep clears it. */
const BUFFER_TTL_MS = 30 * 60 * 1000;

/** How often the TTL sweep runs. */
const BUFFER_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * In-process guard so two concurrent SSE GETs for the same run id (e.g. a
 * client reconnect while the first stream is still alive) don't both kick off
 * the swarm. This is a best-effort de-dupe only — durability comes from the
 * DB-backed buffers, not from this set.
 */
const activeStreams = new Set<string>();

/** Delete buffers that have outlived their TTL. */
async function sweepExpiredBuffers(): Promise<void> {
  try {
    await db
      .update(investigationRunsTable)
      .set({ primaryBuffer: null, referenceBuffer: null, bufferExpiresAt: null })
      .where(
        and(
          isNotNull(investigationRunsTable.bufferExpiresAt),
          lt(investigationRunsTable.bufferExpiresAt, new Date()),
        ),
      );
  } catch (err) {
    logger.error(
      { err },
      "investigation swarm: failed to sweep expired buffers",
    );
  }
}

const bufferSweepTimer = setInterval(() => {
  void sweepExpiredBuffers();
}, BUFFER_SWEEP_INTERVAL_MS);
// Don't keep the event loop alive solely for the sweep (matters for tests).
bufferSweepTimer.unref();
// Run one sweep on startup so a restart also clears anything already expired.
void sweepExpiredBuffers();

/** Clear the persisted buffers for a finished/abandoned run. */
async function clearBuffers(runId: string): Promise<void> {
  await db
    .update(investigationRunsTable)
    .set({ primaryBuffer: null, referenceBuffer: null, bufferExpiresAt: null })
    .where(eq(investigationRunsTable.id, runId));
}

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

  // Persist the buffers on the run row so the SSE stream can retrieve them
  // even if the server restarts between this POST and the GET (Task #937).
  const [run] = await db
    .insert(investigationRunsTable)
    .values({
      scope: scope ?? null,
      dumpName: dumpName ?? "unknown.bin",
      dumpSize: primaryBuf.length,
      referenceName: referenceName ?? null,
      referenceSize: referenceBuf ? referenceBuf.length : null,
      status: "pending",
      primaryBuffer: primaryBuf,
      referenceBuffer: referenceBuf,
      bufferExpiresAt: new Date(Date.now() + BUFFER_TTL_MS),
    })
    .returning({ id: investigationRunsTable.id });

  res.status(201).json({ id: run.id });
});

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

  // Always upgrade to an SSE stream first so the client (which uses
  // EventSource) can read a structured event for any failure mode instead of
  // hanging on a non-200 response.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let clientGone = false;
  const emit = (event: SwarmEvent) => {
    if (!clientGone) {
      res.write(toSseFrame(event));
    }
  };
  res.on("close", () => {
    clientGone = true;
  });

  // The buffer is gone — either the TTL swept it, the run already ran (buffers
  // are cleared on completion), or it was never persisted. Tell the client to
  // re-upload instead of leaving the connection hanging (Task #937).
  const primaryBuffer = run.primaryBuffer;
  const expired =
    run.bufferExpiresAt != null && run.bufferExpiresAt.getTime() < Date.now();
  if (!primaryBuffer || primaryBuffer.length === 0 || expired) {
    emit({
      type: "buffer_not_found",
      runId,
      error:
        "Server restarted or the upload expired during analysis — please re-upload the dump to start a new run.",
    });
    if (expired) void clearBuffers(runId);
    if (!clientGone) res.end();
    return;
  }

  // Best-effort guard against a duplicate concurrent stream for the same run.
  if (activeStreams.has(runId)) {
    emit({
      type: "buffer_not_found",
      runId,
      error: "This run is already being streamed in another connection.",
    });
    if (!clientGone) res.end();
    return;
  }
  activeStreams.add(runId);

  const ac = new AbortController();
  res.on("close", () => {
    ac.abort();
  });

  // Mark as running
  await db
    .update(investigationRunsTable)
    .set({ status: "running" })
    .where(eq(investigationRunsTable.id, runId));

  const binaries: Record<string, Buffer> = {};
  if (run.referenceBuffer && run.referenceBuffer.length > 0) {
    binaries["reference"] = run.referenceBuffer;
  }

  try {
    const { findings, report } = await runSwarm(
      runId,
      primaryBuffer,
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

    // Mark done and drop the now-consumed buffers from durable storage.
    const finalStatus = ac.signal.aborted ? "cancelled" : "completed";
    await db
      .update(investigationRunsTable)
      .set({
        status: finalStatus,
        summary: report as never,
        finishedAt: new Date(),
        primaryBuffer: null,
        referenceBuffer: null,
        bufferExpiresAt: null,
      })
      .where(eq(investigationRunsTable.id, runId));

    emit({ type: "done", runId, status: finalStatus });
    if (!clientGone) res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(investigationRunsTable)
      .set({
        status: "error",
        finishedAt: new Date(),
        primaryBuffer: null,
        referenceBuffer: null,
        bufferExpiresAt: null,
      })
      .where(eq(investigationRunsTable.id, runId));
    emit({ type: "error", runId, error: msg });
    if (!clientGone) res.end();
  } finally {
    activeStreams.delete(runId);
  }
});

/* ── GET /anthropic/investigation/runs ──────────────────────────────── */

router.get("/investigation/runs", async (req, res) => {
  const scope =
    typeof req.query.scope === "string" ? req.query.scope : undefined;
  const rows = scope
    ? await db
        .select(investigationRunPublicColumns)
        .from(investigationRunsTable)
        .where(eq(investigationRunsTable.scope, scope))
        .orderBy(desc(investigationRunsTable.startedAt))
    : await db
        .select(investigationRunPublicColumns)
        .from(investigationRunsTable)
        .orderBy(desc(investigationRunsTable.startedAt));
  res.json(rows);
});

/* ── GET /anthropic/investigation/runs/:id ──────────────────────────── */

router.get("/investigation/runs/:id", async (req, res) => {
  const runId = req.params.id;
  const [run] = await db
    .select(investigationRunPublicColumns)
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
  // Drop any in-process stream guard; the row delete also drops the buffers.
  activeStreams.delete(runId);
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
