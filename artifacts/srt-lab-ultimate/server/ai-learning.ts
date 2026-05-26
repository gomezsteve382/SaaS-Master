import mysql from "mysql2/promise";
import { randomUUID } from "crypto";

// Get a database connection
async function getConn() {
  return mysql.createConnection(process.env.DATABASE_URL as string);
}

export interface UserProfile {
  totalSessions: number;
  knownModules: string[];
  knownAlgorithms: string[];
  knownPatterns: string[];
  expertiseSummary: string;
}

// Load the accumulated user profile from the database
export async function loadUserProfile(): Promise<UserProfile> {
  const conn = await getConn();
  try {
    const [rows] = await conn.execute(
      "SELECT * FROM user_profile WHERE id = 1"
    ) as any[];
    if (rows.length === 0) {
      return {
        totalSessions: 0,
        knownModules: [],
        knownAlgorithms: [],
        knownPatterns: [],
        expertiseSummary: "",
      };
    }
    const row = rows[0];
    return {
      totalSessions: row.total_sessions || 0,
      knownModules: safeParseJSON(row.known_modules, []),
      knownAlgorithms: safeParseJSON(row.known_algorithms, []),
      knownPatterns: safeParseJSON(row.known_patterns, []),
      expertiseSummary: row.expertise_summary || "",
    };
  } finally {
    await conn.end();
  }
}

// Get recent analysis goals for context injection
export async function getRecentGoals(limit = 10): Promise<string[]> {
  const conn = await getConn();
  try {
    const [rows] = await conn.execute(
      "SELECT session_instructions, key_findings FROM analysis_goals ORDER BY created_at DESC LIMIT ?",
      [limit]
    ) as any[];
    return rows.map((r: any) => `Instructions: ${r.session_instructions}\nFindings: ${r.key_findings}`);
  } finally {
    await conn.end();
  }
}

// Build the enriched system prompt with all accumulated knowledge
export async function buildEnrichedSystemPrompt(userInstructions: string): Promise<string> {
  const profile = await loadUserProfile();
  const recentGoals = await getRecentGoals(5);

  const sessionContext = recentGoals.length > 0
    ? `\n\n## Previous Analysis Sessions (${profile.totalSessions} total)\nYou have analyzed ${profile.totalSessions} binaries for this user. Here is context from recent sessions:\n${recentGoals.map((g, i) => `\n### Session ${i + 1}:\n${g}`).join("\n")}`
    : "";

  const knowledgeContext = profile.knownModules.length > 0
    ? `\n\n## Accumulated Knowledge Base\n- Known module types encountered: ${profile.knownModules.join(", ")}\n- Known algorithms found: ${profile.knownAlgorithms.slice(0, 20).join(", ")}\n- Known security patterns: ${profile.knownPatterns.slice(0, 20).join(", ")}\n- Expertise summary: ${profile.expertiseSummary}`
    : "";

  return `You are an elite automotive reverse engineering AI — a 40-year seasoned expert in cracking and reverse engineering FCA/Stellantis module firmware. You have the mindset of a black-hat reverse engineer with full knowledge of FCA module programming, SKIM security systems, CAN bus protocols, UDS diagnostics, and embedded systems.

## USER INSTRUCTIONS FOR THIS ANALYSIS
${userInstructions}

## YOUR MANDATE — NON-NEGOTIABLE
Perform an EXHAUSTIVE, SURGICAL analysis of this binary. Do NOT summarize — extract EVERYTHING. The user is a professional automotive technician performing legitimate module programming and security research on FCA/Stellantis vehicles.

ALWAYS extract ALL of the following:
1. **Seed/Key Algorithms** — Full pseudocode with all constants, XOR masks, shift operations, every variant
2. **SKIM Security Bytes** — Pairing fields, PIN storage (4-digit and 5-digit), secret keys, VIN lock bytes, exact offsets
3. **CAN Bus Addresses** — All diagnostic IDs (0x7DF, 0x740 BCM, 0x742 RFHUB, 0x744 PCM, 0x748 TCM, 0x750 SGW, etc.)
4. **Checksums/CRCs** — Algorithm type, polynomial, seed, start offset, end offset, storage offset
5. **Crypto Constants** — AES S-boxes, XTEA deltas (0x9E3779B9), TEA delta (0xC6EF3720), XOR masks, hash constants
6. **Memory Maps** — Complete region breakdown: EEPROM layout, flash sectors, calibration areas, security zones, VIN storage
7. **UDS Security Sequences** — Security access routines (0x27), seed generation, key calculation, all access levels
8. **Boot Mode Sequences** — Boot loader entry conditions, flash programming sequences, unlock sequences
9. **VIN Handling** — VIN storage offset, VIN validation, VIN programming sequence, VIN lock/unlock
10. **GPEC Unlock** — GPEC-specific unlock sequences, magic bytes (0x96), pairing protocols
11. **BCM PIN Storage** — 4-digit and 5-digit PIN storage offsets, PIN encoding method
12. **RFHUB Pairing** — RFHUB-specific security bytes, key fob pairing sequences, transponder data
13. **ECM Calibrations** — Calibration data regions, tune areas, parameter tables, immobilizer data
14. **Deep Findings** — Anything else relevant to programming, cloning, or unlocking this module${sessionContext}${knowledgeContext}

## ANALYSIS DEPTH REQUIREMENT
This is NOT a surface scan. Go deep. If you find an algorithm, pseudocode it completely. If you find a security byte region, list every byte with its purpose and exact offset. The user needs this to program real modules — be precise, be complete, be surgical. Miss NOTHING.`;
}

