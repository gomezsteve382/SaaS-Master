/**
 * Parse decompiler text output (e.g. ilspycmd C# project) into the
 * structured shapes the SRT Lab "AlfaOBD Tables" view consumes.
 *
 * The parsing is deliberately conservative: it relies on stable C#
 * patterns ilspycmd emits and never invents or merges values that are
 * not literally present in the decompiled source. If a target pattern
 * is absent in the decompiled output for a given build, the
 * corresponding output entry is empty rather than fabricated.
 *
 * Inputs:
 *   - filesByPath: Map<string, string>  (relative path → decompiled C# text)
 *
 * Outputs:
 *   - { ecutypeFamilies, handlers, transports }
 */

const HEX = "0x[0-9A-Fa-f]+";

/* Recognise "public ECUTYPE_FOO Bar = (ECUTYPE_FOO)0x132;" or
 * "<ECUTYPE_FOO>k__BackingField = ..." style identifiers, plus the
 * canonical enum form `enum ECUTYPE_xxx { Bar = 0x132, ... }`. */
const ENUM_BLOCK_RE = /\benum\s+(ECUTYPE_[A-Za-z0-9_]+)\s*(?::\s*[A-Za-z0-9_]+\s*)?\{([\s\S]*?)\}/g;
const ENUM_MEMBER_RE = new RegExp(`([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(${HEX}|\\d+)`, "g");

/* Detect Process*Data instance methods so we can capture the calls
 * each one makes. We keep the exact text match for the source field
 * so callers can grep back into the decompiler output. */
