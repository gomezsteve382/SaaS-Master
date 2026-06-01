// Task #1006 — route tests for the saved Key Prog ZIP archive endpoint.
//
// Exercises GET /api/key-prog-archives (ordering), POST /api/key-prog-archives
// (upsert happy-path round-trip + id validation 400 + payload-too-large 413),
// and DELETE /api/key-prog-archives/:id. Uses an in-memory shim of
// @workspace/db modeled on keyHistory.test.ts / sec16SyncEvents.test.ts.

import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  vin: string;
  zipName: string;
  savedAt: Date;
  bcmSec16: unknown;
};

const store: Row[] = [];

type Eq = { kind: "eq"; column: string; value: unknown };
type Desc = { kind: "desc"; column: string };

function matches(row: Row, p: Eq): boolean {
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
  const cols = {
    id: { _name: "id" },
    vin: { _name: "vin" },
    zipName: { _name: "zipName" },
    savedAt: { _name: "savedAt" },
    bcmSec16: { _name: "bcmSec16" },
  };
  const keyProgArchivesTable = cols;
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
    execute: (_q: unknown) => {
      store.length = 0;
      return Promise.resolve();
    },
  };
  return { db, keyProgArchivesTable };
});

const routerModule = await import("../routes/keyProgArchives");
const router = routerModule.default;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

const VIN = "1C6JJTAG6KL000001";

function baseEntry(over: Record<string, unknown> = {}) {
  return {
    id: "arc-1",
    vin: VIN,
    zipName: "keyprog-1C6JJTAG6KL000001.zip",
    savedAt: 1_700_000_000_000,
    bcmSec16: { hex: "00112233445566778899AABBCCDDEEFF" },
    ...over,
  };
}

beforeEach(() => {
  store.length = 0;
});

describe("POST /api/key-prog-archives — validation", () => {
  it("rejects a missing id", async () => {
    const entry = baseEntry();
    delete (entry as Record<string, unknown>).id;
    const r = await request(makeApp()).post("/api/key-prog-archives").send(entry);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(store.length).toBe(0);
  });

  it("rejects an id with illegal characters", async () => {
    const r = await request(makeApp())
      .post("/api/key-prog-archives")
      .send(baseEntry({ id: "bad id!" }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(store.length).toBe(0);
  });

  it("rejects an oversized bcmSec16 payload with 413", async () => {
    const r = await request(makeApp())
      .post("/api/key-prog-archives")
      .send(baseEntry({ bcmSec16: { blob: "x".repeat(20 * 1024) } }));
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/large/i);
    expect(store.length).toBe(0);
  });
});

describe("POST /api/key-prog-archives — upsert round-trip", () => {
  it("saves an archive and reads it back via GET", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/api/key-prog-archives")
      .send(baseEntry());
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ id: "arc-1", ok: true });

    const list = await request(app).get("/api/key-prog-archives");
    expect(list.status).toBe(200);
    expect(list.body.archives).toHaveLength(1);
    expect(list.body.archives[0]).toMatchObject({
      id: "arc-1",
      vin: VIN,
      zipName: "keyprog-1C6JJTAG6KL000001.zip",
      bcmSec16: { hex: "00112233445566778899AABBCCDDEEFF" },
    });
    expect(list.body.archives[0].savedAt).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });

  it("updates an existing row in place on conflicting id", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/key-prog-archives")
      .send(baseEntry({ zipName: "first.zip" }));
    await request(app)
      .post("/api/key-prog-archives")
      .send(baseEntry({ zipName: "second.zip" }));

    const list = await request(app).get("/api/key-prog-archives");
    expect(list.body.archives).toHaveLength(1);
    expect(list.body.archives[0].zipName).toBe("second.zip");
  });
});

describe("GET /api/key-prog-archives — ordering", () => {
  it("returns archives newest-first by savedAt", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/key-prog-archives")
      .send(baseEntry({ id: "a", savedAt: 1_000 }));
    await request(app)
      .post("/api/key-prog-archives")
      .send(baseEntry({ id: "b", savedAt: 3_000 }));
    await request(app)
      .post("/api/key-prog-archives")
      .send(baseEntry({ id: "c", savedAt: 2_000 }));

    const r = await request(app).get("/api/key-prog-archives");
    expect(r.body.archives.map((a: { id: string }) => a.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});

describe("DELETE /api/key-prog-archives/:id", () => {
  it("deletes a single archive by id", async () => {
    const app = makeApp();
    await request(app).post("/api/key-prog-archives").send(baseEntry({ id: "a" }));
    await request(app).post("/api/key-prog-archives").send(baseEntry({ id: "b" }));

    const del = await request(app).delete("/api/key-prog-archives/a");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list = await request(app).get("/api/key-prog-archives");
    expect(list.body.archives.map((a: { id: string }) => a.id)).toEqual(["b"]);
  });

  it("rejects an invalid id on delete", async () => {
    const r = await request(makeApp()).delete(
      "/api/key-prog-archives/" + encodeURIComponent("bad id!"),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });
});
