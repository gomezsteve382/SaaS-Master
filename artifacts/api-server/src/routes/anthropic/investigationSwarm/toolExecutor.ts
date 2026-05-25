/**
 * Tool executor for the Investigation Swarm.
 *
 * Wraps the shared TOOL_REGISTRY and adds three swarm-only stub tools:
 *   - uds_static_decode  — decodes known UDS service/NRC bytes statically
 *   - pattern_lookup     — looks up signatures in a static in-memory dict
 *   - kg_query           — queries a minimal in-memory knowledge graph stub
 *
 * Read-only is enforced here at the dispatch layer: any tool name in
 * FORBIDDEN_TOOLS raises ForbiddenToolError before the handler runs.
 */

import { TOOL_REGISTRY, MAX_TOOL_RESULT_BYTES } from "../toolRegistry";
import { FORBIDDEN_TOOLS, type ReadOnlyTool } from "./agents";

export class ForbiddenToolError extends Error {
  constructor(public readonly toolName: string) {
    super(`Forbidden tool called in swarm context: "${toolName}"`);
    this.name = "ForbiddenToolError";
  }
}

/* ── Static UDS decode table ──────────────────────────────────────────── */

const UDS_SERVICES: Record<number, string> = {
  0x10: "DiagnosticSessionControl",
  0x11: "ECUReset",
  0x14: "ClearDiagnosticInformation",
  0x19: "ReadDTCInformation",
  0x22: "ReadDataByIdentifier",
  0x23: "ReadMemoryByAddress",
  0x27: "SecurityAccess",
  0x28: "CommunicationControl",
  0x29: "Authentication (0x29 — not 0x27)",
  0x2C: "DynamicallyDefineDataIdentifier",
  0x2E: "WriteDataByIdentifier",
  0x2F: "InputOutputControlByIdentifier",
  0x31: "RoutineControl",
  0x34: "RequestDownload",
  0x35: "RequestUpload",
  0x36: "TransferData",
  0x37: "RequestTransferExit",
  0x3D: "WriteMemoryByAddress",
  0x3E: "TesterPresent",
  0x50: "DiagnosticSessionControl (response)",
  0x51: "ECUReset (response)",
  0x62: "ReadDataByIdentifier (response)",
  0x67: "SecurityAccess (response)",
  0x6F: "Authentication (response)",
  0x7E: "TesterPresent (response)",
  0x7F: "NegativeResponse",
};

const UDS_NRCS: Record<number, string> = {
  0x10: "generalReject",
  0x11: "serviceNotSupported",
  0x12: "subFunctionNotSupported",
  0x13: "incorrectMessageLengthOrInvalidFormat",
  0x14: "responseTooLong",
  0x21: "busyRepeatRequest",
  0x22: "conditionsNotCorrect",
  0x24: "requestSequenceError",
  0x25: "noResponseFromSubnetComponent",
  0x26: "failurePreventsExecutionOfRequestedAction",
  0x31: "requestOutOfRange",
  0x33: "securityAccessDenied",
  0x35: "invalidKey",
  0x36: "exceededNumberOfAttempts",
  0x37: "requiredTimeDelayNotExpired",
  0x70: "uploadDownloadNotAccepted",
  0x71: "transferDataSuspended",
  0x72: "generalProgrammingFailure",
  0x73: "wrongBlockSequenceCounter",
  0x78: "requestCorrectlyReceived-ResponsePending",
  0x7E: "subFunctionNotSupportedInActiveSession",
  0x7F: "serviceNotSupportedInActiveSession",
  0x92: "voltageTooHigh",
  0x93: "voltageTooLow",
};

function handleUdsStaticDecode(args: Record<string, unknown>): string {
  const bytes = String(args.bytes || "").trim();
  if (!bytes) return "Error: bytes argument is required (hex string, e.g. '7F 22 31').";
  const hexParts = bytes.split(/\s+/).filter(Boolean);
  if (hexParts.length === 0) return "Error: no bytes provided.";
  const decoded = hexParts.map((h) => {
    const val = parseInt(h, 16);
    if (isNaN(val)) return `0x${h}: (invalid)`;
    const svc = UDS_SERVICES[val];
    const nrc = UDS_NRCS[val];
    if (svc) return `0x${h.toUpperCase()}: ${svc}`;
    if (nrc) return `0x${h.toUpperCase()}: NRC ${nrc}`;
    return `0x${h.toUpperCase()}: (unknown)`;
  });
  return `UDS static decode:\n${decoded.join("\n")}`;
}

