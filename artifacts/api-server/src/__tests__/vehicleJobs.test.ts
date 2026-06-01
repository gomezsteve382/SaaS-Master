// Task #1006 — route tests for the vehicle-jobs workflow endpoints.
//
// Exercises POST /api/vehicle-jobs (save round-trip + id/vin validation 400s +
// payload-too-large 413), GET /api/vehicle-jobs (vin/status/kind filters),
// GET /api/vehicle-jobs/:id (with events), PATCH /api/vehicle-jobs/:id,
// DELETE /api/vehicle-jobs/:id, and the /events append + list. The route calls
// req.log.info, so makeApp injects a no-op logger. Uses a two-table in-memory
// shim of @workspace/db modeled on keyHistory.test.ts.

import express, { type Express, type Request } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

type JobRow = {
  id: string;
  vin: string;
  kind: string;
  title: string | null;
  vehicle: unknown;
  status: string;
  census: unknown;
  fixPlan: unknown;
  signOff: unknown;
  owner: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type EventRow = {
  id: number;
  jobId: string;
  ts: Date;
  kind: string;
  module: string | null;
  payload: unknown;
};

const jobs: JobRow[] = [];
const events: EventRow[] = [];
let nextEventId = 1;

type Eq = { kind: "eq"; column: string; value: unknown };
type And = { kind: "and"; filters: Filter[] };
type Desc = { kind: "desc"; column: string };
type Filter = Eq | And;

function matches(row: Record<string, unknown>, p: Filter): boolean {
  if (p.kind === "and") return p.filters.every((f) => matches(row, f));
  return row[p.column] === p.value;
}

const JOBS = Symbol("jobs");
const EVENTS = Symbol("events");

function storeFor(t: unknown): Record<string, unknown>[] {
  if ((t as { _store?: symbol })._store === EVENTS)
    return events as unknown as Record<string, unknown>[];
  return jobs as unknown as Record<string, unknown>[];
}

vi.mock("drizzle-orm", () => ({
  eq: (column: { _name: string }, value: unknown): Eq => ({
    kind: "eq",
    column: column._name,
    value,
  }),
  and: (...filters: Filter[]): And => ({ kind: "and", filters }),
  desc: (column: { _name: string }): Desc => ({
    kind: "desc",
    column: column._name,
  }),
  sql: (..._args: unknown[]) => ({ kind: "sql" }),
}));

vi.mock("@workspace/db", () => {
  const mkTable = (store: symbol, names: string[]) => {
    const t: Record<string, unknown> = { _store: store };
    for (const n of names) t[n] = { _name: n };
    return t;
  };
  const vehicleJobsTable = mkTable(JOBS, [
    "id",
    "vin",
    "kind",
    "title",
    "vehicle",
    "status",
    "census",
    "fixPlan",
    "signOff",
    "owner",
    "createdAt",
    "updatedAt",
  ]);
  const vehicleJobEventsTable = mkTable(EVENTS, [
    "id",
    "jobId",
    "ts",
    "kind",
    "module",
    "payload",
  ]);

  function makeSelectBuilder(table: unknown) {
    const store = storeFor(table);
    const filters: Filter[] = [];
    let order: Desc | null = null;
    let _limit = Infinity;
    const builder: {
      where: (p: Filter) => typeof builder;
      orderBy: (o: Desc) => typeof builder;
      limit: (n: number) => typeof builder;
      then: (
        resolve: (rows: Record<string, unknown>[]) => void,
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
          let rows = store.filter((row) => filters.every((f) => matches(row, f)));
          if (order) {
            const col = order.column;
            rows = [...rows].sort((a, b) => {
              const va = a[col];
              const vb = b[col];
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
  }

  const db = {
    select: (_proj?: unknown) => ({
      from: (t: unknown) => makeSelectBuilder(t),
    }),
    insert: (t: unknown) => ({
      values(v: Record<string, unknown>) {
        const isEvents = (t as { _store?: symbol })._store === EVENTS;
        const finalize = () => {
          if (isEvents) {
            const row = { ...v, id: nextEventId++, ts: new Date() } as EventRow;
            events.push(row);
            return row as unknown as Record<string, unknown>;
          }
          const existing = jobs.find((r) => r.id === v.id);
          if (existing) {
            Object.assign(existing, v);
            return existing as unknown as Record<string, unknown>;
          }
          jobs.push({ ...(v as JobRow) });
          return jobs[jobs.length - 1] as unknown as Record<string, unknown>;
        };
        return {
          returning: async () => [finalize()],
          onConflictDoUpdate({ set }: { target: unknown; set: Record<string, unknown> }) {
            const existing = jobs.find((r) => r.id === v.id);
            if (existing) {
              Object.assign(existing, set);
            } else {
              jobs.push({ ...(v as JobRow) });
            }
            const row = jobs.find((r) => r.id === v.id)!;
            return {
              returning: async () => [row as unknown as Record<string, unknown>],
            };
          },
        };
      },
    }),
    update: (t: unknown) => ({
      set(values: Record<string, unknown>) {
        const store = storeFor(t);
        return {
          where(p: Filter) {
            const target = store.filter((row) => matches(row, p));
            for (const row of target) Object.assign(row, values);
            return {
              returning: async () => target,
            };
          },
        };
      },
    }),
    delete: (t: unknown) => ({
      where(p: Filter) {
        const store = storeFor(t);
        for (let i = store.length - 1; i >= 0; i--) {
          if (matches(store[i]!, p)) store.splice(i, 1);
        }
        return Promise.resolve();
      },
    }),
    execute: (_q: unknown) => Promise.resolve(),
  };
  return { db, vehicleJobsTable, vehicleJobEventsTable };
});

const routerModule = await import("../routes/vehicleJobs");
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

function baseJob(over: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    vin: VIN_A,
    title: "Hellcat swap",
    status: "draft",
    kind: "workflow",
    owner: "JD",
    vehicle: { model: "Charger", year: 2021 },
    ...over,
  };
}

beforeEach(() => {
  jobs.length = 0;
  events.length = 0;
  nextEventId = 1;
});

describe("POST /api/vehicle-jobs — validation", () => {
  it("rejects a missing id", async () => {
    const job = baseJob();
    delete (job as Record<string, unknown>).id;
    const r = await request(makeApp()).post("/api/vehicle-jobs").send(job);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(jobs.length).toBe(0);
  });

  it("rejects an id with illegal characters", async () => {
    const r = await request(makeApp())
      .post("/api/vehicle-jobs")
      .send(baseJob({ id: "bad id!" }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
    expect(jobs.length).toBe(0);
  });

  it("rejects a missing vin", async () => {
    const job = baseJob();
    delete (job as Record<string, unknown>).vin;
    const r = await request(makeApp()).post("/api/vehicle-jobs").send(job);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/vin/i);
    expect(jobs.length).toBe(0);
  });

  it("rejects an oversized vehicle payload with 413", async () => {
    const r = await request(makeApp())
      .post("/api/vehicle-jobs")
      .send(baseJob({ vehicle: { blob: "x".repeat(300 * 1024) } }));
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/large/i);
    expect(jobs.length).toBe(0);
  });
});

describe("POST /api/vehicle-jobs — save round-trip", () => {
  it("saves a job and reads it back, upper-casing the VIN", async () => {
    const app = makeApp();
    const created = await request(app)
      .post("/api/vehicle-jobs")
      .send(baseJob({ vin: VIN_A.toLowerCase() }));
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      id: "job-1",
      vin: VIN_A,
      title: "Hellcat swap",
      status: "draft",
      kind: "workflow",
      owner: "JD",
    });

    const r = await request(app).get("/api/vehicle-jobs/job-1");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: "job-1", vin: VIN_A });
    expect(r.body.vehicle).toMatchObject({ model: "Charger" });
    expect(r.body.events).toEqual([]);
  });

  it("updates an existing job in place on conflicting id", async () => {
    const app = makeApp();
    await request(app).post("/api/vehicle-jobs").send(baseJob({ status: "draft" }));
    await request(app)
      .post("/api/vehicle-jobs")
      .send(baseJob({ status: "in-progress" }));
    expect(jobs.length).toBe(1);
    const r = await request(app).get("/api/vehicle-jobs/job-1");
    expect(r.body.status).toBe("in-progress");
  });
});

describe("GET /api/vehicle-jobs — filtering", () => {
  it("filters by vin, status and kind", async () => {
    const app = makeApp();
    await request(app)
      .post("/api/vehicle-jobs")
      .send(baseJob({ id: "a", vin: VIN_A, status: "draft", kind: "workflow" }));
    await request(app)
      .post("/api/vehicle-jobs")
      .send(baseJob({ id: "b", vin: VIN_B, status: "draft", kind: "workflow" }));
    await request(app)
      .post("/api/vehicle-jobs")
      .send(baseJob({ id: "c", vin: VIN_A, status: "done", kind: "filepatch" }));

    const byVin = await request(app)
      .get("/api/vehicle-jobs")
      .query({ vin: VIN_A.toLowerCase() });
    expect(byVin.body.jobs.map((j: { id: string }) => j.id).sort()).toEqual([
      "a",
      "c",
    ]);

    const byStatus = await request(app)
      .get("/api/vehicle-jobs")
      .query({ status: "done" });
    expect(byStatus.body.jobs.map((j: { id: string }) => j.id)).toEqual(["c"]);

    const combined = await request(app)
      .get("/api/vehicle-jobs")
      .query({ vin: VIN_A, status: "draft", kind: "workflow" });
    expect(combined.body.jobs.map((j: { id: string }) => j.id)).toEqual(["a"]);
  });
});

describe("PATCH /api/vehicle-jobs/:id", () => {
  it("updates fields and bumps payloads", async () => {
    const app = makeApp();
    await request(app).post("/api/vehicle-jobs").send(baseJob());
    const patch = await request(app)
      .patch("/api/vehicle-jobs/job-1")
      .send({ status: "signed-off", signOff: { by: "JD", ok: true } });
    expect(patch.status).toBe(200);
    expect(patch.body.status).toBe("signed-off");
    expect(patch.body.signOff).toMatchObject({ by: "JD", ok: true });
  });

  it("returns 404 patching an unknown job", async () => {
    const r = await request(makeApp())
      .patch("/api/vehicle-jobs/nope")
      .send({ status: "done" });
    expect(r.status).toBe(404);
  });

  it("rejects an oversized census payload with 413", async () => {
    const app = makeApp();
    await request(app).post("/api/vehicle-jobs").send(baseJob());
    const r = await request(app)
      .patch("/api/vehicle-jobs/job-1")
      .send({ census: { blob: "x".repeat(300 * 1024) } });
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/large/i);
  });
});

