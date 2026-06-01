// Task #1006 — route tests for the saved diff-reports endpoint.
//
// Exercises GET /api/diff-reports (ordering + summary projection),
// GET /api/diff-reports/:id (full payload round-trip), GET /api/diff-reports/stats,
// POST /api/diff-reports (happy-path save + id/payload validation 400s +
// payload-too-large 413), and DELETE /api/diff-reports (single + all).
//
// The drizzle `sql` mock captures the template text so db.execute can tell the
// /stats SELECT, the retention prune (OFFSET), and the DELETE-all apart. Uses an
// in-memory shim of @workspace/db modeled on keyHistory.test.ts.

import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  generatedAt: Date;
  baselineLabel: string;
  baselineTs: Date | null;
  baselineModuleCount: number;
  currentTs: Date | null;
  currentModuleCount: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  sameCount: number;
  payload: unknown;
};

const store: Row[] = [];

type Eq = { kind: "eq"; column: string; value: unknown };
type Desc = { kind: "desc"; column: string };
type Sql = { kind: "sql"; text: string };

function matches(row: Row, p: Eq | Sql): boolean {
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
  sql: (strings: TemplateStringsArray | unknown, ..._values: unknown[]): Sql => ({
    kind: "sql",
    text: Array.isArray(strings) ? strings.join(" ? ") : String(strings),
  }),
}));

