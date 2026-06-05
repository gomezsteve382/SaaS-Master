import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  // --- /api/backups REST endpoint (used by client-side audit.js) ---
  {
    const { createBackup, listBackups, getBackupByKey, deleteBackupByKey, deleteAllBackups } = await import("../db");

    // POST /api/backups — create or upsert a backup
    app.post("/api/backups", async (req, res) => {
      try {
        const body = req.body || {};
        const backupKey = body.id || body.key;
        if (!backupKey || !body.module) {
          return res.status(400).json({ error: "Missing required fields: id, module" });
        }
        await createBackup({
          backupKey,
          userId: null, // backups are not user-scoped in SRT Lab
          module: body.module,
          vin: body.vin || null,
          didCount: body.didCount ?? 0,
          tx: body.tx ?? null,
          rx: body.rx ?? null,
          timestamp: body.timestamp || null,
          checksum: body.checksum || null,
          snapshotKind: body.snapshotKind || null,
          preWriteKey: body.preWriteKey || null,
          payload: body.payload || null,
        });
        return res.json({ ok: true, id: backupKey });
      } catch (e: any) {
        console.error("[/api/backups POST]", e);
        return res.status(500).json({ error: e.message || "Internal error" });
      }
    });

    // GET /api/backups — list all backups
    app.get("/api/backups", async (_req, res) => {
      try {
        const list = await listBackups();
        return res.json({ backups: list });
      } catch (e: any) {
        console.error("[/api/backups GET]", e);
        return res.status(500).json({ error: e.message || "Internal error" });
      }
    });

    // GET /api/backups/:id — get a single backup payload
    app.get("/api/backups/:id", async (req, res) => {
      try {
        const key = decodeURIComponent(req.params.id);
        const record = await getBackupByKey(key);
        if (!record) return res.status(404).json({ error: "Not found" });
        return res.json({ id: record.backupKey, payload: record.payload });
      } catch (e: any) {
        console.error("[/api/backups/:id GET]", e);
        return res.status(500).json({ error: e.message || "Internal error" });
      }
    });

    // DELETE /api/backups/:id — delete a single backup
    app.delete("/api/backups/:id", async (req, res) => {
      try {
        const key = decodeURIComponent(req.params.id);
        await deleteBackupByKey(key);
        return res.json({ ok: true });
      } catch (e: any) {
        console.error("[/api/backups/:id DELETE]", e);
        return res.status(500).json({ error: e.message || "Internal error" });
      }
    });

    // DELETE /api/backups — clear all backups
    app.delete("/api/backups", async (_req, res) => {
      try {
        await deleteAllBackups();
        return res.json({ ok: true });
      } catch (e: any) {
        console.error("[/api/backups DELETE all]", e);
        return res.status(500).json({ error: e.message || "Internal error" });
      }
    });
  }

  // --- /api/anthropic/key-photo — Vision OCR for HITAG 2 / HITAG AES key programmer screens ---
  app.post("/api/anthropic/key-photo", async (req, res) => {
    try {
      const { imageBase64, mediaType } = req.body || {};
      if (!imageBase64) {
        return res.status(400).json({ error: "Missing imageBase64 field" });
      }

      const { invokeLLM } = await import("./llm");

      const systemPrompt = `You are an expert automotive transponder data extraction assistant. Your job is to read key programmer screenshots (Autel IM608, VVDI Prog, Tango, etc.) and extract EVERY hex value visible on screen with 100% accuracy.

You will encounter two main screen layouts:

1. HITAG 2 / PCF7945/53 layout (Autel VVDI Prog):
   - Top: "HITAG 2" label, Chip ID field (e.g. 437C2C9F)
   - Parameter section: Low SK (4 hex chars, e.g. 4D494B52), High SK (4 hex chars, e.g. 4F4E)
   - Chip info section: Chip type (PCF7945/53), Low SK (8 hex chars), High SK (8 hex chars), Config page (8 hex chars)
   - Chip data section: Page 0 (8 hex chars), Page 1 (8 hex chars), Page 2 (8 hex chars), Page 3 (8 hex chars)

2. HITAG AES / PCF7939FA layout:
   - Chip ID / UID field
   - AES Key pages (SK0, SK1, SK2, SK3) — each 8 hex chars
   - Config word — 8 hex chars

Extraction rules:
- Read EVERY hex value shown in input fields, text boxes, and data cells
- Hex values are always 4 or 8 characters: 0-9, A-F
- For HITAG 2: Low SK in Parameter = first 4 bytes of the 6-byte secret key (e.g. "4D494B52"); High SK in Parameter = last 2 bytes (e.g. "4F4E")
- For HITAG 2: chipInfoLowSK = full 8-char Low SK from Chip info section; chipInfoHighSK = full 8-char High SK; configPage = 8-char Config page
- For HITAG 2: page0, page1, page2, page3 = 8-char values from Chip data section
- chipType: the chip model shown (e.g. "PCF7945/53", "PCF7939FA", "HITAG 2", "HITAG AES")
- chipId: the Chip ID / UID shown at the top (e.g. "437C2C9F")
- Do NOT guess or invent values — use null for any field you genuinely cannot read
- Strip all spaces from hex values in your output`;

      const result = await invokeLLM({
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "image_url" as const,
                image_url: {
                  url: imageBase64.startsWith("data:") ? imageBase64 : `data:${mediaType || "image/png"};base64,${imageBase64}`,
                  detail: "high" as const,
                },
              },
              {
                type: "text" as const,
                text: `Extract ALL hex values from this key programmer screen. Read every field carefully — Chip ID, all SK values, Config page, and all Page data. Return the complete JSON object with every field you can read.`,
              },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "key_photo_extraction_v2",
            strict: true,
            schema: {
              type: "object",
              properties: {
                chipType:        { type: ["string", "null"], description: "Chip type label shown on screen (e.g. PCF7945/53, PCF7939FA, HITAG 2, HITAG AES)" },
                chipId:          { type: ["string", "null"], description: "Chip ID / UID — 8 hex chars (e.g. 437C2C9F)" },
                // HITAG 2 Parameter section (top right)
                paramLowSK:      { type: ["string", "null"], description: "Parameter section Low SK — 8 hex chars (e.g. 4D494B52)" },
                paramHighSK:     { type: ["string", "null"], description: "Parameter section High SK — 4 hex chars (e.g. 4F4E)" },
                // HITAG 2 Chip info section
                chipInfoLowSK:   { type: ["string", "null"], description: "Chip info Low SK — 8 hex chars" },
                chipInfoHighSK:  { type: ["string", "null"], description: "Chip info High SK — 8 hex chars" },
                configPage:      { type: ["string", "null"], description: "Config page — 8 hex chars" },
                // Chip data pages (both HITAG 2 and HITAG AES)
                page0:           { type: ["string", "null"], description: "Chip data Page 0 — 8 hex chars" },
                page1:           { type: ["string", "null"], description: "Chip data Page 1 — 8 hex chars" },
                page2:           { type: ["string", "null"], description: "Chip data Page 2 — 8 hex chars" },
                page3:           { type: ["string", "null"], description: "Chip data Page 3 — 8 hex chars" },
                // HITAG AES specific
                sk0:             { type: ["string", "null"], description: "AES SK0 — 8 hex chars" },
                sk1:             { type: ["string", "null"], description: "AES SK1 — 8 hex chars" },
                sk2:             { type: ["string", "null"], description: "AES SK2 — 8 hex chars" },
                sk3:             { type: ["string", "null"], description: "AES SK3 — 8 hex chars" },
                notes:           { type: ["string", "null"], description: "Brief description of screen layout and any notable observations" },
              },
              required: ["chipType","chipId","paramLowSK","paramHighSK","chipInfoLowSK","chipInfoHighSK","configPage","page0","page1","page2","page3","sk0","sk1","sk2","sk3","notes"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = result.choices?.[0]?.message?.content;
      let parsed: any = {};
      if (typeof content === "string") {
        try { parsed = JSON.parse(content); } catch { parsed = { notes: content }; }
      }

      // Normalize hex: strip spaces/dashes/colons, uppercase, no length cap (some fields are 4 chars)
      const normHex = (v: any, maxLen = 8) => {
        if (!v) return null;
        const s = String(v).replace(/[\s:_\-]/g, "").toUpperCase();
        return s.length > 0 ? s.slice(0, maxLen) : null;
      };

      // For HITAG 2 screens: derive sk0–sk3 from chip data pages if AES fields are absent
      // page0–page3 from Chip data section map directly to sk0–sk3 in our tab
      const p0 = normHex(parsed.page0);
      const p1 = normHex(parsed.page1);
      const p2 = normHex(parsed.page2);
      const p3 = normHex(parsed.page3);

      // sk0–sk3 come from AES fields if present, otherwise fall back to page data
      const sk0 = normHex(parsed.sk0) || p0;
      const sk1 = normHex(parsed.sk1) || p1;
      const sk2 = normHex(parsed.sk2) || p2;
      const sk3 = normHex(parsed.sk3) || p3;

      // Config: use configPage (HITAG 2) or config (AES)
      const config = normHex(parsed.configPage) || normHex(parsed.config);

      // Chip ID
      const chipId = normHex(parsed.chipId);

      // Full 6-byte HITAG 2 SK = chipInfoLowSK (4 bytes) + chipInfoHighSK (2 bytes)
      const hitag2FullSK = (parsed.chipInfoLowSK && parsed.chipInfoHighSK)
        ? (normHex(parsed.chipInfoLowSK, 8) || '') + (normHex(parsed.chipInfoHighSK, 8) || '')
        : null;

      return res.json({
        // Normalized fields for direct tab population
        chipId,
        sk0,
        sk1,
        sk2,
        sk3,
        config,
        page1: p1,
        page2: p2,
        // Raw extracted fields for display
        chipType:       parsed.chipType || null,
        paramLowSK:     normHex(parsed.paramLowSK),
        paramHighSK:    normHex(parsed.paramHighSK, 4),
        chipInfoLowSK:  normHex(parsed.chipInfoLowSK),
        chipInfoHighSK: normHex(parsed.chipInfoHighSK),
        configPage:     normHex(parsed.configPage),
        page0:          p0,
        page3:          p3,
        hitag2FullSK,
        notes: parsed.notes || null,
      });
    } catch (e: any) {
      console.error("[/api/anthropic/key-photo]", e);
      return res.status(500).json({ error: e.message || "Vision analysis failed" });
    }
  });

  // --- /api/sec16-sync-events REST endpoint (SEC16 sync audit trail) ---
  {
    const { getDb } = await import("../db");
    const { sec16SyncEvents } = await import("../../drizzle/schema");
    const { desc, eq } = await import("drizzle-orm");

    // POST /api/sec16-sync-events — record a sync event (fire-and-forget)
    app.post("/api/sec16-sync-events", async (req, res) => {
      try {
        const db = await getDb();
        if (!db) return res.json({ ok: false, reason: "no-db" });
        const body = req.body || {};
        await db.insert(sec16SyncEvents).values({
          vin:      body.vin      ? String(body.vin).slice(0, 64)   : null,
          platform: body.platform ? String(body.platform).slice(0, 64) : null,
          actionId: body.actionId ? String(body.actionId).slice(0, 128) : null,
          target:   body.target   ? String(body.target).slice(0, 32)  : null,
          recipeId: body.recipeId ? String(body.recipeId).slice(0, 128) : null,
          verified: body.verified ? String(body.verified).slice(0, 32)  : null,
          operator: body.operator ? String(body.operator).slice(0, 256) : null,
          notes:    body.notes    ? String(body.notes)                  : null,
          detail:   body.detail   || null,
        });
        return res.json({ ok: true });
      } catch (e: any) {
        console.error("[/api/sec16-sync-events POST]", e);
        return res.status(500).json({ error: e.message || "Internal error" });
      }
    });

    // GET /api/sec16-sync-events?vin=... — list events (newest first, max 200)
    app.get("/api/sec16-sync-events", async (req, res) => {
      try {
        const db = await getDb();
        if (!db) return res.json({ events: [] });
        const vinFilter = typeof req.query.vin === "string" ? req.query.vin.trim() : "";
        const rows = vinFilter
          ? await db.select().from(sec16SyncEvents).where(eq(sec16SyncEvents.vin, vinFilter)).orderBy(desc(sec16SyncEvents.createdAt)).limit(200)
          : await db.select().from(sec16SyncEvents).orderBy(desc(sec16SyncEvents.createdAt)).limit(200);
        return res.json({ events: rows });
      } catch (e: any) {
        console.error("[/api/sec16-sync-events GET]", e);
        return res.status(500).json({ error: e.message || "Internal error" });
      }
    });
  }

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
