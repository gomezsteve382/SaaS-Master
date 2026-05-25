/**
 * Tool executor for the Investigation Swarm.
 *
 * Wraps the shared TOOL_REGISTRY and adds three swarm-only tools backed
 * by real SRT Lab data sources:
 *
 *   - uds_static_decode  — decodes UDS service/NRC/DID bytes via the
 *                          `@workspace/uds` SERVICES, NRC_TABLE, and
 *                          DID_CATALOG.
 *   - pattern_lookup     — searches the loaded primary dump bytes for
 *                          the supplied hex pattern and returns matched
 *                          offsets (mirror of the hex-viewer search in
 *                          FcaModuleInspector).
 *   - kg_query           — queries the canonical unlock_catalog.json and
 *                          bcmFeatureCatalog.generated.js for the
 *                          supplied algorithm / service / module / DID /
 *                          feature identifier.
 *
 * Read-only is enforced here at the dispatch layer: any tool name in
 * FORBIDDEN_TOOLS raises ForbiddenToolError before the handler runs.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";

import {
  SERVICES,
  serviceForSid,
  serviceForPosRsp,
  NRC_TABLE,
  nrcEntry,
  DID_CATALOG,
  didEntry,
} from "@workspace/uds";

import { TOOL_REGISTRY, MAX_TOOL_RESULT_BYTES } from "../toolRegistry";
import { FORBIDDEN_TOOLS, type ReadOnlyTool } from "./agents";

export class ForbiddenToolError extends Error {
  constructor(public readonly toolName: string) {
    super(`Forbidden tool called in swarm context: "${toolName}"`);
    this.name = "ForbiddenToolError";
  }
}

/* ── Workspace path resolution ────────────────────────────────────────── */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Find the monorepo root by walking up from a start directory until we
 * find a `pnpm-workspace.yaml`. Works in three environments:
 *   - dev (tsx): start dir is the source tree, walks up to the repo root
 *   - vitest:    same as dev
 *   - prod build: start dir is `artifacts/api-server/dist`, walks up too
 *
 * Optional `cwd` fallback covers the case where the bundle has been
 * moved out of the repo (we accept env-var overrides below regardless).
 */
