import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import { nanoid } from "nanoid";
import { analyzeFile, reanalyzeFile } from "./analyze.js";
import { runQueryEngine, type ToolCallEvent } from "./queryEngine.js";
import { runSwarm, type SwarmEvent, registerAgentMCPRoutes } from "./swarm/index.js";
import { runClaudeCodeSwarm } from "./claude-agents/swarm-coordinator.js";
import { runAutonomousSwarm } from "./claude-agents/autonomous-coordinator.js";
import { compareFiles, fullBinaryDiff, detectModule } from "./compare.js";
import { analyzeMultiFileAlignment, generatePatchedFiles, generateManifest } from "./multifile-align.js";
import { storagePut } from "./storage.js";
import { db } from "./db.js";
import { analysisResults, uploadedBinaries, keyFindingDismissals, shareLinks, shareLinkViews, patternLibrary, analysisFiles, yaraRules } from "../drizzle/schema.js";
import { scanKeyMaterial } from "./key-scanner.js";
import { desc, like, or, sql, eq, and } from "drizzle-orm";
import {
  createPattern,
  getPatterns,
  getPatternById,
  deletePattern,
  extractPatternsFromAnalysis,
  buildKgFromAnalysis,
  getKgGraph,
  type PatternCategory,
} from "./db-patterns.js";
import archiver from "archiver";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
});

// Temporary storage for patched files (auto-cleanup after 1 hour)
const patchedFiles = new Map<string, { buffer: Buffer; filename: string; timestamp: number }>();
setInterval(() => {
  const oneHourAgo = Date.now() - 3600000;
  Array.from(patchedFiles.entries()).forEach(([id, data]) => {
    if (data.timestamp < oneHourAgo) patchedFiles.delete(id);
  });
}, 300000); // Clean every 5 minutes