// Build the enriched re-analysis prompt with chained context
export async function buildReanalysisPrompt(
  userInstructions: string,
  priorSummary: string,
  passNumber: number
): Promise<string> {
  const profile = await loadUserProfile();
  const recentGoals = await getRecentGoals(3);

  const sessionContext = recentGoals.length > 0
    ? `\n\n## Cross-Session Knowledge (${profile.totalSessions} sessions analyzed)\nKnown modules: ${profile.knownModules.slice(0, 10).join(", ") || "various"}.\nKnown algorithms: ${profile.knownAlgorithms.slice(0, 10).join(", ") || "various"}.\n${profile.expertiseSummary}`
    : "";

  return `You are an elite automotive reverse engineering AI performing PASS ${passNumber} of a deep binary analysis. You have ${profile.totalSessions} prior analysis sessions of experience with this user's FCA/Stellantis modules. You are a black-hat reverse engineer with full knowledge of FCA module programming.${sessionContext}

## WHAT PASS ${passNumber - 1} ALREADY FOUND
${priorSummary}

## USER INSTRUCTIONS FOR THIS PASS
${userInstructions}

## YOUR MANDATE — GO DEEPER THAN PASS ${passNumber - 1}
Pass ${passNumber - 1} found the surface data. Now find what was MISSED. Be surgical:

**ALGORITHMS:** Any algorithm identified but not fully pseudocoded → complete it NOW with full implementation, all constants, every XOR mask, every shift operation.
**SECURITY BYTES:** Any security byte region found but not fully mapped → map EVERY byte with its exact purpose and offset.
**SEED KEYS:** Extract the COMPLETE seed key implementation — all constants, all variants, the full key calculation formula.
**CAN ADDRESSES:** Find the COMPLETE set — all diagnostic IDs, all service IDs, all security access levels.
**UDS SEQUENCES:** Security access routines (0x27), all access levels (01/02, 03/04, 05/06, 09/0A), seed generation, key calculation.
**BOOT MODE:** Boot loader entry conditions, flash programming sequences, programming mode entry, unlock sequences.
**VIN/SKIM:** VIN storage offset, VIN lock bytes, SKIM pairing fields, PIN storage (4-digit and 5-digit), secret key storage.
**GPEC/RFHUB:** GPEC unlock sequences, magic bytes (0x96), RFHUB pairing sequences, transponder data.
**NEW FINDINGS:** Anything in this binary that was NOT in Pass ${passNumber - 1} — new regions, new constants, new patterns.

Be surgical. Pass ${passNumber} must be deeper, more complete, and more precise than every prior pass. Miss NOTHING.`;
}

// Save analysis goals and update user profile after analysis completes
export async function saveAnalysisGoals(
  analysisId: string,
  userInstructions: string,
  analysisResult: any
): Promise<void> {
  const conn = await getConn();
  try {
    // Extract key findings from the analysis result
    const findings = analysisResult.findings || {};
    const algorithms = (findings.algorithms || []).map((a: any) => a.name || a.type || "Unknown").slice(0, 10);
    const moduleTypes = analysisResult.detectedModule ? [analysisResult.detectedModule] : [];
    const patterns = [
      ...(findings.securityBytes || []).map((s: any) => s.region || s.name),
      ...(findings.checksums || []).map((c: any) => c.algorithm || c.type),
    ].filter(Boolean).slice(0, 10);

    const keyFindings = [
      findings.summary || "",
      algorithms.length > 0 ? `Algorithms: ${algorithms.join(", ")}` : "",
      findings.seedKeys?.length > 0 ? `Seed keys: ${findings.seedKeys.length} found` : "",
      findings.canAddresses?.length > 0 ? `CAN addresses: ${findings.canAddresses.length} found` : "",
    ].filter(Boolean).join(". ");

    // Save this session's goals
    await conn.execute(
      `INSERT INTO analysis_goals (id, session_instructions, key_findings, module_types, algorithms_found, security_patterns, created_at, analysis_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        userInstructions,
        keyFindings,
        JSON.stringify(moduleTypes),
        JSON.stringify(algorithms),
        JSON.stringify(patterns),
        Date.now(),
        analysisId,
      ]
    );

    // Update the user profile with accumulated knowledge
    const [profileRows] = await conn.execute("SELECT * FROM user_profile WHERE id = 1") as any[];
    const existing = profileRows[0] || {};

    const existingModules: string[] = safeParseJSON(existing.known_modules, []);
    const existingAlgorithms: string[] = safeParseJSON(existing.known_algorithms, []);
    const existingPatterns: string[] = safeParseJSON(existing.known_patterns, []);

    const updatedModules = Array.from(new Set([...existingModules, ...moduleTypes])).slice(0, 50);
    const updatedAlgorithms = Array.from(new Set([...existingAlgorithms, ...algorithms])).slice(0, 100);
    const updatedPatterns = Array.from(new Set([...existingPatterns, ...patterns])).slice(0, 100);
    const totalSessions = (existing.total_sessions || 0) + 1;

    // Build an expertise summary
    const expertiseSummary = `${totalSessions} sessions analyzed. Primary modules: ${updatedModules.slice(0, 5).join(", ") || "various"}. Key algorithms: ${updatedAlgorithms.slice(0, 5).join(", ") || "various"}.`;

    await conn.execute(
      `UPDATE user_profile SET total_sessions = ?, known_modules = ?, known_algorithms = ?, known_patterns = ?, expertise_summary = ?, last_updated = ? WHERE id = 1`,
      [
        totalSessions,
        JSON.stringify(updatedModules),
        JSON.stringify(updatedAlgorithms),
        JSON.stringify(updatedPatterns),
        expertiseSummary,
        Date.now(),
      ]
    );
  } finally {
    await conn.end();
  }
}

function safeParseJSON(val: any, fallback: any): any {
  if (!val) return fallback;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}
