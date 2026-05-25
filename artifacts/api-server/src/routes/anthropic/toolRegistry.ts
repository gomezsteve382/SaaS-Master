/**
 * Tool registry for the AI module assistant tool-use loop.
 *
 * All tools are read-only, work on in-memory bytes only (no FS/net/eval),
 * and enforce a per-result payload cap so the model never receives a
 * response large enough to blow the context window.
 *
 * Each entry exposes:
 *   - schema  — Anthropic tool-use JSON schema (passed to messages.create)
 *   - handler — pure async function (bytes, binaries, args) → string result
 */

export const MAX_TOOL_RESULT_BYTES = 8192;   // per single tool result (chars)
export const MAX_CUMULATIVE_BYTES  = 65536;  // total tool output cap per loop
export const MAX_ITERATIONS        = 10;     // hard loop-count cap

/* ─── Helpers ─── */

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated, ${s.length - max} more chars]`;
}

function toHexString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const hex: string[] = [];
  for (let i = 0; i < slice.length; i++) {
    hex.push(slice[i].toString(16).padStart(2, "0").toUpperCase());
    if ((i + 1) % 16 === 0) hex.push("\n");
    else if ((i + 1) % 8 === 0) hex.push("  ");
    else hex.push(" ");
  }
  return hex.join("").trim();
}

function isPrintable(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

/* ─── Tool handlers ─── */

type Binaries = Record<string, Buffer>;

async function handleReadHex(
  primary: Buffer,
  _binaries: Binaries,
  args: Record<string, unknown>
): Promise<string> {
  const offset = Math.max(0, Number(args.offset) || 0);
  const length = Math.min(4096, Math.max(1, Number(args.length) || 64));
  if (offset >= primary.length) {
    return `Error: offset 0x${offset.toString(16).toUpperCase()} is past end of file (${primary.length} bytes)`;
  }
  const actualLen = Math.min(length, primary.length - offset);
  const hex = toHexString(primary, offset, actualLen);
  const lines = [
    `Hex dump: offset 0x${offset.toString(16).toUpperCase()} (${offset}), length ${actualLen} bytes`,
    `File size: ${primary.length} bytes`,
    "",
    hex,
  ];
  if (actualLen < length) {
    lines.push(`\nNote: requested ${length} bytes but only ${actualLen} remain from offset.`);
  }
  return truncate(lines.join("\n"), MAX_TOOL_RESULT_BYTES);
}

async function handleExtractStrings(
  primary: Buffer,
  _binaries: Binaries,
  args: Record<string, unknown>
): Promise<string> {
  const minLen = Math.max(4, Number(args.minLen) || 6);
  const encoding = String(args.encoding || "ascii");
  const results: Array<{ offset: number; length: number; value: string }> = [];

  if (encoding === "utf16le") {
    for (let i = 0; i + 1 < primary.length - 1; i += 2) {
      let j = i;
      while (j + 1 < primary.length && isPrintable(primary[j]) && primary[j + 1] === 0) j += 2;
      const charLen = (j - i) / 2;
      if (charLen >= minLen) {
        results.push({ offset: i, length: j - i, value: primary.subarray(i, j).toString("utf16le") });
        i = j - 2;
        if (results.length >= 100) break;
      }
    }
  } else {
    let start = -1;
    for (let i = 0; i <= primary.length; i++) {
      const b = i < primary.length ? primary[i] : 0;
      if (isPrintable(b)) {
        if (start < 0) start = i;
      } else {
        if (start >= 0 && i - start >= minLen) {
          results.push({
            offset: start,
            length: i - start,
            value: primary.subarray(start, i).toString("ascii"),
          });
          if (results.length >= 100) break;
        }
        start = -1;
      }
    }
  }

  if (results.length === 0) {
    return `No strings of length >= ${minLen} found (encoding: ${encoding}).`;
  }
  const lines = [
    `Found ${results.length} strings (minLen=${minLen}, encoding=${encoding}):`,
    "",
    ...results.slice(0, 50).map(
      (r) => `0x${r.offset.toString(16).padStart(6, "0").toUpperCase()}  [${r.length}]  ${r.value}`
    ),
  ];
  if (results.length > 50) lines.push(`\n…and ${results.length - 50} more.`);
  return truncate(lines.join("\n"), MAX_TOOL_RESULT_BYTES);
}

async function handleSearchPatterns(
  primary: Buffer,
  _binaries: Binaries,
  args: Record<string, unknown>
): Promise<string> {
  const pattern = String(args.pattern || "");
  const kind = String(args.kind || "ascii");

  if (!pattern && kind !== "crypto") return "Error: pattern is required.";

  const matches: Array<{ offset: number; context: string }> = [];

  if (kind === "hex") {
    const hexBytes = pattern.replace(/\s+/g, "").match(/.{1,2}/g);
    if (!hexBytes) return "Error: invalid hex pattern.";
    const needle = Buffer.from(hexBytes.map((h) => parseInt(h, 16)));
    for (let i = 0; i <= primary.length - needle.length; i++) {
      let found = true;
      for (let j = 0; j < needle.length; j++) {
        if (primary[i + j] !== needle[j]) { found = false; break; }
      }
      if (found) {
        const ctx = toHexString(primary, Math.max(0, i - 4), Math.min(needle.length + 8, 32));
        matches.push({ offset: i, context: ctx });
        if (matches.length >= 20) break;
      }
    }
  } else if (kind === "ascii") {
    const needle = Buffer.from(pattern, "ascii");
    for (let i = 0; i <= primary.length - needle.length; i++) {
      let found = true;
      for (let j = 0; j < needle.length; j++) {
        if (primary[i + j] !== needle[j]) { found = false; break; }
      }
      if (found) {
        const ctxStart = Math.max(0, i - 4);
        const ctxEnd = Math.min(primary.length, i + needle.length + 4);
        const ctx = primary.subarray(ctxStart, ctxEnd).toString("ascii").replace(/[^\x20-\x7e]/g, "·");
        matches.push({ offset: i, context: ctx });
        if (matches.length >= 20) break;
      }
    }
  } else if (kind === "crypto") {
    /* Crypto-material heuristic: scan for 16-byte windows that look like
     * a key or cipher state — no 0xFF runs, no 0x00 runs, ≥ 10 unique
     * bytes (high entropy). Optionally takes a hex-byte pattern; if
     * provided, only reports windows that contain those bytes. */
    const needle = pattern && /^[0-9a-fA-F\s]+$/.test(pattern)
      ? Buffer.from(pattern.replace(/\s+/g, "").match(/.{1,2}/g)!.map((h) => parseInt(h, 16)))
      : null;
    for (let i = 0; i <= primary.length - 16; i++) {
      const slice = primary.subarray(i, i + 16);
      let ffCount = 0, zeroCount = 0;
      const seen = new Set<number>();
      for (let j = 0; j < 16; j++) {
        if (slice[j] === 0xff) ffCount++;
        else if (slice[j] === 0x00) zeroCount++;
        seen.add(slice[j]);
      }
      if (ffCount > 2 || zeroCount > 2 || seen.size < 10) continue;
      if (needle) {
        let hit = false;
        for (let j = 0; j <= 16 - needle.length; j++) {
          let ok = true;
          for (let k = 0; k < needle.length; k++) if (slice[j + k] !== needle[k]) { ok = false; break; }
          if (ok) { hit = true; break; }
        }
        if (!hit) continue;
      }
      const ctx = Array.from(slice).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      matches.push({ offset: i, context: ctx });
      i += 15;
      if (matches.length >= 20) break;
    }
  } else {
    return `Error: unknown kind "${kind}". Use hex, ascii, or crypto.`;
  }

  if (matches.length === 0) return `No matches for pattern "${pattern}" (kind=${kind}).`;
  const lines = [
    `${matches.length} match(es) for "${pattern}" (kind=${kind}):`,
    "",
    ...matches.map((m) => `0x${m.offset.toString(16).padStart(6, "0").toUpperCase()}  ${m.context}`),
  ];
  return truncate(lines.join("\n"), MAX_TOOL_RESULT_BYTES);
}

async function handleEepromLayoutScan(
  primary: Buffer,
  _binaries: Binaries,
  _args: Record<string, unknown>
): Promise<string> {
  const lines: string[] = [`EEPROM layout scan — ${primary.length} bytes (0x${primary.length.toString(16).toUpperCase()})`];

  // Detect module type by size + header
  let detectedType = "UNKNOWN";
  if (primary.length === 2048) detectedType = "RFHUB Gen1 (24C16)";
  else if (primary.length === 4096) detectedType = "GPEC2A PCM 95320 (4 KB) or RFHUB Gen2 (24C32)";
  else if (primary.length === 8192) detectedType = "GPEC2A PCM 95640 (8 KB) or 95640 BCM backup";
  else if (primary.length === 65536) {
    const hdr = primary.subarray(0, 4).toString("ascii");
    if (hdr === "XC22" || hdr.startsWith("RFHU")) detectedType = "XC2268 RFHUB internal flash (64 KB)";
    else detectedType = "BCM DFLASH (64 KB)";
  } else if (primary.length === 131072) detectedType = "BCM DFLASH (128 KB)";
  lines.push(`Detected type: ${detectedType}`);
  lines.push("");

  // Scan for VIN-like patterns (17 chars: 1C/2C/3C + alphanumeric)
  lines.push("VIN slot candidates:");
  const vinRe = /[123][A-HJ-NPR-Z0-9]{16}/g;
  const ascii = primary.toString("binary");
  let vm: RegExpExecArray | null;
  let vinCount = 0;
  while ((vm = vinRe.exec(ascii)) !== null && vinCount < 20) {
    lines.push(`  0x${vm.index.toString(16).padStart(6, "0").toUpperCase()}  ${vm[0]}`);
    vinCount++;
  }
  if (vinCount === 0) lines.push("  (none found)");
  lines.push("");

  // Scan for 0xFF padding regions
  lines.push("Large 0xFF regions (potential unused areas):");
  let ffStart = -1; let ffCount = 0;
  const ffRegions: Array<{ start: number; length: number }> = [];
  for (let i = 0; i < primary.length; i++) {
    if (primary[i] === 0xff) {
      if (ffStart < 0) { ffStart = i; ffCount = 0; }
      ffCount++;
    } else if (ffStart >= 0) {
      if (ffCount >= 256) ffRegions.push({ start: ffStart, length: ffCount });
      ffStart = -1; ffCount = 0;
    }
  }
  if (ffStart >= 0 && ffCount >= 256) ffRegions.push({ start: ffStart, length: ffCount });
  if (ffRegions.length === 0) lines.push("  (none ≥ 256 bytes)");
  ffRegions.slice(0, 10).forEach((r) =>
    lines.push(`  0x${r.start.toString(16).padStart(6, "0").toUpperCase()}–0x${(r.start + r.length - 1).toString(16).padStart(6, "0").toUpperCase()}  (${r.length} bytes, ${((r.length / primary.length) * 100).toFixed(1)}%)`)
  );
  if (ffRegions.length > 10) lines.push(`  …and ${ffRegions.length - 10} more`);
  lines.push("");

  // Byte entropy summary
  const byteFreq = new Array(256).fill(0);
  for (let i = 0; i < primary.length; i++) byteFreq[primary[i]]++;
  const ffPct = ((byteFreq[0xff] / primary.length) * 100).toFixed(1);
  const zeroPct = ((byteFreq[0x00] / primary.length) * 100).toFixed(1);
  lines.push(`Byte distribution: 0xFF=${ffPct}%, 0x00=${zeroPct}%`);

  return truncate(lines.join("\n"), MAX_TOOL_RESULT_BYTES);
}

async function handleKeySecretsScan(
  primary: Buffer,
  _binaries: Binaries,
  _args: Record<string, unknown>
): Promise<string> {
  const lines: string[] = [`Key/secrets scan — ${primary.length} bytes`];
  lines.push("");

  // SEC16: 16 consecutive non-FF, non-00 bytes (excluding near-all-FF)
  lines.push("SEC16 candidates (16-byte key sequences, not all-FF/00):");
  let sec16Count = 0;
  for (let i = 0; i <= primary.length - 16; i++) {
    const slice = primary.subarray(i, i + 16);
    const ffCount = slice.reduce((c, b) => c + (b === 0xff ? 1 : 0), 0);
    const zeroCount = slice.reduce((c, b) => c + (b === 0x00 ? 1 : 0), 0);
    if (ffCount <= 2 && zeroCount <= 4) {
      const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      lines.push(`  0x${i.toString(16).padStart(6, "0").toUpperCase()}  ${hex}`);
      sec16Count++;
      i += 15; // skip ahead
      if (sec16Count >= 10) break;
    }
  }
  if (sec16Count === 0) lines.push("  (none found matching criteria)");
  lines.push("");

  // SEC6: 6 consecutive non-FF, non-00 bytes
  lines.push("SEC6 candidates (6-byte sequences, ≥3 non-FF bytes):");
  let sec6Count = 0;
  for (let i = 0; i <= primary.length - 6; i++) {
    const slice = primary.subarray(i, i + 6);
    const nonFF = slice.reduce((c, b) => c + (b !== 0xff ? 1 : 0), 0);
    const nonZero = slice.reduce((c, b) => c + (b !== 0x00 ? 1 : 0), 0);
    if (nonFF >= 3 && nonZero >= 3) {
      const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      lines.push(`  0x${i.toString(16).padStart(6, "0").toUpperCase()}  ${hex}`);
      sec6Count++;
      i += 5;
      if (sec6Count >= 20) break;
    }
  }
  if (sec6Count === 0) lines.push("  (none found)");
  lines.push("");

  // FOBIK key slot markers (AA 50 pattern — common immo record delimiters)
  lines.push("FOBIK/immo slot markers (0xAA 0x50 pattern):");
  let fobikCount = 0;
  for (let i = 0; i < primary.length - 1; i++) {
    if (primary[i] === 0xaa && primary[i + 1] === 0x50) {
      const ctx = Array.from(primary.subarray(i, Math.min(primary.length, i + 8)))
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      lines.push(`  0x${i.toString(16).padStart(6, "0").toUpperCase()}  ${ctx}`);
      fobikCount++;
      if (fobikCount >= 16) break;
    }
  }
  if (fobikCount === 0) lines.push("  (none found)");

  return truncate(lines.join("\n"), MAX_TOOL_RESULT_BYTES);
}

async function handleParseModule(
  primary: Buffer,
  _binaries: Binaries,
  _args: Record<string, unknown>
): Promise<string> {
  const lines: string[] = [`Module parse — ${primary.length} bytes`];

  // Determine type
  let type = "UNKNOWN";
  const sz = primary.length;
  if (sz === 2048) type = "RFHUB_GEN1";
  else if (sz === 4096 || sz === 8192) type = "GPEC2A_OR_RFHUB";
  else if (sz === 65536 || sz === 131072) type = "BCM_OR_XC2268";
  lines.push(`Size: ${sz} bytes → inferred type: ${type}`);
  lines.push("");

  // VIN extraction
  const vinRe = /[123][A-HJ-NPR-Z0-9]{16}/g;
  const ascii = primary.toString("binary");
  const vins: Array<{ offset: number; vin: string }> = [];
  let vm: RegExpExecArray | null;
  while ((vm = vinRe.exec(ascii)) !== null) {
    vins.push({ offset: vm.index, vin: vm[0] });
    if (vins.length >= 10) break;
  }
  lines.push(`VINs found: ${vins.length}`);
  vins.forEach((v) =>
    lines.push(`  0x${v.offset.toString(16).padStart(6, "0").toUpperCase()}  ${v.vin}`)
  );
  lines.push("");

  // Byte stats
  const ffCount = primary.reduce((c, b) => c + (b === 0xff ? 1 : 0), 0);
  const zeroCount = primary.reduce((c, b) => c + (b === 0x00 ? 1 : 0), 0);
  lines.push(`0xFF bytes: ${ffCount} (${((ffCount / sz) * 100).toFixed(1)}%)`);
  lines.push(`0x00 bytes: ${zeroCount} (${((zeroCount / sz) * 100).toFixed(1)}%)`);
  const data = sz - ffCount - zeroCount;
  lines.push(`Populated bytes: ${data} (${((data / sz) * 100).toFixed(1)}%)`);

  // RFHUB Gen1 — reversed VIN at 0x92
  if (sz === 2048) {
    const rev = primary.subarray(0x92, 0x92 + 17).toString("ascii").split("").reverse().join("");
    if (/[123][A-HJ-NPR-Z0-9]{16}/.test(rev)) lines.push(`\nRFHUB Gen1 reversed VIN @ 0x92: ${rev}`);
  }

  // BCM immo block
  if (sz >= 65536) {
    lines.push("\nBCM immo block (0x40C0):");
    const block = primary.subarray(0x40c0, 0x40c0 + 64);
    lines.push("  " + Array.from(block).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "));
  }

  return truncate(lines.join("\n"), MAX_TOOL_RESULT_BYTES);
}

async function handleHexDiff(
  primary: Buffer,
  binaries: Binaries,
  args: Record<string, unknown>
): Promise<string> {
  const otherId = String(args.otherId || "");
  const offset = Math.max(0, Number(args.offset) || 0);
  const length = Math.min(4096, Math.max(1, Number(args.length) || 256));

  const other = binaries[otherId];
  if (!other) {
    const available = Object.keys(binaries).join(", ") || "(none)";
    return `Error: binary "${otherId}" not found. Available: ${available}`;
  }

  const lines = [
    `Hex diff: primary vs "${otherId}" @ 0x${offset.toString(16).toUpperCase()}, ${length} bytes`,
    `Primary size: ${primary.length}, Other size: ${other.length}`,
    "",
  ];

  let diffCount = 0;
  const maxOff = offset + length;
  for (let i = offset; i < maxOff; i++) {
    const a = i < primary.length ? primary[i] : null;
    const b = i < other.length ? other[i] : null;
    if (a !== b) {
      const aStr = a != null ? a.toString(16).padStart(2, "0").toUpperCase() : "--";
      const bStr = b != null ? b.toString(16).padStart(2, "0").toUpperCase() : "--";
      lines.push(`  0x${i.toString(16).padStart(6, "0").toUpperCase()}  primary=${aStr}  ${otherId}=${bStr}`);
      diffCount++;
      if (diffCount >= 100) { lines.push("  …truncated at 100 diffs"); break; }
    }
  }
  if (diffCount === 0) lines.push("  No differences in this range.");
  else lines.push(`\nTotal diffs in range: ${diffCount}`);

  return truncate(lines.join("\n"), MAX_TOOL_RESULT_BYTES);
}

/* ─── Tool registry ─── */

export interface ToolDefinition {
  schema: {
    name: string;
    description: string;
    input_schema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
  handler: (primary: Buffer, binaries: Binaries, args: Record<string, unknown>) => Promise<string>;
}

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  read_hex: {
    schema: {
      name: "read_hex",
      description:
        "Read raw bytes from the loaded binary as a formatted hex dump. Use to inspect specific offsets, verify field values, or examine adjacent bytes around a known offset.",
      input_schema: {
        type: "object",
        properties: {
          offset: { type: "number", description: "Start offset in bytes (decimal or hex converted to decimal)." },
          length: { type: "number", description: "Number of bytes to read. Max 4096." },
        },
        required: ["offset", "length"],
      },
    },
    handler: handleReadHex,
  },

  extract_strings: {
    schema: {
      name: "extract_strings",
      description:
        "Extract all printable ASCII or UTF-16LE strings from the binary. Useful for finding VINs, part numbers, firmware version strings, or human-readable configuration data.",
      input_schema: {
        type: "object",
        properties: {
          minLen: { type: "number", description: "Minimum string length (default: 6)." },
          encoding: { type: "string", enum: ["ascii", "utf16le"], description: "String encoding to search for (default: ascii)." },
        },
      },
    },
    handler: handleExtractStrings,
  },

  search_patterns: {
    schema: {
      name: "search_patterns",
      description:
        "Search the binary for a specific byte sequence, ASCII string, or regex pattern. Returns all match offsets and surrounding context.",
      input_schema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              'The pattern to search for. For hex: space-separated hex bytes like "AA 50 FF". For ascii: a literal string. For regex: a JS regex pattern applied to the ASCII representation.',
          },
          kind: {
            type: "string",
            enum: ["hex", "ascii", "crypto"],
            description:
              'Search mode: "hex" for byte sequences (e.g. "AA 50 FF"), "ascii" for literal text, "crypto" for high-entropy 16-byte windows that look like key material (no FF/00 runs, ≥10 unique bytes). For crypto, pattern is optional — if a hex pattern is supplied, only windows containing those bytes are reported.',
          },
        },
        required: ["pattern", "kind"],
      },
    },
    handler: handleSearchPatterns,
  },

  eeprom_layout_scan: {
    schema: {
      name: "eeprom_layout_scan",
      description:
        "Scan the binary and produce a structural layout report: inferred module type, VIN slot candidates, large 0xFF padding regions, and byte entropy. Useful for a first-pass orientation of an unfamiliar dump.",
      input_schema: {
        type: "object",
        properties: {},
      },
    },
    handler: handleEepromLayoutScan,
  },

  key_secrets_scan: {
    schema: {
      name: "key_secrets_scan",
      description:
        "Scan for key material: SEC16 (16-byte security token), SEC6 (6-byte PCM secret), and FOBIK/immo slot markers (0xAA 0x50 patterns). Reports candidate offsets and hex previews.",
      input_schema: {
        type: "object",
        properties: {},
      },
    },
    handler: handleKeySecretsScan,
  },

  parse_module: {
    schema: {
      name: "parse_module",
      description:
        "Run the SRT Lab module parser against the loaded binary. Returns inferred type, all VIN occurrences, byte statistics, and module-specific fields (immo block for BCM, reversed VIN for RFHUB Gen1, etc.).",
      input_schema: {
        type: "object",
        properties: {},
      },
    },
    handler: handleParseModule,
  },

  hex_diff: {
    schema: {
      name: "hex_diff",
      description:
        "Compare a byte range between the primary binary and a named secondary binary. Returns all differing offsets with the value from each file. Useful for spotting exactly which bytes differ between BCM and RFHUB, or between a virgin and a programmed dump.",
      input_schema: {
        type: "object",
        properties: {
          otherId: { type: "string", description: 'ID of the secondary binary to compare against (e.g. "rfhub", "bcm"). Must be one of the keys in the binaries map supplied with the request.' },
          offset: { type: "number", description: "Start offset in bytes." },
          length: { type: "number", description: "Number of bytes to compare. Max 4096." },
        },
        required: ["otherId", "offset", "length"],
      },
    },
    handler: handleHexDiff,
  },
};

/** All tool schemas in the format Anthropic messages.create expects. */
export const ANTHROPIC_TOOLS = Object.values(TOOL_REGISTRY).map((t) => t.schema);
