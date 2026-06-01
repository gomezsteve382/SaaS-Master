/**
 * /api/tools — RE-Bridge endpoints
 *
 * Thin spawner layer: accept JSON (with base64-encoded binary payloads),
 * write temp files, invoke tools/re-bridge Python scripts, return parsed JSON.
 *
 * Endpoints:
 *   GET  /api/tools/re-bridge/status   — unicorn availability probe
 *   POST /api/tools/make-keyfn         — generate keyfn.py from firmware slice
 *   POST /api/tools/emulate            — single-shot Unicorn emulation
 *   POST /api/tools/checksum-scan      — find stored checksums in a binary
 *   POST /api/tools/fix-checksum       — recompute + write back one checksum
 *   POST /api/tools/eeprom-map         — VIN candidates / strings / mirrors
 */

import { Router, type IRouter } from "express";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import path from "path";

const router: IRouter = Router();

const SCRIPTS = path.resolve(process.cwd(), "../../tools/re-bridge");

const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB upload limit

// ---------------------------------------------------------------------------
// Helper: write base64 payload to a temp file, return path + cleanup fn
// ---------------------------------------------------------------------------
async function tmpFile(b64: string, suffix = ".bin"): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "rebridge-"));
  const filePath = path.join(dir, `payload${suffix}`);
  const buf = Buffer.from(b64, "base64");
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`file too large: ${buf.length} bytes (max ${MAX_FILE_BYTES})`);
  }
  await fs.writeFile(filePath, buf);
  return {
    filePath,
    cleanup: async () => {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: run a Python script, capture stdout, parse JSON
// ---------------------------------------------------------------------------
function runPy(args: string[], timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", args, { cwd: SCRIPTS });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("script timed out"));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      if (!text) {
        resolve({ ok: false, error: stderr.trim() || `exited with code ${code}` });
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({ ok: false, error: "non-JSON output", raw: text.slice(0, 500) });
      }
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// GET /api/tools/re-bridge/status
// ---------------------------------------------------------------------------
router.get("/tools/re-bridge/status", async (_req, res, next) => {
  try {
    const proc = await new Promise<{ ok: boolean; version: string }>((resolve) => {
      const p = spawn("python3", ["-c", "import unicorn; print(unicorn.__version__)"]);
      let out = "";
      p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      p.on("close", (code) => resolve({ ok: code === 0, version: out.trim() }));
      p.on("error", () => resolve({ ok: false, version: "" }));
    });
    if (proc.ok && proc.version) {
      res.json({ available: true, version: proc.version, scripts: SCRIPTS });
    } else {
      res.json({
        available: false,
        reason: "unicorn not importable — run: pip install unicorn",
        scripts: SCRIPTS,
      });
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/tools/make-keyfn
// Body: { fileB64, arch, bits, base, offset, size, start, stop, seedReg, keyReg, keylen, endian, steps }
// ---------------------------------------------------------------------------
router.post("/tools/make-keyfn", async (req, res, next) => {
  let cleanup: (() => Promise<void>) | null = null;
  let outCleanup: (() => Promise<void>) | null = null;
  try {
    const body = req.body ?? {};
    if (!body.fileB64 || typeof body.fileB64 !== "string") {
      res.status(400).json({ ok: false, error: "missing fileB64" });
      return;
    }
    if (!body.start || !body.stop || !body.seedReg || !body.keyReg) {
      res.status(400).json({ ok: false, error: "missing required fields: start, stop, seedReg, keyReg" });
      return;
    }
    const { filePath, cleanup: c } = await tmpFile(body.fileB64);
    cleanup = c;

    const outDir = await fs.mkdtemp(path.join(tmpdir(), "keyfn-out-"));
    const outPath = path.join(outDir, "keyfn.py");
    outCleanup = async () => { try { await fs.rm(outDir, { recursive: true, force: true }); } catch {} };

    const args = [
      path.join(SCRIPTS, "makekeyfn.py"),
      "--file", filePath,
      "--arch",    String(body.arch    ?? "x86"),
      "--bits",    String(body.bits    ?? 64),
      "--base",    String(body.base    ?? "0x400000"),
      "--offset",  String(body.offset  ?? "0"),
      "--size",    String(body.size    ?? "0x200"),
      "--start",   String(body.start),
      "--stop",    String(body.stop),
      "--seed-reg", String(body.seedReg),
      "--key-reg",  String(body.keyReg),
      "--keylen",  String(body.keylen  ?? 4),
      "--endian",  String(body.endian  ?? "little"),
      "--steps",   String(body.steps   ?? 200000),
      "--out",     outPath,
    ];

    const result = await runPy(args, 30_000) as Record<string, unknown>;

    // If successful, read keyfn.py content and include it
    if (result.ok) {
      try {
        const keyfnSrc = await fs.readFile(outPath, "utf8");
        result.keyfnSrc = keyfnSrc;
      } catch {}
    }

    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    await cleanup?.();
    await outCleanup?.();
  }
});

// ---------------------------------------------------------------------------
// POST /api/tools/emulate
// Body: { fileB64, arch, bits, base, offset, size, start, stop, steps, regs, dump, trace }
// ---------------------------------------------------------------------------
router.post("/tools/emulate", async (req, res, next) => {
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const body = req.body ?? {};
    if (!body.fileB64 || typeof body.fileB64 !== "string") {
      res.status(400).json({ ok: false, error: "missing fileB64" });
      return;
    }
    const { filePath, cleanup: c } = await tmpFile(body.fileB64);
    cleanup = c;

    const args = [
      path.join(SCRIPTS, "emulate.py"),
      "--file", filePath,
      "--arch",   String(body.arch   ?? "x86"),
      "--bits",   String(body.bits   ?? 64),
      "--base",   String(body.base   ?? "0x400000"),
      "--offset", String(body.offset ?? "0"),
      "--size",   String(body.size   ?? "0x4000"),
    ];
    if (body.start) args.push("--start", String(body.start));
    if (body.stop)  args.push("--stop",  String(body.stop));
    args.push("--steps", String(body.steps ?? 200000));
    // regs: [{ name, value }] or "name=value" strings
    for (const reg of (body.regs ?? [])) {
      if (typeof reg === "string") {
        args.push("--reg", reg);
      } else if (reg.name && reg.value !== undefined) {
        args.push("--reg", `${reg.name}=${reg.value}`);
      }
    }
    if (body.dump)  args.push("--dump",  String(body.dump));
    if (body.trace) args.push("--trace");

    const result = await runPy(args, 30_000);
    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    await cleanup?.();
  }
});

// ---------------------------------------------------------------------------
// POST /api/tools/checksum-scan
// Body: { fileB64 }
// ---------------------------------------------------------------------------
router.post("/tools/checksum-scan", async (req, res, next) => {
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const body = req.body ?? {};
    if (!body.fileB64 || typeof body.fileB64 !== "string") {
      res.status(400).json({ ok: false, error: "missing fileB64" });
      return;
    }
    const { filePath, cleanup: c } = await tmpFile(body.fileB64);
    cleanup = c;

    const result = await runPy(
      [path.join(SCRIPTS, "autokit_checksum.py"), "checksum", filePath],
      20_000,
    );
    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    await cleanup?.();
  }
});

// ---------------------------------------------------------------------------
// POST /api/tools/fix-checksum
// Body: { fileB64, offset, algorithm }
// Returns: { ok, ...result, patchedB64 }
// ---------------------------------------------------------------------------
router.post("/tools/fix-checksum", async (req, res, next) => {
  let cleanup: (() => Promise<void>) | null = null;
  let outCleanup: (() => Promise<void>) | null = null;
  try {
    const body = req.body ?? {};
    if (!body.fileB64 || typeof body.fileB64 !== "string") {
      res.status(400).json({ ok: false, error: "missing fileB64" });
      return;
    }
    if (!body.offset || !body.algorithm) {
      res.status(400).json({ ok: false, error: "missing offset or algorithm" });
      return;
    }
    const { filePath, cleanup: c } = await tmpFile(body.fileB64);
    cleanup = c;

    const outDir = await fs.mkdtemp(path.join(tmpdir(), "fixck-out-"));
    const outPath = path.join(outDir, "patched.bin");
    outCleanup = async () => { try { await fs.rm(outDir, { recursive: true, force: true }); } catch {} };

    const result = await runPy([
      path.join(SCRIPTS, "autokit_checksum.py"), "fixck", filePath,
      "--offset",    String(body.offset),
      "--algorithm", String(body.algorithm),
      "--out",       outPath,
    ], 20_000) as Record<string, unknown>;

    if (result.ok) {
      try {
        const patched = await fs.readFile(outPath);
        result.patchedB64 = patched.toString("base64");
        result.patchedSize = patched.length;
      } catch {}
    }

    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    await cleanup?.();
    await outCleanup?.();
  }
});

// ---------------------------------------------------------------------------
// POST /api/tools/eeprom-map
// Body: { fileB64 }
// ---------------------------------------------------------------------------
router.post("/tools/eeprom-map", async (req, res, next) => {
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const body = req.body ?? {};
    if (!body.fileB64 || typeof body.fileB64 !== "string") {
      res.status(400).json({ ok: false, error: "missing fileB64" });
      return;
    }
    const { filePath, cleanup: c } = await tmpFile(body.fileB64);
    cleanup = c;

    const result = await runPy(
      [path.join(SCRIPTS, "autokit_checksum.py"), "eepmap", filePath],
      20_000,
    );
    res.json(result);
  } catch (err) {
    next(err);
  } finally {
    await cleanup?.();
  }
});

export default router;
