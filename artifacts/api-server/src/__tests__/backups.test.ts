// Task #1006 — route tests for the module-backup snapshot endpoint.
//
// Exercises GET /api/backups (ordering + module filter), GET /api/backups/:id
// (full payload round-trip), POST /api/backups (happy-path save + id/payload
// validation 400s + payload-too-large 413), and DELETE /api/backups
// (single + all). The post-write pattern/KG extraction is fire-and-forget; we
// stub ../lib/patternExtractor so it never touches the shimmed db. Uses an
// in-memory shim of @workspace/db modeled on keyHistory.test.ts.

import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  module: string;
  vin: string;
  didCount: number;
  tx: number | null;
  rx: number | null;
  timestamp: Date;
  payload: unknown;
  checksum: string | null;
  snapshotKind: string | null;
  preWriteKey: string | null;
};

const store: Row[] = [];

type Eq = { kind: "eq"; column: string; value: unknown };
type Desc = { kind: "desc"; column: string };

function matches(row: Row, p: Eq): boolean {
  if (p.kind !== "eq") return false;
  const v = (row as unknown as Record<string, unknown>)[p.column];
  return v === p.value;
}

// Neutralize the fire-and-forget pattern/KG extraction so it never reaches the
// db shim or produces unhandled rejections during the test.
vi.mock("../lib/patternExtractor", () => ({
  extractFromAnalysis: () => ({ patterns: [], nodes: [], edges: [] }),
}));

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
  const moduleBackupsTable = mk([
    "id",
    "module",
    "vin",
    "didCount",
    "tx",
    "rx",
    "timestamp",
    "payload",
    "checksum",
    "snapshotKind",
    "preWriteKey",
  ]);
  // Referenced by the route's extraction side-effect import but never used
  // because patternExtractor is stubbed to return empty arrays.
  const patternLibraryTable = mk(["category", "signatureHash", "sourceAnalysisIds"]);
  const kgNodesTable = mk(["id", "nodeType", "label"]);
  const kgEdgesTable = mk(["fromNodeId", "toNodeId", "edgeType"]);

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
      where(p: Eq) {
        for (let i = store.length - 1; i >= 0; i--) {
          if (matches(store[i]!, p)) store.splice(i, 1);
        }
        return Promise.resolve();
      },
    }),
    execute: (_q: unknown) => {
      store.length = 0;
      return Promise.resolve();
    },
  };
  return {
    db,
    moduleBackupsTable,
    patternLibraryTable,
    kgNodesTable,
    kgEdgesTable,
  };
});

const routerModule = await import("../routes/backups");
const router = routerModule.default;

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", router);
  return app;
}

const VIN = "1C6JJTAG6KL000001";

function baseEntry(over: Record<string, unknown> = {}) {
  return {
    id: "bk-1",
    module: "BCM",
    vin: VIN,
    timestamp: 1_700_000_000_000,
    checksum: "DEADBEEF",
    snapshotKind: "pre-write",
    preWriteKey: "key-99",
    payload: {
      module: "BCM",
      dids: {
        F190: { bytes: [1, 2, 3] },
        F1A0: { bytes: [4, 5] },
      },
    },
    ...over,
  };
}

beforeEach(() => {
  store.length = 0;
});

