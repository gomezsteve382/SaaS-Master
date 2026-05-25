/**
 * Pattern Library REST endpoints (Task #695).
 *
 * GET    /api/patterns              — list (optional ?category=, ?q=)
 * POST   /api/patterns              — manual add
 * DELETE /api/patterns/:id          — delete one
 * POST   /api/patterns/extract      — auto-extract from a parsed analysis blob
 * GET    /api/patterns/search?q=... — full-text search for AI tool
 */

import { Router, type IRouter } from "express";
import { eq, ilike, or, sql, desc } from "drizzle-orm";
import { db, patternLibraryTable } from "@workspace/db";
import { extractFromAnalysis } from "../lib/patternExtractor";

const router: IRouter = Router();

const MAX_LIST = 500;

/* GET /api/patterns */
router.get("/patterns", async (req, res, next) => {
  try {
    const category =
      typeof req.query.category === "string" ? req.query.category : null;
    const q =
      typeof req.query.q === "string" ? req.query.q.trim() : null;

    let rows;
    if (category && q) {
      rows = await db
        .select()
        .from(patternLibraryTable)
        .where(
          sql`${patternLibraryTable.category} = ${category} AND (
            ${patternLibraryTable.label} ILIKE ${"%" + q + "%"} OR
            ${patternLibraryTable.notes} ILIKE ${"%" + q + "%"}
          )`,
        )
        .orderBy(desc(patternLibraryTable.createdAt))
        .limit(MAX_LIST);
    } else if (category) {
      rows = await db
        .select()
        .from(patternLibraryTable)
        .where(eq(patternLibraryTable.category, category))
        .orderBy(desc(patternLibraryTable.createdAt))
        .limit(MAX_LIST);
    } else if (q) {
      rows = await db
        .select()
        .from(patternLibraryTable)
        .where(
          or(
            ilike(patternLibraryTable.label, "%" + q + "%"),
            ilike(patternLibraryTable.notes, "%" + q + "%"),
          ),
        )
        .orderBy(desc(patternLibraryTable.createdAt))
        .limit(MAX_LIST);
    } else {
      rows = await db
        .select()
        .from(patternLibraryTable)
        .orderBy(desc(patternLibraryTable.createdAt))
        .limit(MAX_LIST);
    }

    res.json({ patterns: rows });
  } catch (err) {
    next(err);
  }
});

/* GET /api/patterns/search?q=... — AI tool endpoint */
router.get("/patterns/search", async (req, res, next) => {
  try {
    const q =
      typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.json({ patterns: [] });
      return;
    }
    const rows = await db
      .select()
      .from(patternLibraryTable)
      .where(
        or(
          ilike(patternLibraryTable.label, "%" + q + "%"),
          ilike(patternLibraryTable.notes, "%" + q + "%"),
          ilike(patternLibraryTable.signatureBytes, "%" + q + "%"),
        ),
      )
      .orderBy(desc(patternLibraryTable.createdAt))
      .limit(20);
    res.json({ patterns: rows });
  } catch (err) {
    next(err);
  }
});