describe("/api/vehicle-jobs/:id/events", () => {
  it("appends an event and lists it back", async () => {
    const app = makeApp();
    await request(app).post("/api/vehicle-jobs").send(baseJob());
    const ev = await request(app)
      .post("/api/vehicle-jobs/job-1/events")
      .send({ kind: "vin-write", module: "BCM", payload: { ok: true } });
    expect(ev.status).toBe(201);
    expect(ev.body).toMatchObject({ jobId: "job-1", kind: "vin-write", module: "BCM" });

    const list = await request(app).get("/api/vehicle-jobs/job-1/events");
    expect(list.status).toBe(200);
    expect(list.body.events).toHaveLength(1);
    expect(list.body.events[0]).toMatchObject({ kind: "vin-write" });
  });

  it("rejects an event with a missing kind", async () => {
    const app = makeApp();
    await request(app).post("/api/vehicle-jobs").send(baseJob());
    const r = await request(app)
      .post("/api/vehicle-jobs/job-1/events")
      .send({ module: "BCM" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/kind/i);
  });

  it("returns 404 appending an event to an unknown job", async () => {
    const r = await request(makeApp())
      .post("/api/vehicle-jobs/nope/events")
      .send({ kind: "vin-write" });
    expect(r.status).toBe(404);
  });
});

describe("GET/DELETE /api/vehicle-jobs/:id", () => {
  it("returns 404 for an unknown id", async () => {
    const r = await request(makeApp()).get("/api/vehicle-jobs/nope");
    expect(r.status).toBe(404);
  });

  it("rejects an invalid id", async () => {
    const r = await request(makeApp()).get(
      "/api/vehicle-jobs/" + encodeURIComponent("bad id!"),
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/id/i);
  });

  it("deletes a job by id", async () => {
    const app = makeApp();
    await request(app).post("/api/vehicle-jobs").send(baseJob({ id: "a" }));
    await request(app).post("/api/vehicle-jobs").send(baseJob({ id: "b" }));
    const del = await request(app).delete("/api/vehicle-jobs/a");
    expect(del.status).toBe(204);
    const list = await request(app).get("/api/vehicle-jobs");
    expect(list.body.jobs.map((j: { id: string }) => j.id)).toEqual(["b"]);
  });
});
