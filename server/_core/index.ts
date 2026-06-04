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

  // --- /api/anthropic/key-photo — Vision OCR for HITAG AES key data ---
  app.post("/api/anthropic/key-photo", async (req, res) => {
    try {
      const { imageBase64, mediaType } = req.body || {};
      if (!imageBase64) {
        return res.status(400).json({ error: "Missing imageBase64 field" });
      }

      const { invokeLLM } = await import("./llm");

      const result = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are an automotive key programmer assistant. You analyze photos of key programmer screens (Autel IM608, VVDI, Tango, etc.) and extract HITAG AES / PCF7953 transponder data. Extract hex values exactly as shown on screen. Return a JSON object with these fields (use null for any field you cannot read):\n- chipId: 8 hex chars (Chip UID)\n- sk0: 8 hex chars (Secret Key page 0)\n- sk1: 8 hex chars (Secret Key page 1)\n- sk2: 8 hex chars (Secret Key page 2)\n- sk3: 8 hex chars (Secret Key page 3)\n- config: 8 hex chars (Config word)\n- keyId: any key identifier visible\n- notes: brief description of what you see\nOnly return the JSON object, no other text.`,
          },
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
                text: "Extract the HITAG AES / PCF7953 transponder data from this key programmer screen photo. Return only the JSON object.",
              },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "key_photo_extraction",
            strict: true,
            schema: {
              type: "object",
              properties: {
                chipId: { type: ["string", "null"], description: "8 hex char Chip UID" },
                sk0: { type: ["string", "null"], description: "8 hex char SK0" },
                sk1: { type: ["string", "null"], description: "8 hex char SK1" },
                sk2: { type: ["string", "null"], description: "8 hex char SK2" },
                sk3: { type: ["string", "null"], description: "8 hex char SK3" },
                config: { type: ["string", "null"], description: "8 hex char Config" },
                keyId: { type: ["string", "null"], description: "Key identifier if visible" },
                notes: { type: ["string", "null"], description: "Brief description" },
              },
              required: ["chipId", "sk0", "sk1", "sk2", "sk3", "config", "keyId", "notes"],
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

      // Normalize: strip spaces, uppercase
      const norm = (v: any) => v ? String(v).replace(/[\s:_\-]/g, "").toUpperCase().slice(0, 8) : null;
      return res.json({
        chipId: norm(parsed.chipId),
        sk0: norm(parsed.sk0),
        sk1: norm(parsed.sk1),
        sk2: norm(parsed.sk2),
        sk3: norm(parsed.sk3),
        config: norm(parsed.config),
        keyId: parsed.keyId || null,
        notes: parsed.notes || null,
      });
    } catch (e: any) {
      console.error("[/api/anthropic/key-photo]", e);
      return res.status(500).json({ error: e.message || "Vision analysis failed" });
    }
  });

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