/* ── Pattern library (static in-memory stub) ──────────────────────────── */

const PATTERN_SIGNATURES: Array<{
  id: string;
  name: string;
  description: string;
  hexPattern?: string;
  tags: string[];
}> = [
  {
    id: "mirrored_aes_secret",
    name: "Mirrored AES-128 Secret Block",
    description:
      "A 16-byte block appearing verbatim and byte-reversed at two offsets. Common in FCA BCM/RFHUB SEC16 pairing — the BCM stores reverse(RFHUB_SEC16). Entropy floor: ≥10 unique bytes, ≤2 zeros, ≤2 0xFF bytes.",
    tags: ["crypto", "sec16", "bcm", "rfhub"],
  },
  {
    id: "fca_vin_wmi_1c",
    name: "FCA WMI 1C (Chrysler/Jeep — US plant)",
    description: "VIN starting with 1C — North American Chrysler/Jeep plant WMI prefix.",
    hexPattern: "31 43",
    tags: ["vin", "wmi", "chrysler"],
  },
  {
    id: "fca_vin_wmi_2c",
    name: "FCA WMI 2C (Chrysler — Canada plant)",
    description: "VIN starting with 2C — Canadian Chrysler plant WMI prefix.",
    hexPattern: "32 43",
    tags: ["vin", "wmi", "chrysler"],
  },
  {
    id: "fca_vin_wmi_3c",
    name: "FCA WMI 3C (Chrysler — Mexico plant)",
    description: "VIN starting with 3C — Mexican Chrysler plant WMI prefix.",
    hexPattern: "33 43",
    tags: ["vin", "wmi", "chrysler"],
  },
  {
    id: "fca_did_f190",
    name: "FCA DID 0xF190 (VIN)",
    description:
      "UDS DID 0xF190 is the standardised ISO 15031 VIN DID. FCA modules respond with 17 ASCII bytes.",
    hexPattern: "F1 90",
    tags: ["did", "vin", "uds"],
  },
  {
    id: "fca_did_2023",
    name: "FCA DID 0x2023 (BCM BODY_PN_CONFIG)",
    description: "BCM proxi blob DID — 16 bytes of feature flags decoded by ProxiTab.",
    hexPattern: "20 23",
    tags: ["did", "bcm", "proxi"],
  },
  {
    id: "fca_did_de00",
    name: "FCA DID 0xDE00–0xDE0C (BCM DEnn features)",
    description:
      "DEnn family: 155-field BCM feature configuration (DRL, horn chirp, auto-lock, etc.).",
    tags: ["did", "bcm", "feature"],
  },
  {
    id: "fca_gpec2a_skim_byte",
    name: "GPEC2A SKIM byte at 0x0011",
    description:
      "0x80 = SKIM enabled (standard), 0x00 = SKIM bypassed (SkimStar unlock applied), 0x40 = learning mode.",
    hexPattern: "80",
    tags: ["skim", "gpec2a", "immobilizer"],
  },
  {
    id: "fca_rfhub_fobik_marker",
    name: "RFHUB FOBIK slot marker 0xAA 0x50",
    description:
      "Delimits each FOBIK transponder key record in the RFHUB EEPROM. Count populated slots to determine how many keys are programmed.",
    hexPattern: "AA 50",
    tags: ["fobik", "rfhub", "immobilizer"],
  },
  {
    id: "fca_gpec2a_unlock_sig",
    name: "GPEC2A Unlock Signature (ZZZZ tamper block)",
    description:
      "17 bytes at GPEC2A 0x0888: all 0xFF = tamper block intact (SKIM locked). Cleared by GPEC2A unlock process (SkimStar / VILLAIN routine 0x0202).",
    tags: ["gpec2a", "unlock", "tamper"],
  },
];