const HANDLER_DECL_RE =
  /^\s*(?:public|private|internal|protected)?\s*(?:static\s+|async\s+|virtual\s+|override\s+)*[A-Za-z0-9_<>\[\],\s]+\s+(Process[A-Za-z0-9_]+Data)\s*\(/m;

/* Inside a handler body, capture method names that look like UDS or
 * KWP-flavoured outbound calls so the SRT Lab can show what each
 * handler actually touches. */
const CALL_RE = /\b([A-Z][A-Za-z0-9_]{2,})\s*\(/g;

/* UDS service identifiers we want to surface explicitly when found
 * inside a Process*Data handler body. */
const UDS_HEX_RE = /\b0x(10|11|14|19|22|23|27|28|2A|2C|2E|2F|31|34|35|36|37|38|3D|3E|7F)\b/gi;

/* Transport detection: managed type/identifier name → transport bucket.
 * Keep this list small and explicit; do not infer beyond it. */
const TRANSPORT_BUCKETS = [
  { kind: "j2534",       patterns: [/\bJ2534\b/, /\bJ2534Sharp\b/i, /\bSAE\.J2534\b/i] },
  { kind: "sae_j2534",   patterns: [/\bSAE\.J2534\b/i] },
  { kind: "j2534_sharp", patterns: [/\bJ2534Sharp\b/i, /\bJ2534-Sharp\b/i] },
  { kind: "serial",      patterns: [/\bSerialPort\b/, /\bIO\.Ports\.SerialPort\b/] },
  { kind: "stn_ftdi",    patterns: [/\bStn\.Ftdi\b/, /\bFtdiStream\b/] },
  { kind: "bluetooth",   patterns: [/\bBluetoothClient\b/, /\bBluetoothDeviceInfo\b/, /\bBluetoothSecurity\b/] },
  { kind: "socket",      patterns: [/\bSystem\.Net\.Sockets\.Socket\b/, /\bTcpClient\b/, /\bUdpClient\b/] },
];

const VERSION_NEAR_TRANSPORT_RE =
  /(?:J2534(?:Sharp)?|SerialPort|FtdiStream|BluetoothClient|Socket)[\s\S]{0,200}?(?:Version|version)[^"]*"([0-9][0-9A-Za-z.\-+]{0,40})"/g;

export function parseDecompiled(filesByPath) {
  const ecutypeFamilies = parseEcutypeFamilies(filesByPath);
  const handlers        = parseHandlers(filesByPath);
  const transports      = parseTransports(filesByPath);
  return { ecutypeFamilies, handlers, transports };
}

/* ── ECUTYPE_* families ─────────────────────────────────────────────── */
function parseEcutypeFamilies(filesByPath) {
  const families = new Map(); // family → { modules: Map<id, entry> }

  for (const [path, text] of filesByPath) {
    if (!text || text.indexOf("ECUTYPE_") < 0) continue;
    let m;
    ENUM_BLOCK_RE.lastIndex = 0;
    while ((m = ENUM_BLOCK_RE.exec(text))) {
      const family = m[1];
      const body = m[2];
      const fam = families.get(family) || { modules: new Map() };
      let mm;
      ENUM_MEMBER_RE.lastIndex = 0;
      while ((mm = ENUM_MEMBER_RE.exec(body))) {
        const name = mm[1];
        if (name === "value__") continue;
        const id = canonU32(mm[2]);
        if (!fam.modules.has(id + "|" + name)) {
          fam.modules.set(id + "|" + name, {
            ecu_type_id: id,
            name,
            display_name: humanize(name),
            protocols: protocolsFromFamily(family),
            source: `${path}:${lineOf(text, mm.index)}`,
          });
        }
      }
      families.set(family, fam);
    }
  }

  /* Surface address pairs when they appear *literally* alongside an
   * ECUTYPE id in the same file: pattern `case ECUTYPE_X.Foo: tx=0x7E0; rx=0x7E8`.
   * This is best-effort and only updates entries we already discovered. */
  for (const [path, text] of filesByPath) {
    if (!text) continue;
    const addrRe = /ECUTYPE_([A-Za-z0-9_]+)\.([A-Za-z_][A-Za-z0-9_]*)[\s\S]{0,200}?(?:tx|TxId|TXID|TX_ID)\D{0,8}(0x[0-9A-Fa-f]+)[\s\S]{0,200}?(?:rx|RxId|RXID|RX_ID)\D{0,8}(0x[0-9A-Fa-f]+)/g;
    let mm;
    while ((mm = addrRe.exec(text))) {
      const family = "ECUTYPE_" + mm[1];
      const fam = families.get(family);
      if (!fam) continue;
      for (const entry of fam.modules.values()) {
        if (entry.name === mm[2]) {
          entry.tx_address = canonU32(mm[3]);
          entry.rx_address = canonU32(mm[4]);
          break;
        }
      }
    }
  }

  const out = [];
  for (const [family, fam] of families) {
    out.push({ family, modules: Array.from(fam.modules.values()).sort(byEcuTypeId) });
  }
  out.sort((a, b) => a.family.localeCompare(b.family));
  return out;
}

function byEcuTypeId(a, b) {
  const ai = parseInt(a.ecu_type_id, 16);
  const bi = parseInt(b.ecu_type_id, 16);
  if (ai !== bi) return ai - bi;
  return a.name.localeCompare(b.name);
}

function protocolsFromFamily(family) {
  const m = family.match(/^ECUTYPE_(.+)$/);
  if (!m) return [];
  const tail = m[1];
  const known = ["KWP2000", "ISO9141", "CAN", "BCAN", "CCAN"];
  const hits = known.filter(k => tail.includes(k));
  return hits.length ? hits : [tail];
}

/* ── Process*Data handlers ──────────────────────────────────────────── */
function parseHandlers(filesByPath) {
  const out = [];
  for (const [path, text] of filesByPath) {
    if (!text || text.indexOf("Process") < 0) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const decl = lines[i].match(HANDLER_DECL_RE);
      if (!decl) continue;
      const name = decl[1];
      const body = sliceBody(text, indexOfLine(text, i));
      if (body == null) continue;
      const calls = uniqueSorted(scanCalls(body)).filter(c => c !== name);
      const udsServices = uniqueSorted(scanUdsServices(body));
      out.push({
        name,
        declaring_type: declaringType(text, indexOfLine(text, i)),
        source: `${path}:${i + 1}`,
        calls,
        uds_services: udsServices,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  // Dedupe by name+source
  const seen = new Set();
  return out.filter(h => {
    const key = h.name + "@" + h.source;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function declaringType(text, idx) {
  const before = text.slice(0, idx);
  const m = /\b(?:public|internal|sealed|abstract|partial)\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let last = null;
  for (const match of before.matchAll(m)) last = match[1];
  return last || undefined;
}

function indexOfLine(text, lineIdx) {
  let i = 0, count = 0;
  while (i < text.length && count < lineIdx) { if (text[i] === "\n") count++; i++; }
  return i;
}

function sliceBody(text, start) {
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(open + 1, i); }
  }
  return null;
}

function scanCalls(body) {
  const out = [];
  let m;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(body))) {
    const c = m[1];
    if (c === "if" || c === "for" || c === "while" || c === "switch" ||
        c === "catch" || c === "return" || c === "throw" || c === "lock" ||
        c === "using" || c === "foreach" || c === "new") continue;
    out.push(c);
  }
  return out;
}

function scanUdsServices(body) {
  const out = [];
  let m;
  UDS_HEX_RE.lastIndex = 0;
  while ((m = UDS_HEX_RE.exec(body))) {
    out.push("0x" + m[1].toUpperCase());
  }
  return out;
}

/* ── Transports ─────────────────────────────────────────────────────── */
function parseTransports(filesByPath) {
  const buckets = new Map(); // kind → Set of types
  for (const [, text] of filesByPath) {
    if (!text) continue;
    for (const b of TRANSPORT_BUCKETS) {
      for (const re of b.patterns) {
        const all = text.match(re);
        if (!all) continue;
        if (!buckets.has(b.kind)) buckets.set(b.kind, new Set());
        for (const hit of all) {
          buckets.get(b.kind).add(hit.replace(/[\s\\]/g, ""));
        }
      }
    }
  }

  const versions = new Map(); // kind → version (best effort)
  for (const [, text] of filesByPath) {
    if (!text) continue;
    let m;
    VERSION_NEAR_TRANSPORT_RE.lastIndex = 0;
    while ((m = VERSION_NEAR_TRANSPORT_RE.exec(text))) {
      const blob = m[0];
      for (const b of TRANSPORT_BUCKETS) {
        if (b.patterns.some(p => p.test(blob))) {
          if (!versions.has(b.kind)) versions.set(b.kind, m[1]);
        }
      }
    }
  }

  const out = [];
  for (const [kind, set] of buckets) {
    const e = { kind, types: Array.from(set).sort() };
    if (versions.has(kind)) e.version = versions.get(kind);
    out.push(e);
  }
  out.sort((a, b) => a.kind.localeCompare(b.kind));
  return out;
}

/* ── Utils ─────────────────────────────────────────────────────────── */
function canonU32(s) {
  let n;
  if (typeof s === "number") n = s >>> 0;
  else if (typeof s === "string") n = (s.startsWith("0x") || s.startsWith("0X")) ? Number(s) : Number(s);
  else throw new Error("canonU32: bad input " + s);
  return "0x" + (n >>> 0).toString(16).toUpperCase();
}

function uniqueSorted(arr) {
  return Array.from(new Set(arr)).sort();
}

function humanize(name) {
  return name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function lineOf(text, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (text[i] === "\n") line++;
  return line;
}
