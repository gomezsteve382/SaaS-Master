import { Router, type IRouter } from "express";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GetUnlockCoverageStatsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// __dirname-equivalent for ESM: the api-server runs via tsx with its CWD at
// artifacts/api-server, so we must resolve up to the workspace root rather
// than relying on process.cwd().
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const DISPATCHER_PATH =
  process.env.SRTLAB_DISPATCHER_PATH ||
  path.resolve(
    WORKSPACE_ROOT,
    "tools/python-bridge/tools/srtlab_unlock_catalog.py",
  );
const SPAWN_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60_000;

type CachedStats = {
  expiresAt: number;
  payload: ReturnType<typeof GetUnlockCoverageStatsResponse.parse>;
};

let cache: CachedStats | null = null;

function runDispatcherStats(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [DISPATCHER_PATH, "--stats"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `dispatcher --stats timed out after ${SPAWN_TIMEOUT_MS}ms`,
        ),
      );
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on("data", (b) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `dispatcher --stats exited with code ${code}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

router.get("/unlock-coverage/stats", async (req, res, next) => {
  try {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      res.json(cache.payload);
      return;
    }

    const stdout = await runDispatcherStats();
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch (parseErr) {
      req.log.warn(
        { err: String(parseErr), stdout: stdout.slice(0, 500) },
        "unlock-coverage stats: dispatcher output was not JSON",
      );
      res.status(503).json({
        error: "dispatcher_invalid_output",
        detail: "Python dispatcher did not return valid JSON",
      });
      return;
    }

    const parsed = GetUnlockCoverageStatsResponse.parse(raw);
    cache = { expiresAt: now + CACHE_TTL_MS, payload: parsed };
    res.json(parsed);
  } catch (err) {
    req.log.warn(
      { err: String(err) },
      "unlock-coverage stats: dispatcher unavailable",
    );
    res.status(503).json({
      error: "dispatcher_unavailable",
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
    // unreachable; next() kept for type compat
    next();
  }
});

export default router;