describe("POST /api/backups — validation", () => {
  it("rejects a missing id/key", async () => {
    const entry = baseEntry();
    delete (entry as Record<string, unknown>).id;
    const r = await request(makeApp()).post("/api/backups").send(entry);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(store.length).toBe(0);
  });

  it("rejects an id with illegal characters", async () => {
    const r = await request(makeApp())
      .post("/api/backups")
      .send(baseEntry({ id: "bad id!" }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(store.length).toBe(0);
  });

  it("rejects a missing payload", async () => {
    const r = await request(makeApp())
      .post("/api/backups")
      .send({ id: "bk-1", module: "BCM" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/payload/i);
    expect(store.length).toBe(0);
  });

  it("rejects an oversized payload with 413", async () => {
    const r = await request(makeApp())
      .post("/api/backups")
      .send(baseEntry({ payload: { blob: "x".repeat(600 * 1024) } }));
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/large/i);
    expect(store.length).toBe(0);
  });
});

describe("POST /api/backups — save round-trip", () => {
  it("saves a backup and reads its summary back via GET", async () => {
    const app = makeApp();
    const created = await request(app).post("/api/backups").send(baseEntry());
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ id: "bk-1", key: "bk-1", ok: true });

    const list = await request(app).get("/api/backups");
    expect(list.status).toBe(200);
    expect(list.body.backups).toHaveLength(1);
    expect(list.body.backups[0]).toMatchObject({
      id: "bk-1",
      module: "BCM",
      vin: VIN,
      didCount: 2,
      checksum: "DEADBEEF",
      snapshotKind: "pre-write",
      preWriteKey: "key-99",
    });
  });

  it("accepts `key` as an id alias", async () => {
    const app = makeApp();
    const entry = baseEntry();
    delete (entry as Record<string, unknown>).id;
    (entry as Record<string, unknown>).key = "bk-key-1";
    const r = await request(app).post("/api/backups").send(entry);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("bk-key-1");
  });

  it("returns the full payload via GET /:id", async () => {
    const app = makeApp();
    await request(app).post("/api/backups").send(baseEntry());
    const r = await request(app).get("/api/backups/bk-1");
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("bk-1");
    expect(r.body.payload).toMatchObject({ module: "BCM" });
  });

  it("updates an existing backup in place on conflicting id", async () => {
    const app = makeApp();
    await request(app).post("/api/backups").send(baseEntry({ checksum: "AAA" }));
    await request(app).post("/api/backups").send(baseEntry({ checksum: "BBB" }));
    const list = await request(app).get("/api/backups");
    expect(list.body.backups).toHaveLength(1);
    expect(list.body.backups[0].checksum).toBe("BBB");
  });
});

describe("GET /api/backups — filtering and ordering", () => {
  it("filters by module", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/backups")
      .send(baseEntry({ id: "a", module: "BCM" }));
    await request(app)
      .post("/api/backups")
      .send(baseEntry({ id: "b", module: "RFHUB" }));
    const r = await request(app).get("/api/backups").query({ module: "RFHUB" });
    expect(r.status).toBe(200);
    expect(r.body.backups.map((x: { id: string }) => x.id)).toEqual(["b"]);
  });

  it("returns backups newest-first by timestamp", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/backups")
      .send(baseEntry({ id: "a", timestamp: 1_000 }));
    await request(app)
      .post("/api/backups")
      .send(baseEntry({ id: "b", timestamp: 3_000 }));
    await request(app)
      .post("/api/backups")
      .send(baseEntry({ id: "c", timestamp: 2_000 }));
    const r = await request(app).get("/api/backups");
    expect(r.body.backups.map((x: { id: string }) => x.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});

describe("GET /api/backups/:id — validation", () => {
  it("rejects an invalid id", async () => {
    const r = await request(makeApp()).get(
      "/api/backups/" + encodeURIComponent("bad id!"),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("returns 404 for an unknown id", async () => {
    const r = await request(makeApp()).get("/api/backups/nope");
    expect(r.status).toBe(404);
  });
});

describe("DELETE /api/backups", () => {
  it("deletes a single backup by id", async () => {
    const app = makeApp();
    await request(app).post("/api/backups").send(baseEntry({ id: "a" }));
    await request(app).post("/api/backups").send(baseEntry({ id: "b" }));
    const del = await request(app).delete("/api/backups/a");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    const list = await request(app).get("/api/backups");
    expect(list.body.backups.map((x: { id: string }) => x.id)).toEqual(["b"]);
  });

  it("rejects an invalid id on delete", async () => {
    const r = await request(makeApp()).delete(
      "/api/backups/" + encodeURIComponent("bad id!"),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("deletes every backup when no id scope is given", async () => {
    const app = makeApp();
    await request(app).post("/api/backups").send(baseEntry({ id: "a" }));
    await request(app).post("/api/backups").send(baseEntry({ id: "b" }));
    const del = await request(app).delete("/api/backups");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    const list = await request(app).get("/api/backups");
    expect(list.body.backups).toHaveLength(0);
  });
});
