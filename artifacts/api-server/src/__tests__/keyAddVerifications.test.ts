// Route tests for the bench-verified offline key-add endpoint.
//
// Exercises GET /api/key-add-verifications (layout filter, ordering), POST
// (upsert + validation 400s), DELETE /api/key-add-verifications/:id, and DELETE
// /api/key-add-verifications (layout scope + delete-all). Also pins the
// confirmedAt epoch-ms round-trip. Uses an in-memory shim of @workspace/db
// modeled on keyHistory.test.ts.

import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  layout: string;
  addedKeyId: string;
  slot: number | null;
  slotIdx: number | null;
  expectedSlotIdx: number | null;
  beforeKeyCount: number | null;
  afterKeyCount: number | null;
  beforeName: string;
  afterName: string;
  confirmedAt: Date;
  createdAt: Date;
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
    layout: { _name: "layout" },
    addedKeyId: { _name: "addedKeyId" },
    slot: { _name: "slot" },
    slotIdx: { _name: "slotIdx" },
    expectedSlotIdx: { _name: "expectedSlotIdx" },
    beforeKeyCount: { _name: "beforeKeyCount" },
    afterKeyCount: { _name: "afterKeyCount" },
    beforeName: { _name: "beforeName" },
    afterName: { _name: "afterName" },
    confirmedAt: { _name: "confirmedAt" },
    createdAt: { _name: "createdAt" },
  };
  const keyAddVerificationsTable = cols;
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
      values(v: Omit<Row, "createdAt">) {
        return {
          onConflictDoUpdate({ set }: { target: unknown; set: Partial<Row> }) {
            const existing = store.find((r) => r.id === v.id);
            if (existing) {
              Object.assign(existing, set);
            } else {
              store.push({ ...v, createdAt: new Date() });
            }
            return Promise.resolve();
          },
        };
      },
    }),
    delete: (_t: unknown) => ({
      where(p: Eq) {
        for (let i = store.length - 1; i >= 0; i--) {
          if (matches(store[i], p)) store.splice(i, 1);
        }
        return Promise.resolve();
      },
    }),
    execute: (_q: unknown) => {
      store.length = 0;
      return Promise.resolve();
    },
  };
  return { db, keyAddVerificationsTable };
});

const routerModule = await import("../routes/keyAddVerifications");
const router = routerModule.default;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

const LAYOUT = "char-mpc-8slot";
const LAYOUT_B = "other-layout";

function baseEntry(over: Record<string, unknown> = {}) {
  return {
    id: "kav-1",
    layout: LAYOUT,
    addedKeyId: "BCD2EB9B",
    slot: 5,
    slotIdx: 4,
    expectedSlotIdx: 4,
    beforeKeyCount: 5,
    afterKeyCount: 6,
    beforeName: "before.bin",
    afterName: "after.bin",
    confirmedAt: 1_700_000_000_000,
    ...over,
  };
}

beforeEach(() => {
  store.length = 0;
});

describe("POST /api/key-add-verifications — validation", () => {
  it("rejects a missing id", async () => {
    const entry = baseEntry();
    delete (entry as Record<string, unknown>).id;
    const r = await request(makeApp())
      .post("/api/key-add-verifications")
      .send(entry);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(store.length).toBe(0);
  });

  it("rejects an invalid layout", async () => {
    const r = await request(makeApp())
      .post("/api/key-add-verifications")
      .send(baseEntry({ layout: "bad layout!" }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/layout/i);
    expect(store.length).toBe(0);
  });
});

describe("POST /api/key-add-verifications — upsert", () => {
  it("inserts a new entry then updates it in place on conflicting id", async () => {
    const app = makeApp();

    const created = await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ addedKeyId: "AAAA1111" }));
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ id: "kav-1", ok: true });
    expect(store.length).toBe(1);

    const updated = await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ addedKeyId: "BBBB2222", slot: 6 }));
    expect(updated.status).toBe(200);
    expect(store.length).toBe(1);

    const list = await request(app)
      .get("/api/key-add-verifications")
      .query({ layout: LAYOUT });
    expect(list.body.entries).toHaveLength(1);
    expect(list.body.entries[0]).toMatchObject({
      id: "kav-1",
      addedKeyId: "BBBB2222",
      slot: 6,
    });
  });
});

describe("GET /api/key-add-verifications — filtering", () => {
  it("requires a valid layout query param", async () => {
    const r = await request(makeApp())
      .get("/api/key-add-verifications")
      .query({ layout: "" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/layout/i);
  });

  it("returns only entries for the requested layout, newest first", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ id: "a", layout: LAYOUT, confirmedAt: 1_000 }));
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ id: "b", layout: LAYOUT_B, confirmedAt: 2_000 }));
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ id: "c", layout: LAYOUT, confirmedAt: 3_000 }));

    const r = await request(app)
      .get("/api/key-add-verifications")
      .query({ layout: LAYOUT });
    expect(r.status).toBe(200);
    expect(r.body.entries.map((e: { id: string }) => e.id)).toEqual(["c", "a"]);
  });
});

describe("DELETE /api/key-add-verifications", () => {
  it("deletes a single entry by id", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ id: "a" }));
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ id: "b" }));

    const del = await request(app).delete("/api/key-add-verifications/a");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list = await request(app)
      .get("/api/key-add-verifications")
      .query({ layout: LAYOUT });
    expect(list.body.entries.map((e: { id: string }) => e.id)).toEqual(["b"]);
  });

  it("rejects an invalid id on delete", async () => {
    const r = await request(makeApp()).delete(
      "/api/key-add-verifications/" +
        encodeURIComponent("bad id with spaces!"),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("deletes every entry scoped to a layout", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ id: "a", layout: LAYOUT }));
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ id: "b", layout: LAYOUT }));
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ id: "c", layout: LAYOUT_B }));

    const del = await request(app)
      .delete("/api/key-add-verifications")
      .query({ layout: LAYOUT });
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    expect(
      (
        await request(app)
          .get("/api/key-add-verifications")
          .query({ layout: LAYOUT })
      ).body.entries,
    ).toHaveLength(0);
    expect(
      (
        await request(app)
          .get("/api/key-add-verifications")
          .query({ layout: LAYOUT_B })
      ).body.entries,
    ).toHaveLength(1);
  });

  it("deletes all entries when no layout scope is given", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ id: "a", layout: LAYOUT }));
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ id: "b", layout: LAYOUT_B }));

    const del = await request(app).delete("/api/key-add-verifications");
    expect(del.status).toBe(200);
    expect(store.length).toBe(0);
  });
});

describe("confirmedAt round-trip", () => {
  it("preserves confirmedAt as epoch milliseconds", async () => {
    const app = makeApp();
    const ms = 1_711_234_567_890;
    await request(app)
      .post("/api/key-add-verifications")
      .send(baseEntry({ confirmedAt: ms }));

    const list = await request(app)
      .get("/api/key-add-verifications")
      .query({ layout: LAYOUT });
    expect(list.body.entries[0].confirmedAt).toBe(ms);
    expect(typeof list.body.entries[0].confirmedAt).toBe("number");
  });
});
