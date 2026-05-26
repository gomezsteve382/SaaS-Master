/**
 * Pattern Library & Knowledge Graph DB helpers
 * All queries return raw Drizzle rows.
 */
import { db } from "./db.js";
import { patternLibrary, kgNodes, kgEdges } from "../drizzle/schema.js";
import { eq, and, like, desc, sql, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";

// ─── Pattern Library ─────────────────────────────────────────────────────────

export type PatternCategory =
  | "crypto_algorithm"
  | "seed_key"
  | "can_id"
  | "uds_service"
  | "checksum"
  | "memory_map"
  | "string_pattern"
  | "byte_sequence"
  | "function_signature"
  | "protocol_sequence"
  | "other";

export interface CreatePatternInput {
  userId: string;
  sourceAnalysisId?: string;
  category: PatternCategory;
  name: string;
  description?: string;
  patternData: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export async function createPattern(input: CreatePatternInput) {
  const now = Date.now();
  const id = randomUUID();
  await db.insert(patternLibrary).values({
    id,
    userId: input.userId,
    sourceAnalysisId: input.sourceAnalysisId ?? null,
    category: input.category,
    name: input.name,
    description: input.description ?? null,
    patternData: input.patternData,
    metadata: input.metadata ?? null,
    matchCount: 1,
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function getPatterns(userId: string, category?: PatternCategory, search?: string) {
  const conditions = [eq(patternLibrary.userId, userId)];
  if (category) conditions.push(eq(patternLibrary.category, category));
  if (search) conditions.push(like(patternLibrary.name, `%${search}%`));
  return db
    .select()
    .from(patternLibrary)
    .where(and(...conditions))
    .orderBy(desc(patternLibrary.updatedAt))
    .limit(200);
}

export async function getPatternById(id: string) {
  const rows = await db.select().from(patternLibrary).where(eq(patternLibrary.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function deletePattern(id: string, userId: string) {
  await db
    .delete(patternLibrary)
    .where(and(eq(patternLibrary.id, id), eq(patternLibrary.userId, userId)));
}

export async function incrementPatternMatchCount(id: string) {
  await db
    .update(patternLibrary)
    .set({ matchCount: sql`${patternLibrary.matchCount} + 1`, updatedAt: Date.now() })
    .where(eq(patternLibrary.id, id));
}

// ─── Auto-extract patterns from an analysis result ───────────────────────────

export async function extractPatternsFromAnalysis(
  userId: string,
  analysisId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  analysisData: any
) {
  const created: string[] = [];

  // Extract crypto algorithms
  if (Array.isArray(analysisData?.algorithms)) {
    for (const algo of analysisData.algorithms as { name?: string; description?: string; offset?: string }[]) {
      if (!algo.name) continue;
      const id = await createPattern({
        userId,
        sourceAnalysisId: analysisId,
        category: "crypto_algorithm",
        name: algo.name,
        description: algo.description,
        patternData: JSON.stringify(algo),
        tags: ["auto-extracted"],
      });
      created.push(id);
    }
  }

  // Extract seed-key algorithms
  if (Array.isArray(analysisData?.seedKeys)) {
    for (const sk of analysisData.seedKeys as { algorithm?: string; offset?: string; description?: string }[]) {
      if (!sk.algorithm) continue;
      const id = await createPattern({
        userId,
        sourceAnalysisId: analysisId,
        category: "seed_key",
        name: sk.algorithm,
        description: sk.description,
        patternData: JSON.stringify(sk),
        tags: ["auto-extracted"],
      });
      created.push(id);
    }
  }

  // Extract CAN IDs
  if (Array.isArray(analysisData?.canAddresses)) {
    for (const can of analysisData.canAddresses as { id?: string; description?: string }[]) {
      if (!can.id) continue;
      const id = await createPattern({
        userId,
        sourceAnalysisId: analysisId,
        category: "can_id",
        name: `CAN ID ${can.id}`,
        description: can.description,
        patternData: can.id,
        tags: ["auto-extracted"],
      });
      created.push(id);
    }
  }

  // Extract checksums
  if (Array.isArray(analysisData?.checksums)) {
    for (const cs of analysisData.checksums as { type?: string; offset?: string; description?: string }[]) {
      if (!cs.type) continue;
      const id = await createPattern({
        userId,
        sourceAnalysisId: analysisId,
        category: "checksum",
        name: cs.type,
        description: cs.description,
        patternData: JSON.stringify(cs),
        tags: ["auto-extracted"],
      });
      created.push(id);
    }
  }

  return created;
}

// ─── Knowledge Graph ──────────────────────────────────────────────────────────

export type KgNodeType =
  | "binary"
  | "algorithm"
  | "seed_key"
  | "can_id"
  | "module_type"
  | "string"
  | "function"
  | "protocol"
  | "checksum"
  | "pattern";

export type KgEdgeType =
  | "contains"
  | "uses"
  | "implements"
  | "matches"
  | "derived_from"
  | "similar_to"
  | "communicates_with"
  | "depends_on";

export async function upsertKgNode(
  userId: string,
  nodeType: KgNodeType,
  label: string,
  properties?: Record<string, unknown>,
  sourceAnalysisId?: string,
  sourcePatternId?: string
) {
  // Check if a node with this label and type already exists for this user
  const existing = await db
    .select()
    .from(kgNodes)
    .where(and(eq(kgNodes.userId, userId), eq(kgNodes.nodeType, nodeType), eq(kgNodes.label, label)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const id = randomUUID();
  await db.insert(kgNodes).values({
    id,
    userId,
    nodeType,
    label,
    properties: properties ?? null,
    sourceAnalysisId: sourceAnalysisId ?? null,
    sourcePatternId: sourcePatternId ?? null,
    createdAt: Date.now(),
  });
  return id;
}

export async function createKgEdge(
  userId: string,
  fromNodeId: string,
  toNodeId: string,
  edgeType: KgEdgeType,
  weight = 1.0,
  properties?: Record<string, unknown>
) {
  // Deduplicate edges
  const existing = await db
    .select()
    .from(kgEdges)
    .where(
      and(
        eq(kgEdges.userId, userId),
        eq(kgEdges.fromNodeId, fromNodeId),
        eq(kgEdges.toNodeId, toNodeId),
        eq(kgEdges.edgeType, edgeType)
      )
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  const id = randomUUID();
  await db.insert(kgEdges).values({
    id,
    userId,
    fromNodeId,
    toNodeId,
    edgeType,
    weight,
    properties: properties ?? null,
    createdAt: Date.now(),
  });
  return id;
}

export async function getKgGraph(userId: string) {
  const nodes = await db.select().from(kgNodes).where(eq(kgNodes.userId, userId)).limit(500);
  const nodeIds = nodes.map((n: { id: string }) => n.id);
  if (nodeIds.length === 0) return { nodes: [], edges: [] };
  const edges = await db
    .select()
    .from(kgEdges)
    .where(and(eq(kgEdges.userId, userId), inArray(kgEdges.fromNodeId, nodeIds)))
    .limit(2000);
  return { nodes, edges };
}

// ─── Build KG from analysis result ───────────────────────────────────────────

export async function buildKgFromAnalysis(
  userId: string,
  analysisId: string,
  filename: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  analysisData: any
) {
  // Create binary node
  const binaryNodeId = await upsertKgNode(userId, "binary", filename, { analysisId }, analysisId);

  // Module type node
  if (analysisData?.detectedModule) {
    const modNodeId = await upsertKgNode(userId, "module_type", analysisData.detectedModule);
    await createKgEdge(userId, binaryNodeId, modNodeId, "implements");
  }

  // Algorithm nodes
  if (Array.isArray(analysisData?.algorithms)) {
    for (const algo of analysisData.algorithms as { name?: string }[]) {
      if (!algo.name) continue;
      const algoNodeId = await upsertKgNode(userId, "algorithm", algo.name, algo as Record<string, unknown>, analysisId);
      await createKgEdge(userId, binaryNodeId, algoNodeId, "uses");
    }
  }

  // Seed-key nodes
  if (Array.isArray(analysisData?.seedKeys)) {
    for (const sk of analysisData.seedKeys as { algorithm?: string }[]) {
      if (!sk.algorithm) continue;
      const skNodeId = await upsertKgNode(userId, "seed_key", sk.algorithm, sk as Record<string, unknown>, analysisId);
      await createKgEdge(userId, binaryNodeId, skNodeId, "contains");
    }
  }

  // CAN ID nodes
  if (Array.isArray(analysisData?.canAddresses)) {
    for (const can of analysisData.canAddresses as { id?: string }[]) {
      if (!can.id) continue;
      const canNodeId = await upsertKgNode(userId, "can_id", `CAN:${can.id}`, can as Record<string, unknown>, analysisId);
      await createKgEdge(userId, binaryNodeId, canNodeId, "communicates_with");
    }
  }

  // Checksum nodes
  if (Array.isArray(analysisData?.checksums)) {
    for (const cs of analysisData.checksums as { type?: string }[]) {
      if (!cs.type) continue;
      const csNodeId = await upsertKgNode(userId, "checksum", cs.type, cs as Record<string, unknown>, analysisId);
      await createKgEdge(userId, binaryNodeId, csNodeId, "uses");
    }
  }

  return binaryNodeId;
}
