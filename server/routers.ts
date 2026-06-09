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
  getDb,
} from "./db";
import { cdaj2534Sessions } from "../drizzle/schema";
import { desc } from "drizzle-orm";
import { storagePut, storageGet, storageGetSignedUrl } from "./storage";
import crypto from "crypto";
import { invokeLLM } from "./_core/llm";

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
  // --- AI Planner ---
  planner: router({
    enhance: publicProcedure
      .input(z.object({
        intent: z.string().max(500),
        planText: z.string().max(8000),
        moduleLabel: z.string().max(200).optional(),
      }))
      .mutation(async ({ input }) => {
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content: `You are an expert automotive UDS (Unified Diagnostic Services) engineer specializing in FCA/Stellantis CDA6 protocol. You help operators understand and plan diagnostic sequences. Given a user's intent and a generated plan from the CDA6 database, provide:
1. A clear explanation of what each step does at the protocol level
2. Any safety warnings or prerequisites
3. Expected timing and flow control notes
4. Tips for troubleshooting if a step fails
Keep responses concise and technical. Use hex notation for bytes. Do not provide seed/key bypass methods.`,
            },
            {
              role: "user",
              content: `Intent: ${input.intent}\n\nModule: ${input.moduleLabel || "unknown"}\n\nGenerated plan:\n${input.planText}\n\nPlease provide an enhanced explanation of this UDS sequence with protocol-level detail, safety notes, and troubleshooting tips.`,
            },
          ],
        });
        const content = response?.choices?.[0]?.message?.content || "No response from AI.";
        return { explanation: content };
      }),
    // --- UDS Workflow Assistant ---
    workflow: publicProcedure
      .input(z.object({
        intent: z.string().max(1000),
        moduleCode: z.string().max(50).optional(),
        vehiclePlatform: z.string().max(20).optional(),
      }))
      .mutation(async ({ input }) => {
        const systemPrompt = `You are an expert FCA/Stellantis UDS diagnostic engineer with complete knowledge of the MODULE_REGISTRY. You generate precise, executable UDS command workflows.

KNOWLEDGE BASE:

MODULE REGISTRY (48 modules with CAN IDs, sessions, security, DIDs):
- ECM (GPEC2A): TX=0x7E0 RX=0x7E8, sessions=[01,02,03], security: diag=01 prog=03, algo=gpec2a, DIDs: F15A(RW,sec03), F180(R), F181(R), F1A2(R)
- BCM: TX=0x744 RX=0x74C, sessions=[01,02,03], security: diag=01 prog=03, algo=cda6, DIDs: F15A(RW,sec03), F1A3(RW,sec03), 0101(RW,sec03), 0102(RW,sec03)
- TCM: TX=0x7E2 RX=0x7EA, sessions=[01,02,03], security: diag=01 prog=03, algo=gpec2
- RFHUB: TX=0x746 RX=0x74E, sessions=[01,02,03], security: diag=01 prog=03, algo=cda6
- IPC: TX=0x742 RX=0x74A, sessions=[01,02,03], security: diag=01 prog=03, algo=sbec
- ABS: TX=0x7E4 RX=0x7EC, sessions=[01,02,03], security: diag=01 prog=03, algo=gpec2
- RADIO: TX=0x772 RX=0x77A, sessions=[01,02,03], security: diag=01 prog=03, algo=alfa_w6, DIDs: F190(RW,sec01), F10B(R)
- HVAC: TX=0x76A RX=0x772, sessions=[01,02,03], security: diag=01 prog=03, algo=alfa_w6
- TPMS: TX=0x752 RX=0x75A, sessions=[01,02], algo=sbec
- SCCM: TX=0x748 RX=0x750, sessions=[01,02], algo=sbec
- TIPM: TX=0x740 RX=0x748, sessions=[01,02,03], security: diag=01 prog=03, algo=t80
- SGW (Gateway): TX=0x73E RX=0x73F, sessions=[01,02,03], algo=xtea_sgw
- ADCM: TX=0x7B0 RX=0x7B8, sessions=[01,02,03], security: diag=01 prog=03, algo=gpec2
- AMP: TX=0x76E RX=0x776, sessions=[01,02], algo=alfa_w6
- BSM: TX=0x756 RX=0x75E, sessions=[01,02], algo=sbec
- EPS: TX=0x762 RX=0x76A, sessions=[01,02], algo=sbec
- ORC: TX=0x74A RX=0x752, sessions=[01,02], algo=sbec
- DDM: TX=0x760 RX=0x768, algo=sbec
- PDM: TX=0x764 RX=0x76C, algo=sbec
- SKREEM: TX=0x74C RX=0x754, algo=sbec
- ACC: TX=0x77E RX=0x786, algo=alfa_w6

COMMON DIDs (available on ALL modules):
- F190: VIN (RW, secLevel=01)
- F10B: Part Number (R)
- F10C: Software Version (R)
- F10D: Calibration ID (R)
- F10E: Odometer BCD 8 bytes (RW, secLevel=03)
- F10F: Vehicle Body Code (RW, secLevel=03)
- F110: Feature Flags 4 bytes (RW, secLevel=03)
- F18C: ECU Serial Number (R)
- F186: Active Diagnostic Session (R)
- F187: ECU SW Version (R)
- F189: Programming Date (R)
- F191: ECU HW Number (R)
- F192: Supplier HW Number (R)
- F193: Supplier HW Version (R)
- F194: Supplier SW Number (R)
- F195: Supplier SW Version (R)
- F197: Vehicle Name (R)

SECURITY ACCESS ALGORITHMS:
- SBEC: key = (seed * 4) + 0x9018 (16-bit). Used by IPC, SKIM, EPS, BSM, ORC, DDM, PDM, SKREEM, SCCM, TPMS
- CDA6: CDA6 transform with dual key constants (KC1, KC2). Used by BCM, RFHUB
- GPEC2A: key = M-seed XOR C, C=0x47EC21F8. Used by ECM/PCM modern
- GPEC2: GPEC2 cipher. Used by TCM, ABS, ADCM
- XTEA_SGW: XTEA with key [0xBC474048, 0xA33B483A, 0x63687279, 0x73313372]. Used by SGW
- TIPM: Level-based algorithm. Used by TIPM
- W6/W7: AlfaOBD algorithms. Used by RADIO, HVAC, AMP, ACC

UDS SERVICE IDs:
- 10 XX: DiagnosticSessionControl (01=default, 02=programming, 03=extended)
- 11 XX: ECUReset (01=hard, 03=soft)
- 14 FF FF FF: ClearDTCs
- 19 02 XX: ReadDTCByStatus
- 22 XX XX: ReadDataByIdentifier
- 27 XX: SecurityAccess (odd=requestSeed, even=sendKey)
- 2E XX XX: WriteDataByIdentifier
- 31 01 XX XX: RoutineControl (start)
- 34: RequestDownload
- 36: TransferData
- 37: RequestTransferExit
- 3E 00/02: TesterPresent

RULES FOR WORKFLOW GENERATION:
1. Always start with DiagnosticSessionControl to enter the correct session
2. If writing (2E) or programming, unlock security first (27 seed/key)
3. For VIN writes: enter extended session (10 03), unlock security at the DID's secLevel, then write (2E F1 90 + VIN bytes)
4. For reading: just enter extended session and read (22 XX XX)
5. Always end with ECU Reset (11 01) after writes
6. Include TesterPresent (3E 00) keep-alive note for long sequences
7. Show expected positive response patterns (e.g., 6E F1 90 for successful VIN write)
8. Note NRC codes that may occur (7F XX 22=conditionsNotCorrect, 7F XX 33=securityAccessDenied, 7F XX 72=generalProgrammingFailure)

OUTPUT FORMAT:
Return a JSON object with this exact structure:
{
  "title": "Brief workflow title",
  "module": { "code": "MODULE_CODE", "name": "Full Name", "tx": "0xXXX", "rx": "0xXXX" },
  "prerequisites": ["list of prerequisites"],
  "steps": [
    {
      "step": 1,
      "service": "Service Name",
      "hex": "XX XX XX",
      "description": "What this does",
      "expectedResponse": "XX XX XX pattern",
      "notes": "Optional notes"
    }
  ],
  "warnings": ["safety warnings"],
  "postActions": ["what to do after"]
}

IMPORTANT: Return ONLY the JSON object, no markdown code fences, no explanation text outside the JSON.`;

        const userMsg = `Generate the UDS workflow for: "${input.intent}"${input.moduleCode ? `\nTarget module: ${input.moduleCode}` : ""}${input.vehiclePlatform ? `\nVehicle platform: ${input.vehiclePlatform}` : ""}`;

        const response = await invokeLLM({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMsg },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "uds_workflow",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  title: { type: "string", description: "Brief workflow title" },
                  module: {
                    type: "object",
                    properties: {
                      code: { type: "string" },
                      name: { type: "string" },
                      tx: { type: "string" },
                      rx: { type: "string" },
                    },
                    required: ["code", "name", "tx", "rx"],
                    additionalProperties: false,
                  },
                  prerequisites: { type: "array", items: { type: "string" } },
                  steps: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        step: { type: "integer" },
                        service: { type: "string" },
                        hex: { type: "string" },
                        description: { type: "string" },
                        expectedResponse: { type: "string" },
                        notes: { type: "string" },
                      },
                      required: ["step", "service", "hex", "description", "expectedResponse", "notes"],
                      additionalProperties: false,
                    },
                  },
                  warnings: { type: "array", items: { type: "string" } },
                  postActions: { type: "array", items: { type: "string" } },
                },
                required: ["title", "module", "prerequisites", "steps", "warnings", "postActions"],
                additionalProperties: false,
              },
            },
          },
        });
        const content = (response?.choices?.[0]?.message?.content || "{}") as string;
        try {
          return JSON.parse(content);
        } catch {
          return { title: "Error", module: { code: "?", name: "?", tx: "?", rx: "?" }, prerequisites: [], steps: [], warnings: ["Failed to parse AI response"], postActions: [] };
        }
      }),
  }),

  // ─── CDA J2534 Session Logging ────────────────────────────────────────────
  cdaj2534: router({
    /** Save a completed diagnostic session to the DB */
    saveSession: publicProcedure
      .input(z.object({
        moduleName: z.string(),
        txId: z.string(),
        rxId: z.string(),
        profileId: z.string().optional(),
        adapterName: z.string().optional(),
        servicesRun: z.array(z.object({
          name: z.string(),
          did: z.string().optional(),
          request: z.string().optional(),
          response: z.string().optional(),
          ok: z.boolean(),
          errorMsg: z.string().optional(),
        })).optional(),
        udsLog: z.array(z.object({
          t: z.string(),
          dir: z.string(),
          hex: z.string(),
        })).optional(),
        outcome: z.enum(["ok", "error", "partial"]).default("ok"),
        errorMessage: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) return { id: null };
        const [result] = await db.insert(cdaj2534Sessions).values({
          userId: ctx.user?.id ?? null,
          moduleName: input.moduleName,
          txId: input.txId,
          rxId: input.rxId,
          profileId: input.profileId ?? null,
          adapterName: input.adapterName ?? null,
          servicesRun: input.servicesRun ?? null,
          udsLog: input.udsLog ?? null,
          outcome: input.outcome,
          errorMessage: input.errorMessage ?? null,
        });
        return { id: (result as any)?.insertId ?? null };
      }),

    /** List recent sessions (last 50) */
    listSessions: publicProcedure
      .query(async ({ ctx }) => {
        const db = await getDb();
        if (!db) return [];
        return db
          .select()
          .from(cdaj2534Sessions)
          .orderBy(desc(cdaj2534Sessions.createdAt))
          .limit(50);
      }),

    /** Get a single session by ID */
    getSession: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return null;
        const rows = await db
          .select()
          .from(cdaj2534Sessions)
          .where((t: any) => t.id.eq(input.id))
          .limit(1);
        return rows[0] ?? null;
      }),
  }),
});
export type AppRouter = typeof appRouter;
