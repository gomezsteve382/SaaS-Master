/**
 * Cross-session learning helpers.
 *
 * Backed by the `user_profile` and `analysis_goals` Postgres tables
 * (see `drizzle/schema.ts`). Per-user routing is not yet plumbed through
 * the upstream endpoints, so all calls are scoped to a single "system"
 * profile until that lands.
 */
import { randomUUID } from "crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "./db.js";
import { userProfile, analysisGoals } from "../drizzle/schema.js";

const SYSTEM_USER_ID = "system";
const MAX_KNOWN = 50;

export interface UserProfile {
  totalSessions: number;
  knownModules: string[];
  knownAlgorithms: string[];
  knownPatterns: string[];
  expertiseSummary: string;
}

const EMPTY_PROFILE: UserProfile = {
  totalSessions: 0,
  knownModules: [],
  knownAlgorithms: [],
  knownPatterns: [],
  expertiseSummary: "",
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function mergeUnique(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const item of incoming) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out.slice(-MAX_KNOWN);
}

function extractFindings(analysisResult: unknown): {
  modules: string[];
  algorithms: string[];
  patterns: string[];
  summary: string;
  keyFindings: Record<string, unknown>;
} {
  const result = (analysisResult ?? {}) as Record<string, unknown>;
  const findings = ((result.findings as Record<string, unknown>) ?? result) as Record<string, unknown>;

  const modules: string[] = [];
  const detectedModule = result.detectedModule ?? findings.detectedModule;
  if (typeof detectedModule === "string" && detectedModule.length > 0) {
    modules.push(detectedModule);
  }

  const algorithms = asStringArray(
    (findings.algorithms as Array<Record<string, unknown>> | undefined)?.map(
      (a) => (typeof a?.name === "string" ? a.name : ""),
    ),
  );

  const seedKeyAlgos = asStringArray(
    (findings.seedKeys as Array<Record<string, unknown>> | undefined)?.map(
      (s) => (typeof s?.algorithm === "string" ? s.algorithm : ""),
    ),
  );

  const patterns: string[] = [];
  const canAddresses = (findings.canAddresses as Array<Record<string, unknown>> | undefined) ?? [];
  for (const ca of canAddresses) {
    if (typeof ca?.module === "string") patterns.push(`CAN:${ca.module}`);
  }
  const checksums = (findings.checksums as Array<Record<string, unknown>> | undefined) ?? [];
  for (const c of checksums) {
    if (typeof c?.type === "string") patterns.push(`CHK:${c.type}`);
  }

  const summary =
    typeof findings.summary === "string"
      ? findings.summary
      : typeof result.summary === "string"
        ? result.summary
        : "";

  return {
    modules,
    algorithms: mergeUnique(algorithms, seedKeyAlgos),
    patterns,
    summary,
    keyFindings: {
      algorithmCount: Array.isArray(findings.algorithms) ? findings.algorithms.length : 0,
      seedKeyCount: Array.isArray(findings.seedKeys) ? findings.seedKeys.length : 0,
      canAddressCount: Array.isArray(findings.canAddresses) ? findings.canAddresses.length : 0,
      checksumCount: Array.isArray(findings.checksums) ? findings.checksums.length : 0,
      securityByteCount: Array.isArray(findings.securityBytes) ? findings.securityBytes.length : 0,
    },
  };
}

export async function loadUserProfile(userId: string = SYSTEM_USER_ID): Promise<UserProfile> {
  try {
    const rows = await db.select().from(userProfile).where(eq(userProfile.userId, userId)).limit(1);
    if (rows.length === 0) return EMPTY_PROFILE;
    const row = rows[0];
    return {
      totalSessions: row.totalSessions ?? 0,
      knownModules: asStringArray(row.knownModules),
      knownAlgorithms: asStringArray(row.knownAlgorithms),
      knownPatterns: asStringArray(row.knownPatterns),
      expertiseSummary: row.expertiseSummary ?? "",
    };
  } catch (err) {
    console.error("[ai-learning] loadUserProfile failed:", (err as Error).message);
    return EMPTY_PROFILE;
  }
}