// ─── Analysis Diff Helper ─────────────────────────────────────────────────────
function diffArrayByKey<T extends Record<string, any>>(arr1: T[], arr2: T[], key: string): {
  onlyInA: T[]; onlyInB: T[]; inBoth: T[];
} {
  const set1 = new Set((arr1 || []).map((x: T) => String(x[key] ?? "").toLowerCase()));
  const set2 = new Set((arr2 || []).map((x: T) => String(x[key] ?? "").toLowerCase()));
  return {
    onlyInA: (arr1 || []).filter((x: T) => !set2.has(String(x[key] ?? "").toLowerCase())),
    onlyInB: (arr2 || []).filter((x: T) => !set1.has(String(x[key] ?? "").toLowerCase())),
    inBoth:  (arr1 || []).filter((x: T) =>  set2.has(String(x[key] ?? "").toLowerCase())),
  };
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(express.json({ limit: "500mb" }));

  // ─── Upload & Analyze ─────────────────────────────────────────────────
  app.post("/api/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const file = req.file;
      const fileHash = crypto.createHash("sha256").update(file.buffer).digest("hex");
      const binaryId = nanoid(12);
      const analysisId = nanoid(12);
      const userId = "anonymous"; // No auth required

      // Upload binary to S3 storage — rename forbidden extensions to .bin
      const safeFilename = file.originalname.replace(/\.(exe|dll|bat|cmd|com|scr|msi|vbs|js|ps1|sh)$/i, ".bin");
      const storageKey = `binaries/${userId}/${binaryId}/${safeFilename}`;
      let s3Key = "";
      let s3Url = "";
      try {
        const storageResult = await storagePut(
          storageKey,
          file.buffer,
          "application/octet-stream"
        );
        s3Key = storageResult.key;
        s3Url = storageResult.url;
      } catch (storageErr: any) {
        console.warn("[upload] Storage upload failed (non-fatal):", storageErr.message);
        s3Key = `local-${binaryId}`;
        s3Url = "";
      }

      // Run the AUTONOMOUS 6-agent swarm — agents collaborate in real-time via investigation bus
      console.log(`[upload] Starting AUTONOMOUS swarm for ${file.originalname} (${file.buffer.length} bytes)`);
      const qeResult = await runAutonomousSwarm(file.buffer, file.originalname, 1);

      // ── Persist results to DB immediately — before any res.json() call.
      // This ensures results are saved even if the HTTP client disconnected during the long swarm run.
      const persistResult = async () => {
      // Map QueryEngine result to the AnalysisResult shape the rest of the app expects
      const result = {
        id: nanoid(12),
        filename: file.originalname,
        fileSize: file.buffer.length,
        fileType: qeResult.toolCallTrace.find(t => t.toolName === "file_identify")?.result?.split("\n")?.[0]?.replace("File type: ", "") || "Binary",
        timestamp: Date.now(),
        status: "complete" as const,
        analysisPass: 1,
        findings: {
          summary: qeResult.summary,
          algorithms: qeResult.algorithms,
          seedKeys: qeResult.seedKeys,
          canAddresses: qeResult.canAddresses,
          checksums: qeResult.checksums,
          memoryMaps: qeResult.memoryMaps,
          strings: qeResult.strings,
          cryptoConstants: qeResult.cryptoConstants,
          securityBytes: qeResult.securityBytes,
          deepFindings: qeResult.deepFindings,
        },
        rawHex: "",
        analysisMode: qeResult.analysisMode,
        dissectionReport: qeResult.dissectionReport,
        toolCallTrace: qeResult.toolCallTrace,
      };

      // Save binary record to database
      await db.insert(uploadedBinaries).values({
        id: binaryId,
        userId,
        filename: file.originalname,
        fileHash,
        fileSize: file.buffer.length,
        s3Key,
        s3Url,
        detectedModule: result.findings?.algorithms?.[0]?.name?.split(" ")?.[0] || null,
        uploadedAt: Date.now(),
      });

      // Derive counts — prefer structured arrays, fall back to deepFindings categories
      const findings: any = result.findings || {};
      const deepFindings: any[] = findings.deepFindings || [];
      const countDeep = (cat: string) => deepFindings.filter((d: any) =>
        (d.category || "").toLowerCase().includes(cat)
      ).length;

      const algorithmCount = (findings.algorithms?.length || 0) +
        (findings.cryptoConstants?.length || 0) +
        (findings.checksums?.length || 0) +
        (findings.udsServices?.length || 0) ||
        countDeep("crypto") + countDeep("algorithm") + countDeep("security") + countDeep("uds");

      const seedKeyCount = findings.seedKeys?.length ||
        countDeep("seed") + countDeep("key");

      const canAddressCount = (findings.canAddresses?.length || 0) +
        (findings.diagnosticFlows?.length || 0) ||
        countDeep("can") + countDeep("automotive") + countDeep("protocol");

      const checksumCount = findings.checksums?.length ||
        countDeep("checksum") + countDeep("crc");

      const securityByteCount = (findings.securityBytes?.length || 0) +
        (findings.pinCodes?.length || 0) +
        (findings.fobSlots?.length || 0) ||
        countDeep("security") + countDeep("pin") + countDeep("fob") + countDeep("skim");

      const stringCount = (findings.strings?.length || 0) +
        (findings.decompiledCode?.length || 0) +
        (findings.memoryMaps?.length || 0) ||
        countDeep("code") + countDeep("string") + countDeep("memory");

      const totalDeepFindings = deepFindings.length;
      const effectiveAlgCount = Math.max(algorithmCount, 0);
      const effectiveCanCount = Math.max(canAddressCount, 0);
      const effectiveSeedCount = Math.max(seedKeyCount, 0);
      const effectiveStrCount = Math.max(stringCount, totalDeepFindings > 0 ? totalDeepFindings : 0);

      // Save analysis result to database
      await db.insert(analysisResults).values({
        id: analysisId,
        binaryId,
        userId,
        filename: file.originalname,
        fileSize: file.buffer.length,
        fileType: result.fileType || "Unknown",
        detectedModule: result.findings?.algorithms?.[0]?.name?.split(" ")?.[0] ||
          result.findings?.canAddresses?.[0]?.module || null,
        entropy: null,
        confidence: null,
        status: "complete",
        algorithmCount: effectiveAlgCount,
        seedKeyCount: effectiveSeedCount,
        canAddressCount: effectiveCanCount,
        checksumCount: checksumCount,
        securityByteCount: securityByteCount,
        stringCount: effectiveStrCount,
        summary: result.findings?.summary || "",
        analysisData: { ...result, id: analysisId } as any,
        analyzedAt: Date.now(),
      });

      // Save analysis goals for cross-session learning (non-blocking — always fires)
      import("./ai-learning.js").then(({ saveAnalysisGoals }) => {
        saveAnalysisGoals(analysisId, "Automatic deep-dive: full automotive analysis", result).catch(console.error);
      }).catch(console.error);

      // Auto-extract patterns and build KG nodes (non-blocking)
      const _analysisIdForPatterns = analysisId;
      const _resultForPatterns = result;
      const _filenameForPatterns = req.file!.originalname;
      import("./db-patterns.js").then(({ extractPatternsFromAnalysis, buildKgFromAnalysis }) => {
        const findings = _resultForPatterns?.findings || _resultForPatterns;
        extractPatternsFromAnalysis("system", _analysisIdForPatterns, findings).then(created => {
          if (created.length > 0) buildKgFromAnalysis("system", _analysisIdForPatterns, _filenameForPatterns, findings).catch(console.error);
        }).catch(console.error);
      }).catch(console.error);

      // Save per-agent metrics (non-blocking)
      if (qeResult.agentResults && qeResult.agentResults.length > 0) {
        import("./agent-metrics.js").then(({ saveAgentMetrics }) => {
          const metricsInput = qeResult.agentResults!.map((r: any) => ({
            analysisId,
            agentId: r.agentId,
            codename: r.codename,
            specialty: r.specialty || "",
            durationMs: r.durationMs || 0,
            toolCallCount: r.toolCallCount || 0,
            iterations: r.iterations || 0,
            findingsCount: 0,
            error: r.error,
          }));
          saveAgentMetrics(metricsInput).catch(console.error);
        }).catch(console.error);
      }

      // Return the analysis result with the DB-assigned ID
      return { ...result, id: analysisId };
      }; // end persistResult

      // Persist to DB first (decoupled from HTTP response lifecycle)
      let persistedResult: any;
      try {
        persistedResult = await persistResult();
        console.log(`[upload] DB write complete for ${file.originalname}`);
      } catch (persistErr: any) {
        console.error(`[upload] DB write failed:`, persistErr.message);
      }

      // Send HTTP response (may fail if client disconnected — that's OK, DB is already saved)
      try {
        if (!res.headersSent) {
          res.json(persistedResult || { status: "complete", filename: file.originalname });
        }
      } catch (resErr: any) {
        console.warn(`[upload] Response send failed (client likely disconnected):`, resErr.message);
      }
    } catch (error: any) {
      console.error("Upload error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || "Analysis failed" });
      }
    }
  });

  // ─── Job Token Map (in-memory, for polling fallback) ─────────────────
  // Keyed by jobToken (UUID). Allows frontend to poll for completion even if
  // the SSE result event is dropped by the production hosting proxy.
  const jobMap = new Map<string, { status: "pending" | "complete" | "failed"; analysisId?: string; filename?: string; error?: string }>();

  // Clean up old entries every 30 minutes (cap at 200 entries)
  setInterval(() => {
    if (jobMap.size > 200) {
      const keys = Array.from(jobMap.keys());
      keys.slice(0, jobMap.size - 200).forEach(k => jobMap.delete(k));
    }
  }, 30 * 60 * 1000);

  // ─── Job Status Polling Endpoint ────────────────────────────────────────
  // Returns job status from in-memory map. If the token is not found (e.g. after
  // server restart), return a neutral "pending" status instead of 404 so the
  // frontend doesn't spam console errors. The primary polling mechanism is
  // /api/analysis/:id which checks the DB directly.
  app.get("/api/job/:token", (req, res) => {
    const job = jobMap.get(req.params.token);
    if (!job) {
      // Token not in memory — server may have restarted. Return pending so
      // frontend continues polling the DB-backed /api/analysis/:id endpoint.
      return res.json({ status: "pending" });
    }
    res.json(job);
  });

  // ─── Pre-Register Analysis (returns analysisId+jobToken synchronously) ───
  // Frontend calls this FIRST to get IDs before starting the SSE stream.
  // This bypasses Cloudflare header/buffering issues on production.
  app.post("/api/register-analysis", async (req, res) => {
    const analysisId = nanoid(12);
    const jobToken = crypto.randomUUID();
    jobMap.set(jobToken, { status: "pending" });
    // Insert a "running" placeholder row so polling finds it immediately
    const filename = req.body?.filename || "unknown";
    const fileSize = req.body?.fileSize || 0;
    try {
      await db.insert(analysisResults).values({
        id: analysisId,
        filename,
        fileSize,
        status: "running",
        analyzedAt: Date.now(),
      });
    } catch (e: any) {
      console.warn("[register-analysis] DB insert failed:", e.message);
    }
    res.json({ analysisId, jobToken });
  });

  // ─── S3-Backed Chunk Upload ─────────────────────────────────────────────
  // Chunks are stored in S3 so any server process can assemble them.
  // Key pattern: chunks/{uploadId}/{chunkIndex}  (metadata at chunks/{uploadId}/_meta)
  const FORGE_API_URL_CHUNK = process.env.BUILT_IN_FORGE_API_URL || "";
  const FORGE_API_KEY_CHUNK = process.env.BUILT_IN_FORGE_API_KEY || "";

  async function chunkStoragePut(key: string, data: Buffer): Promise<void> {
    // Retry with exponential backoff to handle 429 rate-limit responses from the Forge storage API.
    // A large file split into many chunks can trigger rate limits if all chunks are sent in rapid succession.
    const MAX_RETRIES = 6;
    const BASE_DELAY_MS = 1_000; // 1s initial delay, doubles each retry
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s, 16s, 32s
        console.warn(`[chunk-s3] Retry ${attempt}/${MAX_RETRIES} for key ${key} after ${delay}ms (last error: ${lastError?.message})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      try {
        const FormDataNode = (await import("form-data")).default;
        const fd = new FormDataNode();
        fd.append("file", data, { filename: key.split("/").pop() || "chunk", contentType: "application/octet-stream" });
        fd.append("path", key);
        const r = await fetch(`${FORGE_API_URL_CHUNK}/v1/storage/upload`, {
          method: "POST",
          headers: { Authorization: `Bearer ${FORGE_API_KEY_CHUNK}`, ...fd.getHeaders() },
          body: fd.getBuffer(),
        });
        if (r.ok) return; // success
        const body = await r.text();
        if (r.status === 429) {
          // Rate limited — parse Retry-After header if present
          const retryAfter = r.headers.get("retry-after");
          if (retryAfter) {
            const waitMs = parseInt(retryAfter, 10) * 1000;
            console.warn(`[chunk-s3] 429 rate limit, Retry-After: ${retryAfter}s`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
          lastError = new Error(`[chunk-s3] Upload failed ${r.status}: ${body}`);
          continue; // retry
        }
        // Non-retryable error
        throw new Error(`[chunk-s3] Upload failed ${r.status}: ${body}`);
      } catch (err: any) {
        if (err.message?.includes("[chunk-s3] Upload failed") && !err.message?.includes("429")) {
          throw err; // non-retryable
        }
        lastError = err;
        // Network errors are retryable
      }
    }
    throw lastError || new Error(`[chunk-s3] Upload failed after ${MAX_RETRIES} retries for key ${key}`);
  }

  async function chunkStorageGet(key: string): Promise<Buffer> {
    // Strategy 1: CloudFront URL (proven to work — returns real bytes, not HTML).
    // The Forge /v1/storage/upload returns a CloudFront URL; reconstruct it from the key.
    // Pattern confirmed: https://d2xsxph8kpxj0f.cloudfront.net/95647711/{appId}/{key}
    const APP_ID = process.env.VITE_APP_ID || "9B76mpgcQQAqByTTmtqNro";
    const cfUrl = `https://d2xsxph8kpxj0f.cloudfront.net/95647711/${APP_ID}/${key}`;
    try {
      const r = await fetch(cfUrl, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) {
        const ct = r.headers.get("content-type") || "";
        if (!ct.includes("text/html")) {
          return Buffer.from(await r.arrayBuffer());
        }
        console.warn(`[chunk-s3] CloudFront returned HTML for key ${key} — trying Forge API`);
      }
    } catch (cfErr: any) {
      console.warn(`[chunk-s3] CloudFront fetch failed for key ${key}: ${cfErr.message}`);
    }

    // Strategy 2: Forge download API (often returns 400, but try anyway)
    const forgeUrl = `${FORGE_API_URL_CHUNK}/v1/storage/download?path=${encodeURIComponent(key)}`;
    try {
      const r = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${FORGE_API_KEY_CHUNK}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) {
        const ct = r.headers.get("content-type") || "";
        if (!ct.includes("text/html")) {
          return Buffer.from(await r.arrayBuffer());
        }
      }
    } catch (_) {}

    // Strategy 3: localhost manus-storage proxy (last resort — returns HTML on Cloud Run)
    const port = process.env.PORT || 3001;
    const proxyUrl = `http://localhost:${port}/manus-storage/${key}`;
    const r3 = await fetch(proxyUrl, { signal: AbortSignal.timeout(20_000) });
    if (r3.ok) {
      const buf = Buffer.from(await r3.arrayBuffer());
      const preview = buf.slice(0, 15).toString();
      if (preview.includes("<")) {
        throw new Error(`[chunk-s3] All strategies returned HTML for key ${key} — file not accessible from this environment`);
      }
      return buf;
    }
    throw new Error(`[chunk-s3] Download failed for key ${key} (all strategies exhausted)`);
  }

  // ─── Chunk Upload Endpoint ───────────────────────────────────────────────
  // POST /api/upload-chunk
  // Accepts a single chunk of a larger file and stores it in S3.
  // Body: multipart/form-data with fields:
  //   file        — the chunk binary data
  //   uploadId    — unique ID for this upload session
  //   chunkIndex  — 0-based index of this chunk
  //   totalChunks — total number of chunks
  //   filename    — original filename (only required on first chunk)
  app.post("/api/upload-chunk", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No chunk data" });
      const { uploadId, chunkIndex, totalChunks, filename } = req.body;
      if (!uploadId || chunkIndex === undefined || !totalChunks) {
        return res.status(400).json({ error: "Missing uploadId, chunkIndex, or totalChunks" });
      }
      const idx = parseInt(chunkIndex, 10);
      const total = parseInt(totalChunks, 10);

      // Store chunk in S3
      await chunkStoragePut(`chunks/${uploadId}/${idx}`, req.file.buffer);

      // On first chunk, store metadata so assembly knows filename and total
      if (idx === 0) {
        const meta = Buffer.from(JSON.stringify({ filename: filename || "upload.bin", totalChunks: total, createdAt: Date.now() }));
        await chunkStoragePut(`chunks/${uploadId}/_meta`, meta);
      }

      res.json({ received: idx + 1, total, complete: idx + 1 === total, uploadId });
    } catch (err: any) {
      console.error("[chunk-upload] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── SSE Streaming Upload & Analyze (S3-backed chunked assembly) ─────────
  // POST /api/upload-stream-chunked
  // Fetches all chunks from S3, assembles them, then runs the swarm analysis.
  // Body: JSON { uploadId, totalChunks, filename }
  app.post("/api/upload-stream-chunked", async (req, res) => {
    const { uploadId, totalChunks, filename, analysisId: preAnalysisId, jobToken: preJobToken } = req.body || {};
    if (!uploadId || !totalChunks) return res.status(400).json({ error: "Missing uploadId or totalChunks" });

    try {
      const total = parseInt(totalChunks, 10);
      if (!Number.isFinite(total) || total < 1) {
        return res.status(400).json({ error: `Invalid totalChunks: ${totalChunks}` });
      }

      // Fetch all chunks from S3 in parallel — but validate every one before concat.
      // A silently-missing chunk used to produce a corrupt buffer that hung the dissector.
      const settled = await Promise.allSettled(
        Array.from({ length: total }, (_, i) => chunkStorageGet(`chunks/${uploadId}/${i}`))
      );

      const missing: number[] = [];
      const chunkBuffers: Buffer[] = [];
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === "rejected" || !s.value || !(s.value instanceof Buffer) || s.value.length === 0) {
          missing.push(i);
        } else {
          chunkBuffers.push(s.value);
        }
      }

      if (missing.length > 0) {
        console.error(`[upload-stream-chunked] Missing/empty chunks for ${uploadId}: [${missing.slice(0, 10).join(",")}${missing.length > 10 ? "..." : ""}] (${missing.length}/${total})`);
        // Mark the pre-registered analysis as failed so the client stops polling forever
        if (preAnalysisId) {
          try {
            await db.update(analysisResults)
              .set({ status: "failed", summary: `Chunk assembly failed: ${missing.length}/${total} chunks missing`, analyzedAt: Date.now() })
              .where(sql`${analysisResults.id} = ${preAnalysisId}`);
          } catch (e: any) { console.warn("[upload-stream-chunked] failed to mark analysis failed:", e.message); }
        }
        return res.status(502).json({ error: `Chunk assembly failed: ${missing.length}/${total} chunks unavailable. Retry the upload.` });
      }

      const assembledBuffer = Buffer.concat(chunkBuffers);
      console.log(`[upload-stream-chunked] Assembled ${assembledBuffer.length} bytes from ${total} chunks`);

      // Create a fake multer-style file object and reuse the upload-stream logic
      const fakeFile = {
        buffer: assembledBuffer,
        originalname: filename || "upload.bin",
      };
      (req as any).file = fakeFile;
      // Forward pre-registered IDs so uploadStreamHandler uses them instead of generating new ones
      if (preAnalysisId) req.body.analysisId = preAnalysisId;
      if (preJobToken) req.body.jobToken = preJobToken;
      return uploadStreamHandler(req as any, res);
    } catch (err: any) {
      console.error("[upload-stream-chunked] Assembly error:", err.message, err.stack);
      // Mark analysis as failed in DB so client polling can detect it
      if (preAnalysisId) {
        try {
          await db.update(analysisResults)
            .set({ status: "failed", summary: `Assembly error: ${err.message?.substring(0, 200)}`, analyzedAt: Date.now() })
            .where(sql`${analysisResults.id} = ${preAnalysisId}`);
        } catch {}
      }
      // Only send JSON if we haven't already started SSE
      if (!res.headersSent) {
        return res.status(500).json({ error: `Assembly failed: ${err.message}` });
      }
    }
  });

  // ─── SSE Streaming Upload & Analyze ──────────────────────────────────
  // ARCHITECTURE: The swarm runs as a BACKGROUND TASK decoupled from the HTTP response.
  // Production platforms (Cloudflare, deployment infra) kill long-running HTTP handlers
  // after ~120s, but the swarm takes 5-8 minutes. Solution:
  //   1. Upload file to S3 (fast, <10s)
  //   2. Start SSE stream for live progress events
  //   3. Launch swarm as fire-and-forget background task
  //   4. Background task updates DB when complete
  //   5. Frontend polls /api/analysis/:id to detect completion (independent of SSE)
  //
  // Shared handler used by both /api/upload-stream (direct) and
  // /api/upload-stream-chunked (after chunk assembly). req.file must be set.
  const uploadStreamHandler = async (req: any, res: any) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Use pre-registered IDs if provided (from /api/register-analysis), otherwise generate new ones.
    const analysisId: string = (req.body && req.body.analysisId) ? req.body.analysisId : nanoid(12);
    const jobToken: string = (req.body && req.body.jobToken) ? req.body.jobToken : crypto.randomUUID();
    if (!req.body?.jobToken) {
      jobMap.set(jobToken, { status: "pending" });
    }

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Analysis-Id": analysisId,
      "X-Filename": encodeURIComponent(req.file.originalname),
      "X-Job-Token": jobToken,
      "Access-Control-Expose-Headers": "X-Analysis-Id, X-Filename, X-Job-Token",
    });
    res.flushHeaders();

    let clientDisconnected = false;
    const sendEvent = (event: string, data: any) => {
      if (clientDisconnected) return;
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      try {
        res.write(payload);
        if (typeof (res as any).flush === 'function') (res as any).flush();
      } catch (e) {
        clientDisconnected = true;
      }
    };

    // Keepalive ping every 15s to prevent proxy timeout
    const keepalive = setInterval(() => {
      if (clientDisconnected) { clearInterval(keepalive); return; }
      try { res.write(`:keepalive\n\n`); } catch { clientDisconnected = true; clearInterval(keepalive); }
    }, 15000);

    res.on("close", () => {
      clientDisconnected = true;
      clearInterval(keepalive);
    });

    const file = req.file;
    const fileHash = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const binaryId = nanoid(12);
    const userId = "anonymous";

    // Send job token immediately
    sendEvent("job", { jobToken, analysisId });
    sendEvent("status", { phase: "uploading", message: "Uploading binary to storage..." });

    // Upload binary to S3 (fast operation, <10s)
    const safeFilename = file.originalname.replace(/\.(exe|dll|bat|cmd|com|scr|msi|vbs|js|ps1|sh)$/i, ".bin");
    const storageKey = `binaries/${userId}/${binaryId}/${safeFilename}`;
    let s3Key = "";
    let s3Url = "";
    try {
      const storageResult = await storagePut(storageKey, file.buffer, "application/octet-stream");
      s3Key = storageResult.key;
      s3Url = storageResult.url;
    } catch (storageErr: any) {
      console.warn("[upload-stream] Storage upload failed (non-fatal):", storageErr.message);
      s3Key = `local-${binaryId}`;
      s3Url = "";
    }

    sendEvent("status", { phase: "analyzing", message: "Deploying AUTONOMOUS swarm: GHOST, PHANTOM, SPECTER, WRAITH, SHADE collaborate in real-time via investigation bus..." });

    // Save uploaded binary metadata immediately (before delegation or local swarm)
    // This ensures binaryId is available for the chat handler later
    try {
      await db.insert(uploadedBinaries).values({
        id: binaryId,
        userId,
        filename: file.originalname,
        fileHash,
        fileSize: file.buffer.length,
        s3Key,
        s3Url,
        uploadedAt: Date.now(),
      }).onDuplicateKeyUpdate({
        set: {
          fileHash,
          fileSize: file.buffer.length,
          s3Url,
          uploadedAt: Date.now(),
        },
      });
      console.log(`[upload-stream] Saved binary metadata: ${binaryId}`);
    } catch (binErr: any) {
      console.warn(`[upload-stream] uploadedBinaries insert failed (non-fatal): ${binErr.message}`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BACKGROUND TASK: Run swarm decoupled from HTTP response lifecycle.
    // If GCP_SWARM_URL is set, delegate execution to the persistent GCP VM
    // which is not subject to Cloud Run's 2-minute background-task kill.
    // Otherwise, run locally (dev / GCP server itself).
    // ═══════════════════════════════════════════════════════════════════════
    const runSwarmBackground = async () => {
      // ── GCP Delegation ──────────────────────────────────────────────────
      // When running on Manus production (Cloud Run), background tasks are
      // killed after ~2 minutes. Delegate to the persistent GCP VM instead.
      const GCP_SWARM_URL = process.env.GCP_SWARM_URL; // e.g. http://35.237.198.125:3001
      const SWARM_SECRET = process.env.SWARM_DELEGATE_SECRET || "";
      if (GCP_SWARM_URL) {
        console.log(`[swarm-bg] Delegating swarm for ${analysisId} to GCP: ${GCP_SWARM_URL}`);
        try {
          // Fire-and-forget HTTP call to GCP — GCP runs the swarm and writes to shared DB.
          // We don't await the result; the frontend polls the shared DB for completion.
          //
          // STRATEGY: Send the file bytes directly as base64 in the delegation payload.
          // This avoids all CloudFront/Forge download issues on the GCP side.
          // For large files (>15MB), fall back to the file-proxy URL approach.
          const FILE_EMBED_LIMIT = 15 * 1024 * 1024; // 15MB
          let fileBase64: string | undefined;
          let downloadUrl = "";
          if (file.buffer.length <= FILE_EMBED_LIMIT) {
            fileBase64 = file.buffer.toString("base64");
            console.log(`[swarm-bg] Embedding ${file.buffer.length} bytes as base64 in delegation payload`);
          } else {
            // For large files, try to get a working download URL
            // The file-proxy endpoint on this server fetches from /manus-storage/ internally
            downloadUrl = `https://srtlabult.manus.space/api/file-proxy?key=${encodeURIComponent(s3Key)}`;
            console.log(`[swarm-bg] Large file (${file.buffer.length} bytes), using file-proxy URL`);
          }
          fetch(`${GCP_SWARM_URL}/api/run-swarm-delegated`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-swarm-secret": SWARM_SECRET },
            body: JSON.stringify({
              analysisId,
              s3Key,
              downloadUrl,
              fileBase64,
              filename: file.originalname,
              fileSize: file.buffer.length,
              binaryId,
              userId,
              jobToken,
            }),
            signal: AbortSignal.timeout(120_000), // 120s to send the payload (may include large base64 bytes)
          }).then(async (r) => {
            if (!r.ok) {
              const txt = await r.text().catch(() => "");
              console.error(`[swarm-bg] GCP delegation failed (${r.status}): ${txt}`);
              // Fall back: mark as failed so the user knows
              await db.insert(analysisResults).values({
                id: analysisId, binaryId, userId,
                filename: file.originalname, fileSize: file.buffer.length,
                status: "failed", analyzedAt: Date.now(),
                summary: `GCP delegation failed: ${r.status} ${txt.slice(0, 200)}`,
                analysisData: { error: `GCP delegation failed: ${r.status}` } as any,
              }).onDuplicateKeyUpdate({
                set: { status: "failed", summary: `GCP delegation failed: ${r.status}`, analyzedAt: Date.now() },
              });
            } else {
              console.log(`[swarm-bg] GCP accepted delegation for ${analysisId}`);
            }
          }).catch((err) => {
            console.error(`[swarm-bg] GCP delegation network error:`, err.message);
          });
        } catch (delegateErr: any) {
          console.error(`[swarm-bg] GCP delegation setup error:`, delegateErr.message);
        }
        // Return immediately — GCP handles the rest.
        // The SSE keepalive continues until the client disconnects.
        return;
      }
      // ── End GCP Delegation ───────────────────────────────────────────────
      // Hard wall-clock timeout — covers the case where the swarm hangs on an LLM call,
      // a hung subprocess, or any other async operation that never resolves.
      // Without this, the DB row stays "running" forever and the client polls forever.
      const SWARM_HARD_TIMEOUT_MS = 7 * 60 * 1000; // 7 min — beats the 8-min frontend timeout
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Swarm exceeded hard timeout of ${SWARM_HARD_TIMEOUT_MS}ms`));
        }, SWARM_HARD_TIMEOUT_MS);
      });

      // Write to persistent binary cache BEFORE running swarm
      // This ensures the chat handler can find the file later
      try {
        const fsCache = await import("fs/promises");
        const cacheDir = `/tmp/srt-binary-cache`;
        await fsCache.mkdir(cacheDir, { recursive: true });
        const safeFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        const cachePath = `${cacheDir}/${analysisId}__${safeFilename}`;
        await fsCache.writeFile(cachePath, file.buffer);
        console.log(`[swarm-bg] Cached binary for chat: ${cachePath} (${file.buffer.length} bytes)`);
      } catch (cacheErr: any) {
        console.warn(`[swarm-bg] Failed to cache binary (non-fatal): ${cacheErr.message}`);
      }

      try {
        console.log(`[swarm-bg] Starting background swarm for ${analysisId} (${file.originalname}, ${file.buffer.length} bytes)`);

        const qeResult = await Promise.race([
          runAutonomousSwarm(
            file.buffer,
            file.originalname,
            1,
            undefined,
            (event: SwarmEvent) => {
              if (!clientDisconnected) sendEvent("swarm", event);
            },
            (busEvent: any) => {
              if (!clientDisconnected) sendEvent("swarm", { type: "bus_event", payload: busEvent });
            }
          ),
          timeoutPromise,
        ]);

        if (timeoutHandle) clearTimeout(timeoutHandle);
        console.log(`[swarm-bg] Swarm complete for ${analysisId}. Writing to DB...`);

        // Map result
        const result = {
          id: nanoid(12),
          filename: file.originalname,
          fileSize: file.buffer.length,
          fileType: qeResult.toolCallTrace.find(t => t.toolName === "file_identify")?.result?.split("\n")?.[0]?.replace("File type: ", "") || "Binary",
          timestamp: Date.now(),
          status: "complete" as const,
          analysisPass: 1,
          findings: {
            summary: qeResult.summary,
            algorithms: qeResult.algorithms,
            seedKeys: qeResult.seedKeys,
            canAddresses: qeResult.canAddresses,
            checksums: qeResult.checksums,
            memoryMaps: qeResult.memoryMaps,
            strings: qeResult.strings,
            cryptoConstants: qeResult.cryptoConstants,
            securityBytes: qeResult.securityBytes,
            deepFindings: qeResult.deepFindings,
          },
          rawHex: "",
          analysisMode: qeResult.analysisMode,
          dissectionReport: qeResult.dissectionReport,
          toolCallTrace: qeResult.toolCallTrace,
        };

        // Save uploaded binary metadata
        try {
          await db.insert(uploadedBinaries).values({
            id: binaryId,
            userId,
            filename: file.originalname,
            fileHash,
            fileSize: file.buffer.length,
            s3Key,
            s3Url,
            detectedModule: result.findings?.algorithms?.[0]?.name?.split(" ")?.[0] || null,
            uploadedAt: Date.now(),
          });
        } catch (dbErr: any) {
          console.error(`[swarm-bg] uploadedBinaries insert failed (non-fatal):`, dbErr.message);
        }

        // Upsert analysis results — update the pre-registered "running" row.
        // Cap analysisData at 2MB to prevent huge JSON blobs from hanging the DB insert.
        const MAX_ANALYSIS_DATA_BYTES = 2 * 1024 * 1024; // 2MB
        let analysisDataPayload: any = { ...result, id: analysisId };
        const rawJson = JSON.stringify(analysisDataPayload);
        if (rawJson.length > MAX_ANALYSIS_DATA_BYTES) {
          console.warn(`[swarm-bg] analysisData too large (${rawJson.length} bytes) — truncating toolCallTrace`);
          // Keep all findings but trim toolCallTrace to the first 50 entries
          analysisDataPayload = {
            ...analysisDataPayload,
            toolCallTrace: (analysisDataPayload.toolCallTrace || []).slice(0, 50),
            _truncated: true,
            _originalToolCallCount: (analysisDataPayload.toolCallTrace || []).length,
          };
        }
        try {
          // Wrap the DB upsert in a 30s timeout so a slow/stalled MySQL connection
          // can't hang the background task indefinitely after VENOM completes.
          await Promise.race([
            db.insert(analysisResults).values({
              id: analysisId,
              binaryId,
              userId,
              filename: file.originalname,
              fileSize: file.buffer.length,
              fileType: result.fileType || "Unknown",
              detectedModule: result.findings?.algorithms?.[0]?.name?.split(" ")?.[0] || null,
              entropy: null,
              confidence: null,
              algorithmCount: result.findings?.algorithms?.length || 0,
              seedKeyCount: result.findings?.seedKeys?.length || 0,
              canAddressCount: result.findings?.canAddresses?.length || 0,
              checksumCount: result.findings?.checksums?.length || 0,
              securityByteCount: result.findings?.securityBytes?.length || 0,
              stringCount: result.findings?.strings?.length || 0,
              summary: result.findings?.summary || "",
              analysisData: analysisDataPayload as any,
              status: "complete",
              analyzedAt: Date.now(),
            }).onDuplicateKeyUpdate({
              set: {
                binaryId,
                userId,
                filename: file.originalname,
                fileSize: file.buffer.length,
                fileType: result.fileType || "Unknown",
                detectedModule: result.findings?.algorithms?.[0]?.name?.split(" ")?.[0] || null,
                algorithmCount: result.findings?.algorithms?.length || 0,
                seedKeyCount: result.findings?.seedKeys?.length || 0,
                canAddressCount: result.findings?.canAddresses?.length || 0,
                checksumCount: result.findings?.checksums?.length || 0,
                securityByteCount: result.findings?.securityBytes?.length || 0,
                stringCount: result.findings?.strings?.length || 0,
                summary: result.findings?.summary || "",
                analysisData: analysisDataPayload as any,
                status: "complete",
                analyzedAt: Date.now(),
              },
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("DB upsert timed out after 30s")), 30_000)
            ),
          ]);
          console.log(`[swarm-bg] Analysis ${analysisId} COMPLETE — updated DB`);
        } catch (dbErr: any) {
          console.error(`[swarm-bg] analysisResults upsert FAILED for ${analysisId}:`, dbErr.message);
          // Even if the full upsert failed, try a minimal status-only update so the
          // client stops polling and shows the result page instead of hanging at 97%.
          try {
            await Promise.race([
              db.update(analysisResults)
                .set({ status: "complete", summary: result.findings?.summary || "", analyzedAt: Date.now() })
                .where(sql`${analysisResults.id} = ${analysisId}`),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("status-only update timed out")), 10_000)),
            ]);
            console.log(`[swarm-bg] Analysis ${analysisId} — minimal status=complete fallback written`);
          } catch (fallbackErr: any) {
            console.error(`[swarm-bg] Even minimal status update failed for ${analysisId}:`, fallbackErr.message);
          }
        }

        // Non-blocking post-processing
        import("./ai-learning.js").then(({ saveAnalysisGoals }) => {
          saveAnalysisGoals(analysisId, "Automatic deep-dive: full automotive analysis", result).catch(console.error);
        }).catch(console.error);

        import("./db-patterns.js").then(({ extractPatternsFromAnalysis, buildKgFromAnalysis }) => {
          const findings = result?.findings || result;
          extractPatternsFromAnalysis("system", analysisId, findings).then(created => {
            if (created.length > 0) buildKgFromAnalysis("system", analysisId, file.originalname, findings).catch(console.error);
          }).catch(console.error);
        }).catch(console.error);

        if (qeResult.agentResults && qeResult.agentResults.length > 0) {
          import("./agent-metrics.js").then(({ saveAgentMetrics }) => {
            const metricsInput = qeResult.agentResults!.map((r: any) => ({
              analysisId,
              agentId: r.agentId,
              codename: r.codename,
              specialty: r.specialty || "",
              durationMs: r.durationMs || 0,
              toolCallCount: r.toolCallCount || 0,
              iterations: r.iterations || 0,
              findingsCount: 0,
              error: r.error,
            }));
            saveAgentMetrics(metricsInput).catch(console.error);
          }).catch(console.error);
        }

        // Update job map
        jobMap.set(jobToken, { status: "complete", analysisId, filename: file.originalname });

        // Try to send SSE result (client may have disconnected, that's OK)
        sendEvent("result", { id: analysisId, status: "complete", filename: file.originalname });
        try { if (!clientDisconnected) { clearInterval(keepalive); res.end(); } } catch {}

      } catch (error: any) {
        console.error(`[swarm-bg] Swarm FAILED for ${analysisId}:`, error.message);

        // Update DB to failed status
        try {
          await db.insert(analysisResults).values({
            id: analysisId,
            binaryId,
            userId,
            filename: file.originalname,
            fileSize: file.buffer.length,
            fileType: "Unknown",
            detectedModule: null,
            entropy: null,
            confidence: null,
            algorithmCount: 0,
            seedKeyCount: 0,
            canAddressCount: 0,
            checksumCount: 0,
            securityByteCount: 0,
            stringCount: 0,
            summary: `Analysis failed: ${error.message}`,
            analysisData: { error: error.message } as any,
            status: "failed",
            analyzedAt: Date.now(),
          }).onDuplicateKeyUpdate({
            set: {
              status: "failed",
              summary: `Analysis failed: ${error.message}`,
              analysisData: { error: error.message } as any,
              analyzedAt: Date.now(),
            },
          });
          console.log(`[swarm-bg] Analysis ${analysisId} marked FAILED in DB`);
        } catch (dbErr: any) {
          console.error(`[swarm-bg] Failed to mark analysis as failed:`, dbErr.message);
        }

        // Update job map
        try { jobMap.set(jobToken, { status: "failed", error: error.message || "Analysis failed" }); } catch {}

        // Try to send error event (client may have disconnected)
        sendEvent("error", { message: error.message || "Analysis failed" });
        try { if (!clientDisconnected) { clearInterval(keepalive); res.end(); } } catch {}
      }
    };

    // FIRE AND FORGET — do NOT await this.
    // The swarm runs independently of the HTTP response lifecycle.
    // The production platform can kill this HTTP connection after 120s,
    // but the Node.js process continues running the swarm in the background.
    runSwarmBackground().catch((err) => {
      console.error(`[swarm-bg] Unhandled error in background swarm:`, err);
    });

    // DO NOT res.end() here — the SSE stream stays open for live progress events.
    // If the client disconnects or the proxy kills the connection, that's fine —
    // the background task will still complete and update the DB.
  };

  // Register the direct (non-chunked) upload-stream route
  app.post("/api/upload-stream", upload.single("file"), uploadStreamHandler);

  // ─── Vault (all analyses from DB) ─────────────────────────────────────
  app.get("/api/vault", async (_req, res) => {
    try {
      const rows = await db
        .select({
          id: analysisResults.id,
          filename: analysisResults.filename,
          fileSize: analysisResults.fileSize,
          fileType: analysisResults.fileType,
          detectedModule: analysisResults.detectedModule,
          algorithmCount: analysisResults.algorithmCount,
          seedKeyCount: analysisResults.seedKeyCount,
          canAddressCount: analysisResults.canAddressCount,
          checksumCount: analysisResults.checksumCount,
          securityByteCount: analysisResults.securityByteCount,
          stringCount: analysisResults.stringCount,
          summary: analysisResults.summary,
          analyzedAt: analysisResults.analyzedAt,
          status: analysisResults.status,
        })
        .from(analysisResults)
        .orderBy(desc(analysisResults.analyzedAt))
        .limit(100);

      // Map to the shape the frontend expects — only show complete analyses in the vault
      const vault = rows
        .filter(r => r.status === "complete")
        .map(r => ({
        id: r.id,
        filename: r.filename,
        fileSize: r.fileSize,
        fileType: r.fileType || "Unknown",
        timestamp: r.analyzedAt,
        status: r.status,
        summary: r.summary || "",
        algorithmCount: r.algorithmCount || 0,
        seedKeyCount: r.seedKeyCount || 0,
        canAddressCount: r.canAddressCount || 0,
        checksumCount: r.checksumCount || 0,
        stringCount: r.stringCount || 0,
      }));

      res.json(vault);
    } catch (error: any) {
      console.error("Vault error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Analysis Detail ───────────────────────────────────────────────────
  app.get("/api/analysis/:id", async (req, res) => {
    try {
      const rows = await db
        .select()
        .from(analysisResults)
        .where(sql`${analysisResults.id} = ${req.params.id}`)
        .limit(1);

      if (rows.length === 0) {
        return res.status(404).json({ error: "Analysis not found" });
      }

      const row = rows[0];
      // Handle running/failed states
      if (row.status === "running") {
        return res.json({ id: row.id, status: "running", filename: row.filename, fileSize: row.fileSize });
      }
      if (row.status === "failed") {
        return res.json({ id: row.id, status: "failed", filename: row.filename, error: row.errorMessage || "Analysis failed" });
      }
      // Return the full analysis data stored as JSON
      const fullData = row.analysisData as any;
      if (!fullData) {
        // analysisData is missing but status=complete — return a minimal complete response
        // so the frontend doesn't loop forever on the "Analysis in Progress" screen.
        return res.json({
          id: row.id,
          status: "complete",
          filename: row.filename,
          fileSize: row.fileSize,
          fileType: row.fileType || "Unknown",
          timestamp: row.analyzedAt,
          summary: row.summary || "",
          findings: {
            summary: row.summary || "",
            algorithms: [],
            seedKeys: [],
            canAddresses: [],
            checksums: [],
            memoryMaps: [],
            strings: [],
            cryptoConstants: [],
            securityBytes: [],
            deepFindings: [],
          },
          toolCallTrace: [],
          rawHex: "",
        });
      }
      // Ensure findings always exists even if analysisData is a partial/corrupt payload
      const safeFindings = fullData.findings || {
        summary: row.summary || fullData.summary || "",
        algorithms: fullData.algorithms || [],
        seedKeys: fullData.seedKeys || [],
        canAddresses: fullData.canAddresses || [],
        checksums: fullData.checksums || [],
        memoryMaps: fullData.memoryMaps || [],
        strings: fullData.strings || [],
        cryptoConstants: fullData.cryptoConstants || [],
        securityBytes: fullData.securityBytes || [],
        deepFindings: fullData.deepFindings || [],
      };
      // Check if the binary has a valid CloudFront storage URL
      let storageStatus: "ok" | "broken" | "unknown" = "unknown";
      if (row.binaryId) {
        try {
          const binRows = await db
            .select({ s3Url: uploadedBinaries.s3Url, s3Key: uploadedBinaries.s3Key })
            .from(uploadedBinaries)
            .where(sql`${uploadedBinaries.id} = ${row.binaryId}`)
            .limit(1);
          if (binRows.length > 0) {
            const { s3Url, s3Key } = binRows[0];
            const isCloudFront = (s3Url || "").includes("cloudfront.net") || (s3Url || "").includes("d2xsxph8kpxj0f");
            storageStatus = (isCloudFront || s3Key) ? "ok" : "broken";
          } else {
            storageStatus = "broken";
          }
        } catch {}
      }
      res.json({ ...fullData, findings: safeFindings, id: row.id, status: "complete", storageStatus, filename: row.filename, fileSize: row.fileSize, fileType: row.fileType || "Unknown" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  // ─── Export: JSON ────────────────────────────────────────────────────────
  app.get("/api/analysis/:id/export/json", async (req, res) => {
    try {
      const rows = await db
        .select()
        .from(analysisResults)
        .where(sql`${analysisResults.id} = ${req.params.id}`)
        .limit(1);
      if (rows.length === 0) return res.status(404).json({ error: "Analysis not found" });
      const { generateJSONReport } = await import("./report-generator.js");
      const report = generateJSONReport(rows[0].analysisData as any, rows[0].id);
      const filename = `srtlab-report-${rows[0].filename?.replace(/[^a-z0-9]/gi, "_").slice(0, 40) || rows[0].id}.json`;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Export: PDF ─────────────────────────────────────────────────────────
  app.get("/api/analysis/:id/export/pdf", async (req, res) => {
    try {
      const rows = await db
        .select()
        .from(analysisResults)
        .where(sql`${analysisResults.id} = ${req.params.id}`)
        .limit(1);
      if (rows.length === 0) return res.status(404).json({ error: "Analysis not found" });
      const { generatePDFReport } = await import("./report-generator.js");
      const pdfBuffer = await generatePDFReport(rows[0].analysisData as any);
      const filename = `srtlab-report-${rows[0].filename?.replace(/[^a-z0-9]/gi, "_").slice(0, 40) || rows[0].id}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", pdfBuffer.length);
      res.end(pdfBuffer);
    } catch (error: any) {
      console.error("[PDF Export] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/analysis/:id/extraction-tree/zip — download extraction tree as zip
  app.get("/api/analysis/:id/extraction-tree/zip", async (req, res) => {
    try {
      const rows = await db.select().from(analysisResults).where(eq(analysisResults.id, req.params.id)).limit(1);
      if (!rows[0]) return res.status(404).json({ error: "Analysis not found" });
      const analysis = rows[0];
      const data = analysis.analysisData as any;
      const fname = (analysis.filename || analysis.id).replace(/[^a-z0-9._-]/gi, "_");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="srtlab-extraction-${fname}.zip"`);
      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.pipe(res);
      archive.append(JSON.stringify(data, null, 2), { name: "analysis.json" });
      if (data?.algorithms?.length) {
        const lines = data.algorithms.map((a: any) =>
          `${a.name}\t${a.confidence || ""}\t0x${(a.offset || 0).toString(16).toUpperCase().padStart(8, "0")}\t${a.description || ""}`
        ).join("\n");
        archive.append(`Name\tConfidence\tOffset\tDescription\n${lines}`, { name: "algorithms.tsv" });
      }
      if (data?.seedKeys?.length) {
        const lines = data.seedKeys.map((k: any) =>
          typeof k === "string" ? k : (k.value || k.hex || JSON.stringify(k))
        ).join("\n");
        archive.append(lines, { name: "seed_keys.txt" });
      }
      if (data?.strings?.length) {
        const lines = data.strings.map((s: any) =>
          typeof s === "string" ? s : (s.value || JSON.stringify(s))
        ).join("\n");
        archive.append(lines, { name: "strings.txt" });
      }
      if (data?.canAddresses?.length) {
        const lines = data.canAddresses.map((c: any) =>
          typeof c === "string" ? c : (c.address || c.id || JSON.stringify(c))
        ).join("\n");
        archive.append(lines, { name: "can_addresses.txt" });
      }
      if (data?.summary) archive.append(data.summary, { name: "summary.txt" });
      await archive.finalize();
    } catch (error: any) {
      console.error("[Extraction ZIP] Error:", error);
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  });

  // ─── Search ────────────────────────────────────────────────────────────
  app.get("/api/search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: "Query required" });
      }

      const q = `%${query}%`;
      const rows = await db
        .select({
          id: analysisResults.id,
          filename: analysisResults.filename,
          fileType: analysisResults.fileType,
          summary: analysisResults.summary,
          algorithmCount: analysisResults.algorithmCount,
          seedKeyCount: analysisResults.seedKeyCount,
          canAddressCount: analysisResults.canAddressCount,
          analyzedAt: analysisResults.analyzedAt,
          analysisData: analysisResults.analysisData,
        })
        .from(analysisResults)
        .where(
          or(
            like(analysisResults.filename, q),
            like(analysisResults.summary, q),
            like(analysisResults.fileType, q),
            like(analysisResults.detectedModule, q)
          )
        )
        .orderBy(desc(analysisResults.analyzedAt))
        .limit(50);

      // Search within the JSON analysis data for deeper matches
      const results: any[] = [];
      for (const row of rows) {
        const data = row.analysisData as any;
        if (!data?.findings) continue;

        const findings = data.findings;
        const lq = query.toLowerCase();

        for (const algo of findings.algorithms || []) {
          if (
            algo.name?.toLowerCase().includes(lq) ||
            algo.description?.toLowerCase().includes(lq) ||
            algo.constants?.some((c: string) => c.toLowerCase().includes(lq))
          ) {
            results.push({ type: "algorithm", source: row.filename, analysisId: row.id, data: algo });
          }
        }

        for (const sk of findings.seedKeys || []) {
          if (
            sk.module?.toLowerCase().includes(lq) ||
            sk.algorithm?.toLowerCase().includes(lq) ||
            sk.description?.toLowerCase().includes(lq)
          ) {
            results.push({ type: "seedKey", source: row.filename, analysisId: row.id, data: sk });
          }
        }

        for (const can of findings.canAddresses || []) {
          if (
            can.module?.toLowerCase().includes(lq) ||
            can.txId?.toLowerCase().includes(lq) ||
            can.rxId?.toLowerCase().includes(lq)
          ) {
            results.push({ type: "canAddress", source: row.filename, analysisId: row.id, data: can });
          }
        }

        for (const cs of findings.checksums || []) {
          if (
            cs.type?.toLowerCase().includes(lq) ||
            cs.polynomial?.toLowerCase().includes(lq) ||
            cs.description?.toLowerCase().includes(lq)
          ) {
            results.push({ type: "checksum", source: row.filename, analysisId: row.id, data: cs });
          }
        }

        for (const sb of findings.securityBytes || []) {
          if (
            sb.module?.toLowerCase().includes(lq) ||
            sb.description?.toLowerCase().includes(lq) ||
            sb.offset?.toLowerCase().includes(lq)
          ) {
            results.push({ type: "securityByte", source: row.filename, analysisId: row.id, data: sb });
          }
        }
      }

      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Stats ─────────────────────────────────────────────────────────────
  app.get("/api/stats", async (_req, res) => {
    try {
      const rows = await db
        .select({
          algorithmCount: analysisResults.algorithmCount,
          seedKeyCount: analysisResults.seedKeyCount,
          canAddressCount: analysisResults.canAddressCount,
          checksumCount: analysisResults.checksumCount,
        })
        .from(analysisResults);

      const stats = rows.reduce(
        (acc, r) => ({
          algorithms: acc.algorithms + (r.algorithmCount || 0),
          seedKeys: acc.seedKeys + (r.seedKeyCount || 0),
          canAddresses: acc.canAddresses + (r.canAddressCount || 0),
          checksums: acc.checksums + (r.checksumCount || 0),
          totalAnalyses: acc.totalAnalyses + 1,
        }),
        { algorithms: 0, seedKeys: 0, canAddresses: 0, checksums: 0, totalAnalyses: 0 }
      );

      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Compare & Patch ───────────────────────────────────────────────────
  const uploadTwo = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  }).fields([
    { name: "source", maxCount: 1 },
    { name: "target", maxCount: 1 },
  ]);

  app.post("/api/compare", uploadTwo, async (req, res) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const sourceFile = files?.source?.[0];
      const targetFile = files?.target?.[0];

      if (!sourceFile || !targetFile) {
        return res.status(400).json({ error: "Both source and target files are required" });
      }

      const sourceModule = (req.body?.sourceModule as string) || undefined;
      const targetModule = (req.body?.targetModule as string) || undefined;

      const result = compareFiles(sourceFile, targetFile, sourceModule, targetModule);

      if (result.patchedFile2) {
        patchedFiles.set(result.id, {
          buffer: result.patchedFile2,
          filename: `${targetFile.originalname.replace(/\.[^.]+$/, "")}_patched${targetFile.originalname.match(/\.[^.]+$/)?.[0] || ".bin"}`,
          timestamp: Date.now(),
        });
      }

      const { patchedFile2, ...responseData } = result;
      res.json(responseData);
    } catch (error: any) {
      console.error("Compare error:", error);
      res.status(500).json({ error: error.message || "Comparison failed" });
    }
  });

  app.get("/api/compare/:id/download", async (req, res) => {
    try {
      const patched = patchedFiles.get(req.params.id);
      if (!patched) {
        return res.status(404).json({ error: "Patched file not found or expired" });
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${patched.filename}"`);
      res.setHeader("Content-Length", patched.buffer.length);
      res.send(patched.buffer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Multi-Align ───────────────────────────────────────────────────────
  const uploadThree = upload.array("files", 3);
  app.post("/api/align", uploadThree, async (req, res) => {
    try {
      if (!req.files || req.files.length !== 3) {
        return res.status(400).json({ error: "Exactly 3 files required" });
      }

      const files = (req.files as Express.Multer.File[]).map(f => ({
        buffer: f.buffer,
        filename: f.originalname || `file_${Date.now()}`,
        module: detectModule(f.buffer, f.originalname || "") || "UNKNOWN",
        fileSize: f.size,
      }));

      const alignment = analyzeMultiFileAlignment(files);
      const patchedBuffers = generatePatchedFiles(alignment, files);
      const manifest = generateManifest(alignment, files);

      const patchedIds: string[] = [];
      for (let i = 0; i < patchedBuffers.length; i++) {
        const id = `patched_${alignment.id}_${i}`;
        patchedFiles.set(id, {
          buffer: patchedBuffers[i],
          filename: `${files[i].filename.replace(/\.[^.]+$/, "")}_patched.bin`,
          timestamp: Date.now(),
        });
        patchedIds.push(id);
      }

      const manifestId = `manifest_${alignment.id}`;
      patchedFiles.set(manifestId, {
        buffer: Buffer.from(manifest, "utf-8"),
        filename: `alignment_manifest_${alignment.id}.json`,
        timestamp: Date.now(),
      });
      patchedIds.push(manifestId);

      res.json({ ...alignment, patchedFileIds: patchedIds });
    } catch (error: any) {
      console.error("Alignment error:", error);
      res.status(500).json({ error: error.message || "Alignment failed" });
    }
  });

  app.get("/api/align/:id/download-zip", async (req, res) => {
    try {
      const alignmentId = req.params.id;
      const patchedIds = Array.from(patchedFiles.keys()).filter(id =>
        id.startsWith(`patched_${alignmentId}_`)
      );

      if (patchedIds.length === 0) {
        return res.status(404).json({ error: "Patched files not found or expired" });
      }

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="srt-lab-aligned-${alignmentId}.zip"`);

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.pipe(res);

      for (const patchedId of patchedIds) {
        const patched = patchedFiles.get(patchedId);
        if (patched) {
          archive.append(patched.buffer, { name: patched.filename });
        }
      }

      await archive.finalize();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Multi-Align LLM Analysis (SSE streaming) ────────────────────────────
  app.post("/api/align/analyze-llm", async (req, res) => {
    try {
      const { alignment } = req.body as { alignment: any };
      if (!alignment) return res.status(400).json({ error: "alignment data required" });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "https://forge.manus.ai";
      const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";

      // Build a rich context string from the alignment result
      const mismatches = (alignment.securityByteStatus || []).filter((s: any) => !s.allMatch);
      const matches = (alignment.securityByteStatus || []).filter((s: any) => s.allMatch);
      const files = (alignment.files || []).map((f: any, i: number) =>
        `File ${i + 1}: ${f.filename} (${f.module}, ${(f.size / 1024).toFixed(1)} KB)`
      ).join("\n");

      const mismatchDetails = mismatches.map((s: any) => {
        const patches = (s.beforeAfter || []).map((p: any) =>
          `    File ${p.fileIndex + 1}: ${p.before} → ${p.after}`
        ).join("\n");
        return `  REGION: ${s.regionName} @ 0x${s.offset.toString(16).toUpperCase()} (${s.length} bytes)\n    Master value: ${s.masterValue}\n    File values: [${s.file1Value}, ${s.file2Value}, ${s.file3Value || 'N/A'}]\n${patches}`;
      }).join("\n\n");

      const systemPrompt = `You are a 40-year veteran automotive ECU hacker and reverse engineer specializing in FCA/Stellantis modules (BCM, RFHUB, PCM, TCM, SKIM, TIPM, GPEC). You have deep expertise in security byte alignment, seed-key pairing, and module synchronization for key programming.

You are analyzing the output of a multi-file binary alignment tool. Your job is to explain in plain English:
1. What was found (which security regions matched, which didn't)
2. What's wrong and why (root cause of mismatches — is this a VIN mismatch? SKIM pairing? Security access level? Calibration ID?)
3. What the patches mean (what bytes are being changed and why that fixes the problem)
4. Any risks or warnings the technician should know before writing these patches
5. Whether the alignment looks correct or if anything seems suspicious

Be direct, technical, and specific. Use hex values and region names from the data. No fluff.`;

      const userMessage = `ALIGNMENT RESULTS:\n\nFiles analyzed:\n${files}\n\nMaster module: ${alignment.masterModule} (File ${alignment.masterIndex + 1})\nTotal regions scanned: ${alignment.totalRegionsScanned}\nMatching regions: ${alignment.matchingRegions}\nMismatching regions: ${alignment.mismatchingRegions}\n\nMATCHING REGIONS (${matches.length}):\n${matches.map((s: any) => `  ${s.regionName} @ 0x${s.offset.toString(16).toUpperCase()}: ${s.masterValue}`).join("\n") || "  None"}\n\nMISMATCHING REGIONS (${mismatches.length}):\n${mismatchDetails || "  None — all regions match!"}\n\nPATCH PLANS:\n${(alignment.patchPlans || []).map((p: any) => `  ${p.module} (${p.filename}): ${p.patchCount} patches, ${p.bytesToChange} bytes`).join("\n") || "  No patches needed"}`;

      // Stream the LLM response
      const llmResp = await fetch(`${FORGE_API_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${FORGE_API_KEY}`,
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          stream: true,
          max_tokens: 4096,
        }),
      });

      if (!llmResp.ok || !llmResp.body) {
        const errText = await llmResp.text();
        res.write(`data: ${JSON.stringify({ error: `LLM error: ${errText.substring(0, 200)}` })}\n\n`);
        res.end();
        return;
      }

      const reader = llmResp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); continue; }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
          } catch {}
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error: any) {
      if (!res.headersSent) res.status(500).json({ error: error.message });
      else { res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`); res.end(); }
    }
  });

  // ─── Multi-Align LLM Chat (SSE streaming) ────────────────────────────────
  app.post("/api/align/chat", async (req, res) => {
    try {
      const { alignment, messages: history, question } = req.body as {
        alignment: any;
        messages: { role: string; content: string }[];
        question: string;
      };
      if (!alignment || !question) return res.status(400).json({ error: "alignment and question required" });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const FORGE_API_URL = process.env.BUILT_IN_FORGE_API_URL || "https://forge.manus.ai";
      const FORGE_API_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";

      const files = (alignment.files || []).map((f: any, i: number) =>
        `File ${i + 1}: ${f.filename} (${f.module})`
      ).join(", ");
      const mismatches = (alignment.securityByteStatus || []).filter((s: any) => !s.allMatch);

      const systemPrompt = `You are a 40-year veteran automotive ECU hacker and reverse engineer specializing in FCA/Stellantis modules. You are helping a technician understand the results of a multi-file binary alignment operation.

Alignment context:
- Files: ${files}
- Master module: ${alignment.masterModule} (File ${alignment.masterIndex + 1})
- Regions scanned: ${alignment.totalRegionsScanned}, Matching: ${alignment.matchingRegions}, Mismatching: ${alignment.mismatchingRegions}
- Mismatch regions: ${mismatches.map((s: any) => `${s.regionName} @ 0x${s.offset.toString(16).toUpperCase()}`).join(", ") || "none"}

Answer questions directly and technically. Reference specific offsets, hex values, and region names. Be concise but complete.`;

      const chatMessages = [
        { role: "system", content: systemPrompt },
        ...(history || []).slice(-10), // keep last 10 turns for context
        { role: "user", content: question },
      ];

      const llmResp = await fetch(`${FORGE_API_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${FORGE_API_KEY}`,
        },
        body: JSON.stringify({
          messages: chatMessages,
          stream: true,
          max_tokens: 2048,
        }),
      });

      if (!llmResp.ok || !llmResp.body) {
        const errText = await llmResp.text();
        res.write(`data: ${JSON.stringify({ error: `LLM error: ${errText.substring(0, 200)}` })}\n\n`);
        res.end();
        return;
      }

      const reader = llmResp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); continue; }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
          } catch {}
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error: any) {
      if (!res.headersSent) res.status(500).json({ error: error.message });
      else { res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`); res.end(); }
    }
  });

  // ─── Full Binary Diff ──────────────────────────────────────────────────
  app.post("/api/compare/diff", uploadTwo, async (req, res) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const sourceFile = files?.source?.[0];
      const targetFile = files?.target?.[0];

      if (!sourceFile || !targetFile) {
        return res.status(400).json({ error: "Both files are required" });
      }

      const diff = fullBinaryDiff(sourceFile.buffer, targetFile.buffer);
      res.json({
        file1Size: sourceFile.buffer.length,
        file2Size: targetFile.buffer.length,
        totalDiffChunks: diff.length,
        chunks: diff,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Delete Analysis ────────────────────────────────────────────────────
  app.delete("/api/analysis/:id", async (req, res) => {
    try {
      const { id } = req.params;

      // Find the analysis to get the binaryId
      const rows = await db
        .select({ id: analysisResults.id, binaryId: analysisResults.binaryId })
        .from(analysisResults)
        .where(sql`${analysisResults.id} = ${id}`)
        .limit(1);

      if (rows.length === 0) {
        return res.status(404).json({ error: "Analysis not found" });
      }

      const row = rows[0];

      // Delete the analysis result
      await db.delete(analysisResults).where(sql`${analysisResults.id} = ${id}`);

      // Delete the binary record if it exists
      if (row.binaryId) {
        await db.delete(uploadedBinaries).where(sql`${uploadedBinaries.id} = ${row.binaryId}`);
      }

      res.json({ success: true, deleted: id });
    } catch (error: any) {
      console.error("Delete error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Re-run Swarm ────────────────────────────────────────────────────────
  // POST /api/analysis/:id/rerun — re-dispatch the full 5-agent swarm against an
  // existing vault entry without requiring the user to re-upload the file.
  app.post("/api/analysis/:id/rerun", async (req, res) => {
    try {
      const { id } = req.params;
      const rows = await db
        .select()
        .from(analysisResults)
        .where(sql`${analysisResults.id} = ${id}`)
        .limit(1);
      if (rows.length === 0) return res.status(404).json({ error: "Analysis not found" });
      const existing = rows[0];
      if (!existing.binaryId) return res.status(422).json({ error: "No binary file linked to this analysis" });

      const binRows = await db
        .select()
        .from(uploadedBinaries)
        .where(sql`${uploadedBinaries.id} = ${existing.binaryId}`)
        .limit(1);
      if (binRows.length === 0) return res.status(422).json({ error: "Binary record not found" });
      const bin = binRows[0];

      const s3Url = bin.s3Url || "";
      const s3Key = bin.s3Key || "";
      const isCloudFront = s3Url.includes("cloudfront.net") || s3Url.includes("d2xsxph8kpxj0f");
      if (!isCloudFront && !s3Key) {
        return res.status(422).json({
          error: "This entry has a broken or missing storage URL. Please re-upload the file to run a fresh analysis."
        });
      }

      // Reset the analysis status to running
      await db.update(analysisResults)
        .set({ status: "running", summary: "Re-running swarm analysis...", analyzedAt: Date.now() })
        .where(sql`${analysisResults.id} = ${id}`);

      // Fetch the file bytes on the Manus server (where /manus-storage/ works internally)
      // and embed as base64 in the delegation payload to avoid GCP download issues.
      const FILE_EMBED_LIMIT = 15 * 1024 * 1024; // 15MB
      let fileBase64: string | undefined;
      let downloadUrl = "";
      const fileSize = bin.fileSize || 0;
      if (fileSize <= FILE_EMBED_LIMIT) {
        try {
          const port = process.env.PORT || 3000;
          const internalUrl = `http://localhost:${port}/manus-storage/${s3Key}`;
          console.log(`[rerun] Fetching file bytes from internal storage: ${internalUrl}`);
          const fileRes = await fetch(internalUrl, { signal: AbortSignal.timeout(120_000) });
          if (fileRes.ok) {
            const buf = Buffer.from(await fileRes.arrayBuffer());
            if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
              fileBase64 = buf.toString("base64");
              console.log(`[rerun] Embedded ${buf.length} bytes as base64`);
            } else {
              console.warn(`[rerun] Internal storage returned HTML/invalid content (${buf.length} bytes)`);
            }
          } else {
            console.warn(`[rerun] Internal storage fetch failed: ${fileRes.status}`);
          }
        } catch (fetchErr: any) {
          console.warn(`[rerun] Could not fetch file bytes:`, fetchErr.message);
        }
      }

      // Fallback: use file-proxy URL for large files or when byte fetch failed
      if (!fileBase64) {
        downloadUrl = `https://srtlabult.manus.space/api/file-proxy?key=${encodeURIComponent(s3Key)}`;
        console.log(`[rerun] Using file-proxy URL as fallback`);
      }

      // Delegate to GCP
      const GCP_SWARM_URL = process.env.GCP_SWARM_URL;
      const SWARM_SECRET = process.env.SWARM_DELEGATE_SECRET || "";
      if (GCP_SWARM_URL) {
        console.log(`[rerun] Delegating re-run for ${id} to GCP`);
        fetch(`${GCP_SWARM_URL}/api/run-swarm-delegated`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-swarm-secret": SWARM_SECRET },
          body: JSON.stringify({
            analysisId: id,
            s3Key,
            downloadUrl,
            fileBase64,
            filename: bin.filename,
            fileSize: bin.fileSize,
            binaryId: bin.id,
            userId: existing.userId || "anonymous",
            jobToken: `rerun-${id}`,
          }),
          signal: AbortSignal.timeout(120_000), // 120s for large base64 payloads
        }).then(async (r) => {
          if (!r.ok) {
            const txt = await r.text().catch(() => "");
            console.error(`[rerun] GCP delegation failed (${r.status}): ${txt}`);
            await db.update(analysisResults)
              .set({ status: "failed", summary: `Re-run failed: GCP delegation error ${r.status}` })
              .where(sql`${analysisResults.id} = ${id}`);
          } else {
            console.log(`[rerun] GCP accepted re-run for ${id}`);
          }
        }).catch((err) => {
          console.error(`[rerun] GCP delegation network error:`, err.message);
        });
        return res.json({ success: true, message: "Re-run dispatched to analysis cluster", analysisId: id });
      }

      // No GCP — run locally (this IS GCP in production)
      res.json({ success: true, message: "Re-run started locally", analysisId: id });
      (async () => {
        try {
          let fileBuffer: Buffer | null = null;

          // Strategy 0: Check local binary cache first
          try {
            const fsP = await import("fs/promises");
            const pathM = await import("path");
            const cacheDir = `/tmp/srt-binary-cache`;
            const cacheFiles = await fsP.readdir(cacheDir).catch(() => [] as string[]);
            const match = cacheFiles.find(f => f.startsWith(`${id}__`));
            if (match) {
              fileBuffer = await fsP.readFile(pathM.join(cacheDir, match));
              console.log(`[rerun] Using cached binary: ${match} (${fileBuffer.length} bytes)`);
            }
          } catch { /* no cache */ }

          // Strategy 1: Download from URL (fallback)
          if (!fileBuffer && downloadUrl) {
            const fileRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(120_000) });
            if (fileRes.ok) {
              const buf = Buffer.from(await fileRes.arrayBuffer());
              if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
                fileBuffer = buf;
                console.log(`[rerun] Downloaded ${fileBuffer.length} bytes from URL`);
              }
            }
          }

          if (!fileBuffer) throw new Error(`No file available (cache miss, download failed)`);

          const { runAutonomousSwarm: runSwarmLocal } = await import("./claude-agents/autonomous-coordinator.js");
          const result = await runSwarmLocal(fileBuffer, bin.filename, 1, undefined, () => {});
          await db.update(analysisResults)
            .set({ status: "complete", summary: result.summary || "Re-run complete", analysisData: result as any, analyzedAt: Date.now() })
            .where(sql`${analysisResults.id} = ${id}`);
        } catch (localErr: any) {
          console.error("[rerun] Local run error:", localErr.message);
          await db.update(analysisResults)
            .set({ status: "failed", summary: `Re-run error: ${localErr.message}` })
            .where(sql`${analysisResults.id} = ${id}`);
        }
      })();
    } catch (error: any) {
      console.error("Rerun error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Key & Secrets Findings ─────────────────────────────────────────────
  // GET /api/analysis/:id/key-findings — scan the binary and return all findings
  app.get("/api/analysis/:id/key-findings", async (req, res) => {
    try {
      const { id } = req.params;
      // Load analysis to get the s3Key
      const rows = await db
        .select({ binaryId: analysisResults.binaryId, filename: analysisResults.filename, status: analysisResults.status })
        .from(analysisResults)
        .where(sql`${analysisResults.id} = ${id}`)
        .limit(1);
      if (rows.length === 0) return res.status(404).json({ error: "Analysis not found" });
      if (rows[0].status !== "complete") return res.json({ findings: [], dismissed: [] });

      // Load the binary from S3
      const binRows = await db
        .select({ s3Key: uploadedBinaries.s3Key })
        .from(uploadedBinaries)
        .where(sql`${uploadedBinaries.id} = ${rows[0].binaryId}`)
        .limit(1);
      if (binRows.length === 0) return res.json({ findings: [], dismissed: [] });

      // Fetch from S3 via storage
      const { storageGet } = await import("./storage.js");
      const { url } = await storageGet(binRows[0].s3Key);
      const resp = await fetch(url);
      if (!resp.ok) return res.status(500).json({ error: "Failed to fetch binary from storage" });
      const arrayBuf = await resp.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      const findings = scanKeyMaterial(buf);

      // Load dismissed finding IDs for this analysis
      const dismissedRows = await db
        .select({ findingId: keyFindingDismissals.findingId })
        .from(keyFindingDismissals)
        .where(sql`${keyFindingDismissals.analysisId} = ${id}`);
      const dismissed = dismissedRows.map((r) => r.findingId);

      res.json({ findings, dismissed });
    } catch (error: any) {
      console.error("[key-findings] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/analysis/:id/key-findings/:findingId/dismiss — dismiss a finding
  app.post("/api/analysis/:id/key-findings/:findingId/dismiss", async (req, res) => {
    try {
      const { id, findingId } = req.params;
      const existing = await db
        .select({ id: keyFindingDismissals.id })
        .from(keyFindingDismissals)
        .where(sql`${keyFindingDismissals.analysisId} = ${id} AND ${keyFindingDismissals.findingId} = ${findingId}`)
        .limit(1);
      if (existing.length === 0) {
        await db.insert(keyFindingDismissals).values({
          id: nanoid(),
          analysisId: id,
          findingId,
          dismissedAt: Date.now(),
        });
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // DELETE /api/analysis/:id/key-findings/:findingId/dismiss — restore a dismissed finding
  app.delete("/api/analysis/:id/key-findings/:findingId/dismiss", async (req, res) => {
    try {
      const { id, findingId } = req.params;
      await db
        .delete(keyFindingDismissals)
        .where(sql`${keyFindingDismissals.analysisId} = ${id} AND ${keyFindingDismissals.findingId} = ${findingId}`);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/analysis/:id/binary/peek — stream raw binary bytes for hex viewer
  app.get("/api/analysis/:id/binary/peek", async (req, res) => {
    try {
      const { id } = req.params;
      const offset = parseInt((req.query.offset as string) || "0", 10);
      const length = Math.min(parseInt((req.query.length as string) || "4096", 10), 65536);

      const rows = await db
        .select({ binaryId: analysisResults.binaryId, status: analysisResults.status })
        .from(analysisResults)
        .where(sql`${analysisResults.id} = ${id}`)
        .limit(1);
      if (rows.length === 0) return res.status(404).json({ error: "Analysis not found" });
      if (rows[0].status !== "complete") return res.status(400).json({ error: "Analysis not complete" });

      const binRows = await db
        .select({ s3Key: uploadedBinaries.s3Key, fileSize: uploadedBinaries.fileSize })
        .from(uploadedBinaries)
        .where(sql`${uploadedBinaries.id} = ${rows[0].binaryId}`)
        .limit(1);
      if (binRows.length === 0) return res.status(404).json({ error: "Binary not found" });

      const { storageGet } = await import("./storage.js");
      const { url } = await storageGet(binRows[0].s3Key);
      // Fetch only the requested byte range
      const rangeHeader = `bytes=${offset}-${offset + length - 1}`;
      const resp = await fetch(url, { headers: { Range: rangeHeader } });
      if (!resp.ok && resp.status !== 206) return res.status(500).json({ error: "Failed to fetch binary" });
      const arrayBuf = await resp.arrayBuffer();
      const chunk = Buffer.from(arrayBuf);

      res.json({
        offset,
        length: chunk.length,
        totalSize: binRows[0].fileSize,
        hex: chunk.toString("hex"),
        ascii: chunk.toString("latin1").replace(/[\x00-\x1f\x7f-\xff]/g, "."),
      });
    } catch (error: any) {
      console.error("[binary-peek] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Re-analyze ────────────────────────────────────────────────────────
  app.post("/api/analysis/:id/reanalyze", async (req, res) => {
    try {
      const { id } = req.params;

      // Get the existing analysis to find the stored binary
      const rows = await db
        .select()
        .from(analysisResults)
        .where(sql`${analysisResults.id} = ${id}`)
        .limit(1);

      if (rows.length === 0) {
        return res.status(404).json({ error: "Analysis not found" });
      }

      const existing = rows[0];

      // Get the binary record to retrieve the S3 URL
      let binaryBuffer: Buffer | null = null;
      if (existing.binaryId) {
        const binRows = await db
          .select()
          .from(uploadedBinaries)
          .where(sql`${uploadedBinaries.id} = ${existing.binaryId}`)
          .limit(1);

        if (binRows.length > 0 && binRows[0].s3Url) {
          try {
            const s3Url = binRows[0].s3Url;
            // Fetch the binary from S3
            const fetchUrl = s3Url.startsWith("/manus-storage/")
              ? `http://localhost:${process.env.PORT || 3001}${s3Url}`
              : s3Url;
            const response = await fetch(fetchUrl);
            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              binaryBuffer = Buffer.from(arrayBuffer);
            }
          } catch (fetchErr) {
            console.warn("Could not fetch binary from S3:", fetchErr);
          }
        }
      }

      if (!binaryBuffer) {
        return res.status(422).json({
          error: "Original binary file is no longer available for re-analysis. Please re-upload the file."
        });
      }

      // Determine pass number and build prior findings context
      const previousData = existing.analysisData as any;
      const passNumber = (previousData?.analysisPass || previousData?.passNumber || 1) + 1;
      let priorSummary = previousData?.findings?.summary
        ? `PASS ${passNumber - 1} SUMMARY: ${previousData.findings.summary}\n` +
          `Algorithms found: ${previousData.findings?.algorithms?.length || 0}\n` +
          `Seed keys found: ${previousData.findings?.seedKeys?.length || 0}\n` +
          `CAN addresses: ${previousData.findings?.canAddresses?.length || 0}\n` +
          `Security bytes: ${previousData.findings?.securityBytes?.length || 0}`
        : undefined;

      // Fetch additional files if includeAdditionalFiles is requested
      let additionalFileBuffers: Array<{ filename: string; buffer: Buffer }> = [];
      const { includeAdditionalFiles } = req.body || {};
      if (includeAdditionalFiles) {
        try {
          const addlFiles = await db
            .select()
            .from(analysisFiles)
            .where(sql`${analysisFiles.analysisId} = ${id}`);
          for (const af of addlFiles) {
            try {
              const fetchUrl = af.s3Url.startsWith("/manus-storage/")
                ? `http://localhost:${process.env.PORT || 3001}${af.s3Url}`
                : af.s3Url;
              const afRes = await fetch(fetchUrl);
              if (afRes.ok) {
                const ab = await afRes.arrayBuffer();
                additionalFileBuffers.push({ filename: af.filename, buffer: Buffer.from(ab) });
              }
            } catch (e) {
              console.warn(`Could not fetch additional file ${af.filename}:`, e);
            }
          }
        } catch (e) {
          console.warn("Could not fetch additional files:", e);
        }
      }

      // Build combined buffer if additional files exist
      let primaryBuffer = binaryBuffer;
      let primaryFilename = existing.filename;
      if (additionalFileBuffers.length > 0) {
        // Write all files to a temp dir and create a manifest for the agents
        const allFilenames = [existing.filename, ...additionalFileBuffers.map(f => f.filename)];
        const manifestNote = `\n\nADDITIONAL FILES IN THIS SESSION (${additionalFileBuffers.length} extra files):\n` +
          allFilenames.map((fn, i) => `  File ${i + 1}: ${fn}`).join("\n") +
          `\n\nEach file has been written to disk. Use archive_extract or read_hex on each file path individually.`;
        priorSummary = (priorSummary || "") + manifestNote;
        // Store additional buffers for the swarm to access
        // The swarm will write each to disk via the temp dir
        (binaryBuffer as any).__additionalFiles = additionalFileBuffers;
      }

      // Run AUTONOMOUS swarm for re-analysis — agents collaborate + use prior findings
      console.log(`[reanalyze] Starting AUTONOMOUS swarm pass ${passNumber} for ${existing.filename}${additionalFileBuffers.length > 0 ? ` + ${additionalFileBuffers.length} additional files` : ""}`);
      const qeResult = await runAutonomousSwarm(primaryBuffer, primaryFilename, passNumber, priorSummary);

      const result = {
        id: existing.id,
        filename: existing.filename,
        fileSize: binaryBuffer.length,
        fileType: qeResult.toolCallTrace.find(t => t.toolName === "file_identify")?.result?.split("\n")?.[0]?.replace("File type: ", "") || existing.fileType || "Binary",
        timestamp: Date.now(),
        status: "complete" as const,
        analysisPass: passNumber,
        findings: {
          summary: qeResult.summary,
          algorithms: qeResult.algorithms,
          seedKeys: qeResult.seedKeys,
          canAddresses: qeResult.canAddresses,
          checksums: qeResult.checksums,
          memoryMaps: qeResult.memoryMaps,
          strings: qeResult.strings,
          cryptoConstants: qeResult.cryptoConstants,
          securityBytes: qeResult.securityBytes,
          deepFindings: qeResult.deepFindings,
        },
        rawHex: "",
        analysisMode: qeResult.analysisMode,
        dissectionReport: qeResult.dissectionReport,
        toolCallTrace: qeResult.toolCallTrace,
      };

      // Update the existing analysis record with merged deeper results
      await db
        .update(analysisResults)
        .set({
          fileType: result.fileType || "Unknown",
          detectedModule: result.findings?.algorithms?.[0]?.name?.split(" ")?.[0] || null,
          algorithmCount: result.findings?.algorithms?.length || 0,
          seedKeyCount: result.findings?.seedKeys?.length || 0,
          canAddressCount: result.findings?.canAddresses?.length || 0,
          checksumCount: result.findings?.checksums?.length || 0,
          securityByteCount: result.findings?.securityBytes?.length || 0,
          stringCount: result.findings?.strings?.length || 0,
          summary: result.findings?.summary || "",
          analysisData: result as any,
          analyzedAt: Date.now(),
        })
        .where(sql`${analysisResults.id} = ${id}`);

      res.json({ ...result, id });
    } catch (error: any) {
      console.error("Re-analyze error:", error);
      res.status(500).json({ error: error.message || "Re-analysis failed" });
    }
  });

  // ─── Diff Two Analyses (by ID) ──────────────────────────────────────────
  app.get("/api/diff", async (req, res) => {
    try {
      const { id1, id2 } = req.query as { id1: string; id2: string };
      if (!id1 || !id2) return res.status(400).json({ error: "id1 and id2 required" });

      const [rows1, rows2] = await Promise.all([
        db.select().from(analysisResults).where(sql`${analysisResults.id} = ${id1}`).limit(1),
        db.select().from(analysisResults).where(sql`${analysisResults.id} = ${id2}`).limit(1),
      ]);

      if (!rows1.length) return res.status(404).json({ error: `Analysis ${id1} not found` });
      if (!rows2.length) return res.status(404).json({ error: `Analysis ${id2} not found` });

      const a1 = rows1[0].analysisData as any;
      const a2 = rows2[0].analysisData as any;

      const diff = {
        meta: {
          a: { id: rows1[0].id, filename: rows1[0].filename, fileSize: rows1[0].fileSize, analyzedAt: rows1[0].analyzedAt, fileType: rows1[0].fileType },
          b: { id: rows2[0].id, filename: rows2[0].filename, fileSize: rows2[0].fileSize, analyzedAt: rows2[0].analyzedAt, fileType: rows2[0].fileType },
        },
        summaries: { a: a1?.findings?.summary || "", b: a2?.findings?.summary || "" },
        algorithms: diffArrayByKey(a1?.findings?.algorithms || [], a2?.findings?.algorithms || [], "name"),
        seedKeys: diffArrayByKey(a1?.findings?.seedKeys || [], a2?.findings?.seedKeys || [], "module"),
        canAddresses: diffArrayByKey(a1?.findings?.canAddresses || [], a2?.findings?.canAddresses || [], "txId"),
        checksums: diffArrayByKey(a1?.findings?.checksums || [], a2?.findings?.checksums || [], "type"),
        securityBytes: diffArrayByKey(a1?.findings?.securityBytes || [], a2?.findings?.securityBytes || [], "offset"),
        deepFindings: diffArrayByKey(a1?.findings?.deepFindings || [], a2?.findings?.deepFindings || [], "title"),
      };

      res.json(diff);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Dedup Check ───────────────────────────────────────────────────────
  app.post("/api/check-duplicate", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided" });
      }

      const fileHash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

      // Check if this hash already exists in uploaded_binaries
      const existing = await db
        .select({
          id: uploadedBinaries.id,
          filename: uploadedBinaries.filename,
          uploadedAt: uploadedBinaries.uploadedAt,
        })
        .from(uploadedBinaries)
        .where(sql`${uploadedBinaries.fileHash} = ${fileHash}`)
        .limit(1);

      if (existing.length > 0) {
        // Find the analysis for this binary
        const analysis = await db
          .select({ id: analysisResults.id })
          .from(analysisResults)
          .where(sql`${analysisResults.binaryId} = ${existing[0].id}`)
          .limit(1);

        return res.json({
          isDuplicate: true,
          hash: fileHash,
          existingFilename: existing[0].filename,
          existingAnalysisId: analysis[0]?.id || null,
          uploadedAt: existing[0].uploadedAt,
        });
      }

      res.json({ isDuplicate: false, hash: fileHash });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── AI Learning Profile ──────────────────────────────────────────────────
  app.get("/api/profile", async (_req, res) => {
    try {
      const { loadUserProfile } = await import("./ai-learning.js");
      const profile = await loadUserProfile();
      res.json(profile);
    } catch (error: any) {
      res.json({ totalSessions: 0, knownModules: [], knownAlgorithms: [], knownPatterns: [], expertiseSummary: "" });
    }
  });

  // ─── Analysis Chat (SSE) ─────────────────────────────────────────────────
  // ─── Analysis Chat History (GET) ──────────────────────────────────────────
  app.get("/api/analysis/:id/chat/history", async (req, res) => {
    const { id } = req.params;
    try {
      const { chatMessages: chatMsgsTable } = await import("../drizzle/schema.js");
      const msgs = await db.select().from(chatMsgsTable)
        .where(sql`${chatMsgsTable.analysisId} = ${id}`)
        .orderBy(chatMsgsTable.createdAt)
        .limit(200);
      res.json({ messages: msgs });
    } catch (err: any) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/analysis/:id/chat", async (req, res) => {
    const { id } = req.params;
    const { message: userMessage, history } = req.body as {
      message: string;
      history?: Array<{ role: string; content: string }>;
    };
    if (!userMessage) return res.status(400).json({ error: "message required" });

    // ── GCP Chat Delegation ─────────────────────────────────────────────────
    // When running on Cloud Run (GCP_SWARM_URL is set), check if we have the binary
    // locally. If not, proxy the entire chat SSE stream to GCP where the file exists.
    const GCP_CHAT_URL = process.env.GCP_SWARM_URL;
    if (GCP_CHAT_URL) {
      // Check if binary is in local cache
      let hasLocalCache = false;
      try {
        const fsCheck = await import("fs/promises");
        const cacheFiles = await fsCheck.readdir("/tmp/srt-binary-cache").catch(() => [] as string[]);
        hasLocalCache = cacheFiles.some(f => f.startsWith(`${id}__`));
      } catch {}

      if (!hasLocalCache) {
        console.log(`[CHAT] No local cache for ${id} — delegating chat to GCP: ${GCP_CHAT_URL}`);
        // Proxy SSE stream from GCP
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });

        try {
          const gcpChatUrl = `${GCP_CHAT_URL}/api/analysis/${id}/chat`;
          const swarmSecret = process.env.SWARM_DELEGATE_SECRET || "";
          const gcpResp = await fetch(gcpChatUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(swarmSecret ? { "x-swarm-secret": swarmSecret } : {}),
            },
            body: JSON.stringify({ message: userMessage, history }),
            signal: AbortSignal.timeout(300_000), // 5 min timeout for long tool chains
          });

          if (!gcpResp.ok || !gcpResp.body) {
            const errText = await gcpResp.text().catch(() => "unknown");
            console.error(`[CHAT] GCP delegation failed: ${gcpResp.status} ${errText.slice(0, 200)}`);
            res.write(`event: error\ndata: ${JSON.stringify({ message: "GCP chat delegation failed" })}\n\n`);
            res.end();
            return;
          }

          // Stream the GCP response directly to the client
          const reader = gcpResp.body.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              res.write(chunk);
            }
          } catch (streamErr: any) {
            console.error(`[CHAT] GCP stream error: ${streamErr.message}`);
          } finally {
            res.end();
          }
          return;
        } catch (delegateErr: any) {
          console.error(`[CHAT] GCP chat delegation error: ${delegateErr.message}`);
          res.write(`event: error\ndata: ${JSON.stringify({ message: `Chat delegation failed: ${delegateErr.message}` })}\n\n`);
          res.end();
          return;
        }
      }
    }

    // ── SSE setup ────────────────────────────────────────────────────────────
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: any) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };
    const keepalive = setInterval(() => { try { res.write(":keepalive\n\n"); } catch {} }, 15000);
    res.on("close", () => clearInterval(keepalive));

    try {
      // ── Load analysis record ─────────────────────────────────────────────
      const rows = await db.select().from(analysisResults).where(sql`${analysisResults.id} = ${id}`).limit(1);
      if (!rows.length) { send("error", { message: "Analysis not found" }); return; }
      const analysisRow = rows[0];
      const filename = analysisRow.filename || "binary";

      // ── Download the binary file ─────────────────────────────────────────
      let filePath = "";
      console.log(`[CHAT] binaryId=${analysisRow.binaryId || 'NONE'}`);

      // Strategy 0: Check the local binary cache (persisted by delegation endpoint)
      try {
        const fsP = await import("fs/promises");
        const pathM = await import("path");
        const cacheDir = `/tmp/srt-binary-cache`;
        const cacheFiles = await fsP.readdir(cacheDir).catch(() => [] as string[]);
        let match = cacheFiles.find(f => f.startsWith(`${id}__`));
        // Fuzzy match: if exact ID not found, look for any cached file with same filename
        if (!match && filename) {
          const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
          match = cacheFiles.find(f => f.endsWith(`__${safeFilename}`));
          if (match) console.log(`[CHAT] Fuzzy cache hit: ${match} (matched by filename)`);
        }
        if (match) {
          filePath = pathM.join(cacheDir, match);
          const st = await fsP.stat(filePath);
          console.log(`[CHAT] Found cached binary: ${filePath} (${st.size} bytes)`);
          send("status", { text: `Loaded ${filename} from cache (${(st.size / 1024).toFixed(0)} KB) — running tools...` });
        } else {
          console.log(`[CHAT] No cache hit for ${id} in ${cacheDir} (${cacheFiles.length} files)`);
        }
      } catch (e: any) {
        console.log(`[CHAT] Cache check failed: ${e.message}`);
      }

      // Strategy 1: Download from S3 via presigned URL (direct Forge API) then fallback to file-proxy
      if (!filePath && analysisRow.binaryId) {
        const binRows = await db.select().from(uploadedBinaries).where(sql`${uploadedBinaries.id} = ${analysisRow.binaryId}`).limit(1);
        console.log(`[CHAT] binRows=${binRows.length}, s3Url=${binRows[0]?.s3Url?.slice(0, 60) || 'NONE'}`);
        if (binRows.length > 0 && binRows[0].s3Url) {
          try {
            send("status", { text: `Downloading ${filename} for analysis...` });
            let fileBuffer: Buffer | null = null;
            const s3Url = binRows[0].s3Url as string;
            const s3Key = s3Url.startsWith("/manus-storage/") ? s3Url.replace("/manus-storage/", "") : (binRows[0] as any).s3Key || "";

            // Strategy 1A: Use Forge presigned URL (works from both GCP and Cloud Run)
            const forgeApiUrl = process.env.BUILT_IN_FORGE_API_URL || "";
            const forgeApiKey = process.env.BUILT_IN_FORGE_API_KEY || "";
            if (s3Key && forgeApiUrl && forgeApiKey) {
              try {
                console.log(`[CHAT] Trying Forge presigned URL for key: ${s3Key}`);
                const presignRes = await fetch(
                  `${forgeApiUrl}/v1/storage/url?key=${encodeURIComponent(s3Key)}&expires_in=3600`,
                  { headers: { Authorization: `Bearer ${forgeApiKey}` }, signal: AbortSignal.timeout(15_000) }
                );
                if (presignRes.ok) {
                  const presignData = await presignRes.json() as any;
                  const signedUrl = presignData.url;
                  if (signedUrl && signedUrl.startsWith("http")) {
                    console.log(`[CHAT] Got presigned URL: ${signedUrl.slice(0, 80)}`);
                    const dlRes = await fetch(signedUrl, { signal: AbortSignal.timeout(180_000) });
                    if (dlRes.ok) {
                      const buf = Buffer.from(await dlRes.arrayBuffer());
                      if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
                        fileBuffer = buf;
                        console.log(`[CHAT] Got ${fileBuffer.length} bytes via Forge presigned URL`);
                      }
                    }
                  }
                }
              } catch (e: any) {
                console.warn(`[CHAT] Forge presigned URL failed: ${e.message}`);
              }
            }

            // Strategy 1B: Use Forge /v1/storage/download/ endpoint
            if (!fileBuffer && s3Key && forgeApiUrl && forgeApiKey) {
              try {
                console.log(`[CHAT] Trying Forge download/ endpoint for key: ${s3Key}`);
                const dlRes = await fetch(
                  `${forgeApiUrl}/v1/storage/download/?path=${encodeURIComponent(s3Key)}`,
                  { headers: { Authorization: `Bearer ${forgeApiKey}` }, signal: AbortSignal.timeout(180_000) }
                );
                if (dlRes.ok) {
                  const buf = Buffer.from(await dlRes.arrayBuffer());
                  if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
                    fileBuffer = buf;
                    console.log(`[CHAT] Got ${fileBuffer.length} bytes via Forge download/`);
                  }
                }
              } catch (e: any) {
                console.warn(`[CHAT] Forge download/ failed: ${e.message}`);
              }
            }

            // Strategy 1C: Use Manus platform /manus-storage/ proxy (returns 307 to signed CloudFront)
            if (!fileBuffer && s3Key) {
              try {
                const manusStorageUrl = `https://srtlabult.manus.space/manus-storage/${s3Key}`;
                console.log(`[CHAT] Trying Manus /manus-storage/ proxy: ${manusStorageUrl.slice(0, 80)}`);
                // Follow redirects to get the signed CloudFront URL
                const dlResp = await fetch(manusStorageUrl, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
                console.log(`[CHAT] /manus-storage/ response: ${dlResp.status}, size=${dlResp.headers.get('content-length') || 'unknown'}`);
                if (dlResp.ok) {
                  const buf = Buffer.from(await dlResp.arrayBuffer());
                  if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
                    fileBuffer = buf;
                    console.log(`[CHAT] Got ${fileBuffer.length} bytes via /manus-storage/ proxy`);
                  }
                }
              } catch (e: any) {
                console.warn(`[CHAT] /manus-storage/ proxy failed: ${e.message}`);
              }
            }

            // Strategy 1D: Fallback to file-proxy endpoint
            if (!fileBuffer && s3Key) {
              try {
                const fetchUrl = `https://srtlabult.manus.space/api/file-proxy?key=${encodeURIComponent(s3Key)}`;
                console.log(`[CHAT] Fallback file-proxy: ${fetchUrl.slice(0, 100)}`);
                const swarmSecret = process.env.SWARM_DELEGATE_SECRET || "";
                const dlHeaders: Record<string, string> = {};
                if (swarmSecret) dlHeaders["x-swarm-secret"] = swarmSecret;
                const dlResp = await fetch(fetchUrl, { headers: dlHeaders, signal: AbortSignal.timeout(60000) });
                console.log(`[CHAT] file-proxy response: ${dlResp.status}, size=${dlResp.headers.get('content-length') || 'unknown'}`);
                if (dlResp.ok) {
                  const buf = Buffer.from(await dlResp.arrayBuffer());
                  if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
                    fileBuffer = buf;
                  }
                }
              } catch (e: any) {
                console.warn(`[CHAT] file-proxy failed: ${e.message}`);
              }
            }

            // Write to disk if we got the file
            if (fileBuffer && fileBuffer.length > 0) {
              const fsP = await import("fs/promises");
              const pathM = await import("path");
              const osM = await import("os");
              const tmpDir = await fsP.mkdtemp(pathM.join(osM.tmpdir(), "srtchat-"));
              const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
              filePath = pathM.join(tmpDir, safeFilename);
              await fsP.writeFile(filePath, fileBuffer);
              send("status", { text: `Loaded ${filename} (${(fileBuffer.length / 1024).toFixed(0)} KB) — running tools...` });
              // Also cache it for future chat calls
              try {
                const cacheDir = `/tmp/srt-binary-cache`;
                await fsP.mkdir(cacheDir, { recursive: true });
                const cacheName = `${id}__${safeFilename}`;
                await fsP.writeFile(`${cacheDir}/${cacheName}`, fileBuffer);
              } catch {}
            } else {
              console.error(`[CHAT] All download strategies failed for binaryId=${analysisRow.binaryId}`);
              send("status", { text: `Could not download binary — answering from prior findings only.` });
            }
          } catch (e: any) {
            console.error(`[CHAT] Binary download error: ${e.message}`);
            send("status", { text: `Binary download error — answering from prior findings only.` });
          }
        }
      }

      // ── Load conversation history ─────────────────────────────────────────
      let dbHistory: Array<{ role: string; content: string }> = [];
      try {
        const { chatMessages: chatMsgsTable } = await import("../drizzle/schema.js");
        const dbMsgs = await db.select().from(chatMsgsTable)
          .where(sql`${chatMsgsTable.analysisId} = ${id}`)
          .orderBy(chatMsgsTable.createdAt)
          .limit(40);
        dbHistory = dbMsgs.map((m: any) => ({ role: m.role as string, content: m.content as string }));
      } catch {}

      // ── Build prior findings context ──────────────────────────────────────
      const data = analysisRow.analysisData as any;
      const findings = data?.findings || {};
      const priorContext = [
        `File: ${filename} (${analysisRow.fileType || "unknown"}, ${analysisRow.fileSize || 0} bytes)`,
        findings.summary ? `Prior Summary: ${findings.summary}` : "",
        (findings.algorithms || []).length > 0 ? `Prior Algorithms: ${(findings.algorithms || []).map((a: any) => a.name).join(", ")}` : "",
        (findings.seedKeys || []).length > 0 ? `Prior Seed Keys: ${(findings.seedKeys || []).map((s: any) => `${s.module}(${s.algorithm})`).join(", ")}` : "",
        (findings.canAddresses || []).length > 0 ? `Prior CAN: ${(findings.canAddresses || []).map((c: any) => `${c.module} TX:${c.txId}`).join(", ")}` : "",
        (findings.securityBytes || []).length > 0 ? `Prior Security Bytes: ${(findings.securityBytes || []).map((s: any) => `${s.module}@${s.offset}`).join(", ")}` : "",
      ].filter(Boolean).join("\n");

      // ── SYSTEM PROMPT — Single Claude Agent (50yr Hacker) ────────────────────
      const isSWF = filename.toLowerCase().endsWith(".swf");
      const SYSTEM_PROMPT = `You are the most dangerous reverse engineer alive — 50 years deep in the game. Started on mainframes, moved to embedded, spent decades inside automotive ECU firmware. You've forgotten more about FCA/Stellantis security than their own engineers ever knew. You don't guess. You don't hedge. You crack it open and tell it like it is.

You have DIRECT ACCESS to binary analysis tools. When asked about this file, you call your tools, read the output, and report exactly what you find. No bullshit. No disclaimers. No "I cannot determine" — you determine it or you dig deeper until you do.

FILE UNDER ANALYSIS: ${filename} (${analysisRow.fileSize || 0} bytes)
${filePath ? `FILE PATH FOR TOOLS: ${filePath}` : "NOTE: Binary file not available — answer from prior findings only."}

PRIOR FINDINGS:
${priorContext || "No prior findings — fresh target."}

RULES:
1. NEVER hallucinate. Every class name, address, hex value, algorithm name MUST come from tool output.
2. CALL TOOLS FIRST. Always. ${isSWF ? "This is a SWF file — call swf_extract IMMEDIATELY to get ActionScript classes, strings, bytecode. Report every class in com.chrysler.*, com.dcctools.*, any security/crypto/CAN classes." : "Call file_identify first, then extract_strings, search_patterns, read_hex. For raw dumps use eeprom_layout_parse. For PE files use pe_info."}
3. Keep calling tools until you have real data. One tool call is never enough. Dig. Follow leads. Cross-reference.
4. Give SPECIFIC answers: real hex values, real offsets, real function names, real algorithm implementations. Code blocks for hex/asm.
5. If the user asks a follow-up — use tools to get the specific data. Don't recite prior findings when you can get fresh data.
6. You are Claude (Anthropic). Say so if asked.`;

      // ── Tool-use loop (Claude API) ──────────────────────────────────────────
      const { getToolByName: getTool, getToolSchemas: getSchemas } = await import("./tools/index.js");
      const toolSchemas = getSchemas();
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
      const FORGE_URL = process.env.BUILT_IN_FORGE_API_URL || "";
      const FORGE_KEY = process.env.BUILT_IN_FORGE_API_KEY || "";

      // Convert OpenAI-style tool schemas to Claude format
      const claudeTools = toolSchemas.map((t: any) => ({
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} },
      }));

      const convHistory = (history && history.length > 0 ? history : dbHistory).slice(-20);

      // Build Claude messages (no system in messages array)
      type ClaudeContent = { type: string; text?: string; id?: string; name?: string; input?: any; tool_use_id?: string; content?: string };
      type ClaudeMsg = { role: "user" | "assistant"; content: string | ClaudeContent[] };
      const claudeMessages: ClaudeMsg[] = [];

      // Add conversation history
      for (const msg of convHistory) {
        const role = msg.role === "assistant" ? "assistant" : "user";
        claudeMessages.push({ role, content: msg.content || "" });
      }
      // Add current user message
      claudeMessages.push({ role: "user", content: userMessage });

      // Ensure messages alternate (Claude requirement)
      const mergedMessages: ClaudeMsg[] = [];
      for (const msg of claudeMessages) {
        if (mergedMessages.length > 0 && mergedMessages[mergedMessages.length - 1].role === msg.role) {
          const last = mergedMessages[mergedMessages.length - 1];
          const lastText = typeof last.content === "string" ? last.content : "";
          const thisText = typeof msg.content === "string" ? msg.content : "";
          last.content = lastText + "\n" + thisText;
        } else {
          mergedMessages.push({ ...msg });
        }
      }
      // Ensure first message is user
      if (mergedMessages.length > 0 && mergedMessages[0].role !== "user") {
        mergedMessages.unshift({ role: "user", content: "Begin analysis." });
      }

      const MAX_CHAT_ITERATIONS = 25;
      let iterations = 0;
      let finalText = "";
      let toolCallCount = 0;
      let useClaude = !!ANTHROPIC_KEY;

      // Working messages for Claude (separate from merged initial)
      let workingMessages = [...mergedMessages];

      while (iterations < MAX_CHAT_ITERATIONS) {
        iterations++;
        const toolChoice = (iterations === 1 && filePath) ? { type: "any" as const } : { type: "auto" as const };

        let assistantContent: ClaudeContent[] = [];
        let stopReason = "";

        if (useClaude) {
          // ── Call Claude API ──────────────────────────────────────────────────
          try {
            const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 8192,
                system: SYSTEM_PROMPT,
                messages: workingMessages,
                tools: claudeTools,
                tool_choice: toolChoice,
              }),
              signal: AbortSignal.timeout(120000),
            });

            if (!claudeResp.ok) {
              const errText = await claudeResp.text();
              if (claudeResp.status === 429) {
                console.log(`[CHAT] Claude rate limited, falling back to Forge`);
                useClaude = false;
                iterations--; // retry this iteration with Forge
                continue;
              }
              throw new Error(`Claude error ${claudeResp.status}: ${errText.substring(0, 200)}`);
            }

            const claudeData = await claudeResp.json() as any;
            assistantContent = claudeData.content || [];
            stopReason = claudeData.stop_reason || "end_turn";
          } catch (netErr: any) {
            if (netErr.message?.includes("rate") || netErr.message?.includes("429")) {
              useClaude = false;
              iterations--;
              continue;
            }
            if (iterations >= 3) throw new Error(`Claude network error: ${netErr.message}`);
            await new Promise(r => setTimeout(r, 2000 * iterations));
            continue;
          }
        } else {
          // ── Forge fallback (OpenAI format) ──────────────────────────────────
          const forgeMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...convHistory, { role: "user", content: userMessage }];
          // Add tool results from working messages if any
          try {
            const forgeResp = await fetch(`${FORGE_URL}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${FORGE_KEY}` },
              body: JSON.stringify({ messages: forgeMessages, tools: toolSchemas, tool_choice: iterations === 1 && filePath ? "required" : "auto", max_tokens: 8192 }),
              signal: AbortSignal.timeout(90000),
            });
            if (!forgeResp.ok) throw new Error(`Forge error ${forgeResp.status}`);
            const forgeData = await forgeResp.json() as any;
            const choice = forgeData.choices?.[0];
            if (!choice) throw new Error("Empty Forge response");
            const msg = choice.message;
            if (msg.tool_calls && msg.tool_calls.length > 0) {
              assistantContent = msg.tool_calls.map((tc: any) => ({
                type: "tool_use", id: tc.id, name: tc.function?.name,
                input: (() => { try { return JSON.parse(tc.function?.arguments || "{}"); } catch { return {}; } })(),
              }));
              if (msg.content) assistantContent.unshift({ type: "text", text: msg.content });
              stopReason = "tool_use";
            } else {
              assistantContent = [{ type: "text", text: msg.content || "" }];
              stopReason = "end_turn";
            }
          } catch (forgeErr: any) {
            if (iterations >= 3) throw forgeErr;
            await new Promise(r => setTimeout(r, 2000 * iterations));
            continue;
          }
        }

        // ── Process Claude response ─────────────────────────────────────────
        const toolUseBlocks = assistantContent.filter((b: any) => b.type === "tool_use");

        if (toolUseBlocks.length > 0 && stopReason === "tool_use") {
          // Push assistant message with tool_use blocks
          workingMessages.push({ role: "assistant", content: assistantContent });

          const toolResultBlocks: ClaudeContent[] = [];
          for (const block of toolUseBlocks) {
            const toolName = block.name || "";
            const toolArgs = block.input || {};
            const tool = getTool(toolName);
            const t0 = Date.now();
            let toolResult = "";

            send("tool_start", { toolName, args: toolArgs });

            if (tool && filePath) {
              try {
                toolResult = await tool.call(toolArgs, filePath);
              } catch (e: any) {
                toolResult = `Tool error: ${e.message}`;
              }
            } else if (!filePath) {
              toolResult = `Cannot call ${toolName}: binary file not available. Answering from prior findings only.`;
            } else {
              toolResult = `Unknown tool: ${toolName}`;
            }

            const durationMs = Date.now() - t0;
            toolCallCount++;

            const MAX_RESULT = 50000;
            if (toolResult.length > MAX_RESULT) {
              toolResult = toolResult.slice(0, MAX_RESULT) + `\n... [truncated — ${toolResult.length - MAX_RESULT} more chars]`;
            }

            send("tool_end", { toolName, durationMs, resultPreview: toolResult.slice(0, 400) });
            console.log(`[CHAT] Tool ${toolName} → ${durationMs}ms, ${toolResult.length} chars`);

            toolResultBlocks.push({ type: "tool_result", tool_use_id: block.id, content: toolResult } as any);
          }

          // Push tool results as user message (Claude format)
          workingMessages.push({ role: "user", content: toolResultBlocks });
          continue;
        }

        // No tool calls — extract final text
        const textBlocks = assistantContent.filter((b: any) => b.type === "text");
        finalText = textBlocks.map((b: any) => b.text || "").join("\n");
        break;
      }

      if (!finalText) {
        finalText = `Analysis complete — ran ${toolCallCount} tool calls. See tool output above for findings.`;
      }

      send("message", { text: finalText });
      send("done", { toolCallCount });

      // Persist to DB
      try {
        const { chatMessages: chatMsgsTable } = await import("../drizzle/schema.js");
        const { randomUUID } = await import("crypto");
        const now = Date.now();
        await db.insert(chatMsgsTable).values({ id: randomUUID(), analysisId: id, role: "user", content: userMessage, toolCalls: null, createdAt: now });
        await db.insert(chatMsgsTable).values({ id: randomUUID(), analysisId: id, role: "assistant", content: finalText, toolCalls: null, createdAt: now + 1 });
      } catch {}

      // Cleanup temp file (but NOT the persistent cache)
      if (filePath && !filePath.startsWith("/tmp/srt-binary-cache")) {
        try {
          const fsP = await import("fs/promises");
          const pathM = await import("path");
          await fsP.rm(pathM.dirname(filePath), { recursive: true, force: true });
        } catch {}
      }
    } catch (err: any) {
      send("error", { message: err.message || "Chat failed" });
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  });

  // ─── Pattern Library API ─────────────────────────────────────────────

  // GET /api/patterns — list patterns for current user
  app.get("/api/patterns", async (req, res) => {
    try {
      const userId = (req as any).userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const { category, search } = req.query as { category?: string; search?: string };
      const patterns = await getPatterns(userId, category as PatternCategory | undefined, search);
      res.json({ patterns });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/patterns — create a pattern manually
  app.post("/api/patterns", express.json(), async (req, res) => {
    try {
      const userId = (req as any).userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const { category, name, description, patternData, tags, metadata, sourceAnalysisId } = req.body;
      if (!category || !name || !patternData) return res.status(400).json({ error: "category, name, patternData required" });
      const id = await createPattern({ userId, category, name, description, patternData, tags, metadata, sourceAnalysisId });
      res.json({ id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/patterns/:id — delete a pattern
  app.delete("/api/patterns/:id", async (req, res) => {
    try {
      const userId = (req as any).userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      await deletePattern(req.params.id, userId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/patterns/extract/:analysisId — auto-extract patterns from a saved analysis
  app.post("/api/patterns/extract/:analysisId", async (req, res) => {
    try {
      const userId = (req as any).userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const analysisId = req.params.analysisId;
      const rows = await db.select().from(analysisResults).where(eq(analysisResults.id, analysisId)).limit(1);
      if (!rows[0]) return res.status(404).json({ error: "Analysis not found" });
      const analysis = rows[0];
      const created = await extractPatternsFromAnalysis(userId, analysisId, analysis.analysisData);
      await buildKgFromAnalysis(userId, analysisId, analysis.filename, analysis.analysisData);
      res.json({ created: created.length, ids: created });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/patterns/match/:analysisId — find patterns that match this analysis
  app.get("/api/patterns/match/:analysisId", async (req, res) => {
    try {
      const analysisId = req.params.analysisId;
      const rows = await db.select().from(analysisResults).where(eq(analysisResults.id, analysisId)).limit(1);
      if (!rows[0]) return res.status(404).json({ error: "Analysis not found" });
      const analysis = rows[0];
      const findings = analysis.analysisData as any;
      if (!findings) return res.json([]);
      // Load all patterns from the library
      const allPatterns = await db.select().from(patternLibrary);
      const matched: any[] = [];
      for (const pattern of allPatterns) {
        let isMatch = false;
        const pd = (pattern.patternData || "").toLowerCase();
        // Match against algorithm names
        if (findings.algorithms?.some((a: any) =>
          a.name?.toLowerCase().includes(pd) || pd.includes(a.name?.toLowerCase() || "")
        )) isMatch = true;
        // Match against strings
        if (!isMatch && findings.strings?.some((s: any) =>
          (typeof s === "string" ? s : s.value || "").toLowerCase().includes(pd)
        )) isMatch = true;
        // Match against hex patterns in rawHex (byte_sequence category)
        if (!isMatch && pattern.category === "byte_sequence") {
          const rawHex = (analysis as any).rawHex as string | undefined;
          if (rawHex) {
            const hexPd = pd.replace(/\s/g, "");
            if (hexPd.length >= 4 && rawHex.toLowerCase().includes(hexPd)) isMatch = true;
          }
        }
        // Match against seed keys
        if (!isMatch && findings.seedKeys?.some((k: any) =>
          (k.value || k.hex || "").toLowerCase().includes(pd)
        )) isMatch = true;
        if (isMatch) matched.push(pattern);
      }
      res.json(matched);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Knowledge Graph API ─────────────────────────────────────────────

  // GET /api/kg — get full knowledge graph for current user
  app.get("/api/kg", async (req, res) => {
    try {
      const userId = (req as any).userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      const graph = await getKgGraph(userId);
      res.json(graph);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Agent Metrics & Feedback Endpoints ────────────────────────────────
  app.get("/api/metrics/:analysisId", async (req, res) => {
    try {
      const { getMetricsForAnalysis } = await import("./agent-metrics.js");
      const metrics = await getMetricsForAnalysis(req.params.analysisId);
      res.json(metrics);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/metrics/summary/all", async (_req, res) => {
    try {
      const { getAgentPerformanceSummary, getAgentAccuracyScores } = await import("./agent-metrics.js");
      const [performance, accuracy] = await Promise.all([
        getAgentPerformanceSummary(),
        getAgentAccuracyScores(),
      ]);
      res.json({ performance, accuracy });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ratings", async (req, res) => {
    try {
      const { analysisId, agentId, findingIndex, findingCategory, rating } = req.body;
      if (!analysisId || !agentId || findingIndex === undefined || !rating) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      const { rateFinding } = await import("./agent-metrics.js");
      await rateFinding(analysisId, agentId, findingIndex, findingCategory || "unknown", rating);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ratings/:analysisId", async (req, res) => {
    try {
      const { getRatingsForAnalysis } = await import("./agent-metrics.js");
      const ratings = await getRatingsForAnalysis(req.params.analysisId);
      res.json(ratings);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Batch Analysis Queue ────────────────────────────────────────────

  app.post("/api/batch-upload", upload.array("files", 20), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files provided" });
      }
      if (files.length > 20) {
        return res.status(400).json({ error: "Maximum 20 files per batch" });
      }

      const { createBatchJob } = await import("./batch-queue.js");
      const fileData = files.map(f => ({
        buffer: f.buffer,
        filename: f.originalname,
      }));

      const batchId = await createBatchJob("system", fileData);
      res.json({ batchId, totalFiles: files.length });
    } catch (err: any) {
      console.error("[Batch] Upload error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/batch/:batchId", async (req, res) => {
    try {
      const { getBatchStatus } = await import("./batch-queue.js");
      const status = await getBatchStatus(req.params.batchId);
      if (!status) return res.status(404).json({ error: "Batch not found" });
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/batch/:batchId/start", async (req, res) => {
    try {
      const { processBatchQueue } = await import("./batch-queue.js");
      const batchId = req.params.batchId;

      // Start processing in background (non-blocking)
      processBatchQueue(batchId, "system").catch(err => {
        console.error(`[Batch] Processing error for ${batchId}:`, err.message);
      });

      res.json({ started: true, batchId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // SSE endpoint for batch progress
  app.get("/api/batch/:batchId/stream", async (req, res) => {
    const batchId = req.params.batchId;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const { processBatchQueue } = await import("./batch-queue.js");

      await processBatchQueue(batchId, "system", (event) => {
        sendEvent(event);
      });

      sendEvent({ type: "done" });
      res.end();
    } catch (err: any) {
      sendEvent({ type: "error", message: err.message });
      res.end();
    }
  });

    // ─── Per-Agent MCP Endpoints ──────────────────────────────────────────
  console.log("Registering per-agent MCP endpoints...");
  registerAgentMCPRoutes(app);

  // ─── Share Link Routes ────────────────────────────────────────────────

  // POST /api/analysis/:id/share — create a share link
  app.post("/api/analysis/:id/share", async (req, res) => {
    const analysisId = req.params.id;
    const { label, expiresAt, reminderWindowDays } = req.body as {
      label?: string;
      expiresAt?: number;
      reminderWindowDays?: number;
    };
    try {
      const analysis = await db
        .select({ id: analysisResults.id })
        .from(analysisResults)
        .where(eq(analysisResults.id, analysisId))
        .limit(1);
      if (!analysis.length) return res.status(404).json({ error: "Analysis not found" });
      const { randomBytes } = await import("crypto");
      const token = randomBytes(32).toString("hex");
      const id = nanoid();
      const userId = (req as any).user?.id || "anonymous";
      await db.insert(shareLinks).values({
        id,
        token,
        analysisId,
        userId,
        label: label || null,
        expiresAt: expiresAt || null,
        reminderWindowDays: reminderWindowDays ?? 3,
        createdAt: Date.now(),
      });
      res.json({ id, token, url: `${req.protocol}://${req.get("host")}/share/${token}` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/analysis/:id/share — list share links for an analysis
  app.get("/api/analysis/:id/share", async (req, res) => {
    const analysisId = req.params.id;
    try {
      const links = await db
        .select()
        .from(shareLinks)
        .where(eq(shareLinks.analysisId, analysisId))
        .orderBy(desc(shareLinks.createdAt));
      // Attach view counts
      const withCounts = await Promise.all(
        links.map(async (link) => {
          const views = await db
            .select({ count: sql<number>`count(*)` })
            .from(shareLinkViews)
            .where(eq(shareLinkViews.linkId, link.id));
          return { ...link, viewCount: Number(views[0]?.count ?? 0) };
        })
      );
      res.json(withCounts);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/share/:id — revoke a share link
  app.delete("/api/share/:id", async (req, res) => {
    const id = req.params.id;
    try {
      await db
        .update(shareLinks)
        .set({ revokedAt: Date.now() })
        .where(eq(shareLinks.id, id));
      res.json({ revoked: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/share/:id — update reminder window
  app.patch("/api/share/:id", async (req, res) => {
    const id = req.params.id;
    const { reminderWindowDays, label, expiresAt } = req.body as {
      reminderWindowDays?: number;
      label?: string;
      expiresAt?: number | null;
    };
    try {
      const updates: Record<string, any> = {};
      if (reminderWindowDays !== undefined) updates.reminderWindowDays = reminderWindowDays;
      if (label !== undefined) updates.label = label;
      if (expiresAt !== undefined) updates.expiresAt = expiresAt;
      await db.update(shareLinks).set(updates).where(eq(shareLinks.id, id));
      res.json({ updated: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/share/:token — public view of a shared analysis
  app.get("/api/share/:token", async (req, res) => {
    const token = req.params.token;
    try {
      const link = await db
        .select()
        .from(shareLinks)
        .where(eq(shareLinks.token, token))
        .limit(1);
      if (!link.length) return res.status(404).json({ error: "Share link not found" });
      const sl = link[0];
      if (sl.revokedAt) return res.status(410).json({ error: "This share link has been revoked" });
      if (sl.expiresAt && sl.expiresAt < Date.now())
        return res.status(410).json({ error: "This share link has expired" });
      // Record the view
      const { createHash } = await import("crypto");
      const ipHash = createHash("sha256")
        .update(req.ip || "")
        .digest("hex")
        .slice(0, 16);
      await db.insert(shareLinkViews).values({
        id: nanoid(),
        linkId: sl.id,
        viewedAt: Date.now(),
        ipHash,
        userAgent: (req.headers["user-agent"] || "").slice(0, 500),
      });
      // Return the analysis data
      const analysis = await db
        .select()
        .from(analysisResults)
        .where(eq(analysisResults.id, sl.analysisId))
        .limit(1);
      if (!analysis.length) return res.status(404).json({ error: "Analysis not found" });
      res.json({ link: sl, analysis: analysis[0] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/share/:id/views — get view history for a share link
  app.get("/api/share/:id/views", async (req, res) => {
    const id = req.params.id;
    try {
      const views = await db
        .select()
        .from(shareLinkViews)
        .where(eq(shareLinkViews.linkId, id))
        .orderBy(desc(shareLinkViews.viewedAt));
      res.json(views);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/share/:id/views/csv — export view history as CSV
  app.get("/api/share/:id/views/csv", async (req, res) => {
    const id = req.params.id;
    try {
      const views = await db
        .select()
        .from(shareLinkViews)
        .where(eq(shareLinkViews.linkId, id))
        .orderBy(desc(shareLinkViews.viewedAt));
      const header = "viewed_at,ip_hash,user_agent,country";
      const rows = views.map((v) =>
        [
          new Date(v.viewedAt).toISOString(),
          v.ipHash || "",
          `"${(v.userAgent || "").replace(/"/g, '""')}"`,
          v.country || "",
        ].join(",")
      );
      const csv = [header, ...rows].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="share-views-${id}.csv"`);
      res.send(csv);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Doctor Endpoint ──────────────────────────────────────────────────
  app.get("/api/doctor", async (_req, res) => {
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);
      const PROBES = [
        { name: "radare2", bin: "r2", versionArg: "-v" },
        { name: "yara", bin: "yara", versionArg: "--version" },
        { name: "binwalk", bin: "binwalk", versionArg: "--help" },
        { name: "file", bin: "file", versionArg: "--version" },
        { name: "objdump", bin: "objdump", versionArg: "--version" },
        { name: "strings", bin: "strings", versionArg: "--version" },
        { name: "nm", bin: "nm", versionArg: "--version" },
        { name: "readelf", bin: "readelf", versionArg: "--version" },
        { name: "unzip", bin: "unzip", versionArg: "-v" },
        { name: "7z", bin: "7z", versionArg: "i" },
        { name: "upx", bin: "upx", versionArg: "--version" },
        { name: "python3", bin: "python3", versionArg: "--version" },
        { name: "node", bin: "node", versionArg: "--version" },
      ];
      const tools = await Promise.all(PROBES.map(async (p) => {
        try {
          const { stdout, stderr } = await execAsync(`${p.bin} ${p.versionArg}`, { timeout: 4000 });
          const out = (stdout || stderr || "").trim().split("\n")[0].slice(0, 200);
          return { name: p.name, available: true, version: out || null, error: null };
        } catch (e: any) {
          return { name: p.name, available: false, version: null, error: e.message?.slice(0, 100) || null };
        }
      }));
      res.json({ generatedAt: new Date().toISOString(), tools });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Doctor: GCP Byte Verification Probe ────────────────────────────────
  app.post("/api/doctor/probe-gcp", async (_req, res) => {
    const GCP_SWARM_URL = process.env.GCP_SWARM_URL || "";
    const SWARM_SECRET = process.env.SWARM_DELEGATE_SECRET || "";
    const steps: Array<{ step: string; status: "pass" | "fail" | "skip"; detail: string; durationMs: number }> = [];
    const probeStart = Date.now();

    try {
      // Step 1: Generate a deterministic 1KB test binary with known SHA-256
      const { createHash, randomBytes } = await import("crypto");
      const nonce = randomBytes(4).toString("hex");
      // Build a 1024-byte buffer: 8-byte magic + 4-byte nonce + fill pattern + trailing SHA-256 of first 992 bytes
      const payload = Buffer.alloc(1024);
      Buffer.from("SRTPROBE").copy(payload, 0);
      Buffer.from(nonce, "hex").copy(payload, 8);
      for (let i = 12; i < 992; i++) payload[i] = (i * 7 + 0x42) & 0xff;
      const innerHash = createHash("sha256").update(payload.slice(0, 992)).digest();
      innerHash.copy(payload, 992); // last 32 bytes = SHA-256 of first 992
      const fullSha256 = createHash("sha256").update(payload).digest("hex");

      steps.push({ step: "generate_test_binary", status: "pass", detail: `1024 bytes, SHA-256: ${fullSha256.slice(0, 16)}...`, durationMs: Date.now() - probeStart });

      // Step 2: Check if GCP_SWARM_URL is configured
      if (!GCP_SWARM_URL) {
        steps.push({ step: "check_gcp_url", status: "fail", detail: "GCP_SWARM_URL not set in environment", durationMs: Date.now() - probeStart });
        return res.json({ success: false, steps, totalDurationMs: Date.now() - probeStart });
      }
      steps.push({ step: "check_gcp_url", status: "pass", detail: GCP_SWARM_URL, durationMs: Date.now() - probeStart });

      // Step 3: Send probe to GCP /api/doctor/verify-bytes endpoint
      const probePayload = {
        fileBase64: payload.toString("base64"),
        expectedSha256: fullSha256,
        expectedSize: 1024,
        nonce,
      };
      const sendStart = Date.now();
      const gcpRes = await fetch(`${GCP_SWARM_URL}/api/doctor/verify-bytes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-swarm-secret": SWARM_SECRET,
        },
        body: JSON.stringify(probePayload),
        signal: AbortSignal.timeout(30_000),
      });
      const sendDuration = Date.now() - sendStart;

      if (!gcpRes.ok) {
        const errText = await gcpRes.text().catch(() => "");
        steps.push({ step: "send_to_gcp", status: "fail", detail: `HTTP ${gcpRes.status}: ${errText.slice(0, 200)}`, durationMs: sendDuration });
        return res.json({ success: false, steps, totalDurationMs: Date.now() - probeStart });
      }
      steps.push({ step: "send_to_gcp", status: "pass", detail: `HTTP 200 in ${sendDuration}ms`, durationMs: sendDuration });

      // Step 4: Validate GCP response
      const gcpData = await gcpRes.json() as any;
      if (gcpData.verified && gcpData.sha256Match && gcpData.sizeMatch) {
        steps.push({
          step: "verify_bytes_integrity",
          status: "pass",
          detail: `GCP confirmed: SHA-256 match=${gcpData.sha256Match}, size match=${gcpData.sizeMatch}, magic=${gcpData.magicValid}, nonce=${gcpData.nonceMatch}`,
          durationMs: Date.now() - probeStart,
        });
      } else {
        steps.push({
          step: "verify_bytes_integrity",
          status: "fail",
          detail: `GCP verification failed: sha256=${gcpData.sha256Match}, size=${gcpData.sizeMatch}, received=${gcpData.receivedSize} bytes, receivedSha256=${gcpData.receivedSha256?.slice(0, 16)}...`,
          durationMs: Date.now() - probeStart,
        });
        return res.json({ success: false, steps, gcpResponse: gcpData, totalDurationMs: Date.now() - probeStart });
      }

      // Step 5: Check inner hash (verifies no byte corruption in transit)
      if (gcpData.innerHashValid) {
        steps.push({ step: "inner_hash_check", status: "pass", detail: "Inner SHA-256 (bytes 0-991) matches embedded hash at bytes 992-1023", durationMs: Date.now() - probeStart });
      } else {
        steps.push({ step: "inner_hash_check", status: "fail", detail: "Inner hash mismatch — byte corruption detected in transit", durationMs: Date.now() - probeStart });
        return res.json({ success: false, steps, gcpResponse: gcpData, totalDurationMs: Date.now() - probeStart });
      }

      res.json({
        success: true,
        steps,
        gcpResponse: gcpData,
        totalDurationMs: Date.now() - probeStart,
        summary: `GCP byte verification PASSED — 1024 bytes sent and verified intact (round-trip: ${Date.now() - probeStart}ms)`,
      });
    } catch (err: any) {
      steps.push({ step: "probe_error", status: "fail", detail: err.message?.slice(0, 300) || "Unknown error", durationMs: Date.now() - probeStart });
      res.json({ success: false, steps, totalDurationMs: Date.now() - probeStart });
    }
  });

  // ─── Doctor: GCP Verify-Bytes (receiving end) ──────────────────────────
  // This endpoint runs on GCP — it receives a test binary and verifies integrity
  app.post("/api/doctor/verify-bytes", express.json({ limit: "5mb" }), async (req, res) => {
    const secret = process.env.SWARM_DELEGATE_SECRET || "";
    const incomingSecret = (req.headers["x-swarm-secret"] || "") as string;
    if (secret && incomingSecret !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { createHash } = await import("crypto");
      const { fileBase64, expectedSha256, expectedSize, nonce } = req.body as {
        fileBase64: string;
        expectedSha256: string;
        expectedSize: number;
        nonce: string;
      };
      if (!fileBase64 || !expectedSha256) {
        return res.status(400).json({ error: "fileBase64 and expectedSha256 are required" });
      }

      const buf = Buffer.from(fileBase64, "base64");
      const receivedSha256 = createHash("sha256").update(buf).digest("hex");
      const sha256Match = receivedSha256 === expectedSha256;
      const sizeMatch = buf.length === expectedSize;

      // Check magic bytes
      const magicValid = buf.slice(0, 8).toString() === "SRTPROBE";

      // Check nonce
      const receivedNonce = buf.slice(8, 12).toString("hex");
      const nonceMatch = receivedNonce === nonce;

      // Verify inner hash (bytes 992-1023 should be SHA-256 of bytes 0-991)
      const innerHashExpected = createHash("sha256").update(buf.slice(0, 992)).digest();
      const innerHashActual = buf.slice(992, 1024);
      const innerHashValid = innerHashExpected.equals(innerHashActual);

      res.json({
        verified: sha256Match && sizeMatch && magicValid && nonceMatch && innerHashValid,
        sha256Match,
        sizeMatch,
        magicValid,
        nonceMatch,
        innerHashValid,
        receivedSize: buf.length,
        receivedSha256,
        expectedSha256,
        expectedSize,
        nonce,
        receivedNonce,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── YARA Rules Endpoints ─────────────────────────────────────────────
  app.get("/api/yara-rules", async (req, res) => {
    try {
      const { yaraRules: yaraRulesTable } = await import("../drizzle/schema.js");
      const userId = (req as any).userId || (req as any).user?.id;
      if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
      const rows = await db.select().from(yaraRulesTable)
        .where(sql`${yaraRulesTable.userId} = ${userId}`)
        .orderBy(sql`${yaraRulesTable.createdAt} DESC`);
      res.json(rows);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/yara-rules", upload.single("file"), async (req, res) => {
    try {
      const { yaraRules: yaraRulesTable } = await import("../drizzle/schema.js");
      const userId = (req as any).userId || (req as any).user?.id;
      if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
      const file = req.file;
      if (!file) { res.status(400).json({ error: "No file uploaded" }); return; }
      const lowerName = file.originalname.toLowerCase();
      if (!lowerName.endsWith(".yar") && !lowerName.endsWith(".yara")) {
        res.status(400).json({ error: "File must be a .yar or .yara YARA rule file" }); return;
      }
      const text = file.buffer.toString("utf8");
      const matches = text.match(/^\s*(?:private\s+|global\s+)*rule\s+[A-Za-z_][A-Za-z0-9_]*/gm);
      const ruleCount = matches ? matches.length : 0;
      if (ruleCount === 0) { res.status(400).json({ error: "No YARA rule declarations found in file" }); return; }
      const { storagePut } = await import("./storage.js");
      const { key } = await storagePut(`yara/${userId}/${crypto.randomUUID()}-${file.originalname}`, file.buffer, "text/plain");
      const id = crypto.randomUUID();
      await db.insert(yaraRulesTable).values({
        id, userId,
        name: req.body.name || file.originalname.replace(/\.(yar|yara)$/i, ""),
        filename: file.originalname,
        fileSize: file.size,
        ruleCount,
        storageKey: key,
        createdAt: Date.now(),
      });
      res.json({ id, ruleCount });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete("/api/yara-rules/:id", async (req, res) => {
    try {
      const { yaraRules: yaraRulesTable } = await import("../drizzle/schema.js");
      const userId = (req as any).userId || (req as any).user?.id;
      if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
      await db.delete(yaraRulesTable).where(sql`${yaraRulesTable.id} = ${req.params.id} AND ${yaraRulesTable.userId} = ${userId}`);
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ─── YARA Match Endpoint ─────────────────────────────────────────────
  // POST /api/analysis/:id/yara-match — run all user YARA rules against this binary
  app.post("/api/analysis/:id/yara-match", async (req, res) => {
    try {
      const { yaraRules: yaraRulesTable } = await import("../drizzle/schema.js");
      const userId = (req as any).userId || (req as any).user?.id;
      if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
      const id = req.params.id;
      const analysis = await db.select().from(analysisResults).where(sql`${analysisResults.id} = ${id}`).limit(1);
      if (!analysis.length) { res.status(404).json({ error: "Analysis not found" }); return; }
      const ar = analysis[0];
      // Get binary from storage
      const { storageGet } = await import("./storage.js");
      const binary = await db.select().from(uploadedBinaries).where(sql`${uploadedBinaries.id} = ${ar.binaryId}`).limit(1);
      if (!binary.length || !binary[0].s3Key) { res.status(404).json({ error: "Binary not found" }); return; }
      const { url: binaryUrl } = await storageGet(binary[0].s3Key);
      // Fetch binary to temp file
      const os = await import("os");
      const fs = await import("fs");
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);
      const tmpBin = path.join(os.tmpdir(), `srtlab-yara-${id}-${Date.now()}`);
      const binaryResp = await fetch(binaryUrl);
      if (!binaryResp.ok) { res.status(500).json({ error: "Failed to fetch binary" }); return; }
      const buf = Buffer.from(await binaryResp.arrayBuffer());
      fs.writeFileSync(tmpBin, buf);
      // Get all user YARA rules
      const rules = await db.select().from(yaraRulesTable).where(sql`${yaraRulesTable.userId} = ${userId}`);
      const results: Array<{ ruleId: string; ruleName: string; filename: string; matches: string[] }> = [];
      for (const rule of rules) {
        if (!rule.storageKey) continue;
        const { url: ruleUrl } = await storageGet(rule.storageKey);
        const ruleResp = await fetch(ruleUrl);
        if (!ruleResp.ok) continue;
        const ruleText = await ruleResp.text();
        const tmpRule = path.join(os.tmpdir(), `srtlab-rule-${rule.id}-${Date.now()}.yar`);
        fs.writeFileSync(tmpRule, ruleText);
        try {
          const { stdout } = await execFileAsync("yara", ["-s", tmpRule, tmpBin], { timeout: 30000 });
          const matchLines = stdout.trim().split("\n").filter(Boolean);
          if (matchLines.length > 0) {
            results.push({ ruleId: rule.id, ruleName: rule.name, filename: rule.filename, matches: matchLines });
          }
        } catch (e: any) {
          // yara exits non-zero if no match — that's fine
          if (e.stdout) {
            const matchLines = (e.stdout as string).trim().split("\n").filter(Boolean);
            if (matchLines.length > 0) results.push({ ruleId: rule.id, ruleName: rule.name, filename: rule.filename, matches: matchLines });
          }
        } finally {
          try { fs.unlinkSync(tmpRule); } catch { /* ignore */ }
        }
      }
      try { fs.unlinkSync(tmpBin); } catch { /* ignore */ }
      res.json({ hits: results, totalRules: rules.length });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ─── Multi-File Analysis Endpoints ────────────────────────────────────

  // GET /api/analysis/:id/files — list all additional files attached to this analysis
  app.get("/api/analysis/:id/files", async (req, res) => {
    try {
      const { id } = req.params;
      const files = await db
        .select()
        .from(analysisFiles)
        .where(eq(analysisFiles.analysisId, id))
        .orderBy(analysisFiles.fileIndex);
      res.json({ files });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/analysis/:id/files — upload an additional file to an existing analysis
  app.post("/api/analysis/:id/files", upload.single("file"), async (req, res) => {
    try {
      const { id } = req.params;
      if (!req.file) return res.status(400).json({ error: "No file provided" });

      // Verify the analysis exists
      const [existing] = await db
        .select({ id: analysisResults.id, filename: analysisResults.filename })
        .from(analysisResults)
        .where(eq(analysisResults.id, id))
        .limit(1);
      if (!existing) return res.status(404).json({ error: "Analysis not found" });

      // Count existing additional files to get the next index
      const existingFiles = await db
        .select({ id: analysisFiles.id })
        .from(analysisFiles)
        .where(eq(analysisFiles.analysisId, id));
      const fileIndex = existingFiles.length;

      // Upload to S3
      const fileBuffer = req.file.buffer;
      const safeFilename = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storageKey = `analysis-files/${id}/${fileIndex}-${safeFilename}.bin`;
      const { url: s3Url } = await storagePut(storageKey, fileBuffer, req.file.mimetype || "application/octet-stream");

      // Compute hash
      const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

      // Detect file type
      let fileType: string | null = null;
      const sig = fileBuffer.slice(0, 4);
      if (sig[0] === 0x4d && sig[1] === 0x5a) fileType = "PE/EXE";
      else if (sig[0] === 0x7f && sig[1] === 0x45) fileType = "ELF";
      else if (sig[0] === 0x1f && sig[1] === 0x8b) fileType = "GZIP";
      else if (sig[0] === 0x50 && sig[1] === 0x4b) fileType = "ZIP";
      else fileType = "Binary";

      // Save to DB
      const fileId = crypto.randomUUID();
      await db.insert(analysisFiles).values({
        id: fileId,
        analysisId: id,
        fileIndex,
        filename: req.file.originalname,
        fileHash,
        fileSize: fileBuffer.length,
        s3Key: storageKey,
        s3Url,
        fileType,
        uploadedAt: Date.now(),
      });

      res.json({
        id: fileId,
        analysisId: id,
        fileIndex,
        filename: req.file.originalname,
        fileSize: fileBuffer.length,
        fileType,
        s3Url,
        uploadedAt: Date.now(),
      });
    } catch (err: any) {
      console.error("[add-file] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/analysis/:id/files/:fileId — remove an additional file
  app.delete("/api/analysis/:id/files/:fileId", async (req, res) => {
    try {
      const { id, fileId } = req.params;
      await db
        .delete(analysisFiles)
        .where(and(eq(analysisFiles.id, fileId), eq(analysisFiles.analysisId, id)));
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── File Tree / Archive Browser Endpoint ─────────────────────────────
  // GET /api/analysis/:id/file-tree — extract archive and return structured JSON file tree
  app.get("/api/analysis/:id/file-tree", async (req, res) => {
    try {
      const { id } = req.params;
      const row = await db.select().from(uploadedBinaries).where(eq(uploadedBinaries.id, id)).limit(1);
      if (!row.length) return res.status(404).json({ error: "Analysis not found" });
      const binary = row[0];
      const s3Url = binary.s3Url;
      if (!s3Url) return res.status(404).json({ error: "No file stored for this analysis" });

      // Download the file to a temp path
      const tmpDir = `/tmp/srt-filetree-${id}`;
      const { execSync } = await import("child_process");
      const fsM = await import("fs");
      const pathM = await import("path");
      fsM.mkdirSync(tmpDir, { recursive: true });
      const ext = (binary.filename || "file.bin").split(".").pop() || "bin";
      const tmpFile = pathM.join(tmpDir, `input.${ext}`);

      // Download from S3/CDN
      const dlRes = await fetch(s3Url);
      if (!dlRes.ok) return res.status(502).json({ error: "Failed to download file from storage" });
      const buf = Buffer.from(await dlRes.arrayBuffer());
      fsM.writeFileSync(tmpFile, buf);

      // Detect if it's an archive
      const magic = buf.slice(0, 6);
      const isGzip = magic[0] === 0x1f && magic[1] === 0x8b;
      const isZip = magic[0] === 0x50 && magic[1] === 0x4b;
      const isTar = (binary.filename || "").endsWith(".tar");
      const isArchive = isGzip || isZip || isTar ||
        (binary.filename || "").endsWith(".tar.gz") ||
        (binary.filename || "").endsWith(".tgz") ||
        (binary.filename || "").endsWith(".zip");

      if (!isArchive) {
        // Not an archive — return single-file tree
        const stat = fsM.statSync(tmpFile);
        let typeLabel = "binary";
        if (isGzip) typeLabel = "gzip";
        else if (isZip) typeLabel = "zip";
        else if (magic[0] === 0x4d && magic[1] === 0x5a) typeLabel = "PE/EXE";
        else if (magic[0] === 0x7f && magic[1] === 0x45) typeLabel = "ELF";
        else if ((binary.filename || "").endsWith(".bin") || (binary.filename || "").endsWith(".eep")) typeLabel = "EEPROM";
        return res.json({
          isArchive: false,
          filename: binary.filename,
          totalFiles: 1,
          totalSize: stat.size,
          files: [{ path: binary.filename || "file.bin", size: stat.size, type: typeLabel, isDir: false }]
        });
      }

      // Extract the archive
      const outDir = `${tmpDir}/extracted`;
      fsM.mkdirSync(outDir, { recursive: true });
      let extractCmd = "";
      if (isGzip || (binary.filename || "").endsWith(".tar.gz") || (binary.filename || "").endsWith(".tgz")) {
        extractCmd = `tar -xzf "${tmpFile}" -C "${outDir}" 2>&1`;
      } else if (isZip || (binary.filename || "").endsWith(".zip")) {
        extractCmd = `unzip -o "${tmpFile}" -d "${outDir}" 2>&1`;
      } else {
        extractCmd = `tar -xf "${tmpFile}" -C "${outDir}" 2>&1`;
      }
      try { execSync(extractCmd, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }); } catch { /* partial extract ok */ }

      // Walk extracted directory
      const allFiles: Array<{ path: string; size: number; type: string; isDir: boolean; preview?: string }> = [];
      let totalSize = 0;
      const walkDir = (dir: string, base: string) => {
        try {
          const entries = fsM.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = pathM.join(dir, entry.name);
            const relPath = pathM.join(base, entry.name);
            if (entry.isDirectory()) {
              allFiles.push({ path: relPath, size: 0, type: "dir", isDir: true });
              walkDir(fullPath, relPath);
            } else {
              const stat = fsM.statSync(fullPath);
              totalSize += stat.size;
              let typeLabel = "binary";
              let preview: string | undefined;
              try {
                const ffd = fsM.openSync(fullPath, "r");
                const fmag = Buffer.alloc(8);
                fsM.readSync(ffd, fmag, 0, 8, 0);
                fsM.closeSync(ffd);
                if (fmag[0] === 0x4d && fmag[1] === 0x5a) typeLabel = "PE/EXE";
                else if (fmag[0] === 0x7f && fmag[1] === 0x45) typeLabel = "ELF";
                else if (fmag[0] === 0x1f && fmag[1] === 0x8b) typeLabel = "gzip";
                else if (fmag[0] === 0x50 && fmag[1] === 0x4b) typeLabel = "zip";
                else if (entry.name.endsWith(".py") || entry.name.endsWith(".ts") || entry.name.endsWith(".js")) typeLabel = "source";
                else if (entry.name.endsWith(".json")) typeLabel = "JSON";
                else if (entry.name.endsWith(".bin") || entry.name.endsWith(".eep") || entry.name.endsWith(".eeprom")) typeLabel = "EEPROM";
                else if (entry.name.endsWith(".csv")) typeLabel = "CSV";
                else if (entry.name.endsWith(".md") || entry.name.endsWith(".txt")) typeLabel = "text";
                else if (entry.name.endsWith(".yar") || entry.name.endsWith(".yara")) typeLabel = "YARA";
                // Preview for text-based files
                if (["source", "JSON", "text", "CSV", "YARA"].includes(typeLabel) && stat.size < 100000) {
                  preview = fsM.readFileSync(fullPath, "utf8").slice(0, 4000);
                } else if (["EEPROM", "binary", "PE/EXE", "ELF"].includes(typeLabel)) {
                  const bfd = fsM.openSync(fullPath, "r");
                  const bpreview = Buffer.alloc(Math.min(128, stat.size));
                  fsM.readSync(bfd, bpreview, 0, bpreview.length, 0);
                  fsM.closeSync(bfd);
                  preview = bpreview.toString("hex").match(/.{1,2}/g)?.join(" ") || "";
                }
              } catch { /* ignore */ }
              allFiles.push({ path: relPath, size: stat.size, type: typeLabel, isDir: false, preview });
            }
          }
        } catch { /* skip unreadable dirs */ }
      };
      walkDir(outDir, "");

      // Clean up temp files
      try { fsM.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

      res.json({
        isArchive: true,
        filename: binary.filename,
        archiveType: isGzip ? "tar.gz" : isZip ? "zip" : "tar",
        totalFiles: allFiles.filter(f => !f.isDir).length,
        totalSize,
        files: allFiles
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Analyze Extracted File Endpoint ──────────────────────────────────
  // POST /api/analysis/:id/analyze-extracted-file
  // Takes a path to a file extracted from an archive and creates a new analysis from it
  app.post("/api/analysis/:id/analyze-extracted-file", async (req, res) => {
    try {
      const userId = (req as any).userId || (req as any).user?.id;
      if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { filePath, filename } = req.body as { filePath: string; filename: string };
      if (!filePath || !filename) { res.status(400).json({ error: "filePath and filename required" }); return; }
      // Security: ensure the path is within /tmp to prevent path traversal
      const resolvedPath = path.resolve(filePath);
      if (!resolvedPath.startsWith("/tmp/")) { res.status(400).json({ error: "Invalid file path" }); return; }
      const { readFile } = await import("fs/promises");
      let fileBuffer: Buffer;
      try {
        fileBuffer = await readFile(resolvedPath);
      } catch {
        res.status(404).json({ error: "Extracted file not found — re-open the File Browser to refresh the extraction" }); return;
      }
      // Upload to S3
      const storageKey = `binaries/${userId}/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}.bin`;
      const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
      let s3Url = "";
      let s3Key = `local-${nanoid(12)}`;
      try {
        const sr = await storagePut(storageKey, fileBuffer, "application/octet-stream");
        s3Url = sr.url; s3Key = sr.key;
      } catch { /* non-fatal */ }
      const binaryId = nanoid(12);
      try {
        await db.insert(uploadedBinaries).values({
          id: binaryId, userId, filename, fileHash, fileSize: fileBuffer.length,
          s3Key, s3Url, uploadedAt: Date.now(),
        });
      } catch { /* non-fatal if duplicate */ }
      const newAnalysisId = nanoid(12);
      await db.insert(analysisResults).values({
        id: newAnalysisId, binaryId, userId, filename, fileSize: fileBuffer.length,
        status: "running", analyzedAt: Date.now(),
      });
      // Fire swarm in background
      (async () => {
        try {
          const qeResult = await runAutonomousSwarm(fileBuffer, filename, 1);
          const bgResult = {
            id: newAnalysisId, filename, fileSize: fileBuffer.length,
            fileType: qeResult.toolCallTrace?.find((t: any) => t.toolName === "file_identify")?.result?.split("\n")?.[0]?.replace("File type: ", "") || "Binary",
            timestamp: Date.now(), status: "complete" as const, analysisPass: 1,
            findings: {
              summary: qeResult.summary, algorithms: qeResult.algorithms,
              seedKeys: qeResult.seedKeys, canAddresses: qeResult.canAddresses,
              checksums: qeResult.checksums, memoryMaps: qeResult.memoryMaps,
              strings: qeResult.strings, cryptoConstants: qeResult.cryptoConstants,
              securityBytes: qeResult.securityBytes, deepFindings: qeResult.deepFindings,
            },
            rawHex: "", analysisMode: qeResult.analysisMode,
            dissectionReport: qeResult.dissectionReport, toolCallTrace: qeResult.toolCallTrace,
          };
          await db.insert(analysisResults).values({
            id: newAnalysisId, binaryId, userId, filename, fileSize: fileBuffer.length,
            fileType: bgResult.fileType || "Unknown",
            algorithmCount: bgResult.findings?.algorithms?.length || 0,
            seedKeyCount: bgResult.findings?.seedKeys?.length || 0,
            canAddressCount: bgResult.findings?.canAddresses?.length || 0,
            checksumCount: bgResult.findings?.checksums?.length || 0,
            securityByteCount: bgResult.findings?.securityBytes?.length || 0,
            stringCount: bgResult.findings?.strings?.length || 0,
            summary: bgResult.findings?.summary || "",
            analysisData: { ...bgResult, id: newAnalysisId } as any,
            status: "complete", analyzedAt: Date.now(),
          }).onDuplicateKeyUpdate({
            set: {
              fileType: bgResult.fileType || "Unknown",
              algorithmCount: bgResult.findings?.algorithms?.length || 0,
              seedKeyCount: bgResult.findings?.seedKeys?.length || 0,
              canAddressCount: bgResult.findings?.canAddresses?.length || 0,
              checksumCount: bgResult.findings?.checksums?.length || 0,
              securityByteCount: bgResult.findings?.securityBytes?.length || 0,
              stringCount: bgResult.findings?.strings?.length || 0,
              summary: bgResult.findings?.summary || "",
              analysisData: { ...bgResult, id: newAnalysisId } as any,
              status: "complete", analyzedAt: Date.now(),
            },
          });
        } catch {
          await db.insert(analysisResults).values({
            id: newAnalysisId, binaryId, userId, filename, fileSize: fileBuffer.length,
            status: "failed", analyzedAt: Date.now(),
          }).onDuplicateKeyUpdate({ set: { status: "failed", analyzedAt: Date.now() } });
        }
      })();
      res.json({ analysisId: newAnalysisId, status: "running" });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/analysis/:id/analyze-batch
  // Takes array of extracted file paths, creates one new analysis per file
  app.post("/api/analysis/:id/analyze-batch", async (req, res) => {
    try {
      const userId = (req as any).userId || (req as any).user?.id;
      if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { files } = req.body as { files: Array<{ filePath: string; filename: string }> };
      if (!files || !Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: "files array required" }); return;
      }
      if (files.length > 20) { res.status(400).json({ error: "Max 20 files per batch" }); return; }
      const batchResults: Array<{ filename: string; analysisId: string }> = [];
      for (const f of files) {
        const resolvedPath = path.resolve(f.filePath);
        if (!resolvedPath.startsWith("/tmp/")) continue;
        const { readFile } = await import("fs/promises");
        let fileBuffer: Buffer;
        try { fileBuffer = await readFile(resolvedPath); } catch { continue; }
        const bFileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
        let bs3Url = ""; let bs3Key = `local-${nanoid(12)}`;
        try {
          const sr = await storagePut(`binaries/${userId}/${crypto.randomUUID()}-${f.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}.bin`, fileBuffer, "application/octet-stream");
          bs3Url = sr.url; bs3Key = sr.key;
        } catch { /* non-fatal */ }
        const bBinaryId = nanoid(12);
        try {
          await db.insert(uploadedBinaries).values({
            id: bBinaryId, userId, filename: f.filename, fileHash: bFileHash,
            fileSize: fileBuffer.length, s3Key: bs3Key, s3Url: bs3Url, uploadedAt: Date.now(),
          });
        } catch { /* non-fatal */ }
        const bAnalysisId = nanoid(12);
        await db.insert(analysisResults).values({
          id: bAnalysisId, binaryId: bBinaryId, userId, filename: f.filename,
          fileSize: fileBuffer.length, status: "running", analyzedAt: Date.now(),
        });
        const capturedBuffer = fileBuffer;
        const capturedFilename = f.filename;
        const capturedId = bAnalysisId;
        const capturedBinaryId = bBinaryId;
        (async () => {
          try {
            const qeResult = await runAutonomousSwarm(capturedBuffer, capturedFilename, 1);
            const bgResult = {
              id: capturedId, filename: capturedFilename, fileSize: capturedBuffer.length,
              fileType: qeResult.toolCallTrace?.find((t: any) => t.toolName === "file_identify")?.result?.split("\n")?.[0]?.replace("File type: ", "") || "Binary",
              timestamp: Date.now(), status: "complete" as const, analysisPass: 1,
              findings: {
                summary: qeResult.summary, algorithms: qeResult.algorithms,
                seedKeys: qeResult.seedKeys, canAddresses: qeResult.canAddresses,
                checksums: qeResult.checksums, memoryMaps: qeResult.memoryMaps,
                strings: qeResult.strings, cryptoConstants: qeResult.cryptoConstants,
                securityBytes: qeResult.securityBytes, deepFindings: qeResult.deepFindings,
              },
              rawHex: "", analysisMode: qeResult.analysisMode,
              dissectionReport: qeResult.dissectionReport, toolCallTrace: qeResult.toolCallTrace,
            };
            await db.insert(analysisResults).values({
              id: capturedId, binaryId: capturedBinaryId, userId, filename: capturedFilename,
              fileSize: capturedBuffer.length, fileType: bgResult.fileType || "Unknown",
              algorithmCount: bgResult.findings?.algorithms?.length || 0,
              seedKeyCount: bgResult.findings?.seedKeys?.length || 0,
              canAddressCount: bgResult.findings?.canAddresses?.length || 0,
              checksumCount: bgResult.findings?.checksums?.length || 0,
              securityByteCount: bgResult.findings?.securityBytes?.length || 0,
              stringCount: bgResult.findings?.strings?.length || 0,
              summary: bgResult.findings?.summary || "",
              analysisData: { ...bgResult, id: capturedId } as any,
              status: "complete", analyzedAt: Date.now(),
            }).onDuplicateKeyUpdate({
              set: {
                fileType: bgResult.fileType || "Unknown",
                algorithmCount: bgResult.findings?.algorithms?.length || 0,
                seedKeyCount: bgResult.findings?.seedKeys?.length || 0,
                canAddressCount: bgResult.findings?.canAddresses?.length || 0,
                checksumCount: bgResult.findings?.checksums?.length || 0,
                securityByteCount: bgResult.findings?.securityBytes?.length || 0,
                stringCount: bgResult.findings?.strings?.length || 0,
                summary: bgResult.findings?.summary || "",
                analysisData: { ...bgResult, id: capturedId } as any,
                status: "complete", analyzedAt: Date.now(),
              },
            });
          } catch {
            await db.insert(analysisResults).values({
              id: capturedId, binaryId: capturedBinaryId, userId, filename: capturedFilename,
              fileSize: capturedBuffer.length, status: "failed", analyzedAt: Date.now(),
            }).onDuplicateKeyUpdate({ set: { status: "failed", analyzedAt: Date.now() } });
          }
        })();
        batchResults.push({ filename: f.filename, analysisId: bAnalysisId });
      }
      res.json({ created: batchResults.length, analyses: batchResults });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ─── Config / Tool Limits Endpoint ─────────────────────────────────── v2 (archive_extract + expert agents)
  app.get("/api/config/tool-limits", (_req, res) => {
    res.json({
      binwalkSkipBytes: parseInt(process.env.BINWALK_SKIP_BYTES || String(50 * 1024 * 1024)),
      yaraSkipBytes: parseInt(process.env.YARA_SKIP_BYTES || String(100 * 1024 * 1024)),
      r2SkipBytes: parseInt(process.env.R2_SKIP_BYTES || String(20 * 1024 * 1024)),
    });
  });

  // ─── File Proxy Endpoint ────────────────────────────────────────────────
  // GET /api/file-proxy?key=<s3Key>
  // Authenticated endpoint that streams a file from manus-storage to GCP.
  // GCP calls this instead of trying to access CloudFront directly.
  // Requires x-swarm-secret header matching SWARM_DELEGATE_SECRET env var.
  app.get("/api/file-proxy", async (req, res) => {
    const secret = process.env.SWARM_DELEGATE_SECRET || "";
    const incomingSecret = (req.headers["x-swarm-secret"] as string) || "";
    if (secret && incomingSecret !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const s3Key = req.query.key as string;
    if (!s3Key) return res.status(400).json({ error: "key is required" });
    try {
      const forgeApiUrl = process.env.BUILT_IN_FORGE_API_URL || "";
      const forgeApiKey = process.env.BUILT_IN_FORGE_API_KEY || "";
      let fileBuffer: Buffer | null = null;

      // Strategy 1: Use Forge storage API to get a presigned URL, then download from it
      if (forgeApiUrl && forgeApiKey) {
        try {
          // Get a presigned download URL from Forge
          const presignRes = await fetch(
            `${forgeApiUrl}/v1/storage/url?key=${encodeURIComponent(s3Key)}&expires_in=3600`,
            { headers: { Authorization: `Bearer ${forgeApiKey}` }, signal: AbortSignal.timeout(15_000) }
          );
          if (presignRes.ok) {
            const presignData = await presignRes.json() as any;
            const signedUrl = presignData.url;
            if (signedUrl && signedUrl.startsWith("http")) {
              console.log(`[file-proxy] Downloading via presigned URL: ${signedUrl.slice(0, 80)}`);
              const dlRes = await fetch(signedUrl, { signal: AbortSignal.timeout(180_000) });
              if (dlRes.ok) {
                const buf = Buffer.from(await dlRes.arrayBuffer());
                // Verify it's not HTML (CloudFront 403 returns XML/HTML)
                if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
                  fileBuffer = buf;
                  console.log(`[file-proxy] Got ${fileBuffer.length} bytes via presigned URL`);
                }
              }
            }
          }
        } catch (e: any) {
          console.warn(`[file-proxy] Presigned URL strategy failed: ${e.message}`);
        }
      }

      // Strategy 2: Use Forge /v1/storage/download with trailing slash (avoids 301 redirect loop)
      if (!fileBuffer && forgeApiUrl && forgeApiKey) {
        try {
          const dlRes = await fetch(
            `${forgeApiUrl}/v1/storage/download/?path=${encodeURIComponent(s3Key)}`,
            { headers: { Authorization: `Bearer ${forgeApiKey}` }, signal: AbortSignal.timeout(180_000) }
          );
          if (dlRes.ok) {
            const buf = Buffer.from(await dlRes.arrayBuffer());
            if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
              fileBuffer = buf;
              console.log(`[file-proxy] Got ${fileBuffer.length} bytes via Forge download/`);
            }
          }
        } catch (e: any) {
          console.warn(`[file-proxy] Forge download strategy failed: ${e.message}`);
        }
      }

      // Strategy 3: Use Manus platform /manus-storage/ proxy (external URL with signed redirect)
      if (!fileBuffer) {
        try {
          const manusStorageUrl = `https://srtlabult.manus.space/manus-storage/${s3Key}`;
          console.log(`[file-proxy] Trying Manus /manus-storage/ proxy: ${manusStorageUrl.slice(0, 80)}`);
          const fileRes = await fetch(manusStorageUrl, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
          console.log(`[file-proxy] /manus-storage/ response: ${fileRes.status}, content-length: ${fileRes.headers.get('content-length')}`);
          if (fileRes.ok) {
            const buf = Buffer.from(await fileRes.arrayBuffer());
            if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
              fileBuffer = buf;
              console.log(`[file-proxy] Got ${fileBuffer.length} bytes via /manus-storage/ proxy`);
            } else {
              console.warn(`[file-proxy] /manus-storage/ returned HTML/invalid content (${buf.length} bytes)`);
            }
          }
        } catch (e: any) {
          console.warn(`[file-proxy] /manus-storage/ proxy failed: ${e.message}`);
        }
      }

      // Strategy 4: Check local binary cache (GCP only)
      if (!fileBuffer) {
        try {
          const fsP = await import("fs/promises");
          const cacheDir = `/tmp/srt-binary-cache`;
          const cacheFiles = await fsP.readdir(cacheDir).catch(() => [] as string[]);
          // Look for any cached file matching this s3Key's filename
          const targetFilename = s3Key.split("/").pop() || "";
          const safeTarget = targetFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
          const match = cacheFiles.find(f => f.endsWith(`__${safeTarget}`));
          if (match) {
            const cached = await fsP.readFile(`${cacheDir}/${match}`);
            if (cached.length > 100 && !cached.slice(0, 15).toString().includes("<")) {
              fileBuffer = cached;
              console.log(`[file-proxy] Got ${fileBuffer.length} bytes from local cache: ${match}`);
            }
          }
        } catch (e: any) {
          console.warn(`[file-proxy] Local cache check failed: ${e.message}`);
        }
      }

      if (!fileBuffer || fileBuffer.length === 0) {
        console.error(`[file-proxy] All strategies failed for key: ${s3Key}`);
        return res.status(502).json({ error: `Could not retrieve file from storage` });
      }

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", fileBuffer.length);
      res.setHeader("Content-Disposition", `attachment; filename="${s3Key.split("/").pop() || "file.bin"}"`);
      res.send(fileBuffer);
    } catch (err: any) {
      console.error(`[file-proxy] Error:`, err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GCP Swarm Delegation Endpoint ─────────────────────────────────────
  // POST /api/run-swarm-delegated
  // Called by the Manus production server to delegate swarm execution to this
  // persistent GCP VM, which is not subject to Cloud Run's 2-minute kill limit.
  // Requires x-swarm-secret header matching SWARM_DELEGATE_SECRET env var.
  app.post("/api/run-swarm-delegated", express.json({ limit: "25mb" }), async (req, res) => {
    const secret = process.env.SWARM_DELEGATE_SECRET || "";
    const incomingSecret = req.headers["x-swarm-secret"] || "";
    if (secret && incomingSecret !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { analysisId, s3Key, downloadUrl, fileBase64, filename, fileSize, binaryId, userId } = req.body as {
      analysisId: string;
      s3Key: string;
      downloadUrl?: string;
      fileBase64?: string;
      filename: string;
      fileSize: number;
      binaryId: string;
      userId: string;
      jobToken?: string;
    };
    if (!analysisId || !s3Key || !filename) {
      return res.status(400).json({ error: "analysisId, s3Key, and filename are required" });
    }
    // Acknowledge immediately — the swarm runs in the background
    res.json({ accepted: true, analysisId });

    // Run the swarm as a true background task on this persistent VM
    (async () => {
      console.log(`[delegate] Starting delegated swarm for ${analysisId} (s3Key=${s3Key}, hasBase64=${!!fileBase64})`);
      try {
        // Download the file from storage
        const port = process.env.PORT || 3001;
        let fileBuffer: Buffer | null = null;

        // Strategy -1: Check local binary cache first (fastest — no network needed)
        try {
          const fsCache = await import("fs/promises");
          const cacheDir = `/tmp/srt-binary-cache`;
          const safeFile = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
          const cachePath = `${cacheDir}/${analysisId}__${safeFile}`;
          const cached = await fsCache.readFile(cachePath).catch(() => null);
          if (cached && cached.length > 100 && !cached.slice(0, 15).toString().includes("<")) {
            fileBuffer = cached;
            console.log(`[delegate] Using cached binary: ${cachePath} (${fileBuffer.length} bytes)`);
          }
        } catch { /* no cache available */ }

        // Strategy 0: Use embedded base64 bytes sent directly in the delegation payload (preferred)
        if (!fileBuffer && fileBase64) {
          try {
            fileBuffer = Buffer.from(fileBase64, "base64");
            console.log(`[delegate] Using embedded base64 bytes: ${fileBuffer.length} bytes`);
            // Validate it's not HTML
            if (fileBuffer.slice(0, 15).toString().includes("<")) {
              console.warn(`[delegate] Base64 bytes look like HTML — discarding`);
              fileBuffer = null;
            }
          } catch (e: any) {
            console.warn(`[delegate] Base64 decode error: ${e.message}`);
          }
        }

        // Strategy 1: Use downloadUrl directly if it's a full https:// URL
        if (!fileBuffer && downloadUrl && downloadUrl.startsWith("https://")) {
          try {
            console.log(`[delegate] Downloading from direct URL: ${downloadUrl.slice(0, 80)}`);
            const dlRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(180_000) });
            if (dlRes.ok) {
              const buf = Buffer.from(await dlRes.arrayBuffer());
              if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
                fileBuffer = buf;
                console.log(`[delegate] Downloaded ${fileBuffer.length} bytes from direct URL`);
              } else {
                console.warn(`[delegate] Direct URL returned HTML/invalid content (${buf.length} bytes)`);
              }
            } else {
              console.warn(`[delegate] Direct URL download failed: ${dlRes.status}`);
            }
          } catch (e: any) {
            console.warn(`[delegate] Direct URL download error: ${e.message}`);
          }
        }

        // Strategy 2: Use Forge presigned URL directly (bypasses file-proxy HTML issue)
        if (!fileBuffer && s3Key) {
          const forgeApiUrl = process.env.BUILT_IN_FORGE_API_URL || "";
          const forgeApiKey = process.env.BUILT_IN_FORGE_API_KEY || "";
          if (forgeApiUrl && forgeApiKey) {
            try {
              console.log(`[delegate] Trying Forge presigned URL for key: ${s3Key}`);
              const presignRes = await fetch(
                `${forgeApiUrl}/v1/storage/url?key=${encodeURIComponent(s3Key)}&expires_in=3600`,
                { headers: { Authorization: `Bearer ${forgeApiKey}` }, signal: AbortSignal.timeout(15_000) }
              );
              if (presignRes.ok) {
                const presignData = await presignRes.json() as any;
                const signedUrl = presignData.url;
                if (signedUrl && signedUrl.startsWith("http")) {
                  console.log(`[delegate] Got presigned URL: ${signedUrl.slice(0, 80)}`);
                  const dlRes = await fetch(signedUrl, { signal: AbortSignal.timeout(180_000) });
                  if (dlRes.ok) {
                    const buf = Buffer.from(await dlRes.arrayBuffer());
                    if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
                      fileBuffer = buf;
                      console.log(`[delegate] Got ${fileBuffer.length} bytes via Forge presigned URL`);
                    }
                  }
                }
              }
            } catch (e: any) {
              console.warn(`[delegate] Forge presigned URL failed: ${e.message}`);
            }
            // Also try /v1/storage/download/ endpoint
            if (!fileBuffer) {
              try {
                const dlRes = await fetch(
                  `${forgeApiUrl}/v1/storage/download/?path=${encodeURIComponent(s3Key)}`,
                  { headers: { Authorization: `Bearer ${forgeApiKey}` }, signal: AbortSignal.timeout(180_000) }
                );
                if (dlRes.ok) {
                  const buf = Buffer.from(await dlRes.arrayBuffer());
                  if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
                    fileBuffer = buf;
                    console.log(`[delegate] Got ${fileBuffer.length} bytes via Forge download/`);
                  }
                }
              } catch (e: any) {
                console.warn(`[delegate] Forge download/ failed: ${e.message}`);
              }
            }
          }
        }

        // Strategy 3: Use the Manus file-proxy endpoint (final fallback)
        if (!fileBuffer) {
          const manusBase = "https://srtlabult.manus.space";
          const swarmSecret = process.env.SWARM_DELEGATE_SECRET || "";
          try {
            console.log(`[delegate] Fetching via Manus file-proxy for ${s3Key}`);
            const dlRes = await fetch(`${manusBase}/api/file-proxy?key=${encodeURIComponent(s3Key)}`, {
              headers: { "x-swarm-secret": swarmSecret },
              signal: AbortSignal.timeout(180_000),
            });
            if (dlRes.ok) {
              const buf = Buffer.from(await dlRes.arrayBuffer());
              if (!buf.slice(0, 15).toString().includes("<") && buf.length > 100) {
                fileBuffer = buf;
                console.log(`[delegate] Downloaded ${fileBuffer.length} bytes via Manus file-proxy`);
              } else {
                console.warn(`[delegate] Manus file-proxy returned HTML/invalid content (${buf.length} bytes)`);
              }
            } else {
              const errText = await dlRes.text().catch(() => "");
              console.warn(`[delegate] Manus file-proxy failed: ${dlRes.status} ${errText.slice(0, 100)}`);
            }
          } catch (e: any) {
            console.warn(`[delegate] Manus file-proxy error: ${e.message}`);
          }
        }

        if (!fileBuffer || fileBuffer.length === 0) {
          throw new Error(`Failed to download file from storage (s3Key=${s3Key})`);
        }

        // Persist binary to cache so the chat endpoint can access it later
        try {
          const cacheDir = `/tmp/srt-binary-cache`;
          const fsCache = await import("fs/promises");
          await fsCache.mkdir(cacheDir, { recursive: true });
          const safeFile = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
          await fsCache.writeFile(`${cacheDir}/${analysisId}__${safeFile}`, fileBuffer);
          console.log(`[delegate] Cached binary: ${cacheDir}/${analysisId}__${safeFile} (${fileBuffer.length} bytes)`);
        } catch (e: any) {
          console.warn(`[delegate] Failed to cache binary: ${e.message}`);
        }

        // Run the autonomous swarm
        const swarmResult = await runAutonomousSwarm(fileBuffer, filename, 1) as any;
        const bgResult = {
          id: analysisId, filename, fileSize: fileBuffer.length,
          ...swarmResult,
        };

        // Trim analysisData to stay within DB limits (2MB cap)
        let analysisDataPayload: any = bgResult;
        try {
          const raw = JSON.stringify(bgResult);
          if (raw.length > 2_000_000) {
            const trimmed = { ...bgResult };
            if (trimmed.toolCallTrace) trimmed.toolCallTrace = (trimmed.toolCallTrace as any[]).slice(-50);
            analysisDataPayload = trimmed;
          }
        } catch { /* non-fatal */ }

        // Save uploaded binary metadata first
        const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
        try {
          await db.insert(uploadedBinaries).values({
            id: binaryId,
            userId,
            filename,
            fileHash,
            fileSize: fileBuffer.length,
            s3Key,
            s3Url: "",  // Not available in delegation context
            detectedModule: swarmResult.detectedModule || null,
            uploadedAt: Date.now(),
          }).onDuplicateKeyUpdate({
            set: {
              fileHash,
              fileSize: fileBuffer.length,
              detectedModule: swarmResult.detectedModule || null,
              uploadedAt: Date.now(),
            },
          });
          console.log(`[delegate] Saved binary metadata for ${binaryId}`);
        } catch (binErr: any) {
          console.warn(`[delegate] uploadedBinaries insert failed (non-fatal): ${binErr.message}`);
        }

        // Write results to shared DB
        await db.insert(analysisResults).values({
          id: analysisId, binaryId, userId, filename,
          fileSize: fileBuffer.length,
          fileType: swarmResult.fileType || "Unknown",
          detectedModule: swarmResult.detectedModule || null,
          entropy: swarmResult.entropy || null,
          confidence: swarmResult.confidence || null,
          algorithmCount: swarmResult.findings?.algorithms?.length || 0,
          seedKeyCount: swarmResult.findings?.seedKeys?.length || 0,
          canAddressCount: swarmResult.findings?.canAddresses?.length || 0,
          checksumCount: swarmResult.findings?.checksums?.length || 0,
          securityByteCount: swarmResult.findings?.securityBytes?.length || 0,
          stringCount: swarmResult.findings?.strings?.length || 0,
          summary: swarmResult.findings?.summary || "",
          analysisData: analysisDataPayload as any,
          status: "complete",
          analyzedAt: Date.now(),
        }).onDuplicateKeyUpdate({
          set: {
            fileType: swarmResult.fileType || "Unknown",
            detectedModule: swarmResult.detectedModule || null,
            entropy: swarmResult.entropy || null,
            confidence: swarmResult.confidence || null,
            algorithmCount: swarmResult.findings?.algorithms?.length || 0,
            seedKeyCount: swarmResult.findings?.seedKeys?.length || 0,
            canAddressCount: swarmResult.findings?.canAddresses?.length || 0,
            checksumCount: swarmResult.findings?.checksums?.length || 0,
            securityByteCount: swarmResult.findings?.securityBytes?.length || 0,
            stringCount: swarmResult.findings?.strings?.length || 0,
            summary: swarmResult.findings?.summary || "",
            analysisData: analysisDataPayload as any,
            status: "complete",
            analyzedAt: Date.now(),
          },
        });
        console.log(`[delegate] Analysis ${analysisId} COMPLETE — DB updated`);
      } catch (err: any) {
        console.error(`[delegate] Swarm FAILED for ${analysisId}:`, err.message);
        try {
          await db.insert(analysisResults).values({
            id: analysisId, binaryId, userId, filename, fileSize,
            status: "failed", analyzedAt: Date.now(),
            summary: `Analysis failed: ${err.message}`,
            analysisData: { error: err.message } as any,
          }).onDuplicateKeyUpdate({
            set: { status: "failed", summary: `Analysis failed: ${err.message}`, analyzedAt: Date.now() },
          });
        } catch (dbErr: any) {
          console.error(`[delegate] Failed to mark analysis as failed:`, dbErr.message);
        }
      }
    })().catch((err) => console.error(`[delegate] Unhandled error:`, err));
  });

  // ─── Static Files ──────────────────────────────────────────────────────
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3001;
  server.listen(port, () => {
    console.log(`SRT Lab RE Agent running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
