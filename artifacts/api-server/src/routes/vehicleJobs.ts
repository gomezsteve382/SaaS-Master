import { Router, type IRouter } from "express";
import { desc, eq, and } from "drizzle-orm";
import {
  db,
  vehicleJobsTable,
  vehicleJobEventsTable,
  type VehicleJob,
  type VehicleJobEvent,
} from "@workspace/db";

const router: IRouter = Router();

/**
 * Vehicle Jobs (Task #501).
 *
 * One row per in-progress module-swap workflow. The job persists VIN,
 * vehicle metadata, current census snapshot, fix-plan progress and the
 * sign-off summary so a tech can pick a job up on a different machine.
 * Events live in `vehicle_job_events` as an append-only audit log.
 */

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_LIST = 200;
const MAX_EVENTS = 500;
const MAX_PAYLOAD_BYTES = 256 * 1024;

function rowToJson(row: VehicleJob) {
  return {
    id: row.id,
    vin: row.vin,
    kind: row.kind ?? "workflow",
    title: row.title ?? null,
    vehicle: row.vehicle ?? null,
    status: row.status,
    census: row.census ?? null,
    fixPlan: row.fixPlan ?? null,
    signOff: row.signOff ?? null,
    owner: row.owner ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

function eventToJson(row: VehicleJobEvent) {
  return {
    id: row.id,
    jobId: row.jobId,
    ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
    kind: row.kind,
    module: row.module ?? null,
    payload: row.payload ?? null,
  };
}

function checkPayloadSize(payload: unknown): boolean {
  if (payload == null) return true;
  try {
    return JSON.stringify(payload).length <= MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

router.get("/vehicle-jobs", async (req, res, next) => {
  try {
    const vin = typeof req.query["vin"] === "string" ? req.query["vin"].toUpperCase() : null;
    const status = typeof req.query["status"] === "string" ? req.query["status"] : null;
    const kind = typeof req.query["kind"] === "string" ? req.query["kind"] : null;

    const conditions = [];
    if (vin) conditions.push(eq(vehicleJobsTable.vin, vin));
    if (status) conditions.push(eq(vehicleJobsTable.status, status));
    if (kind) conditions.push(eq(vehicleJobsTable.kind, kind));

    const baseQuery = db.select().from(vehicleJobsTable);
    const rows = conditions.length
      ? await baseQuery
          .where(conditions.length === 1 ? conditions[0] : and(...conditions))
          .orderBy(desc(vehicleJobsTable.updatedAt))
          .limit(MAX_LIST)
      : await baseQuery
          .orderBy(desc(vehicleJobsTable.updatedAt))
          .limit(MAX_LIST);

    res.json({ jobs: rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/vehicle-jobs", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const id = typeof body.id === "string" ? body.id : "";
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const vin = typeof body.vin === "string" ? body.vin.toUpperCase().slice(0, 32) : "";
    if (!vin) {
      res.status(400).json({ error: "missing vin" });
      return;
    }
    const title = typeof body.title === "string" ? body.title.slice(0, 256) : null;
    const vehicle = body.vehicle && typeof body.vehicle === "object" ? body.vehicle : null;
    const status = typeof body.status === "string" ? body.status.slice(0, 32) : "draft";
    const kind = typeof body.kind === "string" ? body.kind.slice(0, 32) : "workflow";
    const owner = typeof body.owner === "string" ? body.owner.slice(0, 128) : null;
    const fixPlan =
      body.fixPlan && typeof body.fixPlan === "object" ? body.fixPlan : null;

    if (!checkPayloadSize(vehicle)) {
      res.status(413).json({ error: "vehicle payload too large" });
      return;
    }
    if (!checkPayloadSize(fixPlan)) {
      res.status(413).json({ error: "fixPlan payload too large" });
      return;
    }

    const now = new Date();
    const insertValues: typeof vehicleJobsTable.$inferInsert = {
      id,
      vin,
      kind,
      title,
      vehicle,
      status,
      owner,
      createdAt: now,
      updatedAt: now,
    };
    const updateValues: Record<string, unknown> = {
      vin,
      kind,
      title,
      vehicle,
      status,
      owner,
      updatedAt: now,
    };
    if (fixPlan !== null) {
      insertValues.fixPlan = fixPlan;
      updateValues["fixPlan"] = fixPlan;
    }

    const [row] = await db
      .insert(vehicleJobsTable)
      .values(insertValues)
      .onConflictDoUpdate({
        target: vehicleJobsTable.id,
        set: updateValues,
      })
      .returning();

    req.log.info({ jobId: id, vin }, "vehicle job upserted");
    res.json(rowToJson(row));
  } catch (err) {
    next(err);
  }
});

router.get("/vehicle-jobs/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }

    const [job] = await db
      .select()
      .from(vehicleJobsTable)
      .where(eq(vehicleJobsTable.id, id))
      .limit(1);

    if (!job) {
      res.status(404).json({ error: "not found" });
      return;
    }

    const events = await db
      .select()
      .from(vehicleJobEventsTable)
      .where(eq(vehicleJobEventsTable.jobId, id))
      .orderBy(desc(vehicleJobEventsTable.ts))
      .limit(MAX_EVENTS);

    res.json({ ...rowToJson(job), events: events.map(eventToJson) });
  } catch (err) {
    next(err);
  }
});

router.patch("/vehicle-jobs/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const body = req.body ?? {};

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.title === "string") updates["title"] = body.title.slice(0, 256);
    if (body.title === null) updates["title"] = null;
    if (typeof body.status === "string") updates["status"] = body.status.slice(0, 32);
    if (typeof body.owner === "string") updates["owner"] = body.owner.slice(0, 128);
    if (body.owner === null) updates["owner"] = null;
    if (Object.prototype.hasOwnProperty.call(body, "vehicle")) {
      if (!checkPayloadSize(body.vehicle)) {
        res.status(413).json({ error: "vehicle payload too large" });
        return;
      }
      updates["vehicle"] = body.vehicle;
    }
    if (Object.prototype.hasOwnProperty.call(body, "census")) {
      if (!checkPayloadSize(body.census)) {
        res.status(413).json({ error: "census payload too large" });
        return;
      }
      updates["census"] = body.census;
    }
    if (Object.prototype.hasOwnProperty.call(body, "fixPlan")) {
      if (!checkPayloadSize(body.fixPlan)) {
        res.status(413).json({ error: "fixPlan payload too large" });
        return;
      }
      updates["fixPlan"] = body.fixPlan;
    }
    if (Object.prototype.hasOwnProperty.call(body, "signOff")) {
      if (!checkPayloadSize(body.signOff)) {
        res.status(413).json({ error: "signOff payload too large" });
        return;
      }
      updates["signOff"] = body.signOff;
    }

    const [row] = await db
      .update(vehicleJobsTable)
      .set(updates)
      .where(eq(vehicleJobsTable.id, id))
      .returning();

    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }

    res.json(rowToJson(row));
  } catch (err) {
    next(err);
  }
});

