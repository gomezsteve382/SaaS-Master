/* ============================================================================
 * /api/key-writer — server-side relay for the transponder writer bridge.
 *
 * The browser's Web Serial path covers Chromium-based desktops. For
 * Firefox, locked-down corporate browsers, and field laptops where Web
 * Serial is disabled, the SRT Lab front-end falls back to this relay,
 * which forwards request frames to a desktop USB-CDC daemon over
 * loopback HTTP. The daemon binary is NOT shipped from this server
 * (tools/python-bridge/ is off-limits per user preference, and we are
 * deliberately not bundling a native serialport addon into the
 * web-server build); the bench operator runs it on the same machine
 * and points us at it via KEY_WRITER_DAEMON_URL.
 *
 * Endpoints:
 *   GET  /transport/status — capability probe: { available, reason,
 *                            model?, firmware? }
 *   POST /transport/send   — relay one request frame: { frame: base64 }
 *                            -> { frame: base64 }
 *
 * Refuse-on-doubt (server-side hardening, evaluated in this order):
 *
 *   1. If KEY_WRITER_DAEMON_URL is unset → `available:false`, /send → 501.
 *      Default posture: relay is OFF.
 *
 *   2. The daemon URL must resolve to loopback (127.0.0.1, ::1, localhost)
 *      UNLESS the operator explicitly opts in with
 *      KEY_WRITER_DAEMON_ALLOW_REMOTE=1. Off-host writer daemons are a
 *      serious risk — anyone who can reach the api-server would otherwise
 *      be able to drive hardware on a remote machine.
 *
 *   3. If KEY_WRITER_RELAY_TOKEN is set, /send must carry a matching
 *      `x-key-writer-token` header. If the token is NOT set, the relay
 *      is treated as unauthenticated and refused unless the operator
 *      explicitly opts in with KEY_WRITER_ALLOW_UNAUTHENTICATED=1
 *      (intended for local-only deploys behind a trusted reverse proxy).
 *
 *   4. Inbound `frame` must be a valid base64 string and decode to at
 *      most KEY_WRITER_MAX_FRAME_BYTES (default 4096) bytes. The
 *      writer protocol's largest legitimate frame is well under 256 B;
 *      4096 is a generous cap that still blocks abuse.
 *
 * The client surfaces every refusal verbatim so the bench operator can
 * see exactly why the relay said no instead of silently falling back.
 * ========================================================================== */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";

const router: IRouter = Router();

const DAEMON_URL = process.env.KEY_WRITER_DAEMON_URL || null;
const DAEMON_TIMEOUT_MS = Number(process.env.KEY_WRITER_DAEMON_TIMEOUT_MS || 5000);
const ALLOW_REMOTE = process.env.KEY_WRITER_DAEMON_ALLOW_REMOTE === "1";
const ALLOW_UNAUTH = process.env.KEY_WRITER_ALLOW_UNAUTHENTICATED === "1";
const RELAY_TOKEN = process.env.KEY_WRITER_RELAY_TOKEN || null;
const MAX_FRAME_BYTES = Math.max(1, Number(process.env.KEY_WRITER_MAX_FRAME_BYTES || 4096));

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

type Refusal = { available: false; reason: string; httpStatus: number };

function daemonReadiness(): { ok: true; url: string } | Refusal {
  if (!DAEMON_URL) {
    return {
      available: false,
      reason: "no daemon configured (set KEY_WRITER_DAEMON_URL on the server)",
      httpStatus: 501,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(DAEMON_URL);
  } catch {
    return { available: false, reason: "KEY_WRITER_DAEMON_URL is not a valid URL", httpStatus: 500 };
  }
  if (!ALLOW_REMOTE && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return {
      available: false,
      reason:
        `daemon host ${parsed.hostname} is not loopback — refusing to relay; ` +
        `set KEY_WRITER_DAEMON_ALLOW_REMOTE=1 to override (NOT recommended)`,
      httpStatus: 403,
    };
  }
  if (!RELAY_TOKEN && !ALLOW_UNAUTH) {
    return {
      available: false,
      reason:
        "relay is unauthenticated — set KEY_WRITER_RELAY_TOKEN (recommended) " +
        "or KEY_WRITER_ALLOW_UNAUTHENTICATED=1 to explicitly accept the risk",
      httpStatus: 403,
    };
  }
  return { ok: true, url: DAEMON_URL };
}

function checkAuth(req: Request): null | Refusal {
  if (!RELAY_TOKEN) return null; // unauthenticated mode already gated by daemonReadiness
  const got = req.header("x-key-writer-token");
  if (got !== RELAY_TOKEN) {
    return {
      available: false,
      reason: "missing or invalid x-key-writer-token header",
      httpStatus: 401,
    };
  }
  return null;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function validateFrame(frame: unknown): { ok: true; bytes: number } | { ok: false; error: string } {
  if (typeof frame !== "string" || frame.length === 0) {
    return { ok: false, error: "missing or empty `frame` (expected base64 string)" };
  }
  // Cheap shape check before decoding so we never construct a giant Buffer.
  const maxB64Len = Math.ceil((MAX_FRAME_BYTES * 4) / 3) + 4;
  if (frame.length > maxB64Len) {
    return { ok: false, error: `frame exceeds max ${MAX_FRAME_BYTES} bytes` };
  }
  if (!BASE64_RE.test(frame)) {
    return { ok: false, error: "frame is not valid base64" };
  }
  const decoded = Buffer.from(frame, "base64");
  if (decoded.length === 0) {
    return { ok: false, error: "frame decoded to zero bytes" };
  }
  if (decoded.length > MAX_FRAME_BYTES) {
    return { ok: false, error: `frame exceeds max ${MAX_FRAME_BYTES} bytes` };
  }
  return { ok: true, bytes: decoded.length };
}

router.get("/key-writer/transport/status", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ready = daemonReadiness();
    if (!("ok" in ready)) {
      res.json({ available: false, reason: ready.reason, model: null, firmware: null });
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DAEMON_TIMEOUT_MS);
    try {
      const r = await fetch(`${ready.url}/status`, { signal: ctrl.signal });
      if (!r.ok) {
        res.json({ available: false, reason: `daemon HTTP ${r.status}`, model: null, firmware: null });
        return;
      }
      const body = (await r.json()) as { model?: string; firmware?: string };
      res.json({
        available: true,
        reason: "ready",
        model: body.model || null,
        firmware: body.firmware || null,
      });
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    next(e);
  }
});

router.post("/key-writer/transport/send", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ready = daemonReadiness();
    if (!("ok" in ready)) {
      res.status(ready.httpStatus).json({ error: ready.reason });
      return;
    }
    const authFail = checkAuth(req);
    if (authFail) {
      res.status(authFail.httpStatus).json({ error: authFail.reason });
      return;
    }
    const frame = (req.body || {}).frame;
    const v = validateFrame(frame);
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DAEMON_TIMEOUT_MS);
    try {
      const r = await fetch(`${ready.url}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ frame }),
        signal: ctrl.signal,
      });
      const body = await r.text();
      res.status(r.status).type("application/json").send(body);
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    next(e);
  }
});

export default router;
