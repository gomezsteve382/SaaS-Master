/**
 * Knowledge Graph REST endpoints (Task #695).
 *
 * GET  /api/kg              — full graph (nodes + edges), optional ?focus=<nodeLabel>
 * POST /api/kg/ingest       — upsert nodes + edges from extraction result
 * POST /api/kg/extract      — extract KG from analysis blob + persist
 */

import { Router, type IRouter } from "express";
import { eq, or, ilike, sql } from "drizzle-orm";
import { db, kgNodesTable, kgEdgesTable } from "@workspace/db";
import { extractFromAnalysis, type KgNodeType } from "../lib/patternExtractor";

const router: IRouter = Router();

/* GET /api/kg */
router.get("/kg", async (req, res, next) => {
  try {
    const focus =
      typeof req.query.focus === "string" ? req.query.focus.trim() : null;

    let nodes;
    let edges;

    if (focus) {
      nodes = await db
        .select()
        .from(kgNodesTable)
        .where(
          or(
            ilike(kgNodesTable.label, "%" + focus + "%"),
            ilike(kgNodesTable.nodeType, "%" + focus + "%"),
          ),
        )
        .limit(200);

      const nodeIds = nodes.map((n) => n.id);
      if (nodeIds.length === 0) {
        res.json({ nodes: [], edges: [] });
        return;
      }

      const allEdges = await db.select().from(kgEdgesTable).limit(2000);
      edges = allEdges.filter(
        (e) => nodeIds.includes(e.fromNodeId) || nodeIds.includes(e.toNodeId),
      );

      const connectedIds = new Set<string>();
      for (const id of nodeIds) connectedIds.add(id);
      for (const e of edges) {
        connectedIds.add(e.fromNodeId);
        connectedIds.add(e.toNodeId);
      }

      if (connectedIds.size > nodeIds.length) {
        const extra = await db
          .select()
          .from(kgNodesTable)
          .limit(500);
        const extraFiltered = extra.filter(
          (n) => connectedIds.has(n.id) && !nodeIds.includes(n.id),
        );
        nodes = [...nodes, ...extraFiltered];
      }
    } else {
      nodes = await db.select().from(kgNodesTable).limit(500);
      edges = await db.select().from(kgEdgesTable).limit(2000);
    }

    res.json({ nodes, edges });
  } catch (err) {
    next(err);
  }
});

/* POST /api/kg/ingest — upsert nodes + edges */
router.post("/kg/ingest", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const rawNodes: unknown[] = Array.isArray(body.nodes) ? body.nodes : [];
    const rawEdges: unknown[] = Array.isArray(body.edges) ? body.edges : [];

    const nodeMap = new Map<string, string>();

    for (const rn of rawNodes) {
      if (!rn || typeof rn !== "object") continue;
      const n = rn as Record<string, unknown>;
      const nodeType = typeof n.nodeType === "string" ? n.nodeType : "MODULE";
      const label = typeof n.label === "string" ? n.label.trim() : "";
      if (!label) continue;
      const metadata =
        n.metadata && typeof n.metadata === "object"
          ? (n.metadata as Record<string, unknown>)
          : {};

      const existing = await db
        .select()
        .from(kgNodesTable)
        .where(
          sql`${kgNodesTable.nodeType} = ${nodeType} AND ${kgNodesTable.label} = ${label}`,
        )
        .limit(1);

      let nodeId: string;
      if (existing.length > 0) {
        nodeId = existing[0]!.id;
      } else {
        const [inserted] = await db
          .insert(kgNodesTable)
          .values({ nodeType: nodeType as KgNodeType, label, metadata })
          .returning();
        nodeId = inserted!.id;
      }
      nodeMap.set(`${nodeType}:${label}`, nodeId);
    }

    let edgesInserted = 0;
    for (const re of rawEdges) {
      if (!re || typeof re !== "object") continue;
      const e = re as Record<string, unknown>;
      const fromLabel = typeof e.fromLabel === "string" ? e.fromLabel : "";
      const fromType = typeof e.fromType === "string" ? e.fromType : "MODULE";
      const toLabel = typeof e.toLabel === "string" ? e.toLabel : "";
      const toType = typeof e.toType === "string" ? e.toType : "MODULE";
      const edgeType = typeof e.edgeType === "string" ? e.edgeType : "seen_together";
      const meta =
        e.meta && typeof e.meta === "object"
          ? (e.meta as Record<string, unknown>)
          : {};

      const fromId = nodeMap.get(`${fromType}:${fromLabel}`);
      const toId = nodeMap.get(`${toType}:${toLabel}`);
      if (!fromId || !toId) continue;

      const existing = await db
        .select()
        .from(kgEdgesTable)
        .where(
          eq(kgEdgesTable.fromNodeId, fromId),
        )
        .limit(50);

      const alreadyExists = existing.some(
        (x) => x.toNodeId === toId && x.edgeType === edgeType,
      );
      if (!alreadyExists) {
        await db
          .insert(kgEdgesTable)
          .values({ fromNodeId: fromId, toNodeId: toId, edgeType, meta });
        edgesInserted++;
      }
    }

    res.json({ nodesUpserted: nodeMap.size, edgesInserted, ok: true });
  } catch (err) {
    next(err);
  }
});

/* POST /api/kg/extract — auto-extract from analysis blob + persist */
router.post("/kg/extract", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const analysisId =
      typeof body.analysisId === "string" ? body.analysisId : "manual";
    const blob =
      body.payload && typeof body.payload === "object"
        ? body.payload
        : body;

    const { nodes: nodeSpecs, edges: edgeSpecs } = extractFromAnalysis(
      blob,
      analysisId,
    );

    const ingestRes = await fetch(
      `http://localhost:${process.env.PORT ?? 3001}/api/kg/ingest`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes: nodeSpecs, edges: edgeSpecs }),
      },
    );
    const ingestJson = (await ingestRes.json()) as Record<string, unknown>;
    res.json(ingestJson);
  } catch (err) {
    next(err);
  }
});

export default router;