export async function getRecentGoals(limit = 10, userId: string = SYSTEM_USER_ID): Promise<string[]> {
  try {
    const rows = await db
      .select({ summary: analysisGoals.summary, instructions: analysisGoals.userInstructions })
      .from(analysisGoals)
      .where(eq(analysisGoals.userId, userId))
      .orderBy(desc(analysisGoals.createdAt))
      .limit(limit);
    return rows
      .map((r) => r.summary || r.instructions || "")
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch (err) {
    console.error("[ai-learning] getRecentGoals failed:", (err as Error).message);
    return [];
  }
}

function basePrompt(userInstructions: string, profile: UserProfile, recentGoals: string[]): string {
  const profileLines: string[] = [];
  if (profile.totalSessions > 0) {
    profileLines.push(`Cross-session context (${profile.totalSessions} prior analyses):`);
    if (profile.knownModules.length > 0) {
      profileLines.push(`- Previously seen modules: ${profile.knownModules.join(", ")}`);
    }
    if (profile.knownAlgorithms.length > 0) {
      profileLines.push(`- Previously catalogued algorithms: ${profile.knownAlgorithms.join(", ")}`);
    }
    if (profile.knownPatterns.length > 0) {
      profileLines.push(`- Recurring patterns: ${profile.knownPatterns.slice(0, 20).join(", ")}`);
    }
    if (profile.expertiseSummary) {
      profileLines.push(`- Expertise focus: ${profile.expertiseSummary}`);
    }
    if (recentGoals.length > 0) {
      profileLines.push(`- Recent prior summaries:`);
      for (const g of recentGoals.slice(0, 5)) {
        profileLines.push(`  • ${g.slice(0, 240)}`);
      }
    }
  }
  return profileLines.length > 0
    ? `\n\n## PRIOR-SESSION CONTEXT\n${profileLines.join("\n")}\n\nUse this context to avoid re-deriving known facts and to focus on novel findings.`
    : "";
}

export async function buildEnrichedSystemPrompt(userInstructions: string): Promise<string> {
  const [profile, recentGoals] = await Promise.all([loadUserProfile(), getRecentGoals(10)]);
  const enrichment = basePrompt(userInstructions, profile, recentGoals);
  return `You are an elite automotive reverse engineering AI — a 40-year seasoned expert in cracking and reverse engineering FCA/Stellantis module firmware.

## USER INSTRUCTIONS FOR THIS ANALYSIS
${userInstructions}${enrichment}

Perform an EXHAUSTIVE, SURGICAL analysis of this binary. Extract every seed/key algorithm, security byte region, CAN address, checksum, crypto constant, memory map, UDS sequence, boot mode sequence, VIN handling routine, GPEC unlock, BCM PIN storage, RFHUB pairing, ECM calibration, and anything else relevant to programming, cloning, or unlocking the module.`;
}

export async function buildReanalysisPrompt(
  userInstructions: string,
  priorSummary: string,
  passNumber: number,
): Promise<string> {
  const [profile, recentGoals] = await Promise.all([loadUserProfile(), getRecentGoals(5)]);
  const enrichment = basePrompt(userInstructions, profile, recentGoals);
  return `You are an elite automotive reverse engineering AI performing PASS ${passNumber} of a deep binary analysis.

## WHAT PASS ${passNumber - 1} ALREADY FOUND
${priorSummary}

## USER INSTRUCTIONS FOR THIS PASS
${userInstructions}${enrichment}

Find what was MISSED. Go deeper than the previous pass — full pseudocode for any partial algorithm, every byte mapped for any partial security region, complete UDS sequences, complete CAN address sets, new findings not in prior passes.`;
}

export async function saveAnalysisGoals(
  analysisId: string,
  userInstructions: string,
  analysisResult: unknown,
  userId: string = SYSTEM_USER_ID,
): Promise<void> {
  try {
    const extracted = extractFindings(analysisResult);
    const now = Date.now();

    await db
      .insert(analysisGoals)
      .values({
        id: randomUUID(),
        analysisId,
        userId,
        userInstructions,
        summary: extracted.summary,
        keyFindings: extracted.keyFindings,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: analysisGoals.analysisId,
        set: {
          userInstructions,
          summary: extracted.summary,
          keyFindings: extracted.keyFindings,
        },
      });

    const existing = await db
      .select()
      .from(userProfile)
      .where(eq(userProfile.userId, userId))
      .limit(1);

    const currentModules = existing.length > 0 ? asStringArray(existing[0].knownModules) : [];
    const currentAlgorithms = existing.length > 0 ? asStringArray(existing[0].knownAlgorithms) : [];
    const currentPatterns = existing.length > 0 ? asStringArray(existing[0].knownPatterns) : [];
    const currentSessions = existing.length > 0 ? existing[0].totalSessions ?? 0 : 0;

    const mergedModules = mergeUnique(currentModules, extracted.modules);
    const mergedAlgorithms = mergeUnique(currentAlgorithms, extracted.algorithms);
    const mergedPatterns = mergeUnique(currentPatterns, extracted.patterns);
    const nextSessions = currentSessions + 1;
    const expertiseSummary =
      `${nextSessions} analyses; ${mergedModules.length} modules, ${mergedAlgorithms.length} algorithms catalogued.`;

    if (existing.length === 0) {
      await db.insert(userProfile).values({
        id: randomUUID(),
        userId,
        totalSessions: nextSessions,
        knownModules: mergedModules,
        knownAlgorithms: mergedAlgorithms,
        knownPatterns: mergedPatterns,
        expertiseSummary,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: userProfile.userId,
        set: {
          totalSessions: nextSessions,
          knownModules: mergedModules,
          knownAlgorithms: mergedAlgorithms,
          knownPatterns: mergedPatterns,
          expertiseSummary,
          updatedAt: now,
        },
      });
    } else {
      await db
        .update(userProfile)
        .set({
          totalSessions: nextSessions,
          knownModules: mergedModules,
          knownAlgorithms: mergedAlgorithms,
          knownPatterns: mergedPatterns,
          expertiseSummary,
          updatedAt: now,
        })
        .where(eq(userProfile.userId, userId));
    }
  } catch (err) {
    console.error("[ai-learning] saveAnalysisGoals failed:", (err as Error).message);
  }
}
