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
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

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

// ---------------------------------------------------------------------------
// Helpers for autokit_checksum.py (uses CLI file-path args, not stdin JSON)
// ---------------------------------------------------------------------------

/**
 * Write a base64 payload to a temp file, returning the file path.
 * Caller is responsible for deleting it.
 */
function writeTmpFile(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  const tmpPath = path.join(os.tmpdir(), `srtlab_ck_${crypto.randomBytes(8).toString("hex")}.bin`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

/**
 * Spawn autokit_checksum.py with CLI args.  Collects stdout and parses JSON.
 */
function runChecksumScript(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(RE_BRIDGE_DIR, "autokit_checksum.py");
    const child = spawn(PYTHON_BIN, [scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: RE_BRIDGE_DIR,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`autokit_checksum timed out after ${SPAWN_TIMEOUT_MS} ms`));
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
            const parsed = JSON.parse(stdout) as { ok?: boolean; error?: string };
            // Even a non-zero exit is acceptable if the script emitted ok:false JSON
            // (autokit_checksum.py calls sys.exit(0) after err() for graceful failures).
            // Propagate non-zero exits only when no parseable JSON was produced.
            resolve(parsed);
            return;
          } catch {
            reject(new Error(`script stdout was not JSON (exit ${code}): ${stdout.slice(0, 400)}`));
            return;
          }
        }
        reject(new Error(`script exited ${code} with no output: ${stderr.trim().slice(0, 400)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// POST /api/tools/checksum-scan
// ---------------------------------------------------------------------------

router.post("/tools/checksum-scan", async (req: Request, res: Response, next: NextFunction) => {
  let tmpIn: string | null = null;
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

    tmpIn = writeTmpFile(body.fileB64);
    req.log.info({ size: Buffer.from(body.fileB64, "base64").length }, "checksum-scan request");
    const raw = await runChecksumScript(["checksum", tmpIn]) as Record<string, unknown>;
    // Normalize Python snake_case keys to camelCase for the public API contract.
    const result = {
      ...raw,
      wholeFile: raw["whole_file"],
      verifiedChecksums: raw["checksums"],
      whole_file: undefined,
      checksums: undefined,
    };
    res.json(result);
  } catch (e) {
    req.log.warn({ err: String(e) }, "checksum-scan failed");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (tmpIn) try { fs.unlinkSync(tmpIn); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// POST /api/tools/fix-checksum
// ---------------------------------------------------------------------------

router.post("/tools/fix-checksum", async (req: Request, res: Response, next: NextFunction) => {
  let tmpIn: string | null = null;
  let tmpOut: string | null = null;
  try {
    const body = req.body as Record<string, unknown>;
    if (!body?.fileB64 || typeof body.fileB64 !== "string") {
      res.status(400).json({ ok: false, error: "fileB64 is required (base64 string)" });
      return;
    }
    if (body.offset == null || body.offset === "" || !body.algorithm) {
      res.status(400).json({ ok: false, error: "offset and algorithm are required" });
      return;
    }
    if (roughBodySize(body) > MAX_BODY_BYTES) {
      res.status(413).json({ ok: false, error: "payload exceeds 10 MB limit" });
      return;
    }

    tmpIn = writeTmpFile(body.fileB64);
    tmpOut = path.join(os.tmpdir(), `srtlab_ck_out_${crypto.randomBytes(8).toString("hex")}.bin`);

    req.log.info({ offset: body.offset, algorithm: body.algorithm }, "fix-checksum request");

    const result = await runChecksumScript([
      "fixck", tmpIn,
      "--offset", String(body.offset),
      "--algorithm", String(body.algorithm),
      "--out", tmpOut,
    ]) as Record<string, unknown>;

    // Read patched binary and return as base64 under the spec-required key "fileB64".
    let fileB64 = "";
    let patchedSize = 0;
    if ((result as { ok?: unknown }).ok && tmpOut && fs.existsSync(tmpOut)) {
      const buf = fs.readFileSync(tmpOut);
      fileB64 = buf.toString("base64");
      patchedSize = buf.length;
    }

    res.json({ ...result, fileB64, patchedSize });
  } catch (e) {
    req.log.warn({ err: String(e) }, "fix-checksum failed");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (tmpIn) try { fs.unlinkSync(tmpIn); } catch { /* best-effort */ }
    if (tmpOut) try { fs.unlinkSync(tmpOut); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// POST /api/tools/eeprom-map
// ---------------------------------------------------------------------------

router.post("/tools/eeprom-map", async (req: Request, res: Response, next: NextFunction) => {
  let tmpIn: string | null = null;
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

    tmpIn = writeTmpFile(body.fileB64);
    req.log.info({ size: Buffer.from(body.fileB64, "base64").length }, "eeprom-map request");
    const raw = await runChecksumScript(["eepmap", tmpIn]) as Record<string, unknown>;
    // Normalize Python snake_case keys to camelCase for the public API contract.
    const result = {
      ...raw,
      vinCandidates: raw["vin_candidates"],
      mirroredBlocks: raw["mirrored_blocks"],
      vin_candidates: undefined,
      mirrored_blocks: undefined,
    };
    res.json(result);
  } catch (e) {
    req.log.warn({ err: String(e) }, "eeprom-map failed");
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (tmpIn) try { fs.unlinkSync(tmpIn); } catch { /* best-effort */ }
  }
});

export default router;