function handlePatternLookup(args: Record<string, unknown>): string {
  const query = String(args.query || "").toLowerCase().trim();
  if (!query) return "Error: query argument is required.";
  const results = PATTERN_SIGNATURES.filter(
    (p) =>
      p.id.includes(query) ||
      p.name.toLowerCase().includes(query) ||
      p.description.toLowerCase().includes(query) ||
      p.tags.some((t) => t.includes(query)),
  );
  if (results.length === 0)
    return `No patterns found matching "${query}". Available tags: crypto, sec16, vin, wmi, did, bcm, rfhub, gpec2a, skim, fobik, immobilizer, proxi, unlock, tamper.`;
  const lines = [`Pattern library: ${results.length} match(es) for "${query}"`, ""];
  for (const r of results.slice(0, 10)) {
    lines.push(`[${r.id}] ${r.name}`);
    lines.push(`  ${r.description}`);
    if (r.hexPattern) lines.push(`  Hex pattern: ${r.hexPattern}`);
    lines.push(`  Tags: ${r.tags.join(", ")}`);
    lines.push("");
  }
  const out = lines.join("\n");
  return out.length > MAX_TOOL_RESULT_BYTES
    ? out.slice(0, MAX_TOOL_RESULT_BYTES) + "\n…[truncated]"
    : out;
}

/* ── Knowledge graph stub ─────────────────────────────────────────────── */

const KG_NODES: Array<{
  type: string;
  id: string;
  label: string;
  description: string;
  relations: string[];
}> = [
  {
    type: "module",
    id: "bcm_mpc5606b",
    label: "BCM MPC5606B",
    description:
      "FCA Body Control Module — NXP MPC5606B SoC. DFLASH: 64 KB (standard) or 128 KB (Trackhawk/Redeye). Stores VIN, SEC16, FOBIK keys, proxi blob, immo block.",
    relations: ["paired_with:rfhub_yazaki_fcm", "synced_with:gpec2a_95320", "synced_with:gpec2a_95640"],
  },
  {
    type: "module",
    id: "rfhub_yazaki_fcm",
    label: "RFHUB Yazaki FCM",
    description:
      "FCA Remote/FOBIK Hub — Yazaki FCM EEPROM. Gen1: 24C16 (2 KB), Gen2: 24C32 (4 KB). Stores byte-reversed VIN, SEC16 (master), FOBIK transponder slots.",
    relations: ["paired_with:bcm_mpc5606b", "sec16_source_for:gpec2a_95320"],
  },
  {
    type: "module",
    id: "gpec2a_95320",
    label: "GPEC2A PCM (95320 4 KB)",
    description:
      "Continental GPEC2A Powertrain Control Module — 95320 4 KB EXT EEPROM. Stores VIN at 4 slots, SEC6 (= first 6 bytes of RFHUB SEC16), SKIM byte at 0x0011.",
    relations: ["sec6_derived_from:rfhub_yazaki_fcm", "skim_controlled_by:rfhub_yazaki_fcm"],
  },
  {
    type: "module",
    id: "gpec2a_95640",
    label: "GPEC2A PCM (95640 8 KB)",
    description:
      "Continental GPEC2A Powertrain Control Module — 95640 8 KB EXT EEPROM. Same layout as 95320 but 8 KB. Appears on higher-output engine variants.",
    relations: ["sec6_derived_from:rfhub_yazaki_fcm"],
  },
  {
    type: "algorithm",
    id: "sec16_pairing",
    label: "SEC16 Cross-Module Pairing Rule",
    description:
      "BCM.SEC16 = reverse(RFHUB.SEC16). PCM.SEC6 = RFHUB.SEC16[0:6]. Verification: read 16 bytes from BCM immo block, reverse, compare to RFHUB SEC16 at offset 0x00. Mismatch = modules from different vehicles.",
    relations: ["governs:bcm_mpc5606b", "governs:rfhub_yazaki_fcm", "governs:gpec2a_95320"],
  },
  {
    type: "algorithm",
    id: "fca_seed_key_standard",
    label: "FCA Seed-to-Key 0x01/0x02 (Standard)",
    description:
      "Standard FCA SecurityAccess level. 4-byte seed XORed with module-specific constants derived from part number. Used for BCM, RFHUB, most PCMs.",
    relations: ["used_by:bcm_mpc5606b", "used_by:rfhub_yazaki_fcm"],
  },
  {
    type: "vehicle",
    id: "lx_platform",
    label: "FCA LX Platform (Charger/Challenger/300)",
    description:
      "Dodge Charger, Dodge Challenger, Chrysler 300. MY2011+. BCM: MPC5605B/06B. RFHUB: Yazaki FCM Gen1/Gen2. PCM: Continental GPEC2A/GPEC5.",
    relations: ["uses:bcm_mpc5606b", "uses:rfhub_yazaki_fcm", "uses:gpec2a_95320"],
  },
];

