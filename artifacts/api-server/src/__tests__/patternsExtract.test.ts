/**
 * Integration tests for POST /api/patterns/extract (Task #695).
 *
 * Verifies the full extraction → deduplicate → DB upsert pipeline:
 *   1. A known analysis blob produces a non-zero inserted count.
 *   2. Re-posting the same blob deduplicates (inserted = 0 on second call).
 *   3. POST /api/patterns/extract/:analysisId accepts a path-param provenance ID.
 *   4. An UNKNOWN blob returns {inserted:0, patterns:[]}.
 *   5. PUT /api/patterns/:id edits label, notes, and confidence.
 *   6. KG node upsert uses (nodeType, label) composite key — distinct nodeTypes
 *      with the same label do NOT collapse into a single record.
 */

import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────────
 * In-memory stores — reset in beforeEach so tests are independent.
 * ───────────────────────────────────────────────────────────────────────────── */

type PatternRow = {
  id: string;
  category: string;
  label: string;
  signatureHash: string;
  signatureBytes: string | null;
  confidence: number;
  notes: string | null;
  sourceAnalysisIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

type KgNodeRow = { id: string; nodeType: string; label: string; metadata: Record<string, unknown> };

let patternStore: PatternRow[] = [];
let kgNodeStore: KgNodeRow[] = [];
let nextId = 1;

function resetStores() {
  patternStore = [];
  kgNodeStore = [];
  nextId = 1;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * drizzle-orm stub — only the operators the routes actually use.
 * ───────────────────────────────────────────────────────────────────────────── */

vi.mock("drizzle-orm", () => ({
  eq: (col: { _colName: string }, value: unknown) => ({ kind: "eq", colName: col._colName, value }),
  and: (...parts: unknown[]) => ({ kind: "and", parts }),
  or: (...parts: unknown[]) => ({ kind: "or", parts }),
  ilike: (col: unknown, value: unknown) => ({ kind: "ilike", col, value }),
  desc: (col: unknown) => ({ kind: "desc", col }),
  asc: (col: unknown) => ({ kind: "asc", col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({
      kind: "sql",
      strings: strings.raw,
      vals,
    }),
    { empty: null },
  ),
}));

/* ─────────────────────────────────────────────────────────────────────────────
 * @workspace/db stub.
 *
 * Each table object gets a `_tblName` so INSERT/UPDATE/SELECT can route to the
 * right in-memory store. Column objects carry `_colName` for eq() matching.
 * ───────────────────────────────────────────────────────────────────────────── */

vi.mock("@workspace/db", () => {
  function col(name: string) { return { _colName: name }; }

  const patternLibraryTable = {
    _tblName: "pattern_library",
    id: col("id"),
    category: col("category"),
    label: col("label"),
    signatureHash: col("signatureHash"),
    signatureBytes: col("signatureBytes"),
    confidence: col("confidence"),
    notes: col("notes"),
    sourceAnalysisIds: col("sourceAnalysisIds"),
    createdAt: col("createdAt"),
    updatedAt: col("updatedAt"),
  };

  const kgNodesTable = {
    _tblName: "kg_nodes",
    id: col("id"),
    nodeType: col("nodeType"),
    label: col("label"),
    metadata: col("metadata"),
  };

  const kgEdgesTable = {
    _tblName: "kg_edges",
    id: col("id"),
    fromNodeId: col("fromNodeId"),
    toNodeId: col("toNodeId"),
    edgeType: col("edgeType"),
    weight: col("weight"),
    metadata: col("metadata"),
  };

  /* ── tiny Drizzle-compatible query builder ── */
  type Op = { op: string; args: unknown[] };

  function buildChain(ops: Op[]): ReturnType<typeof proxy> {
    return proxy(ops);
  }

  function proxy(ops: Op[]) {
    return new Proxy({} as Record<string, unknown>, {
      get(_, prop: string) {
        if (prop === "returning") return () => execChain(ops);
        if (prop === Symbol.iterator as unknown as string) {
          return function* () { yield* (execChain(ops) as unknown[]); };
        }
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) =>
            Promise.resolve(execChain(ops)).then(resolve);
        }
        return (...args: unknown[]) => buildChain([...ops, { op: prop, args }]);
      },
    });
  }

  /* ── apply a simple WHERE condition to an array of rows ── */
  function applyWhere(
    rows: Record<string, unknown>[],
    cond: unknown,
  ): Record<string, unknown>[] {
    if (!cond || typeof cond !== "object") return rows;
    const c = cond as Record<string, unknown>;

    if (c.kind === "eq") {
      return rows.filter(r => r[c.colName as string] === c.value);
    }
    if (c.kind === "sql") {
      // The routes use sql`${tbl.nodeType} = ${nodeType} AND ${tbl.label} = ${label}`
      // vals = [colObj, nodeTypeValue, colObj, labelValue]
      const vals = c.vals as unknown[];
      if (vals.length >= 4) {
        const v1 = vals[1]; // nodeType / category value
        const v3 = vals[3]; // label / signatureHash value
        // Detect which composite key is being used from the vals (column objects carry _colName)
        const col0 = vals[0] as { _colName?: string };
        if (col0._colName === "nodeType") {
          return rows.filter(r => r.nodeType === v1 && r.label === v3);
        }
        if (col0._colName === "category") {
          return rows.filter(r => r.category === v1 && r.signatureHash === v3);
        }
      }
      return rows;
    }
    return rows;
  }

  function execChain(ops: Op[]): unknown[] {
    if (!ops.length) return [];
    const root = ops[0]!;

    /* ── SELECT ── */
    if (root.op === "select") {
      const fromOp = ops.find(o => o.op === "from");
      const tbl = fromOp?.args[0] as { _tblName?: string } | undefined;
      let rows: Record<string, unknown>[] = [];
      if (tbl?._tblName === "pattern_library") rows = [...patternStore] as unknown as Record<string, unknown>[];
      else if (tbl?._tblName === "kg_nodes") rows = [...kgNodeStore] as unknown as Record<string, unknown>[];

      const whereOp = ops.find(o => o.op === "where");
      if (whereOp) rows = applyWhere(rows, whereOp.args[0]);

      const lim = ops.find(o => o.op === "limit")?.args[0];
      if (typeof lim === "number") rows = rows.slice(0, lim);
      return rows;
    }

    /* ── INSERT ── */
    if (root.op === "insert") {
      const tbl = root.args[0] as { _tblName?: string };
      const valuesOp = ops.find(o => o.op === "values");
      const vals = valuesOp?.args[0] as Record<string, unknown> | undefined;
      if (!vals) return [];
      const hasConflict = ops.some(o => o.op === "onConflictDoUpdate");

      if (tbl._tblName === "pattern_library") {
        const cat = String(vals.category ?? "");
        const hash = String(vals.signatureHash ?? "");
        const existing = patternStore.find(p => p.category === cat && p.signatureHash === hash);
        if (existing) {
          if (hasConflict) {
            // Update confidence + merge sourceAnalysisIds (mirrors the real onConflictDoUpdate)
            if (typeof vals.confidence === "number") existing.confidence = vals.confidence;
            const newSrc = (vals.sourceAnalysisIds as string[]) ?? [];
            existing.sourceAnalysisIds = [...new Set([...existing.sourceAnalysisIds, ...newSrc])];
            existing.updatedAt = new Date();
            return []; // conflict path: we return [] so route doesn't count as "new insert"
          }
          return [existing];
        }
        const row: PatternRow = {
          id: String(nextId++),
          category: cat,
          label: String(vals.label ?? ""),
          signatureHash: hash,
          signatureBytes: vals.signatureBytes != null ? String(vals.signatureBytes) : null,
          confidence: Number(vals.confidence ?? 1),
          notes: vals.notes != null ? String(vals.notes) : null,
          sourceAnalysisIds: (vals.sourceAnalysisIds as string[]) ?? [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        patternStore.push(row);
        return [row];
      }

      if (tbl._tblName === "kg_nodes") {
        const nodeType = String(vals.nodeType ?? "MODULE");
        const label    = String(vals.label ?? "");
        const existing = kgNodeStore.find(n => n.nodeType === nodeType && n.label === label);
        if (existing) return [existing];
        const node: KgNodeRow = {
          id: String(nextId++),
          nodeType,
          label,
          metadata: (vals.metadata as Record<string, unknown>) ?? {},
        };
        kgNodeStore.push(node);
        return [node];
      }

      if (tbl._tblName === "kg_edges") return [{ id: String(nextId++) }];
      return [];
    }

    /* ── UPDATE ── */
    if (root.op === "update") {
      const tbl = root.args[0] as { _tblName?: string };
      const setOp  = ops.find(o => o.op === "set")?.args[0] as Record<string, unknown> | undefined;
      const whereOp = ops.find(o => o.op === "where");

      if (tbl._tblName === "pattern_library" && setOp) {
        const cond = whereOp?.args[0] as { colName?: string; value?: unknown } | undefined;
        const targetId = cond?.colName === "id" ? String(cond.value) : null;
        const updated = patternStore.filter(p => !targetId || p.id === targetId);
        patternStore = patternStore.map(p => {
          if (targetId && p.id !== targetId) return p;
          return {
            ...p,
            ...(typeof setOp.label === "string" ? { label: setOp.label } : {}),
            ...(setOp.notes !== undefined ? { notes: setOp.notes != null ? String(setOp.notes) : null } : {}),
            ...(typeof setOp.confidence === "number" ? { confidence: setOp.confidence } : {}),
            updatedAt: new Date(),
          };
        });
        return updated.map(p => patternStore.find(r => r.id === p.id) ?? p);
      }
      return [];
    }

    return [];
  }

  return { db: proxy([]), patternLibraryTable, kgNodesTable, kgEdgesTable };
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Build app once — the mock is module-level and accesses stores by reference,
 * so resetting stores in beforeEach is sufficient for test isolation.
 * ───────────────────────────────────────────────────────────────────────────── */

let app: Express;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  const [{ default: patternsRouter }, { default: kgRouter }] = await Promise.all([
    import("../routes/patterns"),
    import("../routes/knowledgeGraph"),
  ]);
  app.use("/api", patternsRouter);
  app.use("/api", kgRouter);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Tests
 * ───────────────────────────────────────────────────────────────────────────── */

describe("POST /api/patterns/extract — pipeline integration", () => {
  beforeEach(resetStores);

  it("inserts patterns from a valid analysis blob", async () => {
    const res = await request(app)
      .post("/api/patterns/extract")
      .send({
        module: "BCM",
        vin: "1C4RJFLGXJC123456",
        sec16: "AABBCCDDEEFF00112233445566778899",
        analysisId: "integ-001",
      })
      .expect(200);

    expect(res.body.inserted).toBeGreaterThan(0);
    expect(Array.isArray(res.body.patterns)).toBe(true);
    expect(patternStore.length).toBeGreaterThan(0);
  });

  it("deduplicates — re-posting the same blob does not grow the store", async () => {
    const blob = { module: "RFHUB", vin: "3C4PDCGG4GT654321", analysisId: "integ-002" };

    const first = await request(app).post("/api/patterns/extract").send(blob).expect(200);
    expect(first.body.inserted).toBeGreaterThan(0);
    const storeSize = patternStore.length;

    await request(app).post("/api/patterns/extract").send(blob).expect(200);
    expect(patternStore.length).toBe(storeSize);
  });

  it("accepts analysisId in the URL path param", async () => {
    const res = await request(app)
      .post("/api/patterns/extract/inspector-foo-bin-12345")
      .send({ module: "GPEC2A", partNumber: "68278900AA" })
      .expect(200);

    expect(res.body.inserted).toBeGreaterThan(0);
  });

  it("returns {inserted:0, patterns:[]} for UNKNOWN/empty blob", async () => {
    const res = await request(app)
      .post("/api/patterns/extract")
      .send({ module: "UNKNOWN", analysisId: "unk-test" })
      .expect(200);

    expect(res.body.inserted).toBe(0);
    expect(res.body.patterns).toHaveLength(0);
  });
});

describe("PUT /api/patterns/:id — edit endpoint", () => {
  beforeEach(async () => {
    resetStores();
    // Seed one pattern via extract
    await request(app)
      .post("/api/patterns/extract")
      .send({ module: "BCM", vin: "1C4RJFLGXJC000001", analysisId: "seed" });
  });

  it("updates label, notes and confidence of an existing pattern", async () => {
    const id = patternStore[0]?.id;
    expect(id).toBeDefined();

    // PUT requires a 36-char UUID-format id — pad to a UUID-like string
    const fakeUuid = `00000000-0000-0000-0000-${String(id!).padStart(12, "0")}`;
    // Seed a row with that id so the mock can find it
    patternStore[0]!.id = fakeUuid;

    const res = await request(app)
      .put(`/api/patterns/${fakeUuid}`)
      .send({ label: "Updated Label", notes: "bench confirmed", confidence: 0.85 })
      .expect(200);

    expect(res.body.ok).toBe(true);
    const updated = patternStore.find(p => p.id === fakeUuid);
    expect(updated?.label).toBe("Updated Label");
    expect(updated?.notes).toBe("bench confirmed");
    expect(updated?.confidence).toBe(0.85);
  });

  it("returns 404 for a valid UUID that matches no record", async () => {
    await request(app)
      .put("/api/patterns/00000000-0000-0000-0000-000000000000")
      .send({ label: "Ghost" })
      .expect(404);
  });
});

describe("KG node upsert — composite (nodeType, label) key", () => {
  beforeEach(resetStores);

  it("does not collapse MODULE and VIN nodes that share a label string", async () => {
    await request(app)
      .post("/api/kg/ingest")
      .send({
        nodes: [
          { nodeType: "MODULE", label: "BCM" },
          { nodeType: "VIN",    label: "BCM" }, // same label, different type
        ],
        edges: [],
      })
      .expect(200);

    const moduleNodes = kgNodeStore.filter(n => n.nodeType === "MODULE" && n.label === "BCM");
    const vinNodes    = kgNodeStore.filter(n => n.nodeType === "VIN"    && n.label === "BCM");
    expect(moduleNodes).toHaveLength(1);
    expect(vinNodes).toHaveLength(1);
    expect(kgNodeStore.length).toBe(2);
  });

  it("deduplicates nodes with the same (nodeType, label)", async () => {
    await request(app)
      .post("/api/kg/ingest")
      .send({ nodes: [{ nodeType: "MODULE", label: "RFHUB" }], edges: [] })
      .expect(200);

    await request(app)
      .post("/api/kg/ingest")
      .send({ nodes: [{ nodeType: "MODULE", label: "RFHUB" }], edges: [] })
      .expect(200);

    const rfhubNodes = kgNodeStore.filter(n => n.nodeType === "MODULE" && n.label === "RFHUB");
    expect(rfhubNodes).toHaveLength(1);
  });
});
