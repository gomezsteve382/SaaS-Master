/**
 * Cross-session learning helpers.
 *
 * NOTE: The original implementation queried `user_profile` and `analysis_goals`
 * tables that were never ported from the MySQL schema. Until those tables are
 * added to `drizzle/schema.ts` and migrated, these functions return safe
 * defaults and the "learning" feature is effectively disabled.
 */
import { randomUUID as _randomUUID } from "crypto";
void _randomUUID;

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

export async function loadUserProfile(): Promise<UserProfile> {
  return EMPTY_PROFILE;
}

export async function getRecentGoals(_limit = 10): Promise<string[]> {
  return [];
}

export async function buildEnrichedSystemPrompt(
  userInstructions: string,
): Promise<string> {
  return `You are an elite automotive reverse engineering AI — a 40-year seasoned expert in cracking and reverse engineering FCA/Stellantis module firmware.

## USER INSTRUCTIONS FOR THIS ANALYSIS
${userInstructions}

Perform an EXHAUSTIVE, SURGICAL analysis of this binary. Extract every seed/key algorithm, security byte region, CAN address, checksum, crypto constant, memory map, UDS sequence, boot mode sequence, VIN handling routine, GPEC unlock, BCM PIN storage, RFHUB pairing, ECM calibration, and anything else relevant to programming, cloning, or unlocking the module.`;
}

export async function buildReanalysisPrompt(
  userInstructions: string,
  priorSummary: string,
  passNumber: number,
): Promise<string> {
  return `You are an elite automotive reverse engineering AI performing PASS ${passNumber} of a deep binary analysis.

## WHAT PASS ${passNumber - 1} ALREADY FOUND
${priorSummary}

## USER INSTRUCTIONS FOR THIS PASS
${userInstructions}

Find what was MISSED. Go deeper than the previous pass — full pseudocode for any partial algorithm, every byte mapped for any partial security region, complete UDS sequences, complete CAN address sets, new findings not in prior passes.`;
}

export async function saveAnalysisGoals(
  _analysisId: string,
  _userInstructions: string,
  _analysisResult: unknown,
): Promise<void> {
  // No-op: requires user_profile + analysis_goals tables that haven't been
  // ported to the Postgres schema yet.
}