function findWorkspaceRoot(startDir: string, cwd: string = process.cwd()): string | null {
  for (const start of [startDir, cwd]) {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i++) {
      if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

const WORKSPACE_ROOT = findWorkspaceRoot(__dirname);

function resolveCatalogPath(relPath: string, envVar: string): string | null {
  const override = process.env[envVar];
  if (override && existsSync(override)) return override;
  if (!WORKSPACE_ROOT) return null;
  const resolved = path.resolve(WORKSPACE_ROOT, relPath);
  return existsSync(resolved) ? resolved : null;
}

const UNLOCK_CATALOG_PATH = resolveCatalogPath(
  "artifacts/srt-lab/public/unlock_catalog.json",
  "SRTLAB_UNLOCK_CATALOG_PATH",
);
const BCM_FEATURE_CATALOG_PATH = resolveCatalogPath(
  "artifacts/srt-lab/src/lib/bcmFeatureCatalog.generated.js",
  "SRTLAB_BCM_FEATURE_CATALOG_PATH",
);

/* ── 1. uds_static_decode ─────────────────────────────────────────────── */

function fmtHex(b: number, width = 2): string {
  return "0x" + b.toString(16).toUpperCase().padStart(width, "0");
}

function decodeOneByte(b: number): string {
  // Positive response (SID | 0x40)
  const posSvc = serviceForPosRsp(b);
  if (posSvc) return `${fmtHex(b)}: ${posSvc.name} (positive response)`;
  // Request service
  const req = serviceForSid(b);
  if (req) return `${fmtHex(b)}: ${req.name} (request SID)`;
  // NRC code
  const n = nrcEntry(b);
  if (n) return `${fmtHex(b)}: NRC ${n.shortName} — ${n.description}`;
  return `${fmtHex(b)}: (unknown)`;
}

function decodeFrame(bytes: number[]): string[] {
  const lines: string[] = [];
  if (bytes.length === 0) return lines;

  const b0 = bytes[0];

  // Negative response: 7F <reqSid> <nrc>
  if (b0 === 0x7f && bytes.length >= 3) {
    const reqSvc = serviceForSid(bytes[1]);
    const n = nrcEntry(bytes[2]);
    lines.push(`Frame: NegativeResponse to ${reqSvc ? reqSvc.name : "unknown service"} ${fmtHex(bytes[1])}`);
    lines.push(
      n
        ? `  NRC ${fmtHex(bytes[2])} (${n.shortName}) — ${n.description}${n.isPending ? " [pending/retry]" : ""}`
        : `  NRC ${fmtHex(bytes[2])} — (unknown / reserved)`,
    );
    if (bytes.length > 3) {
      lines.push(`  Trailing bytes: ${bytes.slice(3).map((b) => fmtHex(b)).join(" ")}`);
    }
    return lines;
  }

  // Positive response?
  const posSvc = serviceForPosRsp(b0);
  if (posSvc) {
    lines.push(`Frame: ${posSvc.name} positive response (${fmtHex(b0)})`);
    // ReadDataByIdentifier response: 62 <DID-hi> <DID-lo> <data...>
    if (b0 === 0x62 && bytes.length >= 3) {
      const did = (bytes[1] << 8) | bytes[2];
      const d = didEntry(did);
      lines.push(`  DID ${fmtHex(did, 4)}${d ? `: ${d.name}` : " (not in catalog)"}`);
      if (d && bytes.length > 3) {
        try {
          lines.push(`  Decoded: ${d.decode(bytes.slice(3))}`);
        } catch {
          // ignore decode errors
        }
      }
    }
    return lines;
  }

  // Request?
  const reqSvc = serviceForSid(b0);
  if (reqSvc) {
    lines.push(`Frame: ${reqSvc.name} request (${fmtHex(b0)})`);
    // ReadDataByIdentifier request: 22 <DID-hi> <DID-lo> [<DID-hi> <DID-lo> ...]
    if (b0 === 0x22 && bytes.length >= 3) {
      for (let i = 1; i + 1 < bytes.length; i += 2) {
        const did = (bytes[i] << 8) | bytes[i + 1];
        const d = didEntry(did);
        lines.push(`  DID ${fmtHex(did, 4)}${d ? `: ${d.name}` : " (not in catalog)"}`);
      }
    }
    // WriteDataByIdentifier request: 2E <DID-hi> <DID-lo> <data...>
    else if (b0 === 0x2e && bytes.length >= 3) {
      const did = (bytes[1] << 8) | bytes[2];
      const d = didEntry(did);
      lines.push(`  DID ${fmtHex(did, 4)}${d ? `: ${d.name}` : " (not in catalog)"}`);
    }
    // Sub-function services
    else if (bytes.length >= 2 && reqSvc.subFunctions) {
      const sub = reqSvc.subFunctions.find((s) => s.value === (bytes[1] & 0x7f));
      if (sub) lines.push(`  Sub-function ${fmtHex(bytes[1])}: ${sub.name} — ${sub.description}`);
    }
    return lines;
  }

  return lines;
}

function handleUdsStaticDecode(args: Record<string, unknown>): string {
  const bytes = String(args.bytes || "").trim();
  if (!bytes) return "Error: bytes argument is required (hex string, e.g. '7F 22 31' or '62F19031...').";

  const cleaned = bytes.replace(/0x/gi, "").replace(/[,\s]+/g, " ").trim();
  const parts = cleaned.includes(" ")
    ? cleaned.split(/\s+/).filter(Boolean)
    : (cleaned.match(/.{1,2}/g) || []);
  if (parts.length === 0) return "Error: no bytes provided.";

  const values: number[] = [];
  const perByte: string[] = [];
  for (const p of parts) {
    const v = parseInt(p, 16);
    if (isNaN(v) || v < 0 || v > 0xff) {
      perByte.push(`${p}: (invalid hex byte)`);
      continue;
    }
    values.push(v);
    perByte.push(decodeOneByte(v));
  }

  const lines: string[] = [];
  const frame = decodeFrame(values);
  if (frame.length > 0) {
    lines.push(...frame, "");
  }
  lines.push("Per-byte decode:", ...perByte);
  return lines.join("\n");
}

/* ── 2. pattern_lookup (hex search in loaded dump) ────────────────────── */

function toHexCtx(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  return Array.from(slice)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

function handlePatternLookup(
  args: Record<string, unknown>,
  primaryBuf: Buffer,
  binaries: Record<string, Buffer>,
): string {
  const patternRaw = String(args.pattern ?? args.hex ?? args.query ?? "").trim();
  if (!patternRaw) return "Error: pattern argument is required (hex string, e.g. 'F1 90' or 'AA50').";

  const cleaned = patternRaw.replace(/0x/gi, "").replace(/[,\s]+/g, "");
  if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
    return `Error: invalid hex pattern "${patternRaw}" — provide an even-length hex string.`;
  }
  const hexBytes = cleaned.match(/.{2}/g)!;
  const needle = Buffer.from(hexBytes.map((h) => parseInt(h, 16)));
  if (needle.length === 0) return "Error: empty pattern.";

  // Decide which buffer to search: explicit target or the primary buffer.
  const targetName = args.target != null ? String(args.target) : null;
  let target: Buffer = primaryBuf;
  let targetLabel = "primary";
  if (targetName) {
    const b = binaries[targetName];
    if (!b) {
      const known = Object.keys(binaries);
      return `Error: target "${targetName}" not loaded. Available: ${known.length ? known.join(", ") : "(none)"}.`;
    }
    target = b;
    targetLabel = targetName;
  }
  if (target.length === 0) {
    return "Error: no binary loaded — upload a module file to enable pattern_lookup.";
  }
  if (needle.length > target.length) {
    return `No matches: pattern (${needle.length} B) is larger than ${targetLabel} buffer (${target.length} B).`;
  }

  const maxMatches = 64;
  const offsets: number[] = [];
  // Boyer–Moore-Horspool-lite linear scan; fine for ≤1 MB dumps.
  outer: for (let i = 0; i <= target.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (target[i + j] !== needle[j]) continue outer;
    }
    offsets.push(i);
    if (offsets.length >= maxMatches) break;
  }

  if (offsets.length === 0) {
    return `No matches for hex pattern "${hexBytes.join(" ")}" in ${targetLabel} (${target.length} bytes).`;
  }

  const ctxLen = Math.min(needle.length + 8, 32);
  const lines = [
    `${offsets.length}${offsets.length >= maxMatches ? "+" : ""} match(es) for "${hexBytes.join(" ")}" in ${targetLabel} (${target.length} bytes):`,
    "",
    ...offsets.map((off) => {
      const ctxStart = Math.max(0, off - 4);
      const ctx = toHexCtx(target, ctxStart, ctxLen);
      return `0x${off.toString(16).padStart(6, "0").toUpperCase()}  ${ctx}`;
    }),
  ];
  const out = lines.join("\n");
  return out.length > MAX_TOOL_RESULT_BYTES
    ? out.slice(0, MAX_TOOL_RESULT_BYTES) + "\n…[truncated]"
    : out;
}

/* ── 3. kg_query (unlock_catalog + bcmFeatureCatalog) ─────────────────── */

type UnlockEntry = {
  file?: string;
  module?: string;
  display_name?: string;
  family?: string;
  algorithm?: string;
  status?: string;
  python_function?: string;
  tx_can_id?: number;
  rx_can_id?: number;
  ecu_info?: { name?: string; tx_can_id?: number; rx_can_id?: number };
};

type BcmFeatureRow = {
  request: string;
  groupName: string;
  name: string;
  bit: number;
  length: number;
  options?: Array<{ value: number; label: string }>;
};

type CatalogLoad<T> = { rows: T[]; error: string | null; source: string | null };

let unlockCatalogCache: CatalogLoad<UnlockEntry> | null = null;
let bcmFeatureCache: CatalogLoad<BcmFeatureRow> | null = null;
let bcmFeaturePromise: Promise<CatalogLoad<BcmFeatureRow>> | null = null;

function loadUnlockCatalog(): CatalogLoad<UnlockEntry> {
  if (unlockCatalogCache) return unlockCatalogCache;
  if (!UNLOCK_CATALOG_PATH) {
    unlockCatalogCache = {
      rows: [],
      error:
        "unlock_catalog.json not found — set SRTLAB_UNLOCK_CATALOG_PATH or run from a checkout of the monorepo.",
      source: null,
    };
    return unlockCatalogCache;
  }
  try {
    const raw = readFileSync(UNLOCK_CATALOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed?.entries) ? (parsed.entries as UnlockEntry[]) : [];
    unlockCatalogCache = { rows, error: null, source: UNLOCK_CATALOG_PATH };
  } catch (e) {
    unlockCatalogCache = {
      rows: [],
      error: `Failed to read ${UNLOCK_CATALOG_PATH}: ${e instanceof Error ? e.message : String(e)}`,
      source: UNLOCK_CATALOG_PATH,
    };
  }
  return unlockCatalogCache;
}

async function loadBcmFeatureCatalog(): Promise<CatalogLoad<BcmFeatureRow>> {
  if (bcmFeatureCache) return bcmFeatureCache;
  if (!BCM_FEATURE_CATALOG_PATH) {
    bcmFeatureCache = {
      rows: [],
      error:
        "bcmFeatureCatalog.generated.js not found — set SRTLAB_BCM_FEATURE_CATALOG_PATH or run from a checkout of the monorepo.",
      source: null,
    };
    return bcmFeatureCache;
  }
  if (!bcmFeaturePromise) {
    const src = BCM_FEATURE_CATALOG_PATH;
    bcmFeaturePromise = import(pathToFileURL(src).href)
      .then((mod) => {
        const rows = Array.isArray(mod.DE_FEATURE_CATALOG)
          ? (mod.DE_FEATURE_CATALOG as BcmFeatureRow[])
          : [];
        bcmFeatureCache = { rows, error: null, source: src };
        return bcmFeatureCache;
      })
      .catch((e: unknown) => {
        bcmFeatureCache = {
          rows: [],
          error: `Failed to import ${src}: ${e instanceof Error ? e.message : String(e)}`,
          source: src,
        };
        return bcmFeatureCache;
      });
  }
  return bcmFeaturePromise;
}

function describeUnlock(e: UnlockEntry): string[] {
  const lines: string[] = [];
  const name = e.display_name || e.module || e.file || "(unnamed)";
  lines.push(`[unlock] ${name}  family=${e.family ?? "?"}  algorithm=${e.algorithm ?? "?"}  status=${e.status ?? "?"}`);
  const tx = e.tx_can_id ?? e.ecu_info?.tx_can_id;
  const rx = e.rx_can_id ?? e.ecu_info?.rx_can_id;
  if (tx != null || rx != null) {
    lines.push(`  CAN tx=${tx != null ? "0x" + tx.toString(16).toUpperCase() : "?"} rx=${rx != null ? "0x" + rx.toString(16).toUpperCase() : "?"}  ecu=${e.ecu_info?.name ?? "?"}`);
  }
  if (e.python_function) lines.push(`  bridge fn: ${e.python_function}`);
  return lines;
}

function describeBcmFeature(r: BcmFeatureRow): string {
  const opts = r.options && r.options.length
    ? `  opts=[${r.options.slice(0, 6).map((o) => `${o.value}=${o.label}`).join(", ")}${r.options.length > 6 ? ", …" : ""}]`
    : "  (integer)";
  return `[bcm-feature] ${r.request}  ${r.groupName} / ${r.name}  bit=${r.bit} len=${r.length}${opts}`;
}

async function handleKgQuery(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query || "").trim();
  if (!query) {
    return "Error: query argument is required (e.g. algorithm name, module/DLL name, BCM DID like 'DE00', service like 'auto lock').";
  }
  const q = query.toLowerCase();

  const unlockLoad = loadUnlockCatalog();
  const bcmLoad = await loadBcmFeatureCatalog();
  const unlocks = unlockLoad.rows;
  const bcm = bcmLoad.rows;

  // Also accept "0xDE00" / "DE00" / "0x27" style hex tokens.
  const hexToken = q.replace(/^0x/, "");

  const unlockHits = unlocks.filter((e) => {
    const haystack = [
      e.file,
      e.module,
      e.display_name,
      e.family,
      e.algorithm,
      e.status,
      e.python_function,
      e.ecu_info?.name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q) || (hexToken && haystack.includes(hexToken));
  });

  const bcmHits = bcm.filter((r) => {
    const haystack = `${r.request} ${r.groupName} ${r.name}`.toLowerCase();
    if (haystack.includes(q)) return true;
    if (hexToken && r.request.toLowerCase() === hexToken) return true;
    if (r.options && r.options.some((o) => o.label.toLowerCase().includes(q))) return true;
    return false;
  });

  const loadErrors: string[] = [];
  if (unlockLoad.error) loadErrors.push(`unlock_catalog: ${unlockLoad.error}`);
  if (bcmLoad.error) loadErrors.push(`bcmFeatureCatalog: ${bcmLoad.error}`);

  if (unlockHits.length === 0 && bcmHits.length === 0) {
    const base = `No matches for "${query}". Indexed: ${unlocks.length} unlock_catalog entries, ${bcm.length} BCM DE-feature rows. Try a module/DLL name (e.g. 'abs', 'rfh'), algorithm (e.g. 't8_xor', 'lcg_pair'), BCM DID ('DE00'..'DE0C'), or feature ('auto lock', 'horn', 'DRL').`;
    return loadErrors.length > 0
      ? `${base}\n\nWARNING: catalog data unavailable —\n  ${loadErrors.join("\n  ")}`
      : base;
  }

  const lines: string[] = [
    `Knowledge query "${query}": ${unlockHits.length} unlock entry/entries, ${bcmHits.length} BCM feature row(s)`,
    "",
  ];
  if (loadErrors.length > 0) {
    lines.push("WARNING: catalog data partially unavailable —", ...loadErrors.map((m) => `  ${m}`), "");
  }

  if (unlockHits.length > 0) {
    lines.push(`── Unlock catalog (${unlockHits.length}) ──`);
    for (const e of unlockHits.slice(0, 20)) lines.push(...describeUnlock(e));
    if (unlockHits.length > 20) lines.push(`  …and ${unlockHits.length - 20} more.`);
    lines.push("");
  }

  if (bcmHits.length > 0) {
    lines.push(`── BCM feature catalog (${bcmHits.length}) ──`);
    for (const r of bcmHits.slice(0, 25)) lines.push(describeBcmFeature(r));
    if (bcmHits.length > 25) lines.push(`  …and ${bcmHits.length - 25} more.`);
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
      `Decode a UDS request/response/NRC byte sequence using the ISO 14229 ` +
      `service table (${SERVICES.length} services), NRC table (${NRC_TABLE.length} codes), ` +
      `and SRT Lab DID catalog (${DID_CATALOG.length} DIDs). Recognises ` +
      `negative responses (7F <sid> <nrc>), positive responses (e.g. 62 F1 90 …), ` +
      `RDBI/WDBI requests, and sub-function services. Useful for interpreting ` +
      `raw protocol bytes found in a dump or log.`,
    input_schema: {
      type: "object" as const,
      properties: {
        bytes: {
          type: "string",
          description:
            'Hex bytes to decode. Spaces optional, e.g. "7F 22 31", "62F19031...", or "0x10 0x03".',
        },
      },
      required: ["bytes"],
    },
  },
  pattern_lookup: {
    name: "pattern_lookup",
    description:
      "Search the loaded ECU dump for an exact byte sequence and return matched file offsets. " +
      "Mirrors the hex-viewer search in FcaModuleInspector. Returns up to 64 offsets with " +
      "surrounding hex context.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description:
            'Hex byte pattern to search for, e.g. "F1 90", "AA50", or "20 23". Even number of hex digits required.',
        },
        target: {
          type: "string",
          description:
            "Optional name of a loaded secondary binary to search instead of the primary buffer (see binaries map).",
        },
      },
      required: ["pattern"],
    },
  },
  kg_query: {
    name: "kg_query",
    description:
      "Query the SRT Lab knowledge sources for an algorithm, service, module, DID, or feature " +
      "identifier. Searches the canonical unlock_catalog.json (per-DLL family / algorithm / CAN " +
      "IDs / bridge function) and the curated bcmFeatureCatalog (DE00..DE0C, 155 BCM feature " +
      "rows: bit position, length, option labels). Pure read-only lookup against static data.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            'Identifier to look up — e.g. an algorithm ("t8_xor", "lcg_pair"), a module/DLL ' +
            '("abs", "rfh", "ccn"), a BCM DID ("DE00".."DE0C"), or a feature label ("auto lock", "horn chirp", "DRL").',
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
  if (toolName === "pattern_lookup") return handlePatternLookup(args, primaryBuf, binaries);
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

/* ── Test-only helpers ────────────────────────────────────────────────── */

export const __test = {
  handleUdsStaticDecode,
  handlePatternLookup,
  handleKgQuery,
  loadUnlockCatalog,
  loadBcmFeatureCatalog,
};
