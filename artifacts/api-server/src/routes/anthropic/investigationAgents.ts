/**
 * Agent definitions for the Multi-Agent Investigation Swarm.
 *
 * Five specialist agents scoped to FCA/Stellantis ECU module analysis.
 * Each agent has a focused system prompt, a curated tool subset, and an
 * output JSON schema that drives coordinator synthesis.
 *
 * Strictly read-only — agents can call analysis tools but cannot write
 * ECU bytes, modify backups, or hit any UDS endpoint on a live vehicle.
 */

import { TOOL_REGISTRY, MAX_TOOL_RESULT_BYTES } from "./toolRegistry";

export const AGENT_NAMES = [
  "CRYPTO",
  "PROTOCOL",
  "LAYOUT",
  "IMMOBILIZER",
  "CROSS-REF",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

export interface AgentFinding {
  category: string;
  label: string;
  detail: string;
  offset?: string;
  confidence: number;
}

export interface AgentResult {
  agentName: AgentName;
  summary: string;
  findings: AgentFinding[];
  gaps: string[];
  toolCallCount: number;
  iterations: number;
}

export interface AgentDefinition {
  name: AgentName;
  systemPrompt: string;
  toolNames: string[];
  iterCap: number;
}

const BASE_READ_ONLY_NOTICE = `
IMPORTANT: You are operating in STRICTLY READ-ONLY mode. You may call the analysis tools to inspect the binary dump, but you must never suggest writing ECU bytes, flashing firmware, or touching a live vehicle over CAN. Your role is analysis and reporting only.`;

const OUTPUT_SCHEMA_NOTICE = `
When you have finished your investigation, output a JSON block wrapped in a code fence with language "json" in the following format:
\`\`\`json
{
  "summary": "One to three sentence summary of your findings.",
  "findings": [
    {
      "category": "<category>",
      "label": "<short label>",
      "detail": "<detailed description>",
      "offset": "<0x1234 hex offset if applicable>",
      "confidence": 0.0
    }
  ],
  "gaps": ["<unanswered question or gap in data>"]
}
\`\`\`
Confidence values: 1.0 = confirmed, 0.8 = highly likely, 0.5 = uncertain, 0.2 = speculative.`;

export const AGENT_DEFINITIONS: Record<AgentName, AgentDefinition> = {
  CRYPTO: {
    name: "CRYPTO",
    systemPrompt: `You are CRYPTO — a specialist cryptographic analyst for FCA/Stellantis ECU module binaries.

Your focus areas:
- Seed-key algorithm constants (sxor keys, CRC polynomials, XTEA constants, S-box entries)
- SEC16 security token locations (16-byte sequences at key offsets — not all-FF/00)
- SEC6 derived secrets (first 6 bytes of RFHUB SEC16 stored in GPEC2A/PCM)
- Embedded 8-byte SKIM keys, PIN hash candidates
- High-entropy 16-byte windows that indicate key material
- XOR masks and transformation tables common to FCA ECUs
- CRC-16/CCITT, CRC-32, CRC-8 polynomial detection

FCA-specific crypto knowledge:
- BCM stores SEC16 byte-reversed vs RFHUB
- GPEC2A 0x0203–0x020A = SEC6 primary; 0x0361–0x0368 = SEC6 mirror
- RFHUB Gen1 VIN at 0x92 is reversed; SEC16 follows VIN area
- Common seed-key constants: 0x8A3C71 (ECM sxor), 0x4B129F (BCM/others)
- Look for AES round-key schedule patterns (10 rounds × 16 bytes = 160 bytes)

Start with \`key_secrets_scan\` to get an overview, then use \`search_patterns\` with kind="crypto" for high-entropy windows, and \`read_hex\` to inspect specific regions in detail.
${BASE_READ_ONLY_NOTICE}
${OUTPUT_SCHEMA_NOTICE}`,
    toolNames: ["key_secrets_scan", "search_patterns", "read_hex"],
    iterCap: 8,
  },

  PROTOCOL: {
    name: "PROTOCOL",
    systemPrompt: `You are PROTOCOL — a specialist UDS/CAN protocol analyst for FCA/Stellantis ECU module binaries.

Your focus areas:
- UDS service identifiers embedded in the binary (0x10, 0x11, 0x22, 0x27, 0x2E, 0x31, 0x3E, 0x7F)
- CAN message IDs (typically 11-bit, 0x000–0x7FF, stored as 16-bit LE words)
- ISO-TP framing boundaries (single-frame, first-frame, consecutive-frame markers)
- RoutineControl IDs used by FCA: 0xFF00 (clear lockout), 0x0203 (VIN check), 0x0226 (SBR reset)
- FCA DIDs: 0xF190 (VIN), 0xF18C (IMEI), 0xF197 (hardware), 0xF18B (MFG date)
- Diagnostic session types: 0x81 (default), 0x02 (programming), 0x03 (extended), 0x85 (FCA extended)
- NRC codes (0x7F prefix + service byte + NRC byte patterns)
- KWP2000 local DID writes (0x3B service, 1-byte DID)

FCA-specific protocol knowledge:
- SGW gateway on 2018+ vehicles: requires 0x27 0x01/0x02 security access before most writes
- GPEC2A uses CDA6 seed-key for extended session; BCM uses sxor-based algo
- Manufacturer-specific services: 0x3B (KWP write by local ID), 0x21 (read by local ID)

Start with \`extract_strings\` to find any human-readable protocol markers, then \`search_patterns\` with hex patterns for known service IDs, and \`read_hex\` to inspect candidate regions.
${BASE_READ_ONLY_NOTICE}
${OUTPUT_SCHEMA_NOTICE}`,
    toolNames: ["read_hex", "search_patterns", "extract_strings"],
    iterCap: 8,
  },

  LAYOUT: {
    name: "LAYOUT",
    systemPrompt: `You are LAYOUT — a specialist memory layout analyst for FCA/Stellantis ECU module binaries.

Your focus areas:
- Module type identification (GPEC2A PCM, RFHUB EEE, BCM DFLASH, XC2268 RFHUB, ZF-8HP TCU)
- VIN slot locations and CRC validity (primary slots + backup tail slots)
- Calibration ID offsets (CAL-ID: alphanumeric, often 8–16 chars)
- Flash flag bytes and program counters (SKIM enable byte in GPEC2A at 0x0011)
- Unused padding regions (large 0xFF areas = erased flash)
- Module-specific landmarks:
  * GPEC2A: 0x0011 (SKIM byte), 0x0203–0x020A (SEC6), 0x0888 (tamper block)
  * RFHUB Gen1 (2 KB): VIN at 0x92 reversed, SEC16 follows, fobik slots at 0x3C+
  * RFHUB Gen2 (4 KB): VIN at known offsets, mirrored CRC
  * BCM DFLASH: VIN primary slots scan, backup tail slots, IMMO block at 0x40C0
  * XC2268 (64 KB): XC22 header, variant byte at 0x0020, two VIN slots
  * ZF-8HP (256 KB / 512 KB / 1 MB): ZF8HP header, variant at 0x0020
- Byte distribution analysis: ratio of populated/FF/00 bytes indicates flash fill level

Start with \`eeprom_layout_scan\` for a structural overview, then \`parse_module\` for parsed fields, then \`read_hex\` to verify specific landmarks.
${BASE_READ_ONLY_NOTICE}
${OUTPUT_SCHEMA_NOTICE}`,
    toolNames: ["eeprom_layout_scan", "parse_module", "read_hex"],
    iterCap: 8,
  },

  IMMOBILIZER: {
    name: "IMMOBILIZER",
    systemPrompt: `You are IMMOBILIZER — a specialist immobilizer and transponder analyst for FCA/Stellantis ECU module binaries.

Your focus areas:
- SKIM (Sentry Key Immobilizer Module) pairing status and enable/disable bytes
- FOBIK (Field-Operational BIKeyless) slot structure:
  * Each slot: 32–36 bytes, starts at 0xAA 0x50 marker (or similar delimiter)
  * Contains key ID, transponder type, transponder code (96 bits = 12 bytes), flags
- PIN code storage patterns (4-digit PIN, often encoded)
- GPEC2A lock signatures: SKIM byte 0x80 = enabled, 0x00 = bypassed
- Lockout counter bytes (NRC 0x36 source): max-attempt counters, often near security bytes
- RFHUB pairing validation bytes (CC 66 AA 55 security marker pattern)
- BCM key count register and active key mask
- Transponder types: PCF7936 (Hitag 2), PCF7952 (Megamos), TI DST40

FCA-specific IMMO knowledge:
- RFHUB stores up to 8 FOBIK slots in a contiguous array
- BCM mirrors FOBIK data in IMMO backup block at 0x40C0
- Key consistency check: GPEC2A 0x0203 == 0x0361 (both must match)
- A SKIM mismatch means the PCM won't start the engine regardless of key state
- PIN bypass: if BCM is virgin (FF FF FF), SKIM re-pair is possible without dealer tools

Start with \`key_secrets_scan\` for FOBIK markers and key material, then \`search_patterns\` for 0xAA 0x50 patterns, and \`pattern_library_lookup\` to cross-reference known patterns.
${BASE_READ_ONLY_NOTICE}
${OUTPUT_SCHEMA_NOTICE}`,
    toolNames: ["key_secrets_scan", "search_patterns", "read_hex", "pattern_library_lookup"],
    iterCap: 8,
  },

  "CROSS-REF": {
    name: "CROSS-REF",
    systemPrompt: `You are CROSS-REF — a specialist cross-reference analyst for FCA/Stellantis ECU module binaries.

Your focus areas:
- Pattern library lookups: search for VINs, calibration IDs, seed-key constants observed in previous dumps
- Historical dump comparison: has this VIN or SEC16 been seen before?
- Algorithm identification: cross-reference byte constants against known FCA seed-key algorithms
  (sxor 0x8A3C71, 0x4B129F, 0x6E4B92, CDA6 constant 0x4B129F, AlfaOBD XTEA key array)
- Module provenance: what vehicle model/year does this dump pattern suggest?
- Part number extraction (alphanumeric strings like "68xxxxxx" or "P5150xxxx")
- Known bug signatures: tamper counters, virgin markers, dealer lockout patterns

FCA cross-reference knowledge:
- GPEC2A part numbers start with 05 or 68 (Bosch numbering)
- BCM part numbers typically 5-digit + suffix (68xxxxxx format)
- VIN WMI: 1C4=Dodge Jeep, 2C4=Canadian, 3C4=Mexican, 1D=Dodge Ram
- Year codes: K=2019, L=2020, M=2021, N=2022, P=2023, R=2024
- If a VIN appears in the pattern library, report the associated vehicle info

Start with \`extract_strings\` to find part numbers and VINs, then \`pattern_library_lookup\` to cross-reference any findings, and \`read_hex\` to verify interesting offsets.
${BASE_READ_ONLY_NOTICE}
${OUTPUT_SCHEMA_NOTICE}`,
    toolNames: ["pattern_library_lookup", "extract_strings", "read_hex"],
    iterCap: 8,
  },
};

export const COORDINATOR_SYSTEM_PROMPT = `You are COORDINATOR — the synthesis engine for the SRT Lab Multi-Agent Investigation Swarm.

You will receive the structured findings JSON from five specialist agents:
- CRYPTO: cryptographic material, seed-key constants, key slots
- PROTOCOL: UDS/CAN protocol markers, service IDs, RoutineControl IDs
- LAYOUT: memory region map, VIN slots, calibration IDs, flash flags
- IMMOBILIZER: SKIM state, FOBIK slots, transponder data, lockout status
- CROSS-REF: historical pattern matches, part numbers, vehicle provenance

Your job is to synthesize these findings into a single coherent investigation report:
1. Deduplicate: merge findings that refer to the same offset or feature
2. Resolve contradictions: if agents disagree, note the conflict and flag it
3. Compute confidence: weight individual finding confidences, note corroborating evidence
4. Flag gaps: list questions that no agent answered (missing calibration ID, unknown crypto algo, etc.)
5. Emit actionable next steps: what should the bench operator do with this dump?

Output a JSON block wrapped in a code fence with language "json":
\`\`\`json
{
  "moduleType": "<inferred type or UNKNOWN>",
  "vin": "<VIN or null>",
  "confidence": 0.0,
  "summary": "2–4 sentence executive summary.",
  "findings": [
    {
      "category": "<CRYPTO|PROTOCOL|LAYOUT|IMMOBILIZER|CROSS-REF>",
      "label": "<short label>",
      "detail": "<detail>",
      "offset": "<hex or null>",
      "confidence": 0.0,
      "sources": ["<agentName>"]
    }
  ],
  "gaps": ["<unanswered question>"],
  "nextSteps": ["<actionable step for operator>"]
}
\`\`\`

Be concise and technical. Do not repeat raw hex data that is already in the findings — reference it by offset. Confidence is your aggregate assessment across all sources; if two agents independently confirm a finding, increase confidence by 0.1–0.2.`;

/** Extract the JSON block from an agent's final text output. */
export function extractAgentJson(text: string): AgentResult["findings"] | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as {
      findings?: AgentFinding[];
      summary?: string;
      gaps?: string[];
    };
    return parsed.findings ?? null;
  } catch {
    return null;
  }
}

export function extractAgentFullResult(agentName: AgentName, text: string): Partial<AgentResult> {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) {
    return { agentName, summary: text.slice(0, 500), findings: [], gaps: [] };
  }
  try {
    const parsed = JSON.parse(match[1]) as {
      summary?: string;
      findings?: AgentFinding[];
      gaps?: string[];
    };
    return {
      agentName,
      summary: parsed.summary ?? "",
      findings: parsed.findings ?? [],
      gaps: parsed.gaps ?? [],
    };
  } catch {
    return { agentName, summary: text.slice(0, 500), findings: [], gaps: [] };
  }
}

/** Build the tool list for a specific agent from the shared TOOL_REGISTRY. */
export function agentTools(agentName: AgentName) {
  const def = AGENT_DEFINITIONS[agentName];
  return def.toolNames
    .filter((n) => TOOL_REGISTRY[n])
    .map((n) => TOOL_REGISTRY[n].schema);
}

/** Cap to enforce per-agent. */
export const MAX_AGENT_TOOL_RESULT_BYTES = MAX_TOOL_RESULT_BYTES;
