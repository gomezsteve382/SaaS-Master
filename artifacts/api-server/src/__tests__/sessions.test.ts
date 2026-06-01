// Task #1006 — route tests for the session paper-trail endpoint.
//
// Exercises GET /api/sessions (ordering + vin/jobId filters), POST /api/sessions
// (happy-path save + verbatim payload round-trip + id validation 400 +
// payload-too-large 413), and DELETE /api/sessions/:id. The route calls
// req.log.info, so makeApp injects a no-op logger. Uses an in-memory shim of
// @workspace/db modeled on keyHistory.test.ts.

import express, { type Express, type Request } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  vin: string | null;
  module: string | null;
  operation: string | null;
  success: boolean | null;
  oldVin: string | null;
  newVin: string | null;
  jobId: string | null;
  timestamp: Date;
  payload: unknown;
};

const store: Row[] = [];

type Eq = { kind: "eq"; column: string; value: unknown };
type Desc = { kind: "desc"; column: string };

function matches(row: Row, p: Eq): boolean {
  if (p.kind !== "eq") return false;
  const v = (row as unknown as Record<string, unknown>)[p.column];
  return v === p.value;
}

vi.mock("drizzle-orm", () => ({
  eq: (column: { _name: string }, value: unknown): Eq => ({
    kind: "eq",
    column: column._name,
    value,
  }),
  desc: (column: { _name: string }): Desc => ({
    kind: "desc",
    column: column._name,
  }),
  sql: (..._args: unknown[]) => ({ kind: "sql" }),
}));

vi.mock("@workspace/db", () => {
  const mk = (names: string[]) =>
    Object.fromEntries(names.map((n) => [n, { _name: n }]));
  const sessionLogTable = mk([
    "id",
    "vin",
    "module",
    "operation",
    "success",
    "oldVin",
    "newVin",
    "technician",
    "titleRef",
    "titleNotes",
    "adapter",
    "sgwRouted",
    "algorithm",
    "voltage",
    "preWriteConfirmed",
    "notes",
    "backupKey",
    "jobId",
    "timestamp",
    "payload",
  ]);
  const db = {
    select: () => ({
      from: (_t: unknown) => {
        const filters: Eq[] = [];
        let order: Desc | null = null;
        let _limit = Infinity;
        const builder: {
          where: (p: Eq) => typeof builder;
          orderBy: (o: Desc) => typeof builder;
          limit: (n: number) => typeof builder;
          then: (
            resolve: (rows: Row[]) => void,
            reject?: (e: unknown) => void,
          ) => void;
        } = {
          where(p) {
            filters.push(p);
            return builder;
          },
          orderBy(o) {
            order = o;
            return builder;
          },
          limit(n) {
            _limit = n;
            return builder;
          },
          then(resolve, reject) {
            try {
              let rows = store.filter((row) =>
                filters.every((f) => matches(row, f)),
              );
              if (order) {
                const col = order.column;
                rows = [...rows].sort((a, b) => {
                  const va = (a as unknown as Record<string, unknown>)[col];
                  const vb = (b as unknown as Record<string, unknown>)[col];
                  if (va instanceof Date && vb instanceof Date) {
                    return vb.getTime() - va.getTime();
                  }
                  return 0;
                });
              }
              resolve(rows.slice(0, _limit));
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
          onConflictDoUpdate({ set }: { target: unknown; set: Partial<Row> }) {
            const existing = store.find((r) => r.id === v.id);
            if (existing) {
              Object.assign(existing, set);
            } else {
              store.push({ ...v });
            }
            return Promise.resolve();
          },
        };
      },
    }),
    delete: (_t: unknown) => ({
      where(p: Eq) {
        for (let i = store.length - 1; i >= 0; i--) {
          if (matches(store[i]!, p)) store.splice(i, 1);
        }
        return Promise.resolve();
      },
    }),
    execute: (_q: unknown) => Promise.resolve(),
  };
  return { db, sessionLogTable };
});

const routerModule = await import("../routes/sessions");
const router = routerModule.default;

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req: Request, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    };
    next();
  });
  app.use("/api", router);
  return app;
}

const VIN_A = "1C6JJTAG6KL000001";
const VIN_B = "1C6JJTAG6KL000002";