/* POST /api/patterns — manual add */
router.post("/patterns", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const category = typeof body.category === "string" ? body.category.trim() : "";
    const label = typeof body.label === "string" ? body.label.trim() : "";
    const signatureHash =
      typeof body.signatureHash === "string" ? body.signatureHash.trim() : "";
    const signatureBytes =
      typeof body.signatureBytes === "string" ? body.signatureBytes.trim() : null;
    const confidence =
      typeof body.confidence === "number" ? body.confidence : 1.0;
    const notes =
      typeof body.notes === "string" ? body.notes.trim() || null : null;
    const sourceAnalysisIds = Array.isArray(body.sourceAnalysisIds)
      ? body.sourceAnalysisIds
      : [];

    if (!category || !label || !signatureHash) {
      res.status(400).json({ error: "category, label, signatureHash required" });
      return;
    }

    const [row] = await db
      .insert(patternLibraryTable)
      .values({
        category,
        label,
        signatureBytes,
        signatureHash,
        confidence,
        notes,
        sourceAnalysisIds,
      })
      .onConflictDoUpdate({
        target: [patternLibraryTable.category, patternLibraryTable.signatureHash],
        set: {
          label,
          confidence,
          notes,
          updatedAt: new Date(),
          sourceAnalysisIds: sql`
            (SELECT jsonb_agg(DISTINCT elem)
             FROM jsonb_array_elements(
               ${patternLibraryTable.sourceAnalysisIds}::jsonb || ${JSON.stringify(sourceAnalysisIds)}::jsonb
             ) AS elem)
          `,
        },
      })
      .returning();

    res.status(201).json({ pattern: row, ok: true });
  } catch (err) {
    next(err);
  }
});

/* DELETE /api/patterns/:id */
router.delete("/patterns/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    await db
      .delete(patternLibraryTable)
      .where(eq(patternLibraryTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* PUT /api/patterns/:id — edit label / notes / confidence */
router.put("/patterns/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const body = req.body ?? {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.label === "string" && body.label.trim()) updates.label = body.label.trim();
    if (typeof body.notes === "string") updates.notes = body.notes.trim() || null;
    if (typeof body.confidence === "number") updates.confidence = body.confidence;

    const [updated] = await db
      .update(patternLibraryTable)
      .set(updates)
      .where(eq(patternLibraryTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ pattern: updated, ok: true });
  } catch (err) {
    next(err);
  }
});

/* Shared handler for both extract routes */
async function handleExtract(
  analysisId: string,
  body: Record<string, unknown>,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  try {
    const blob =
      body.payload && typeof body.payload === "object"
        ? (body.payload as Record<string, unknown>)
        : body;

    const { patterns } = extractFromAnalysis(blob, analysisId);

    if (patterns.length === 0) {
      res.json({ inserted: 0, patterns: [] });
      return;
    }

    const inserted: string[] = [];
    for (const p of patterns) {
      const sourceIds = analysisId !== "manual" ? [analysisId] : [];
      const [row] = await db
        .insert(patternLibraryTable)
        .values({
          category: p.category,
          label: p.label,
          signatureBytes: p.signatureBytes,
          signatureHash: p.signatureHash,
          confidence: p.confidence,
          notes: p.notes,
          sourceAnalysisIds: sourceIds,
        })
        .onConflictDoUpdate({
          target: [patternLibraryTable.category, patternLibraryTable.signatureHash],
          set: {
            confidence: p.confidence,
            updatedAt: new Date(),
            sourceAnalysisIds: sourceIds.length
              ? sql`
                  (SELECT jsonb_agg(DISTINCT elem)
                   FROM jsonb_array_elements(
                     ${patternLibraryTable.sourceAnalysisIds}::jsonb || ${JSON.stringify(sourceIds)}::jsonb
                   ) AS elem)
                `
              : patternLibraryTable.sourceAnalysisIds,
          },
        })
        .returning();
      if (row) inserted.push(row.id);
    }

    res.json({ inserted: inserted.length, patterns: inserted });
  } catch (err) {
    next(err);
  }
}

/* POST /api/patterns/extract — auto-extract from analysis blob (analysisId from body) */
router.post("/patterns/extract", (req, res, next) => {
  const body: Record<string, unknown> = req.body ?? {};
  const analysisId = typeof body.analysisId === "string" ? body.analysisId : "manual";
  handleExtract(analysisId, body, res, next);
});

/* POST /api/patterns/extract/:analysisId — extract with explicit provenance ID in path */
router.post("/patterns/extract/:analysisId", (req, res, next) => {
  const body: Record<string, unknown> = req.body ?? {};
  const analysisId = req.params.analysisId;
  handleExtract(analysisId, body, res, next);
});

export default router;
