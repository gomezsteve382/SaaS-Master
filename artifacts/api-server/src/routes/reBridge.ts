/**
 * /api/tools/re-bridge  — firmware emulation bridge routes.
 *
 * GET  /api/tools/re-bridge/status   — probe Python + Unicorn availability
 * POST /api/tools/make-keyfn         — run makekeyfn.py; extract seed→key fn
 * POST /api/tools/emulate            — run emulate.py; general CPU emulation
 *
 * All POST routes accept JSON with a `fileB64` field (base64 firmware bytes)
 * plus arch/bits/address parameters. The Python scripts are spawned with the
 * JSON payload piped to stdin; they respond with a single JSON object on stdout.
 *
 * The 10 MB request body limit (matching the Express global JSON parser in
 * app.ts) guards against accidentally uploading oversized firmware images
 * (ECM bins are typically < 2 MB; GPEC2A < 4 MB, ~5.5 MB once base64-encoded).
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const router: IRouter = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const RE_BRIDGE_DIR  = path.join(WORKSPACE_ROOT, "tools", "re-bridge");
const PYTHON_BIN     = process.env.PYTHON_BIN || "python3";
const SPAWN_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES   = 10 * 1024 * 1024; // 10 MB (matches express.json limit in app.ts)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a Python script, pipe `payload` (stringified JSON) to stdin,
 * collect stdout and parse as JSON.  Rejects on non-zero exit or timeout.
 */
function runPythonScript(scriptPath: string, payload: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: RE_BRIDGE_DIR,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`Python script timed out after ${SPAWN_TIMEOUT_MS} ms`));
      }
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });

    child.on("error", (err) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (stdout.trim()) {
          try {
            resolve(JSON.parse(stdout));
            return;
          } catch {
            reject(new Error(`script stdout was not JSON: ${stdout.slice(0, 400)}`));
            return;
          }
        }
        reject(new Error(`script exited ${code}: ${stderr.trim().slice(0, 400)}`));
      }
    });

    // Write payload and close stdin so the script's json.load() can return.
    child.stdin.write(payload, "utf8");
    child.stdin.end();
  });
}

/** Rough byte-size estimate for a JSON body (avoids deserialising fileB64). */
function roughBodySize(body: unknown): number {
  try {
    return JSON.stringify(body).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// GET /api/tools/re-bridge/status
// ---------------------------------------------------------------------------

router.get("/tools/re-bridge/status", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const child = spawn(PYTHON_BIN, ["-c",
      "import unicorn; import sys; print(unicorn.__version__); sys.exit(0)"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { err += b.toString("utf8"); });

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
      setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
    });

    const version = out.trim() || null;
    if (version) {
      res.json({ ok: true, version, python: PYTHON_BIN });
    } else {
      res.json({
        ok: false,
        version: null,
        python: PYTHON_BIN,
        error: err.trim() || "unicorn not importable",
      });
    }
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// POST /api/tools/make-keyfn
// ---------------------------------------------------------------------------

router.post("/tools/make-keyfn", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body?.fileB64 || typeof body.fileB64 !== "string") {
      res.status(400).json({ ok: false, error: "fileB64 is required (base64 string)" });
      return;
    }
    if (roughBodySize(body) > MAX_BODY_BYTES) {
      res.status(413).json({ ok: false, error: "payload exceeds 10 MB limit" });
      return;
    }

    req.log.info({ arch: body.arch, bits: body.bits }, "make-keyfn request");
    const result = await runPythonScript(
      path.join(RE_BRIDGE_DIR, "makekeyfn.py"),
      JSON.stringify(body),
    );
    res.json(result);
  } catch (e) {
    req.log.warn({ err: String(e) }, "make-keyfn failed");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tools/emulate
// ---------------------------------------------------------------------------

router.post("/tools/emulate", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body?.fileB64 || typeof body.fileB64 !== "string") {
      res.status(400).json({ ok: false, error: "fileB64 is required (base64 string)" });
      return;
    }
    if (roughBodySize(body) > MAX_BODY_BYTES) {
      res.status(413).json({ ok: false, error: "payload exceeds 10 MB limit" });
      return;
    }

    req.log.info({ arch: body.arch, bits: body.bits }, "emulate request");
    const result = await runPythonScript(
      path.join(RE_BRIDGE_DIR, "emulate.py"),
      JSON.stringify(body),
    );
    res.json(result);
  } catch (e) {
    req.log.warn({ err: String(e) }, "emulate failed");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
