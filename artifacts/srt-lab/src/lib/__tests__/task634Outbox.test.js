// Task #675 — coverage for the offline outbox + conflict flow.
//
// UnlockCoverageTab now delegates the queue + replay machinery to
// `task634Outbox.js`. A regression here silently loses bench-operator
// data (the whole reason the outbox exists is to survive an offline
// window), so the coalescing rules, drain ordering, stop-on-error
// behavior, and 409 conflict capture are pinned here. The browser
// `online` auto-flush hookup that calls into this module is exercised
// by a separate jsdom test below.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { coalesceOutbox, replayOutbox, OUTBOX_KEY } from "../task634Outbox.js";

function mkVerify(entryId, payload = {}, overrides = {}) {
  return {
    id: `op-${entryId}-${overrides.queuedAt || "0"}`,
    kind: "verify",
    entryId,
    payload: { operator: "AB", vin: null, notes: null, ...payload },
    clientVerifiedAt: overrides.clientVerifiedAt || "2026-05-18T10:00:00.000Z",
    queuedAt: overrides.queuedAt || "2026-05-18T10:00:00.000Z",
    ...overrides,
  };
}

function mkClear(entryId, overrides = {}) {
  return {
    id: `op-${entryId}-clear`,
    kind: "clear",
    entryId,
    clientVerifiedAt: overrides.clientVerifiedAt || "2026-05-18T10:05:00.000Z",
    queuedAt: overrides.queuedAt || "2026-05-18T10:05:00.000Z",
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("OUTBOX_KEY", () => {
  it("is the v1 namespaced localStorage key the component reads from", () => {
    expect(OUTBOX_KEY).toBe("srtlab.task634.outbox.v1");
  });
});

describe("coalesceOutbox", () => {
  it("appends an op when no prior op for the entryId exists", () => {
    const next = coalesceOutbox([], mkVerify("xc2268_rfhub_vin_patch"));
    expect(next).toHaveLength(1);
    expect(next[0].entryId).toBe("xc2268_rfhub_vin_patch");
  });

  it("returns a new array — never mutates the input queue", () => {
    const original = [mkVerify("a")];
    const next = coalesceOutbox(original, mkVerify("b"));
    expect(next).not.toBe(original);
    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
  });

  it("coalesces by entryId — the newer op wins, older one is dropped", () => {
    const first = mkVerify("a", { operator: "AB" }, { queuedAt: "1" });
    const second = mkVerify("a", { operator: "CD" }, { queuedAt: "2" });
    const next = coalesceOutbox([first], second);
    expect(next).toHaveLength(1);
    expect(next[0].payload.operator).toBe("CD");
  });

  it("coalesces across op kinds (Save → Clear → Save while offline keeps only the last)", () => {
    const q0 = coalesceOutbox([], mkVerify("a", {}, { queuedAt: "1" }));
    const q1 = coalesceOutbox(q0, mkClear("a", { queuedAt: "2" }));
    const q2 = coalesceOutbox(q1, mkVerify("a", { operator: "ZZ" }, { queuedAt: "3" }));
    expect(q2).toHaveLength(1);
    expect(q2[0].kind).toBe("verify");
    expect(q2[0].payload.operator).toBe("ZZ");
  });

  it("preserves the relative order of ops for other entryIds", () => {
    const a = mkVerify("a", {}, { queuedAt: "1" });
    const b = mkVerify("b", {}, { queuedAt: "2" });
    const c = mkVerify("c", {}, { queuedAt: "3" });
    const aPrime = mkVerify("a", { operator: "ZZ" }, { queuedAt: "4" });
    const next = coalesceOutbox([a, b, c], aPrime);
    expect(next.map((o) => o.entryId)).toEqual(["b", "c", "a"]);
  });

  it("ignores ops missing an entryId (returns a shallow copy of the queue)", () => {
    const original = [mkVerify("a")];
    const next = coalesceOutbox(original, { kind: "verify" });
    expect(next).toEqual(original);
    expect(next).not.toBe(original);
  });
});

describe("replayOutbox", () => {
  it("throws if no fetch implementation is available", async () => {
    await expect(replayOutbox([mkVerify("a")], { fetchImpl: null })).rejects.toThrow(
      /no fetch/i,
    );
  });

  it("returns early for an empty queue", async () => {
    const fetchImpl = vi.fn();
    const result = await replayOutbox([], { fetchImpl });
    expect(result).toEqual({ remaining: [], drained: 0, conflicts: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("flushes verify ops in queue order against /api/task634-verifications", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push({ url, method: opts?.method, body: JSON.parse(opts.body) });
      return jsonResponse(200, {
        ok: true,
        verification: {
          entryId: calls[calls.length - 1].body.entryId,
          operator: "AB",
          vin: null,
          notes: null,
          verifiedAt: "2026-05-18T11:00:00.000Z",
        },
      });
    });
    const applied = [];
    const q = [
      mkVerify("a", {}, { queuedAt: "1" }),
      mkVerify("b", {}, { queuedAt: "2" }),
      mkVerify("c", {}, { queuedAt: "3" }),
    ];
    const result = await replayOutbox(q, {
      fetchImpl,
      onApplyVerification: (entryId) => applied.push(entryId),
    });
    expect(result.drained).toBe(3);
    expect(result.remaining).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(calls.map((c) => c.body.entryId)).toEqual(["a", "b", "c"]);
    expect(calls.every((c) => c.url === "/api/task634-verifications")).toBe(true);
    expect(calls.every((c) => c.method === "POST")).toBe(true);
    expect(applied).toEqual(["a", "b", "c"]);
  });

  it("sends clientVerifiedAt and payload fields on verify ops", async () => {
    const fetchImpl = vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      return jsonResponse(200, { ok: true, verification: { entryId: body.entryId } });
    });
    const op = mkVerify("a", { operator: "ZZ", vin: "1C6JJTAG6KL000001", notes: "n" }, {
      clientVerifiedAt: "2026-05-18T09:00:00.000Z",
    });
    await replayOutbox([op], { fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({
      entryId: "a",
      operator: "ZZ",
      vin: "1C6JJTAG6KL000001",
      notes: "n",
      clientVerifiedAt: "2026-05-18T09:00:00.000Z",
    });
  });

  it("DELETEs clear ops against the per-entryId URL", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push({ url, method: opts?.method });
      return jsonResponse(200, { ok: true });
    });
    const cleared = [];
    const result = await replayOutbox([mkClear("xc2268_rfhub_vin_patch")], {
      fetchImpl,
      onApplyClear: (entryId) => cleared.push(entryId),
    });
    expect(calls[0].url).toBe("/api/task634-verifications/xc2268_rfhub_vin_patch");
    expect(calls[0].method).toBe("DELETE");
    expect(cleared).toEqual(["xc2268_rfhub_vin_patch"]);
    expect(result.drained).toBe(1);
  });

  it("treats a 404 on clear as success (already gone)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, {}));
    const cleared = [];
    const result = await replayOutbox([mkClear("a")], {
      fetchImpl,
      onApplyClear: (entryId) => cleared.push(entryId),
    });
    expect(result.drained).toBe(1);
    expect(result.remaining).toEqual([]);
    expect(cleared).toEqual(["a"]);
  });

  it("stops draining on a network error and leaves the failing op at the head with lastError", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (_url, opts) => {
      n += 1;
      if (n === 1) {
        const body = JSON.parse(opts.body);
        return jsonResponse(200, { ok: true, verification: { entryId: body.entryId } });
      }
      throw new Error("ECONNREFUSED");
    });
    const q = [
      mkVerify("a", {}, { queuedAt: "1" }),
      mkVerify("b", {}, { queuedAt: "2" }),
      mkVerify("c", {}, { queuedAt: "3" }),
    ];
    const result = await replayOutbox(q, { fetchImpl });
    expect(result.drained).toBe(1);
    expect(result.remaining).toHaveLength(2);
    expect(result.remaining[0].entryId).toBe("b");
    expect(result.remaining[0].lastError).toMatch(/ECONNREFUSED/);
    // The third op was never even attempted.
    expect(result.remaining[1].entryId).toBe("c");
    expect(result.remaining[1].lastError).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops draining on a non-OK, non-409 HTTP response (e.g. 500) and records lastError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "boom" }));
    const q = [mkVerify("a"), mkVerify("b", {}, { queuedAt: "2" })];
    const result = await replayOutbox(q, { fetchImpl });
    expect(result.drained).toBe(0);
    expect(result.remaining).toHaveLength(2);
    expect(result.remaining[0].lastError).toMatch(/HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("captures a 409 conflict, drops the conflicting op, and continues draining following ops", async () => {
    const conflictBody = {
      error: "conflict",
      conflict: {
        clientVerifiedAt: "2026-05-18T10:00:00.000Z",
        server: {
          entryId: "a",
          operator: "OTHER_TECH",
          vin: null,
          notes: null,
          verifiedAt: "2026-05-18T10:30:00.000Z",
        },
      },
    };
    let call = 0;
    const fetchImpl = vi.fn(async (_url, opts) => {
      call += 1;
      if (call === 1) return jsonResponse(409, conflictBody);
      const body = JSON.parse(opts.body);
      return jsonResponse(200, { ok: true, verification: { entryId: body.entryId } });
    });
    const applied = [];
    const result = await replayOutbox([mkVerify("a"), mkVerify("b", {}, { queuedAt: "2" })], {
      fetchImpl,
      onApplyVerification: (entryId) => applied.push(entryId),
    });
    expect(result.drained).toBe(2);
    expect(result.remaining).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      entryId: "a",
      clientVerifiedAt: "2026-05-18T10:00:00.000Z",
      server: { operator: "OTHER_TECH", verifiedAt: "2026-05-18T10:30:00.000Z" },
    });
    // The conflicting op is NOT applied locally — only the successful follow-up is.
    expect(applied).toEqual(["b"]);
  });

  it("survives a 409 response with a missing/malformed body (no crash, op still dropped)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => { throw new Error("no body"); },
    }));
    const result = await replayOutbox([mkVerify("a")], { fetchImpl });
    expect(result.drained).toBe(1);
    expect(result.remaining).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("drops unknown op kinds silently instead of jamming the queue", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const weird = { id: "x", kind: "scuttle", entryId: "a", clientVerifiedAt: "t", queuedAt: "t" };
    const result = await replayOutbox([weird, mkVerify("b")], { fetchImpl });
    expect(result.drained).toBe(2);
    expect(result.remaining).toEqual([]);
    // Only the verify op should have hit fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("auto-flush on the browser `online` event", () => {
  // Lightweight jsdom shim — we only need addEventListener + dispatchEvent.
  // This pins the contract UnlockCoverageTab relies on: the same handler
  // that drains the outbox is wired to `window.addEventListener("online")`
  // and removed on cleanup.
  let target;
  beforeEach(() => {
    target = new EventTarget();
  });
  afterEach(() => { target = null; });

  it("invokes the registered handler when an 'online' event fires", async () => {
    const handler = vi.fn(async () => {});
    target.addEventListener("online", handler);
    target.dispatchEvent(new Event("online"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("drains a queued op via replayOutbox when the 'online' handler runs", async () => {
    const fetchImpl = vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      return jsonResponse(200, { ok: true, verification: { entryId: body.entryId } });
    });
    let queue = [mkVerify("a")];
    const handler = vi.fn(async () => {
      const { remaining } = await replayOutbox(queue, { fetchImpl });
      queue = remaining;
    });
    target.addEventListener("online", handler);
    target.dispatchEvent(new Event("online"));
    // Let the async handler resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/task634-verifications",
      expect.objectContaining({ method: "POST" }),
    );
    expect(queue).toEqual([]);
  });

  it("does not re-fire after the handler is removed", () => {
    const handler = vi.fn();
    target.addEventListener("online", handler);
    target.removeEventListener("online", handler);
    target.dispatchEvent(new Event("online"));
    expect(handler).not.toHaveBeenCalled();
  });
});