vi.mock("@workspace/db", () => {
  const cols = {
    id: { _name: "id" },
    generatedAt: { _name: "generatedAt" },
    baselineLabel: { _name: "baselineLabel" },
    baselineTs: { _name: "baselineTs" },
    baselineModuleCount: { _name: "baselineModuleCount" },
    currentTs: { _name: "currentTs" },
    currentModuleCount: { _name: "currentModuleCount" },
    addedCount: { _name: "addedCount" },
    removedCount: { _name: "removedCount" },
    changedCount: { _name: "changedCount" },
    sameCount: { _name: "sameCount" },
    payload: { _name: "payload" },
  };
  const diffReportsTable = cols;
  const db = {
    select: (_proj?: unknown) => ({
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
      where(p: Eq | Sql) {
        // The retention prune deletes by a sql() age predicate; the test shim
        // only models the explicit eq() delete-by-id path and ignores prune.
        if (p.kind !== "eq") return Promise.resolve();
        for (let i = store.length - 1; i >= 0; i--) {
          if (matches(store[i]!, p)) store.splice(i, 1);
        }
        return Promise.resolve();
      },
    }),
    execute: (q: Sql) => {
      const text = (q?.text ?? "").toUpperCase();
      if (text.includes("SELECT")) {
        return Promise.resolve({
          rows: [{ report_count: store.length, total_bytes: 0 }],
        });
      }
      // The prune query carries an OFFSET; treat it as a no-op so saved rows
      // survive the fire-and-forget retention sweep. Only the unqualified
      // DELETE-all clears the store.
      if (text.includes("OFFSET")) return Promise.resolve({ rows: [] });
      if (text.includes("DELETE FROM")) {
        store.length = 0;
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { db, diffReportsTable };
});

const routerModule = await import("../routes/diffReports");
const router = routerModule.default;

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", router);
  return app;
}

function basePayload(over: Record<string, unknown> = {}) {
  return {
    baseline: { label: "stock", ts: 1_000, modules: [{ m: "BCM" }, { m: "RFHUB" }] },
    current: { ts: 2_000, modules: [{ m: "BCM" }, { m: "RFHUB" }, { m: "PCM" }] },
    diff: {
      added: [{ m: "PCM" }],
      removed: [],
      changed: [{ m: "BCM" }],
      same: [{ m: "RFHUB" }],
    },
    generatedAt: 3_000,
    ...over,
  };
}

function baseEntry(over: Record<string, unknown> = {}) {
  return {
    id: "diff-1",
    payload: basePayload(),
    ...over,
  };
}

beforeEach(() => {
  store.length = 0;
});

describe("POST /api/diff-reports — validation", () => {
  it("rejects a missing id", async () => {
    const r = await request(makeApp())
      .post("/api/diff-reports")
      .send({ payload: basePayload() });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(store.length).toBe(0);
  });

  it("rejects an id with illegal characters", async () => {
    const r = await request(makeApp())
      .post("/api/diff-reports")
      .send(baseEntry({ id: "bad id!" }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(store.length).toBe(0);
  });

  it("rejects a missing payload", async () => {
    const r = await request(makeApp())
      .post("/api/diff-reports")
      .send({ id: "diff-1" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/payload/i);
    expect(store.length).toBe(0);
  });

  it("rejects an oversized payload with 413", async () => {
    const r = await request(makeApp())
      .post("/api/diff-reports")
      .send(baseEntry({ payload: { blob: "x".repeat(3 * 1024 * 1024) } }));
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/large/i);
    expect(store.length).toBe(0);
  });
});

describe("POST /api/diff-reports — save round-trip", () => {
  it("derives summary counts from the payload and reads them back", async () => {
    const app = makeApp();
    const created = await request(app).post("/api/diff-reports").send(baseEntry());
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ id: "diff-1", ok: true });

    const list = await request(app).get("/api/diff-reports");
    expect(list.status).toBe(200);
    expect(list.body.reports).toHaveLength(1);
    expect(list.body.reports[0]).toMatchObject({
      id: "diff-1",
      baselineLabel: "stock",
      baselineModuleCount: 2,
      currentModuleCount: 3,
      addedCount: 1,
      removedCount: 0,
      changedCount: 1,
      sameCount: 1,
    });
    expect(list.body.reports[0].generatedAt).toBe(3_000);
  });

  it("returns the full payload via GET /:id", async () => {
    const app = makeApp();
    await request(app).post("/api/diff-reports").send(baseEntry());
    const r = await request(app).get("/api/diff-reports/diff-1");
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("diff-1");
    expect(r.body.payload).toMatchObject({ baseline: { label: "stock" } });
  });

  it("updates an existing report in place on conflicting id", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/diff-reports")
      .send(baseEntry({ baselineLabel: "first" }));
    await request(app)
      .post("/api/diff-reports")
      .send(baseEntry({ baselineLabel: "second" }));
    const list = await request(app).get("/api/diff-reports");
    expect(list.body.reports).toHaveLength(1);
    expect(list.body.reports[0].baselineLabel).toBe("second");
  });
});

describe("GET /api/diff-reports/:id — validation", () => {
  it("rejects an invalid id", async () => {
    const r = await request(makeApp()).get(
      "/api/diff-reports/" + encodeURIComponent("bad id!"),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("returns 404 for an unknown id", async () => {
    const r = await request(makeApp()).get("/api/diff-reports/nope");
    expect(r.status).toBe(404);
  });
});

describe("GET /api/diff-reports — ordering", () => {
  it("returns reports newest-first by generatedAt", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/diff-reports")
      .send(baseEntry({ id: "a", payload: basePayload({ generatedAt: 1_000 }) }));
    await request(app)
      .post("/api/diff-reports")
      .send(baseEntry({ id: "b", payload: basePayload({ generatedAt: 3_000 }) }));
    await request(app)
      .post("/api/diff-reports")
      .send(baseEntry({ id: "c", payload: basePayload({ generatedAt: 2_000 }) }));
    const r = await request(app).get("/api/diff-reports");
    expect(r.body.reports.map((x: { id: string }) => x.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});

describe("GET /api/diff-reports/stats", () => {
  it("reports the saved count", async () => {
    const app = makeApp();
    await request(app).post("/api/diff-reports").send(baseEntry({ id: "a" }));
    await request(app).post("/api/diff-reports").send(baseEntry({ id: "b" }));
    const r = await request(app).get("/api/diff-reports/stats");
    expect(r.status).toBe(200);
    expect(r.body.reportCount).toBe(2);
    expect(typeof r.body.capBytes).toBe("number");
  });
});

describe("DELETE /api/diff-reports", () => {
  it("deletes a single report by id", async () => {
    const app = makeApp();
    await request(app).post("/api/diff-reports").send(baseEntry({ id: "a" }));
    await request(app).post("/api/diff-reports").send(baseEntry({ id: "b" }));
    const del = await request(app).delete("/api/diff-reports/a");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    const list = await request(app).get("/api/diff-reports");
    expect(list.body.reports.map((x: { id: string }) => x.id)).toEqual(["b"]);
  });

  it("rejects an invalid id on delete", async () => {
    const r = await request(makeApp()).delete(
      "/api/diff-reports/" + encodeURIComponent("bad id!"),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("deletes every report when no id scope is given", async () => {
    const app = makeApp();
    await request(app).post("/api/diff-reports").send(baseEntry({ id: "a" }));
    await request(app).post("/api/diff-reports").send(baseEntry({ id: "b" }));
    const del = await request(app).delete("/api/diff-reports");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    const list = await request(app).get("/api/diff-reports");
    expect(list.body.reports).toHaveLength(0);
  });
});