router.delete("/vehicle-jobs/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db.delete(vehicleJobsTable).where(eq(vehicleJobsTable.id, id));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get("/vehicle-jobs/:id/events", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const events = await db
      .select()
      .from(vehicleJobEventsTable)
      .where(eq(vehicleJobEventsTable.jobId, id))
      .orderBy(desc(vehicleJobEventsTable.ts))
      .limit(MAX_EVENTS);
    res.json({ events: events.map(eventToJson) });
  } catch (err) {
    next(err);
  }
});

router.post("/vehicle-jobs/:id/events", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!ID_PATTERN.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const body = req.body ?? {};
    const kind = typeof body.kind === "string" ? body.kind.slice(0, 64) : "";
    if (!kind) {
      res.status(400).json({ error: "missing kind" });
      return;
    }
    const moduleName = typeof body.module === "string" ? body.module.slice(0, 32) : null;
    const payload = body.payload && typeof body.payload === "object" ? body.payload : null;
    if (!checkPayloadSize(payload)) {
      res.status(413).json({ error: "payload too large" });
      return;
    }

    // Verify the parent job exists so we don't strand orphan events.
    const [parent] = await db
      .select({ id: vehicleJobsTable.id })
      .from(vehicleJobsTable)
      .where(eq(vehicleJobsTable.id, id))
      .limit(1);
    if (!parent) {
      res.status(404).json({ error: "job not found" });
      return;
    }

    const [row] = await db
      .insert(vehicleJobEventsTable)
      .values({
        jobId: id,
        kind,
        module: moduleName,
        payload,
      })
      .returning();

    // Touch the parent job so list-views resort by recent activity.
    await db
      .update(vehicleJobsTable)
      .set({ updatedAt: new Date() })
      .where(eq(vehicleJobsTable.id, id));

    res.status(201).json(eventToJson(row));
  } catch (err) {
    next(err);
  }
});

export default router;
