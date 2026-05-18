// Task #675 — server-side coverage for the optimistic-concurrency
// check in POST /api/task634-verifications.
//
// The UnlockCoverageTab offline outbox queues writes while the API is
// unreachable and replays them in order when the server comes back.
// Each replayed verify carries the operator-perceived `clientVerifiedAt`
// timestamp; if another bench has already verified the same entry with
// a strictly newer `verifiedAt`, the server must refuse the stale write
// with HTTP 409 and return the authoritative row so the UI can surface
// the conflict (see UnlockCoverageTab → outboxConflicts banner).
//
// This suite exercises that contract end-to-end through the express
// router with a minimal in-memory mock of @workspace/db.

import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock @workspace/db before importing the route. The drizzle chain the
// route uses (`db.select().from(t).where(...).limit(1)` and
// `db.insert(t).values(...).onConflictDoUpdate(...)`) is shimmed with
// an in-memory map keyed by entryId. Predicates are passed straight
// through to a small "executor" that interprets `eq()` / `and()` / `gt()`
// markers built by drizzle-orm.
type Row = {
  entryId: string;
  vin: string | null;
  notes: string | null;
  operator: string | null;
  verifiedAt: Date;
};

const store = new Map<string, Row>();

// Marker types so we can pretend to evaluate drizzle predicates.
type Eq = { kind: "eq"; column: string; value: unknown };
type Gt = { kind: "gt"; column: string; value: Date };
type And = { kind: "and"; parts: Array<Eq | Gt | And> };

function matches(row: Row, p: Eq | Gt | And): boolean {
  if (p.kind === "and") return p.parts.every((pp) => matches(row, pp));
  const v = (row as unknown as Record<string, unknown>)[p.column];
  if (p.kind === "eq") return v === p.value;
  if (p.kind === "gt") return v instanceof Date && v.getTime() > p.value.getTime();
  return false;
}

vi.mock("drizzle-orm", () => ({
  eq: (column: { _name: string }, value: unknown): Eq => ({
    kind: "eq",
    column: column._name,
    value,
  }),
  gt: (column: { _name: string }, value: Date): Gt => ({
    kind: "gt",
    column: column._name,
    value,
  }),
  and: (...parts: Array<Eq | Gt | And>): And => ({ kind: "and", parts }),
  desc: (_column: unknown) => ({ kind: "desc" }),
}));

vi.mock("@workspace/db", () => {
  const cols = {
    entryId: { _name: "entryId" },
    verifiedAt: { _name: "verifiedAt" },
    vin: { _name: "vin" },
    notes: { _name: "notes" },
    operator: { _name: "operator" },
  };
  const task634VerificationsTable = cols;
  const db = {
    select: () => ({
      from: (_t: unknown) => {
        const filters: Array<Eq | Gt | And> = [];
        let _limit = Infinity;
        const builder = {
          where(pred: Eq | Gt | And) {
            filters.push(pred);
            return builder;
          },
          limit(n: number) {
            _limit = n;
            return builder;
          },
          orderBy(_o: unknown) {
            return builder;
          },
          then(resolve: (rows: Row[]) => void, reject?: (e: unknown) => void) {
            try {
              const all = Array.from(store.values()).filter((row) =>
                filters.every((f) => matches(row, f)),
              );
              resolve(all.slice(0, _limit));
            } catch (e) {
              reject?.(e);
            }
          },
        };
        return builder;
      },
    }),
    insert: (_t: unknown) => ({
      values(v: Row) {
        return {
          async onConflictDoUpdate(opts: { set: Partial<Row> }) {
            const existing = store.get(v.entryId);
            if (existing) {
              store.set(v.entryId, { ...existing, ...opts.set, entryId: v.entryId });
            } else {
              store.set(v.entryId, { ...v });
            }
          },
        };
      },
    }),
    delete: (_t: unknown) => ({
      async where(pred: Eq | And) {
        for (const [k, row] of Array.from(store.entries())) {
          if (matches(row, pred)) store.delete(k);
        }
      },
    }),
  };
  return { db, task634VerificationsTable };
});

