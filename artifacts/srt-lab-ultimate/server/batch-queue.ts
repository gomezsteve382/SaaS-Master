/**
 * SRT Lab — Batch Analysis Queue
 *
 * Accepts multiple binary files, queues them, and processes sequentially.
 * Emits SSE events for real-time progress tracking.
 */

import { db } from "./db.js";
import { batchJobs, batchItems, analysisResults, uploadedBinaries } from "../drizzle/schema.js";
import { eq, and, asc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { storagePut } from "./storage.js";
import { createHash } from "crypto";
import { runClaudeCodeSwarm } from "./claude-agents/swarm-coordinator.js";
import type { SwarmEvent } from "./swarm/coordinator.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BatchJob {
  id: string;
  status: "pending" | "running" | "complete" | "failed";
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  createdAt: number;
  completedAt?: number;
  items: BatchItem[];
}

export interface BatchItem {
  id: string;
  filename: string;
  fileSize: number;
  status: "queued" | "running" | "complete" | "failed";
  analysisId?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  orderIndex: number;
}

export interface BatchProgressEvent {
  type: "batch_start" | "item_start" | "item_progress" | "item_complete" | "item_failed" | "batch_complete";
  batchId: string;
  itemId?: string;
  filename?: string;
  orderIndex?: number;
  totalFiles?: number;
  completedFiles?: number;
  failedFiles?: number;
  analysisId?: string;
  error?: string;
  swarmEvent?: SwarmEvent;
  message?: string;
}

// ─── Create Batch Job ───────────────────────────────────────────────────────

export async function createBatchJob(
  userId: string,
  files: Array<{ buffer: Buffer; filename: string }>
): Promise<string> {
  const batchId = nanoid(12);

  // Create the batch job
  await db.insert(batchJobs).values({
    id: batchId,
    userId,
    status: "pending",
    totalFiles: files.length,
    completedFiles: 0,
    failedFiles: 0,
    createdAt: Date.now(),
  });

  // Upload files to S3 and create batch items
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const itemId = nanoid(12);
    const s3Key = `batch/${batchId}/${itemId}-${file.filename}`;

    await storagePut(s3Key, file.buffer, "application/octet-stream");

    await db.insert(batchItems).values({
      id: itemId,
      batchId,
      filename: file.filename,
      fileSize: file.buffer.length,
      s3Key,
      status: "queued",
      orderIndex: i,
    });
  }

  return batchId;
}

// ─── Get Batch Status ───────────────────────────────────────────────────────

export async function getBatchStatus(batchId: string): Promise<BatchJob | null> {
  const [job] = await db
    .select()
    .from(batchJobs)
    .where(eq(batchJobs.id, batchId));

  if (!job) return null;

  const items = await db
    .select()
    .from(batchItems)
    .where(eq(batchItems.batchId, batchId))
    .orderBy(asc(batchItems.orderIndex));

  return {
    id: job.id,
    status: job.status as BatchJob["status"],
    totalFiles: job.totalFiles,
    completedFiles: job.completedFiles || 0,
    failedFiles: job.failedFiles || 0,
    createdAt: job.createdAt,
    completedAt: job.completedAt || undefined,
    items: items.map(item => ({
      id: item.id,
      filename: item.filename,
      fileSize: item.fileSize,
      status: item.status as BatchItem["status"],
      analysisId: item.analysisId || undefined,
      error: item.error || undefined,
      startedAt: item.startedAt || undefined,
      completedAt: item.completedAt || undefined,
      orderIndex: item.orderIndex,
    })),
  };
}

// ─── Process Batch Queue ────────────────────────────────────────────────────

