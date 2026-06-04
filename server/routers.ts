import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import {
  createSession,
  getUserSessions,
  getSession,
  createUpload,
  getSessionUploads,
  getUpload,
  createOperation,
  getSessionOperations,
  createAuditLog,
  getUserAuditLogs,
  getSessionAuditLogs,
} from "./db";
import { storagePut, storageGet, storageGetSignedUrl } from "./storage";
import crypto from "crypto";

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

  // --- Sessions ---
  sessions: router({
    create: protectedProcedure
      .input(z.object({ title: z.string().optional() }))
      .mutation(async ({ ctx, input }) => {
        const result = await createSession(ctx.user.id, input.title);
        await createAuditLog({
          userId: ctx.user.id,
          sessionId: result.id,
          action: "session.create",
          description: `Created session: ${input.title || "Untitled"}`,
          metadata: { sessionId: result.id },
        });
        return result;
      }),
    list: protectedProcedure.query(async ({ ctx }) => {
      return getUserSessions(ctx.user.id);
    }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return getSession(input.id);
      }),
  }),

  // --- Uploads ---
  uploads: router({
    create: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        slotType: z.enum(["RFHUB", "BCM", "PCM"]),
        filename: z.string(),
        fileSize: z.number(),
        fileData: z.string(), // base64 encoded
        purpose: z.enum(["source", "candidate", "readback_pre", "readback_post"]).default("source"),
      }))
      .mutation(async ({ ctx, input }) => {
        const buffer = Buffer.from(input.fileData, "base64");
        const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

        // Store in S3
        const storageKey = `uploads/${ctx.user.id}/${input.sessionId}/${Date.now()}_${input.filename}`;
        const { key, url } = await storagePut(storageKey, buffer, "application/octet-stream");

        const uploadData = {
          sessionId: input.sessionId,
          userId: ctx.user.id,
          slotType: input.slotType as "RFHUB" | "BCM" | "PCM",
          filename: input.filename,
          fileSize: input.fileSize,
          sha256,
          storageKey: key,
          storageUrl: url,
          purpose: input.purpose as "source" | "candidate" | "readback_pre" | "readback_post",
        };

        const result = await createUpload(uploadData);

        await createAuditLog({
          userId: ctx.user.id,
          sessionId: input.sessionId,
          action: "upload.create",
          description: `Uploaded ${input.slotType} file: ${input.filename} (${input.fileSize} bytes)`,
          metadata: { uploadId: result.id, sha256, slotType: input.slotType, filename: input.filename },
        });

        return { ...result, sha256, storageUrl: url };
      }),
    list: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input }) => {
        return getSessionUploads(input.sessionId);
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return getUpload(input.id);
      }),
    getSignedUrl: protectedProcedure
      .input(z.object({ storageKey: z.string() }))
      .query(async ({ input }) => {
        const url = await storageGetSignedUrl(input.storageKey);
        return { url };
      }),
  }),

  // --- Operations ---
  operations: router({
    create: protectedProcedure
      .input(z.object({
        sessionId: z.number(),
        opType: z.enum(["inspect", "generate_candidate", "export_candidate", "sec16_sync", "diff_compute", "three_way_compare"]),
        sourceUploadId: z.number().optional(),
        targetUploadId: z.number().optional(),
        inputParams: z.any().optional(),
        resultSummary: z.any().optional(),
        success: z.boolean(),
        errorMessage: z.string().optional(),
        candidateStorageKey: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const result = await createOperation({
          ...input,
          userId: ctx.user.id,
          opType: input.opType as any,
          sourceUploadId: input.sourceUploadId ?? null,
          targetUploadId: input.targetUploadId ?? null,
          inputParams: input.inputParams ?? null,
          resultSummary: input.resultSummary ?? null,
          errorMessage: input.errorMessage ?? null,
          candidateStorageKey: input.candidateStorageKey ?? null,
        });

        await createAuditLog({
          userId: ctx.user.id,
          sessionId: input.sessionId,
          action: `operation.${input.opType}`,
          description: `${input.opType} operation ${input.success ? "succeeded" : "failed"}`,
          metadata: { operationId: result.id, opType: input.opType, success: input.success },
        });

        return result;
      }),
    list: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input }) => {
        return getSessionOperations(input.sessionId);
      }),
  }),

  // --- Audit Logs ---
  audit: router({
    list: protectedProcedure
      .input(z.object({ limit: z.number().min(1).max(500).default(100) }).optional())
      .query(async ({ ctx, input }) => {
        return getUserAuditLogs(ctx.user.id, input?.limit ?? 100);
      }),
    bySession: protectedProcedure
      .input(z.object({ sessionId: z.number() }))
      .query(async ({ input }) => {
        return getSessionAuditLogs(input.sessionId);
      }),
  }),
});

export type AppRouter = typeof appRouter;
