// Task #1001 — route tests for the cross-device key history endpoint.
//
// Exercises GET /api/key-history (VIN filter, ordering), POST /api/key-history
// (upsert + validation 400s), DELETE /api/key-history/:id, and DELETE
// /api/key-history (VIN scope + delete-all). Also pins the capturedAt
// epoch-ms round-trip. Uses an in-memory shim of @workspace/db modeled on
// sec16SyncEvents.test.ts / task634Verifications.test.ts.

import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: string;
  vin: string;
  chipId: string;
  uidHex: string;
  skHex: string;
  flags: unknown;
  label: string;
  slotIdx: number | null;
  capturedAt: Date;
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
    vin: { _name: "vin" },
    chipId: { _name: "chipId" },
    uidHex: { _name: "uidHex" },
    skHex: { _name: "skHex" },
    flags: { _name: "flags" },
    label: { _name: "label" },
    slotIdx: { _name: "slotIdx" },
    capturedAt: { _name: "capturedAt" },
    createdAt: { _name: "createdAt" },
  };
  const keyHistoryTable = cols;
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
  return { db, keyHistoryTable };
});

const routerModule = await import("../routes/keyHistory");
const router = routerModule.default;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

const VIN_A = "1C6JJTAG6KL000001";
const VIN_B = "1C6JJTAG6KL000002";

function baseEntry(over: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    vin: VIN_A,
    chipId: "PCF7953",
    uidHex: "AABBCCDD",
    skHex: "00112233445566778899AABBCCDDEEFF",
    label: "blade key",
    slotIdx: 0,
    capturedAt: 1_700_000_000_000,
    ...over,
  };
}

beforeEach(() => {
  store.length = 0;
});

describe("POST /api/key-history — validation", () => {
  it("rejects an invalid/short VIN", async () => {
    const r = await request(makeApp())
      .post("/api/key-history")
      .send(baseEntry({ vin: "SHORTVIN" }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/vin/i);
    expect(store.length).toBe(0);
  });

  it("rejects a missing id", async () => {
    const entry = baseEntry();
    delete (entry as Record<string, unknown>).id;
    const r = await request(makeApp()).post("/api/key-history").send(entry);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(store.length).toBe(0);
  });

  it("rejects a missing chipId", async () => {
    const entry = baseEntry();
    delete (entry as Record<string, unknown>).chipId;
    const r = await request(makeApp()).post("/api/key-history").send(entry);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/chipId/i);
    expect(store.length).toBe(0);
  });
});

describe("POST /api/key-history — upsert", () => {
  it("inserts a new entry then updates it in place on conflicting id", async () => {
    const app = makeApp();

    const created = await request(app)
      .post("/api/key-history")
      .send(baseEntry({ label: "first" }));
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ id: "key-1", ok: true });
    expect(store.length).toBe(1);

    const updated = await request(app)
      .post("/api/key-history")
      .send(baseEntry({ label: "second", chipId: "HITAG2" }));
    expect(updated.status).toBe(200);
    expect(store.length).toBe(1);

    const list = await request(app).get("/api/key-history").query({ vin: VIN_A });
    expect(list.body.entries).toHaveLength(1);
    expect(list.body.entries[0]).toMatchObject({
      id: "key-1",
      label: "second",
      chipId: "HITAG2",
    });
  });

  it("normalizes a lower-case / whitespaced VIN on write", async () => {
    const app = makeApp();
    const r = await request(app)
      .post("/api/key-history")
      .send(baseEntry({ vin: "  1c6jjtag6kl000001  " }));
    expect(r.status).toBe(200);
    const list = await request(app).get("/api/key-history").query({ vin: VIN_A });
    expect(list.body.entries).toHaveLength(1);
    expect(list.body.entries[0].vin).toBe(VIN_A);
  });
});

describe("GET /api/key-history — filtering", () => {
  it("requires a valid vin query param", async () => {
    const r = await request(makeApp()).get("/api/key-history").query({ vin: "" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/vin/i);
  });

  it("returns only entries for the requested VIN, newest first", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/key-history")
      .send(baseEntry({ id: "a", vin: VIN_A, capturedAt: 1_000 }));
    await request(app)
      .post("/api/key-history")
      .send(baseEntry({ id: "b", vin: VIN_B, capturedAt: 2_000 }));
    await request(app)
      .post("/api/key-history")
      .send(baseEntry({ id: "c", vin: VIN_A, capturedAt: 3_000 }));

    const r = await request(app)
      .get("/api/key-history")
      .query({ vin: " 1c6jjtag6kl000001 " });
    expect(r.status).toBe(200);
    expect(r.body.entries.map((e: { id: string }) => e.id)).toEqual(["c", "a"]);
  });
});

describe("DELETE /api/key-history", () => {
  it("deletes a single entry by id", async () => {
    const app = makeApp();
    await request(app).post("/api/key-history").send(baseEntry({ id: "a" }));
    await request(app).post("/api/key-history").send(baseEntry({ id: "b" }));

    const del = await request(app).delete("/api/key-history/a");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list = await request(app).get("/api/key-history").query({ vin: VIN_A });
    expect(list.body.entries.map((e: { id: string }) => e.id)).toEqual(["b"]);
  });

  it("rejects an invalid id on delete", async () => {
    const r = await request(makeApp()).delete(
      "/api/key-history/" + encodeURIComponent("bad id with spaces!"),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("deletes every entry scoped to a VIN", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/key-history")
      .send(baseEntry({ id: "a", vin: VIN_A }));
    await request(app)
      .post("/api/key-history")
      .send(baseEntry({ id: "b", vin: VIN_A }));
    await request(app)
      .post("/api/key-history")
      .send(baseEntry({ id: "c", vin: VIN_B }));

    const del = await request(app)
      .delete("/api/key-history")
      .query({ vin: VIN_A });
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    expect(
      (await request(app).get("/api/key-history").query({ vin: VIN_A })).body
        .entries,
    ).toHaveLength(0);
    expect(
      (await request(app).get("/api/key-history").query({ vin: VIN_B })).body
        .entries,
    ).toHaveLength(1);
  });

  it("deletes all entries when no vin scope is given", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/key-history")
      .send(baseEntry({ id: "a", vin: VIN_A }));
    await request(app)
      .post("/api/key-history")
      .send(baseEntry({ id: "b", vin: VIN_B }));

    const del = await request(app).delete("/api/key-history");
    expect(del.status).toBe(200);
    expect(store.length).toBe(0);
  });
});

describe("capturedAt round-trip", () => {
  it("preserves capturedAt as epoch milliseconds", async () => {
    const app = makeApp();
    const ms = 1_711_234_567_890;
    await request(app)
      .post("/api/key-history")
      .send(baseEntry({ capturedAt: ms }));

    const list = await request(app).get("/api/key-history").query({ vin: VIN_A });
    expect(list.body.entries[0].capturedAt).toBe(ms);
    expect(typeof list.body.entries[0].capturedAt).toBe("number");
  });
});
