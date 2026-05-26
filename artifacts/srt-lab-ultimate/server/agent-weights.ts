/**
 * SRT Lab — Agent Weight Calculator
 *
 * Uses accumulated feedback ratings to dynamically adjust agent parameters:
 * - Higher-rated agents get more iterations and tool budget
 * - Lower-rated agents get fewer iterations to save resources
 * - Injects performance context into agent system prompts
 */

import { getAgentAccuracyScores, getAgentPerformanceSummary } from "./agent-metrics.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentWeights {
  agentId: string;
  maxIterations: number;       // Adjusted iteration cap (12-30)
  performanceBoost: string;    // Injected into system prompt
  accuracyScore: number;       // 0.0 - 1.0
  totalRatings: number;
  tier: "elite" | "standard" | "probation";
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_ITERATIONS = 20;
const MIN_ITERATIONS = 12;
const MAX_ITERATIONS = 30;
const MIN_RATINGS_FOR_ADJUSTMENT = 5; // Need at least 5 ratings to adjust (was 3 — too aggressive with sparse data)
const MIN_RATINGS_FOR_PROBATION = 10; // Need more data before penalizing an agent

// ─── Calculate Weights ──────────────────────────────────────────────────────

export async function calculateAgentWeights(): Promise<Map<string, AgentWeights>> {
  const weights = new Map<string, AgentWeights>();

  try {
    const [accuracyScores, performanceSummary] = await Promise.all([
      getAgentAccuracyScores(),
      getAgentPerformanceSummary(),
    ]);

    // Build accuracy map
    const accuracyMap = new Map(accuracyScores.map(s => [s.agentId, s]));
    const perfMap = new Map(performanceSummary.map(p => [p.agentId, p]));

    // All known agent IDs
    const allAgents = ["ghost", "phantom", "specter", "wraith", "shade"];

    for (const agentId of allAgents) {
      const accuracy = accuracyMap.get(agentId);
      const perf = perfMap.get(agentId);

      const totalRatings = accuracy?.totalRatings || 0;
      const score = accuracy?.accuracyScore ?? 0.5;

      // Only adjust if we have enough data
      let maxIterations = BASE_ITERATIONS;
      let tier: "elite" | "standard" | "probation" = "standard";
      let performanceBoost = "";

      if (totalRatings >= MIN_RATINGS_FOR_ADJUSTMENT) {
        if (score >= 0.8) {
          // Elite tier: high accuracy, give more resources
          tier = "elite";
          maxIterations = Math.min(MAX_ITERATIONS, BASE_ITERATIONS + Math.round((score - 0.5) * 12));
          performanceBoost = `\n\n[PERFORMANCE CONTEXT] You are rated ELITE with ${Math.round(score * 100)}% accuracy across ${totalRatings} rated findings. Your analysis is highly valued — go deeper, use more tools, leave no stone unturned. You have an extended iteration budget of ${maxIterations} cycles.`;
        } else if (score >= 0.5 || totalRatings < MIN_RATINGS_FOR_PROBATION) {
          // Standard tier: normal performance, OR not enough data to penalize yet
          tier = "standard";
          maxIterations = BASE_ITERATIONS;
          if (score < 0.5 && totalRatings < MIN_RATINGS_FOR_PROBATION) {
            performanceBoost = `\n\n[PERFORMANCE CONTEXT] Your accuracy rating is ${Math.round(score * 100)}% but based on only ${totalRatings} ratings — too few to adjust your budget. Focus on precision and verify findings with multiple tool calls.`;
          } else {
            performanceBoost = `\n\n[PERFORMANCE CONTEXT] Your accuracy rating is ${Math.round(score * 100)}% across ${totalRatings} findings. Focus on precision — verify your findings with multiple tool calls before reporting.`;
          }
        } else {
          // Probation tier: low accuracy AND enough data to be confident about it
          tier = "probation";
          maxIterations = Math.max(MIN_ITERATIONS, BASE_ITERATIONS - Math.round((0.5 - score) * 14));
          performanceBoost = `\n\n[PERFORMANCE CONTEXT] Your accuracy rating is ${Math.round(score * 100)}% across ${totalRatings} findings. CRITICAL: Focus on QUALITY over quantity. Only report findings you are highly confident about. Double-check everything.`;
        }
      }

      // Add historical performance context if available
      if (perf && perf.totalRuns > 1) {
        performanceBoost += `\n[HISTORICAL] ${perf.totalRuns} prior runs. Avg ${perf.avgToolCalls} tool calls, ${perf.avgFindings} findings per run.`;
      }

      weights.set(agentId, {
        agentId,
        maxIterations,
        performanceBoost,
        accuracyScore: score,
        totalRatings,
        tier,
      });
    }
  } catch (error) {
    console.warn("[AgentWeights] Failed to calculate weights, using defaults:", error);
    // Return empty map — caller will use defaults
  }

  return weights;
}

// ─── Apply Weights to Agent ─────────────────────────────────────────────────

export function applyWeightsToAgent(
  agent: { id: string; systemPrompt: string; maxIterations: number },
  weights: Map<string, AgentWeights>
): { systemPrompt: string; maxIterations: number } {
  const w = weights.get(agent.id);
  if (!w) {
    return { systemPrompt: agent.systemPrompt, maxIterations: agent.maxIterations };
  }

  return {
    systemPrompt: agent.systemPrompt + w.performanceBoost,
    maxIterations: w.maxIterations,
  };
}
