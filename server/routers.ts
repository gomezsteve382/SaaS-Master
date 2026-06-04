import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { createSession, getUserSessions, getSessionById, createUpload, getSessionUploads, getUploadById, createOperation, getSessionOperations, createAuditLog, getUserAuditLogs, getSessionAuditLogs } from "./db";
import { storagePut, storageGetSignedUrl } from "./storage";
import { parseModule, checkSafeMode, generateRfhCandidate, computeByteDiff, threeWayCompare, computeSha256, bcmSec16ToRfh, rfhSec16ToBcm } from "./lib/moduleParser";
import type { ParseResult, SlotType } from "./lib/moduleParser";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ─── Sessions ──────────────────────────────────────────────────────────────
  sessions: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return getUserSessions(ctx.user.id);
    }),
    create: protectedProcedure
      .input(z.object({ title: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const session = await createSession(ctx.user.id, input.title);
        await createAuditLog({
          userId: ctx.user.id,
          sessionId: session.id,
          action: "session_created",
          description: `Created session: ${input.title || "Untitled Session"}`,
        });
        return session;
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return getSessionById(input.id);
      }),
  }),

  // ─── Uploads ───────────────────────────────────────────────────────────────
  uploads: router({
    list: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input }) => {
        return getSessionUploads(input.sessionId);
      }),
    upload: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        slotType: z.enum(["RFHUB", "BCM", "PCM"]),
        filename: z.string(),
        fileBase64: z.string(),
        purpose: z.enum(["source", "candidate", "readback_pre", "readback_post"]).default("source"),
      }))
      .mutation(async ({ ctx, input }) => {
        const buffer = Buffer.from(input.fileBase64, "base64");
        const sha256 = computeSha256(buffer);

        // Parse the module
        const parseResult = parseModule(buffer, input.filename, input.slotType as SlotType);

        // Store in S3
        const storageKey = `uploads/${ctx.user.id}/${input.sessionId}/${Date.now()}_${input.filename}`;
        const { key, url } = await storagePut(storageKey, buffer, "application/octet-stream");

        // Save to database
        const upload = await createUpload({
          sessionId: input.sessionId,
          userId: ctx.user.id,
          slotType: input.slotType,
          filename: input.filename,
          fileSize: buffer.length,
          sha256,
          storageKey: key,
          storageUrl: url,
          detectedType: parseResult.type,
          parsedVin: parseResult.primaryVin,
          parsedSec16: parseResult.primarySec16,
          parseResult: parseResult as any,
          checksumsValid: parseResult.allChecksumsValid,
          purpose: input.purpose,
        });

        // Audit log
        await createAuditLog({
          userId: ctx.user.id,
          sessionId: input.sessionId,
          action: "file_uploaded",
          description: `Uploaded ${input.filename} (${input.slotType}, ${buffer.length} bytes, SHA-256: ${sha256.substring(0, 16)}...)`,
          metadata: { uploadId: upload.id, slotType: input.slotType, sha256, fileSize: buffer.length },
        });

        return { uploadId: upload.id, parseResult };
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return getUploadById(input.id);
      }),
  }),

  // ─── Inspect ───────────────────────────────────────────────────────────────
  inspect: router({
    parse: protectedProcedure
      .input(z.object({ uploadId: z.number() }))
      .query(async ({ ctx, input }) => {
        const upload = await getUploadById(input.uploadId);
        if (!upload) throw new Error("Upload not found");
        // Return stored parse result
        return upload.parseResult as ParseResult;
      }),
    safeCheck: protectedProcedure
      .input(z.object({ uploadId: z.number() }))
      .query(async ({ input }) => {
        const upload = await getUploadById(input.uploadId);
        if (!upload) throw new Error("Upload not found");
        const parseResult = upload.parseResult as ParseResult;
        return checkSafeMode(parseResult);
      }),
  }),

  // ─── Candidate Generation ──────────────────────────────────────────────────
  candidate: router({
    generate: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        rfhubUploadId: z.number(),
        targetVin: z.string().length(17),
        targetSec16Hex: z.string().length(32),
      }))
      .mutation(async ({ ctx, input }) => {
        const upload = await getUploadById(input.rfhubUploadId);
        if (!upload) throw new Error("RFHUB upload not found");

        // Safe mode check
        const parseResult = upload.parseResult as ParseResult;
        const safeCheck = checkSafeMode(parseResult);
        if (!safeCheck.allowed) {
          await createAuditLog({
            userId: ctx.user.id,
            sessionId: input.sessionId,
            action: "candidate_blocked",
            description: `Candidate generation blocked: ${(safeCheck as any).reason}`,
            metadata: safeCheck,
          });
          return { success: false, refusal: safeCheck };
        }

        // Fetch source binary from S3
        const signedUrl = await storageGetSignedUrl(upload.storageKey);
        const response = await fetch(signedUrl);
        const sourceBuffer = new Uint8Array(await response.arrayBuffer());

        // Generate candidate
        const candidate = generateRfhCandidate(sourceBuffer, input.targetVin, input.targetSec16Hex);

        // Store candidate in S3
        const candidateKey = `candidates/${ctx.user.id}/${input.sessionId}/${Date.now()}_candidate.bin`;
        const { key: storedKey, url: storedUrl } = await storagePut(
          candidateKey,
          Buffer.from(candidate.data),
          "application/octet-stream"
        );

        // Record operation
        const op = await createOperation({
          sessionId: input.sessionId,
          userId: ctx.user.id,
          opType: "generate_candidate",
          sourceUploadId: input.rfhubUploadId,
          inputParams: { targetVin: input.targetVin, targetSec16Hex: input.targetSec16Hex },
          resultSummary: { sha256: candidate.sha256, changesCount: candidate.changes.length },
          success: true,
          candidateStorageKey: storedKey,
        });

        // Audit log
        await createAuditLog({
          userId: ctx.user.id,
          sessionId: input.sessionId,
          action: "candidate_generated",
          description: `Generated RFHUB candidate (${candidate.changes.length} regions changed, SHA-256: ${candidate.sha256.substring(0, 16)}...)`,
          metadata: { operationId: op.id, sha256: candidate.sha256, changes: candidate.changes },
        });

        return {
          success: true,
          operationId: op.id,
          sha256: candidate.sha256,
          changes: candidate.changes,
          warnings: candidate.warnings,
          candidateKey: storedKey,
        };
      }),

    // Export requires explicit confirmation
    confirmExport: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        candidateKey: z.string(),
        confirmed: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (!input.confirmed) {
          return { success: false, reason: "Export not confirmed by user." };
        }

        // Get presigned download URL
        const downloadUrl = await storageGetSignedUrl(input.candidateKey);

        // Record export operation
        await createOperation({
          sessionId: input.sessionId,
          userId: ctx.user.id,
          opType: "export_candidate",
          inputParams: { candidateKey: input.candidateKey },
          resultSummary: { exported: true },
          success: true,
          candidateStorageKey: input.candidateKey,
        });

        // Audit log
        await createAuditLog({
          userId: ctx.user.id,
          sessionId: input.sessionId,
          action: "candidate_exported",
          description: `Exported candidate binary (key: ${input.candidateKey})`,
          metadata: { candidateKey: input.candidateKey },
        });

        return { success: true, downloadUrl };
      }),
  }),

  // ─── SEC16 Sync ────────────────────────────────────────────────────────────
  sec16: router({
    sync: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        direction: z.enum(["bcm_to_rfh", "rfh_to_bcm"]),
        sourceSec16Hex: z.string().length(32),
      }))
      .mutation(async ({ ctx, input }) => {
        const result = input.direction === "bcm_to_rfh"
          ? bcmSec16ToRfh(input.sourceSec16Hex)
          : rfhSec16ToBcm(input.sourceSec16Hex);

        await createOperation({
          sessionId: input.sessionId,
          userId: ctx.user.id,
          opType: "sec16_sync",
          inputParams: { direction: input.direction, sourceSec16Hex: input.sourceSec16Hex },
          resultSummary: { derivedSec16: result },
          success: true,
        });

        await createAuditLog({
          userId: ctx.user.id,
          sessionId: input.sessionId,
          action: "sec16_synced",
          description: `SEC16 sync (${input.direction}): ${input.sourceSec16Hex} → ${result}`,
          metadata: { direction: input.direction, source: input.sourceSec16Hex, derived: result },
        });

        return { derivedSec16: result };
      }),
  }),

  // ─── Diff ──────────────────────────────────────────────────────────────────
  diff: router({
    compute: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        sourceUploadId: z.number(),
        targetUploadId: z.number(),
      }))
      .mutation(async ({ ctx, input }) => {
        const sourceUpload = await getUploadById(input.sourceUploadId);
        const targetUpload = await getUploadById(input.targetUploadId);
        if (!sourceUpload || !targetUpload) throw new Error("Upload(s) not found");

        const [sourceResp, targetResp] = await Promise.all([
          fetch(await storageGetSignedUrl(sourceUpload.storageKey)).then(r => r.arrayBuffer()),
          fetch(await storageGetSignedUrl(targetUpload.storageKey)).then(r => r.arrayBuffer()),
        ]);

        const report = computeByteDiff(new Uint8Array(sourceResp), new Uint8Array(targetResp));

        await createOperation({
          sessionId: input.sessionId,
          userId: ctx.user.id,
          opType: "diff_compute",
          sourceUploadId: input.sourceUploadId,
          targetUploadId: input.targetUploadId,
          resultSummary: { changedBytes: report.changedBytes, regionsCount: report.regions.length },
          success: true,
        });

        await createAuditLog({
          userId: ctx.user.id,
          sessionId: input.sessionId,
          action: "diff_computed",
          description: `Byte diff: ${report.changedBytes} bytes changed across ${report.regions.length} regions`,
          metadata: { sourceId: input.sourceUploadId, targetId: input.targetUploadId, changedBytes: report.changedBytes },
        });

        return report;
      }),

    threeWay: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        correctedUploadId: z.number(),
        preBenchUploadId: z.number(),
        postBenchUploadId: z.number(),
      }))
      .mutation(async ({ ctx, input }) => {
        const [corrected, pre, post] = await Promise.all([
          getUploadById(input.correctedUploadId),
          getUploadById(input.preBenchUploadId),
          getUploadById(input.postBenchUploadId),
        ]);
        if (!corrected || !pre || !post) throw new Error("Upload(s) not found");

        const [corrBuf, preBuf, postBuf] = await Promise.all([
          fetch(await storageGetSignedUrl(corrected.storageKey)).then(r => r.arrayBuffer()),
          fetch(await storageGetSignedUrl(pre.storageKey)).then(r => r.arrayBuffer()),
          fetch(await storageGetSignedUrl(post.storageKey)).then(r => r.arrayBuffer()),
        ]);

        const result = threeWayCompare(
          new Uint8Array(corrBuf),
          new Uint8Array(preBuf),
          new Uint8Array(postBuf)
        );

        await createOperation({
          sessionId: input.sessionId,
          userId: ctx.user.id,
          opType: "three_way_compare",
          inputParams: { correctedId: input.correctedUploadId, preId: input.preBenchUploadId, postId: input.postBenchUploadId },
          resultSummary: { runtimeRewrites: result.runtimeRewrites.length, learnedState: result.learnedStateRegions.length },
          success: true,
        });

        await createAuditLog({
          userId: ctx.user.id,
          sessionId: input.sessionId,
          action: "three_way_compared",
          description: `Three-way comparison: ${result.runtimeRewrites.length} runtime rewrites, ${result.learnedStateRegions.length} learned-state changes`,
          metadata: { runtimeRewrites: result.runtimeRewrites.length },
        });

        return result;
      }),
  }),

  // ─── Audit Log ─────────────────────────────────────────────────────────────
  audit: router({
    list: protectedProcedure
      .input(z.object({ sessionId: z.number().optional(), limit: z.number().default(50) }))
      .query(async ({ ctx, input }) => {
        if (input.sessionId) {
          return getSessionAuditLogs(input.sessionId);
        }
        return getUserAuditLogs(ctx.user.id, input.limit);
      }),
  }),

  // ─── Operations ────────────────────────────────────────────────────────────
  operations: router({
    list: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input }) => {
        return getSessionOperations(input.sessionId);
      }),
  }),
});

export type AppRouter = typeof appRouter;