export async function processBatchQueue(
  batchId: string,
  userId: string,
  onProgress?: (event: BatchProgressEvent) => void
): Promise<void> {
  // Mark batch as running
  await db.update(batchJobs)
    .set({ status: "running" })
    .where(eq(batchJobs.id, batchId));

  // Get all queued items
  const items = await db
    .select()
    .from(batchItems)
    .where(and(eq(batchItems.batchId, batchId), eq(batchItems.status, "queued")))
    .orderBy(asc(batchItems.orderIndex));

  const totalFiles = items.length;
  let completedFiles = 0;
  let failedFiles = 0;

  onProgress?.({
    type: "batch_start",
    batchId,
    totalFiles,
    completedFiles: 0,
    failedFiles: 0,
    message: `Starting batch analysis of ${totalFiles} files`,
  });

  for (const item of items) {
    try {
      // Mark item as running
      await db.update(batchItems)
        .set({ status: "running", startedAt: Date.now() })
        .where(eq(batchItems.id, item.id));

      onProgress?.({
        type: "item_start",
        batchId,
        itemId: item.id,
        filename: item.filename,
        orderIndex: item.orderIndex,
        totalFiles,
        completedFiles,
        message: `Starting analysis of ${item.filename} (${item.orderIndex + 1}/${totalFiles})`,
      });

      // Fetch file from S3 via the Manus /manus-storage/ redirect (follows to CloudFront presigned URL)
      const manusBase = "https://srtlabult.manus.space";
      let fileBuffer: Buffer;
      try {
        const redirectRes = await fetch(`${manusBase}/manus-storage/${item.s3Key}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        const location = redirectRes.headers.get("location");
        if (location) {
          const dlRes = await fetch(location, { signal: AbortSignal.timeout(120_000) });
          if (!dlRes.ok) throw new Error(`CloudFront download failed: ${dlRes.status}`);
          fileBuffer = Buffer.from(await dlRes.arrayBuffer());
        } else {
          // Fallback: direct follow-redirect (works if not behind auth)
          const dlRes = await fetch(`${manusBase}/manus-storage/${item.s3Key}`, { signal: AbortSignal.timeout(120_000) });
          if (!dlRes.ok) throw new Error(`Storage download failed: ${dlRes.status}`);
          fileBuffer = Buffer.from(await dlRes.arrayBuffer());
        }
      } catch (dlErr: any) {
        throw new Error(`Failed to fetch file from storage (${item.s3Key}): ${dlErr.message}`);
      }

      // Run swarm analysis
      const result = await runClaudeCodeSwarm(
        fileBuffer,
        item.filename,
        1,
        undefined,
        (swarmEvent: SwarmEvent) => {
          onProgress?.({
            type: "item_progress",
            batchId,
            itemId: item.id,
            filename: item.filename,
            orderIndex: item.orderIndex,
            swarmEvent,
            message: swarmEvent.message || `[${swarmEvent.codename || "SWARM"}] ${swarmEvent.type}`,
          });
        }
      );

      // Store analysis result
      const analysisId = nanoid(12);
      const fileHash = createHash("sha256").update(fileBuffer).digest("hex");

      // Store binary reference
      const binaryId = nanoid(12);
      await db.insert(uploadedBinaries).values({
        id: binaryId,
        userId,
        filename: item.filename,
        fileHash,
        fileSize: item.fileSize,
        s3Key: item.s3Key,
        s3Url: `/manus-storage/${item.s3Key}`,
        uploadedAt: Date.now(),
      });

      // Store analysis
      await db.insert(analysisResults).values({
        id: analysisId,
        binaryId,
        userId,
        filename: item.filename,
        fileSize: item.fileSize,
        fileType: result.algorithms?.[0]?.name ? "executable" : "binary",
        summary: result.summary || "",
        analysisData: JSON.stringify(result),
        algorithmCount: result.algorithms?.length || 0,
        seedKeyCount: result.seedKeys?.length || 0,
        canAddressCount: result.canAddresses?.length || 0,
        checksumCount: result.checksums?.length || 0,
        securityByteCount: result.securityBytes?.length || 0,
        analyzedAt: Date.now(),
      });

      // Mark item complete
      completedFiles++;
      await db.update(batchItems)
        .set({ status: "complete", analysisId, completedAt: Date.now() })
        .where(eq(batchItems.id, item.id));

      await db.update(batchJobs)
        .set({ completedFiles })
        .where(eq(batchJobs.id, batchId));

      onProgress?.({
        type: "item_complete",
        batchId,
        itemId: item.id,
        filename: item.filename,
        orderIndex: item.orderIndex,
        analysisId,
        totalFiles,
        completedFiles,
        message: `Completed ${item.filename} (${completedFiles}/${totalFiles})`,
      });

    } catch (error: any) {
      failedFiles++;
      await db.update(batchItems)
        .set({ status: "failed", error: error.message, completedAt: Date.now() })
        .where(eq(batchItems.id, item.id));

      await db.update(batchJobs)
        .set({ failedFiles })
        .where(eq(batchJobs.id, batchId));

      onProgress?.({
        type: "item_failed",
        batchId,
        itemId: item.id,
        filename: item.filename,
        orderIndex: item.orderIndex,
        error: error.message,
        totalFiles,
        completedFiles,
        failedFiles,
        message: `Failed ${item.filename}: ${error.message}`,
      });
    }
  }

  // Mark batch complete
  const finalStatus = failedFiles === totalFiles ? "failed" : "complete";
  await db.update(batchJobs)
    .set({ status: finalStatus, completedAt: Date.now(), completedFiles, failedFiles })
    .where(eq(batchJobs.id, batchId));

  onProgress?.({
    type: "batch_complete",
    batchId,
    totalFiles,
    completedFiles,
    failedFiles,
    message: `Batch complete: ${completedFiles} succeeded, ${failedFiles} failed out of ${totalFiles}`,
  });
}