function handleKgQuery(args: Record<string, unknown>): string {
  const query = String(args.query || "").toLowerCase().trim();
  if (!query) return "Error: query argument is required.";
  const results = KG_NODES.filter(
    (n) =>
      n.id.includes(query) ||
      n.label.toLowerCase().includes(query) ||
      n.description.toLowerCase().includes(query) ||
      n.type.includes(query),
  );
  if (results.length === 0)
    return `No KG nodes found matching "${query}". Try: bcm, rfhub, gpec2a, sec16, skim, algorithm, vehicle, lx.`;
  const lines = [`Knowledge graph: ${results.length} node(s) for "${query}"`, ""];
  for (const n of results.slice(0, 8)) {
    lines.push(`[${n.type}] ${n.label} (${n.id})`);
    lines.push(`  ${n.description}`);
    if (n.relations.length) lines.push(`  Relations: ${n.relations.join(", ")}`);
    lines.push("");
  }
  const out = lines.join("\n");
  return out.length > MAX_TOOL_RESULT_BYTES
    ? out.slice(0, MAX_TOOL_RESULT_BYTES) + "\n…[truncated]"
    : out;
}

/* ── Swarm-only tool schemas (passed to the Anthropic API) ───────────── */

export const SWARM_ONLY_TOOL_SCHEMAS = {
  uds_static_decode: {
    name: "uds_static_decode",
    description:
      "Decode one or more UDS service/NRC bytes statically from a hex string. Returns the standard ISO 14229 name for each byte. Useful for interpreting raw protocol bytes found in the dump.",
    input_schema: {
      type: "object" as const,
      properties: {
        bytes: {
          type: "string",
          description: 'Space-separated hex bytes to decode, e.g. "7F 22 31" or "27 67".',
        },
      },
      required: ["bytes"],
    },
  },
  pattern_lookup: {
    name: "pattern_lookup",
    description:
      "Look up a query string against the SRT Lab pattern library — a curated set of known FCA cryptographic signatures, DID constants, and module-specific markers. Returns matching entries with descriptions and hex patterns.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            'Search term — e.g. "mirrored_aes", "fobik", "sec16", "skim", "proxi", "gpec2a".',
        },
      },
      required: ["query"],
    },
  },
  kg_query: {
    name: "kg_query",
    description:
      "Query the SRT Lab knowledge graph for module relationships, algorithm descriptions, and vehicle platform context. Use to understand how modules relate (e.g. BCM↔RFHUB SEC16 pairing rule) or which platforms use a given module.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: 'Search term — e.g. "bcm", "sec16 pairing", "lx platform", "seed key".',
        },
      },
      required: ["query"],
    },
  },
};

/* ── Unified tool schema array for a given agent ─────────────────────── */

export function buildToolsForAgent(allowedTools: ReadOnlyTool[]) {
  return allowedTools.map((name) => {
    if (name in SWARM_ONLY_TOOL_SCHEMAS)
      return SWARM_ONLY_TOOL_SCHEMAS[name as keyof typeof SWARM_ONLY_TOOL_SCHEMAS];
    const def = TOOL_REGISTRY[name];
    if (!def) throw new Error(`Tool "${name}" not found in registry`);
    return def.schema;
  });
}

/* ── Main executor ───────────────────────────────────────────────────── */

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  primaryBuf: Buffer,
  binaries: Record<string, Buffer>,
): Promise<string> {
  if (FORBIDDEN_TOOLS.includes(toolName)) {
    throw new ForbiddenToolError(toolName);
  }

  if (toolName === "uds_static_decode") return handleUdsStaticDecode(args);
  if (toolName === "pattern_lookup") return handlePatternLookup(args);
  if (toolName === "kg_query") return handleKgQuery(args);

  const def = TOOL_REGISTRY[toolName];
  if (!def) return `Error: unknown tool "${toolName}"`;
  if (primaryBuf.length === 0)
    return "Error: no binary loaded — upload a module file to enable tool inspection.";

  try {
    const result = await def.handler(primaryBuf, binaries, args);
    return result.slice(0, MAX_TOOL_RESULT_BYTES);
  } catch (e) {
    return `Error: tool execution failed — ${e instanceof Error ? e.message : String(e)}`;
  }
}
