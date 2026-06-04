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
