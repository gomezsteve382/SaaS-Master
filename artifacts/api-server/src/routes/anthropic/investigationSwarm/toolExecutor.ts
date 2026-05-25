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
const PROXI_DECODER_PATH = resolveCatalogPath(
  "artifacts/srt-lab/src/lib/proxiDecoder.js",
  "SRTLAB_PROXI_DECODER_PATH",
);

/** File offset of the 16-byte BCM 0x2023 proxi blob inside a BCM .bin dump.
 *  Mirrors `PROXI_OFFSET` in ProxiTab.jsx. */
const BCM_PROXI_2023_OFFSET = 0x2023;
const BCM_PROXI_2023_LENGTH = 16;

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

/* ── 4. decode_bcm_feature (kg lookup + decode from loaded BCM dump) ── */

type ProxiDecoderModule = {
  decodeProxi2023: (bytes: Uint8Array) => DecodedRow[];
  decodeDeDid: (request: string, bytes: Uint8Array) => DecodedRow[];
};
type DecodedRow = {
  source: string;
  request: string;
  groupName: string;
  name: string;
  bit: number;
  length: number;
  raw: number | null;
  label: string;
  category: string;
};

let proxiDecoderPromise: Promise<ProxiDecoderModule | { error: string }> | null = null;

function loadProxiDecoder(): Promise<ProxiDecoderModule | { error: string }> {
  if (proxiDecoderPromise) return proxiDecoderPromise;
  if (!PROXI_DECODER_PATH) {
    proxiDecoderPromise = Promise.resolve({
      error:
        "proxiDecoder.js not found — set SRTLAB_PROXI_DECODER_PATH or run from a checkout of the monorepo.",
    });
    return proxiDecoderPromise;
  }
  const src = PROXI_DECODER_PATH;
  proxiDecoderPromise = import(pathToFileURL(src).href)
    .then((mod) => mod as ProxiDecoderModule)
    .catch((e: unknown) => ({
      error: `Failed to import ${src}: ${e instanceof Error ? e.message : String(e)}`,
    }));
  return proxiDecoderPromise;
}

function parseHexBytes(raw: string): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  const cleaned = raw.replace(/0x/gi, "").replace(/[,\s]+/g, "");
  if (cleaned.length === 0) return { ok: false, error: "empty hex string" };
  if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
    return { ok: false, error: `invalid hex string "${raw}" — provide an even-length hex string.` };
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  return { ok: true, bytes: out };
}

/** Strip a leading UDS positive-response header (e.g. `62 DD DD`) if the
 *  caller pasted the raw response. Mirrors the strip in ProxiTab.jsx. */
function stripUdsRdbiHeader(bytes: Uint8Array, didHex: string): Uint8Array {
  if (didHex.length !== 4) return bytes;
  const hi = parseInt(didHex.substr(0, 2), 16);
  const lo = parseInt(didHex.substr(2, 2), 16);
  if (bytes.length >= 3 && bytes[0] === 0x62 && bytes[1] === hi && bytes[2] === lo) {
    return bytes.slice(3);
  }
  return bytes;
}

function describeDecodedRow(r: DecodedRow, isInteger: boolean): string {
  const valuePart =
    r.raw === null || r.raw === undefined ? `value=?` : `value=${r.raw}`;
  const labelPart = isInteger
    ? `(integer)`
    : `label="${r.label ?? "—"}"`;
  return `  ${r.request}  ${r.groupName} / ${r.name}  bit=${r.bit} len=${r.length}  ${valuePart}  ${labelPart}`;
}