// Now import the router (after the mocks).
const routerModule = await import("../routes/task634Verifications");
const router = routerModule.default;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  store.clear();
});

describe("POST /api/task634-verifications — optimistic concurrency", () => {
  it("accepts a fresh write with no clientVerifiedAt", async () => {
    const app = makeApp();
    const r = await request(app)
      .post("/api/task634-verifications")
      .send({ entryId: "xc2268_rfhub_vin_patch", operator: "AB" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.verification.entryId).toBe("xc2268_rfhub_vin_patch");
    expect(store.size).toBe(1);
  });

  it("accepts a queued write whose clientVerifiedAt is >= the server's row", async () => {
    store.set("entry_a", {
      entryId: "entry_a",
      vin: null,
      notes: null,
      operator: "ORIGINAL",
      verifiedAt: new Date("2026-05-18T10:00:00.000Z"),
    });
    const app = makeApp();
    const r = await request(app)
      .post("/api/task634-verifications")
      .send({
        entryId: "entry_a",
        operator: "REPLAYED",
        // Queued AFTER the server row — no conflict.
        clientVerifiedAt: "2026-05-18T10:30:00.000Z",
      });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // Upsert should have overwritten the operator.
    expect(store.get("entry_a")?.operator).toBe("REPLAYED");
  });

  it("returns 409 with the server row when clientVerifiedAt is older than the stored verifiedAt", async () => {
    const serverVerifiedAt = new Date("2026-05-18T10:30:00.000Z");
    store.set("entry_a", {
      entryId: "entry_a",
      vin: "1C6JJTAG6KL000001",
      notes: "verified at the bench",
      operator: "OTHER_TECH",
      verifiedAt: serverVerifiedAt,
    });
    const app = makeApp();
    const r = await request(app)
      .post("/api/task634-verifications")
      .send({
        entryId: "entry_a",
        operator: "STALE_REPLAY",
        // Queued BEFORE the other bench's write landed.
        clientVerifiedAt: "2026-05-18T10:00:00.000Z",
      });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("conflict");
    expect(r.body.conflict.clientVerifiedAt).toBe("2026-05-18T10:00:00.000Z");
    expect(r.body.conflict.server.entryId).toBe("entry_a");
    expect(r.body.conflict.server.operator).toBe("OTHER_TECH");
    expect(r.body.conflict.server.vin).toBe("1C6JJTAG6KL000001");
    expect(r.body.conflict.server.verifiedAt).toBe(serverVerifiedAt.toISOString());
    // The stale write must NOT have clobbered the row.
    expect(store.get("entry_a")?.operator).toBe("OTHER_TECH");
  });

  it("rejects a malformed clientVerifiedAt with 400 (so the outbox doesn't loop forever)", async () => {
    const app = makeApp();
    const r = await request(app)
      .post("/api/task634-verifications")
      .send({ entryId: "entry_a", clientVerifiedAt: "not-a-real-date" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/clientVerifiedAt/);
    expect(store.size).toBe(0);
  });

  it("rejects an invalid entryId with 400", async () => {
    const app = makeApp();
    const r = await request(app)
      .post("/api/task634-verifications")
      .send({ entryId: "Has Spaces & Caps!" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid entryId");
  });

  it("treats an equal clientVerifiedAt as non-conflicting (only strictly-newer server rows block)", async () => {
    const ts = "2026-05-18T10:00:00.000Z";
    store.set("entry_a", {
      entryId: "entry_a",
      vin: null,
      notes: null,
      operator: "ORIGINAL",
      verifiedAt: new Date(ts),
    });
    const app = makeApp();
    const r = await request(app)
      .post("/api/task634-verifications")
      .send({ entryId: "entry_a", operator: "REPLAYED", clientVerifiedAt: ts });
    expect(r.status).toBe(200);
    expect(store.get("entry_a")?.operator).toBe("REPLAYED");
  });
});
