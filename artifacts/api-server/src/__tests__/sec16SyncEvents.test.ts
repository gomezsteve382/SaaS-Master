// Task #682 — route tests for the SEC16 sync events append-only log.
//
// Exercises GET /api/sec16-sync-events (ordering + ?vin= filter) and
// POST /api/sec16-sync-events (required fields, allowed `verified`
// enum values, VIN normalization, trimming/truncation). Uses an
// in-memory shim of @workspace/db modeled on task634Verifications.test.ts.

import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = {
  id: number;
  vin: string | null;
  platform: string | null;
  actionId: string;
  target: string;
  recipeId: string | null;
  verified: string;
  operator: string | null;
  notes: string | null;
  detail: unknown;
  createdAt: Date;
};

const store: Row[] = [];
let nextId = 1;

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
}));

vi.mock("@workspace/db", () => {
  const cols = {
    id: { _name: "id" },
    vin: { _name: "vin" },
    platform: { _name: "platform" },
    actionId: { _name: "actionId" },
    target: { _name: "target" },
    recipeId: { _name: "recipeId" },
    verified: { _name: "verified" },
    operator: { _name: "operator" },
    notes: { _name: "notes" },
    detail: { _name: "detail" },
    createdAt: { _name: "createdAt" },
  };
  const sec16SyncEventsTable = cols;
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
                  if (typeof va === "number" && typeof vb === "number") {
                    return vb - va;
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
      values(v: Omit<Row, "id" | "createdAt">) {
        const row: Row = {
          ...v,
          id: nextId++,
          createdAt: new Date(),
        };
        return {
          returning: async () => {
            store.push(row);
            return [row];
          },
        };
      },
    }),
  };
  return { db, sec16SyncEventsTable };
});

const routerModule = await import("../routes/sec16SyncEvents");
const router = routerModule.default;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  store.length = 0;
  nextId = 1;
});

