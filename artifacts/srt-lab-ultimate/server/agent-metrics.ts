/**
 * SRT Lab — Agent Metrics & Feedback System
 *
 * Persists per-agent performance data after each analysis.
 * Handles user feedback (thumbs up/down) on findings.
 * Computes agent accuracy scores from feedback data.
 */

import { db } from "./db.js";
import { agentMetrics, findingRatings } from "../drizzle/schema.js";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentMetricInput {
  analysisId: string;
  agentId: string;
  codename: string;
  specialty: string;
  durationMs: number;
  toolCallCount: number;
  iterations: number;
  findingsCount: number;
  error?: string;
}

export interface AgentAccuracyScore {
  agentId: string;
  codename: string;
  totalRatings: number;
  upvotes: number;
  downvotes: number;
  accuracyScore: number; // 0.0 - 1.0
}

// ─── Save Agent Metrics ─────────────────────────────────────────────────────

export async function saveAgentMetrics(metrics: AgentMetricInput[]): Promise<void> {
  if (metrics.length === 0) return;

  const rows = metrics.map(m => ({
    id: nanoid(12),
    analysisId: m.analysisId,
    agentId: m.agentId,
    codename: m.codename,
    specialty: m.specialty || "",
    durationMs: m.durationMs,
    toolCallCount: m.toolCallCount,
    iterations: m.iterations,
    findingsCount: m.findingsCount,
    error: m.error || null,
    accuracyScore: 0.5,
    createdAt: Date.now(),
  }));

  await db.insert(agentMetrics).values(rows);
}

// ─── Get Agent Metrics for an Analysis ──────────────────────────────────────

export async function getMetricsForAnalysis(analysisId: string) {
  return db
    .select()
    .from(agentMetrics)
    .where(eq(agentMetrics.analysisId, analysisId))
    .orderBy(desc(agentMetrics.durationMs));
}

// ─── Get Aggregate Agent Accuracy Scores ────────────────────────────────────

export async function getAgentAccuracyScores(): Promise<AgentAccuracyScore[]> {
  const results = await db
    .select({
      agentId: findingRatings.agentId,
      totalRatings: sql<number>`COUNT(*)`,
      upvotes: sql<number>`SUM(CASE WHEN ${findingRatings.rating} = 'up' THEN 1 ELSE 0 END)`,
      downvotes: sql<number>`SUM(CASE WHEN ${findingRatings.rating} = 'down' THEN 1 ELSE 0 END)`,
    })
    .from(findingRatings)
    .groupBy(findingRatings.agentId);

  return results.map(r => ({
    agentId: r.agentId,
    codename: r.agentId.toUpperCase(),
    totalRatings: Number(r.totalRatings),
    upvotes: Number(r.upvotes),
    downvotes: Number(r.downvotes),
    accuracyScore: Number(r.totalRatings) > 0
      ? Number(r.upvotes) / Number(r.totalRatings)
      : 0.5,
  }));
}

// ─── Rate a Finding ─────────────────────────────────────────────────────────

export async function rateFinding(
  analysisId: string,
  agentId: string,
  findingIndex: number,
  findingCategory: string,
  rating: "up" | "down"
): Promise<void> {
  // Upsert: delete existing rating for this finding, then insert new one
  await db
    .delete(findingRatings)
    .where(
      and(
        eq(findingRatings.analysisId, analysisId),
        eq(findingRatings.agentId, agentId),
        eq(findingRatings.findingIndex, findingIndex)
      )
    );

  await db.insert(findingRatings).values({
    id: nanoid(12),
    analysisId,
    agentId,
    findingIndex,
    findingCategory,
    rating,
    createdAt: Date.now(),
  });

  // Update accuracy score for this agent — only for the CURRENT analysis row,
  // not all rows globally. The global score is computed on-the-fly by getAgentAccuracyScores().
  // Previously this was: .where(eq(agentMetrics.agentId, agentId)) which overwrote
  // every row for the agent across all analyses, corrupting historical data.
  const scores = await getAgentAccuracyScores();
  const agentScore = scores.find(s => s.agentId === agentId);
  if (agentScore) {
    await db
      .update(agentMetrics)
      .set({ accuracyScore: agentScore.accuracyScore })
      .where(
        and(
          eq(agentMetrics.agentId, agentId),
          eq(agentMetrics.analysisId, analysisId)
        )
      );
  }
}

// ─── Get Ratings for an Analysis ────────────────────────────────────────────

export async function getRatingsForAnalysis(analysisId: string) {
  return db
    .select()
    .from(findingRatings)
    .where(eq(findingRatings.analysisId, analysisId));
}

// ─── Get All-Time Agent Performance Summary ─────────────────────────────────

export async function getAgentPerformanceSummary() {
  const results = await db
    .select({
      agentId: agentMetrics.agentId,
      codename: agentMetrics.codename,
      specialty: agentMetrics.specialty,
      totalRuns: sql<number>`COUNT(*)`,
      avgDurationMs: sql<number>`AVG(${agentMetrics.durationMs})`,
      avgToolCalls: sql<number>`AVG(${agentMetrics.toolCallCount})`,
      avgIterations: sql<number>`AVG(${agentMetrics.iterations})`,
      avgFindings: sql<number>`AVG(${agentMetrics.findingsCount})`,
      avgAccuracy: sql<number>`AVG(${agentMetrics.accuracyScore})`,
      totalErrors: sql<number>`SUM(CASE WHEN ${agentMetrics.error} IS NOT NULL THEN 1 ELSE 0 END)`,
    })
    .from(agentMetrics)
    .groupBy(agentMetrics.agentId, agentMetrics.codename, agentMetrics.specialty);

  return results.map(r => ({
    agentId: r.agentId,
    codename: r.codename,
    specialty: r.specialty,
    totalRuns: Number(r.totalRuns),
    avgDurationMs: Math.round(Number(r.avgDurationMs)),
    avgToolCalls: Math.round(Number(r.avgToolCalls) * 10) / 10,
    avgIterations: Math.round(Number(r.avgIterations) * 10) / 10,
    avgFindings: Math.round(Number(r.avgFindings) * 10) / 10,
    avgAccuracy: Math.round(Number(r.avgAccuracy) * 100) / 100,
    totalErrors: Number(r.totalErrors),
  }));
}