function baseEntry(over: Record<string, unknown> = {}) {
  return {
    id: "sess-1",
    module: "BCM",
    operation: "VIN write",
    success: true,
    newVin: VIN_A,
    technician: "JD",
    timestamp: 1_700_000_000_000,
    jobId: "job-1",
    notes: "bench write",
    ...over,
  };
}

beforeEach(() => {
  store.length = 0;
});

describe("POST /api/sessions — validation", () => {
  it("rejects a missing id", async () => {
    const entry = baseEntry();
    delete (entry as Record<string, unknown>).id;
    const r = await request(makeApp()).post("/api/sessions").send(entry);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(store.length).toBe(0);
  });

  it("rejects an id with illegal characters", async () => {
    const r = await request(makeApp())
      .post("/api/sessions")
      .send(baseEntry({ id: "bad id!" }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(store.length).toBe(0);
  });

  it("rejects an oversized payload with 413", async () => {
    const r = await request(makeApp())
      .post("/api/sessions")
      .send(baseEntry({ notes: "x".repeat(70 * 1024) }));
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/large/i);
    expect(store.length).toBe(0);
  });
});

describe("POST /api/sessions — save round-trip", () => {
  it("saves a session and reads the verbatim record back", async () => {
    const app = makeApp();
    const created = await request(app).post("/api/sessions").send(baseEntry());
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ id: "sess-1", ok: true, synced: true });

    const list = await request(app).get("/api/sessions").query({ vin: VIN_A });
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0]).toMatchObject({
      id: "sess-1",
      module: "BCM",
      operation: "VIN write",
      success: true,
      newVin: VIN_A,
      technician: "JD",
      notes: "bench write",
      synced: true,
    });
  });

  it("strips the client-only synced flag before persisting", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/sessions")
      .send(baseEntry({ synced: false }));
    const list = await request(app).get("/api/sessions").query({ vin: VIN_A });
    // GET always pins synced:true (server-authoritative), regardless of input.
    expect(list.body.sessions[0].synced).toBe(true);
  });

  it("updates an existing session in place on conflicting id", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/sessions")
      .send(baseEntry({ operation: "first" }));
    await request(app)
      .post("/api/sessions")
      .send(baseEntry({ operation: "second" }));
    const list = await request(app).get("/api/sessions").query({ vin: VIN_A });
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0].operation).toBe("second");
  });
});

describe("GET /api/sessions — filtering and ordering", () => {
  it("filters by VIN", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/sessions")
      .send(baseEntry({ id: "a", newVin: VIN_A }));
    await request(app)
      .post("/api/sessions")
      .send(baseEntry({ id: "b", newVin: VIN_B }));
    const r = await request(app).get("/api/sessions").query({ vin: VIN_A });
    expect(r.body.sessions.map((s: { id: string }) => s.id)).toEqual(["a"]);
  });

  it("filters by jobId", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/sessions")
      .send(baseEntry({ id: "a", jobId: "job-1" }));
    await request(app)
      .post("/api/sessions")
      .send(baseEntry({ id: "b", jobId: "job-2" }));
    const r = await request(app).get("/api/sessions").query({ jobId: "job-2" });
    expect(r.body.sessions.map((s: { id: string }) => s.id)).toEqual(["b"]);
  });

  it("returns sessions newest-first by timestamp", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/sessions")
      .send(baseEntry({ id: "a", timestamp: 1_000 }));
    await request(app)
      .post("/api/sessions")
      .send(baseEntry({ id: "b", timestamp: 3_000 }));
    await request(app)
      .post("/api/sessions")
      .send(baseEntry({ id: "c", timestamp: 2_000 }));
    const r = await request(app).get("/api/sessions");
    expect(r.body.sessions.map((s: { id: string }) => s.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("deletes a single session by id", async () => {
    const app = makeApp();
    await request(app).post("/api/sessions").send(baseEntry({ id: "a" }));
    await request(app).post("/api/sessions").send(baseEntry({ id: "b" }));
    const del = await request(app).delete("/api/sessions/a");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    const list = await request(app).get("/api/sessions");
    expect(list.body.sessions.map((s: { id: string }) => s.id)).toEqual(["b"]);
  });

  it("rejects an invalid id on delete", async () => {
    const r = await request(makeApp()).delete(
      "/api/sessions/" + encodeURIComponent("bad id!"),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });
});