async function handleDecodeBcmFeature(
  args: Record<string, unknown>,
  primaryBuf: Buffer,
): Promise<string> {
  const decoderLoad = await loadProxiDecoder();
  if ("error" in decoderLoad) return `Error: ${decoderLoad.error}`;
  const { decodeProxi2023, decodeDeDid } = decoderLoad;

  const bcmLoad = await loadBcmFeatureCatalog();
  if (bcmLoad.error && bcmLoad.rows.length === 0) {
    return `Error: ${bcmLoad.error}`;
  }
  const catalog = bcmLoad.rows;

  const nameArg = args.name != null ? String(args.name).trim() : "";
  const didArg = args.did != null ? String(args.did).trim().toUpperCase().replace(/^0X/, "") : "";
  const bitArg = args.bit != null ? Number(args.bit) : NaN;
  const lenArg = args.length != null ? Number(args.length) : NaN;
  const bytesArg = args.bytes != null ? String(args.bytes).trim() : "";

  if (!nameArg && !didArg) {
    return "Error: provide either `name` (feature name fragment) or `did` (e.g. 'DE00' or '2023'). Optional: `bit` + `length` to pin a specific field, or `bytes` to decode an explicit response payload.";
  }

  /* ── Resolve which catalog rows the caller is asking about ─────── */
  type CatalogPick = {
    request: string;        // e.g. "DE00" or "2023"
    groupName: string;
    name: string;
    bit: number;
    length: number;
    options?: Array<{ value: number; label: string }>;
    source: "DEnn" | "BODY_PN_2023";
  };

  const picks: CatalogPick[] = [];

  // 1. DEnn catalog (option-rich BCM feature DIDs)
  for (const r of catalog) {
    const reqUpper = r.request.toUpperCase();
    const nameMatch = nameArg
      ? `${r.groupName} ${r.name}`.toLowerCase().includes(nameArg.toLowerCase())
      : true;
    const didMatch = didArg ? reqUpper === didArg : true;
    const bitMatch = Number.isFinite(bitArg) ? r.bit === bitArg : true;
    const lenMatch = Number.isFinite(lenArg) ? r.length === lenArg : true;
    if (nameMatch && didMatch && bitMatch && lenMatch) {
      picks.push({
        request: r.request,
        groupName: r.groupName,
        name: r.name,
        bit: r.bit,
        length: r.length,
        options: r.options,
        source: "DEnn",
      });
    }
  }

  // 2. BODY_PN_CONFIG (DID 0x2023, 16 B blob inside the BCM .bin)
  //    The 0x2023 rows aren't in DE_FEATURE_CATALOG — they live in the
  //    cgwConfig BODY_PN table, surfaced via decodeProxi2023(buf).
  //    We probe by decoding a zero blob: the row metadata (name, bit,
  //    length) is identical regardless of the bytes.
  let body2023Rows: DecodedRow[] = [];
  try {
    body2023Rows = decodeProxi2023(new Uint8Array(BCM_PROXI_2023_LENGTH));
  } catch {
    body2023Rows = [];
  }
  for (const r of body2023Rows) {
    const nameMatch = nameArg
      ? `${r.groupName} ${r.name}`.toLowerCase().includes(nameArg.toLowerCase())
      : true;
    const didMatch = didArg ? didArg === "2023" : true;
    const bitMatch = Number.isFinite(bitArg) ? r.bit === bitArg : true;
    const lenMatch = Number.isFinite(lenArg) ? r.length === lenArg : true;
    if (nameMatch && didMatch && bitMatch && lenMatch) {
      picks.push({
        request: "2023",
        groupName: r.groupName,
        name: r.name,
        bit: r.bit,
        length: r.length,
        source: "BODY_PN_2023",
      });
    }
  }

  if (picks.length === 0) {
    const hints: string[] = [];
    if (nameArg) hints.push(`name~"${nameArg}"`);
    if (didArg) hints.push(`did=${didArg}`);
    if (Number.isFinite(bitArg)) hints.push(`bit=${bitArg}`);
    if (Number.isFinite(lenArg)) hints.push(`length=${lenArg}`);
    return `NRC: no catalog match for ${hints.join(" ")}. Indexed ${catalog.length} DEnn rows + ${body2023Rows.length} BODY_PN (0x2023) rows. Try a coarser name fragment (e.g. "auto lock", "drl", "horn"), or use kg_query first to discover the right DID/bit.`;
  }

  /* ── Disambiguate: too many candidates → list instead of decoding ── */
  // Only kicks in for fuzzy name-driven queries — when the caller pins
  // a specific DID (or bit) they've already accepted the row set.
  const MAX_DECODE = 8;
  if (
    picks.length > MAX_DECODE &&
    !Number.isFinite(bitArg) &&
    !didArg
  ) {
    const lines = [
      `Ambiguous: ${picks.length} catalog rows matched. Narrow with \`did\`, \`bit\`+\`length\`, or a more specific \`name\`.`,
      "",
      ...picks.slice(0, 25).map((p) =>
        `  [${p.source === "DEnn" ? "DEnn" : "BODY_PN"}] ${p.request}  ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
      ),
    ];
    if (picks.length > 25) lines.push(`  …and ${picks.length - 25} more.`);
    return lines.join("\n");
  }

  /* ── Decode each pick against either the loaded BCM buf or `bytes` ─ */
  const lines: string[] = [
    `Decoded ${picks.length} BCM feature${picks.length === 1 ? "" : "s"}:`,
    "",
  ];

  for (const p of picks) {
    const isInteger = !p.options || p.options.length === 0;
    if (p.source === "BODY_PN_2023") {
      if (primaryBuf.length === 0) {
        lines.push(
          `[2023] ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
          `  NRC: no BCM dump loaded — upload a BCM .bin so the 0x2023 proxi blob (offset 0x${BCM_PROXI_2023_OFFSET.toString(16).toUpperCase()}, ${BCM_PROXI_2023_LENGTH} bytes) can be sliced.`,
        );
        continue;
      }
      if (primaryBuf.length < BCM_PROXI_2023_OFFSET + BCM_PROXI_2023_LENGTH) {
        lines.push(
          `[2023] ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
          `  NRC: loaded buffer is only ${primaryBuf.length} B — too small to contain DID 0x2023 (need ≥ ${BCM_PROXI_2023_OFFSET + BCM_PROXI_2023_LENGTH} B). Likely not a BCM .bin.`,
        );
        continue;
      }
      const slice = new Uint8Array(
        primaryBuf.subarray(BCM_PROXI_2023_OFFSET, BCM_PROXI_2023_OFFSET + BCM_PROXI_2023_LENGTH),
      );
      let rows: DecodedRow[];
      try {
        rows = decodeProxi2023(slice);
      } catch (e) {
        lines.push(
          `[2023] ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
          `  Error decoding 0x2023 blob: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      const hit = rows.find(
        (r) => r.name === p.name && r.bit === p.bit && r.length === p.length,
      );
      if (!hit) {
        lines.push(
          `[2023] ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
          `  NRC: row no longer present after decode (catalog drift?).`,
        );
        continue;
      }
      if (hit.raw === null || hit.raw === undefined) {
        lines.push(
          `[2023] ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
          `  NRC: 0x2023 blob too short to cover bit ${p.bit}+${p.length}.`,
        );
        continue;
      }
      lines.push(`[2023 ← loaded BCM dump @ 0x${BCM_PROXI_2023_OFFSET.toString(16).toUpperCase()}]`);
      lines.push(describeDecodedRow(hit, isInteger));
      continue;
    }

    // DEnn — needs an explicit `bytes` payload (DEnn DIDs are not in flash)
    if (!bytesArg) {
      lines.push(
        `[${p.request}] ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
        `  NRC: DID ${p.request} is not in the BCM flash dump — it's a live UDS read (0x22 ${p.request.substr(0, 2)} ${p.request.substr(2, 2)}). Re-call with \`bytes\` set to the response payload (raw payload, or full \`62 ${p.request.substr(0, 2)} ${p.request.substr(2, 2)} …\` is auto-stripped).`,
      );
      continue;
    }
    const parsed = parseHexBytes(bytesArg);
    if (!parsed.ok) {
      lines.push(
        `[${p.request}] ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
        `  Error: ${parsed.error}`,
      );
      continue;
    }
    const payload = stripUdsRdbiHeader(parsed.bytes, p.request);
    let rows: DecodedRow[];
    try {
      rows = decodeDeDid(p.request, payload);
    } catch (e) {
      lines.push(
        `[${p.request}] ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
        `  Error decoding ${p.request} payload: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    const hit = rows.find(
      (r) => r.name === p.name && r.bit === p.bit && r.length === p.length,
    );
    if (!hit) {
      lines.push(
        `[${p.request}] ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
        `  NRC: row not present after decode (catalog drift?).`,
      );
      continue;
    }
    if (hit.raw === null || hit.raw === undefined) {
      lines.push(
        `[${p.request}] ${p.groupName} / ${p.name}  bit=${p.bit} len=${p.length}`,
        `  NRC: ${payload.length}-byte payload too short to cover bit ${p.bit}+${p.length}.`,
      );
      continue;
    }
    lines.push(`[${p.request} ← supplied bytes (${payload.length} B payload)]`);
    lines.push(describeDecodedRow(hit, isInteger));
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
  decode_bcm_feature: {
    name: "decode_bcm_feature",
    description:
      "Look up a BCM feature in the knowledge graph (DE00..DE0C feature DIDs + the BODY_PN 0x2023 proxi blob) and decode its current value. " +
      "For 0x2023 fields the bytes are sliced from the loaded BCM .bin dump at file offset 0x2023 (16 B). " +
      "For DEnn fields (live UDS reads, not in flash) the caller must supply `bytes` — the raw response payload, or the full `62 DD DD …` positive response (auto-stripped). " +
      "Surfaces NRC-style errors when no BCM dump is loaded, when the loaded buffer is too small for DID 0x2023, when the catalog row isn't found, or when the supplied payload is too short.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            'Optional feature name fragment (case-insensitive) — e.g. "auto lock", "DRL", "horn chirp". Required if `did` is not provided.',
        },
        did: {
          type: "string",
          description:
            'Optional DID hex — "2023" for the BCM proxi blob or "DE00".."DE0C" for the curated feature DIDs. Required if `name` is not provided.',
        },
        bit: {
          type: "integer",
          description: "Optional bit offset within the DID payload (MSB-first). Combine with `length` to pin a specific field when `name` is ambiguous.",
        },
        length: {
          type: "integer",
          description: "Optional bit length of the field. Pair with `bit`.",
        },
        bytes: {
          type: "string",
          description:
            'Optional hex payload for DEnn DIDs (which are NOT in the BCM flash dump). May be the raw payload or the full positive response (e.g. "62 DE 00 ...") — the `62 DD DD` header is auto-stripped.',
        },
      },
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
  if (toolName === "decode_bcm_feature") return handleDecodeBcmFeature(args, primaryBuf);

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
  handleDecodeBcmFeature,
  loadUnlockCatalog,
  loadBcmFeatureCatalog,
};