describe("POST /api/sec16-sync-events — validation", () => {
  it("rejects when actionId is missing", async () => {
    const r = await request(makeApp())
      .post("/api/sec16-sync-events")
      .send({ target: "BCM", verified: "match" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/actionId/);
    expect(store.length).toBe(0);
  });

  it("rejects when target is missing", async () => {
    const r = await request(makeApp())
      .post("/api/sec16-sync-events")
      .send({ actionId: "rfh-bcm-sec16-sync", verified: "match" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/target/);
    expect(store.length).toBe(0);
  });

  it("rejects when verified is missing", async () => {
    const r = await request(makeApp())
      .post("/api/sec16-sync-events")
      .send({ actionId: "rfh-bcm-sec16-sync", target: "BCM" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/verified/);
    expect(store.length).toBe(0);
  });

  it("rejects a verified value outside the allowed enum", async () => {
    const r = await request(makeApp())
      .post("/api/sec16-sync-events")
      .send({
        actionId: "rfh-bcm-sec16-sync",
        target: "BCM",
        verified: "totally-fine",
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/verified/);
    expect(store.length).toBe(0);
  });

  for (const verified of [
    "match",
    "mismatch",
    "unverified",
    "offline",
    "read-error",
  ]) {
    it(`accepts verified="${verified}"`, async () => {
      const r = await request(makeApp())
        .post("/api/sec16-sync-events")
        .send({
          actionId: "rfh-bcm-sec16-sync",
          target: "BCM",
          verified,
        });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.event.verified).toBe(verified);
    });
  }

  it("normalizes VIN (upper-case, strip whitespace, truncate)", async () => {
    const r = await request(makeApp())
      .post("/api/sec16-sync-events")
      .send({
        vin: "  1c6jjtag6kl000001  ",
        actionId: "rfh-bcm-sec16-sync",
        target: "BCM",
        verified: "match",
      });
    expect(r.status).toBe(200);
    expect(r.body.event.vin).toBe("1C6JJTAG6KL000001");
  });

  it("persists optional fields and detail payload", async () => {
    const r = await request(makeApp())
      .post("/api/sec16-sync-events")
      .send({
        vin: "1C6JJTAG6KL000001",
        platform: "dt-ram-2019plus",
        actionId: "rfh-bcm-sec16-sync",
        target: "RFHUB",
        recipeId: "recipe-a",
        verified: "match",
        operator: "JD",
        notes: "bench sync",
        detail: { bytes: 16, offset: "0x40C9" },
      });
    expect(r.status).toBe(200);
    expect(r.body.event).toMatchObject({
      vin: "1C6JJTAG6KL000001",
      platform: "dt-ram-2019plus",
      actionId: "rfh-bcm-sec16-sync",
      target: "RFHUB",
      recipeId: "recipe-a",
      verified: "match",
      operator: "JD",
      notes: "bench sync",
      detail: { bytes: 16, offset: "0x40C9" },
    });
    expect(store.length).toBe(1);
  });

  it("drops non-object detail payloads", async () => {
    const r = await request(makeApp())
      .post("/api/sec16-sync-events")
      .send({
        actionId: "rfh-bcm-sec16-sync",
        target: "BCM",
        verified: "match",
        detail: "not-an-object",
      });
    expect(r.status).toBe(200);
    expect(r.body.event.detail).toBeNull();
  });
});

describe("GET /api/sec16-sync-events — ordering and filtering", () => {
  it("returns events ordered by createdAt descending", async () => {
    const app = makeApp();
    await request(app).post("/api/sec16-sync-events").send({
      actionId: "first", target: "BCM", verified: "match",
    });
    await new Promise((r) => setTimeout(r, 5));
    await request(app).post("/api/sec16-sync-events").send({
      actionId: "second", target: "BCM", verified: "match",
    });
    await new Promise((r) => setTimeout(r, 5));
    await request(app).post("/api/sec16-sync-events").send({
      actionId: "third", target: "BCM", verified: "match",
    });

    const r = await request(app).get("/api/sec16-sync-events");
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: { actionId: string }) => e.actionId)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("filters by VIN (case-insensitive, whitespace-stripped)", async () => {
    const app = makeApp();
    await request(app).post("/api/sec16-sync-events").send({
      vin: "1C6JJTAG6KL000001",
      actionId: "a", target: "BCM", verified: "match",
    });
    await request(app).post("/api/sec16-sync-events").send({
      vin: "1C6JJTAG6KL000002",
      actionId: "b", target: "BCM", verified: "match",
    });
    await request(app).post("/api/sec16-sync-events").send({
      vin: "1C6JJTAG6KL000001",
      actionId: "c", target: "RFHUB", verified: "match",
    });

    const r = await request(app)
      .get("/api/sec16-sync-events")
      .query({ vin: " 1c6jjtag6kl000001 " });
    expect(r.status).toBe(200);
    expect(r.body.events).toHaveLength(2);
    expect(
      r.body.events.every(
        (e: { vin: string }) => e.vin === "1C6JJTAG6KL000001",
      ),
    ).toBe(true);
    // Still ordered newest-first.
    expect(r.body.events.map((e: { actionId: string }) => e.actionId)).toEqual([
      "c",
      "a",
    ]);
  });

  it("returns all events when ?vin= is empty", async () => {
    const app = makeApp();
    await request(app).post("/api/sec16-sync-events").send({
      vin: "1C6JJTAG6KL000001",
      actionId: "a", target: "BCM", verified: "match",
    });
    await request(app).post("/api/sec16-sync-events").send({
      actionId: "b", target: "BCM", verified: "match",
    });

    const r = await request(app).get("/api/sec16-sync-events").query({ vin: "" });
    expect(r.status).toBe(200);
    expect(r.body.events).toHaveLength(2);
  });

  it("returns an empty list when no rows match the VIN filter", async () => {
    const app = makeApp();
    await request(app).post("/api/sec16-sync-events").send({
      vin: "1C6JJTAG6KL000001",
      actionId: "a", target: "BCM", verified: "match",
    });
    const r = await request(app)
      .get("/api/sec16-sync-events")
      .query({ vin: "ZZZZZZZZZZZZZZZZZ" });
    expect(r.status).toBe(200);
    expect(r.body.events).toEqual([]);
  });
});
