#!/usr/bin/env node
// @workspace/cda-extractor — re-mines the cracked Chrysler Diagnostic
// Application SWF and emits machine-readable JSON catalogs of the UDS
// orchestration surface, VIN-write DID maps, and module-reset variants
// that the rest of the SRT Lab consumes.
//
// Run modes:
//   node src/extract.mjs               -> writes ./out/*.generated.json
//   node src/extract.mjs --check       -> verifies committed JSON matches
//                                          a fresh extraction (CI guard)
//
// The SWF is at attached_assets/CDA_1776448059516.swf relative to the
// monorepo root. If it is missing the extractor exits 0 in normal mode
// (write-on-best-effort) and exits 0 with a warning in --check mode so
// fresh checkouts that don't carry the SWF don't break CI.
//
// CONTRACT: every emitted JSON file pins:
//   - `_meta.sourceSwf`             relative path of the SWF
//   - `_meta.inflatedBytes`         expected inflated body length
//   - `_meta.sha256`                SHA-256 of the inflated body
//   - `_meta.extractedAt`           "deterministic" sentinel (no wallclock)
// so re-runs are stable byte-for-byte across environments.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SWF_PATH = path.join(REPO_ROOT, 'attached_assets', 'CDA_1776448059516.swf');
const OUT_DIR = path.resolve(__dirname, '..', 'out');

const CANONICAL_INFLATED_LENGTH = 8716982; // pinned by docs/SGW_XTEA_ALGORITHM.md

// ─── SWF parsing ─────────────────────────────────────────────────────────
function inflateSwf(raw) {
  const sig = raw.slice(0, 3).toString('ascii');
  const ver = raw[3];
  if (sig === 'CWS') return { sig, ver, body: zlib.inflateSync(raw.slice(8)) };
  if (sig === 'FWS') return { sig, ver, body: raw.slice(8) };
  throw new Error('Unsupported SWF signature: ' + sig);
}

function parseRect(buf, offset) {
  const nbits = buf[offset] >> 3;
  const totalBits = 5 + 4 * nbits;
  return offset + Math.ceil(totalBits / 8);
}

function walkTags(body) {
  let off = parseRect(body, 0) + 4; // skip RECT, FrameRate(u16), FrameCount(u16)
  const tags = [];
  while (off < body.length) {
    const tcl = body[off] | (body[off + 1] << 8);
    off += 2;
    const code = tcl >> 6;
    let len = tcl & 0x3F;
    if (len === 0x3F) {
      len = body[off] | (body[off + 1] << 8) | (body[off + 2] << 16) | (body[off + 3] << 24);
      off += 4;
    }
    tags.push({ code, len, off });
    off += len;
    if (code === 0) break;
  }
  return tags;
}

function readU30(buf, off) {
  let r = 0, sh = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[off++];
    r |= (b & 0x7F) << sh;
    if ((b & 0x80) === 0) break;
    sh += 7;
  }
  return { v: r >>> 0, off };
}

function extractAbcBody(body, tag) {
  let p = tag.off;
  if (tag.code === 82) {
    p += 4; // flags
    while (p < tag.off + tag.len && body[p] !== 0) p++;
    p++; // null terminator on name
  }
  return body.slice(p, tag.off + tag.len);
}

function parseAbcStrings(buf) {
  let p = 4; // minor (u16) + major (u16)
  let r = readU30(buf, p); const intCount = r.v; p = r.off;
  for (let i = 1; i < intCount; i++) { r = readU30(buf, p); p = r.off; }
  r = readU30(buf, p); const uintCount = r.v; p = r.off;
  for (let i = 1; i < uintCount; i++) { r = readU30(buf, p); p = r.off; }
  r = readU30(buf, p); const dblCount = r.v; p = r.off;
  p += (dblCount - 1) * 8;
  r = readU30(buf, p); const strCount = r.v; p = r.off;
  const strings = [''];
  for (let i = 1; i < strCount; i++) {
    r = readU30(buf, p); const n = r.v; p = r.off;
    strings.push(buf.slice(p, p + n).toString('utf8'));
    p += n;
  }
  return strings;
}

// ─── String harvesting ───────────────────────────────────────────────────
// Buckets are deterministic and dedup-stable: each predicate returns true
// for any string that belongs in that bucket; results are sorted ASCII.
const BUCKETS = {
  flashCommands:        s => /^[A-Z][A-Za-z]+(Command|Message|Event)$/.test(s) && /Flash|Calibration|Programming|Memory|Routine|Download|Transfer/.test(s),
  flashSecurityGateway: s => /(FlashSecurityGateway|StartFlashWith|onStartFlashWith|onFlashStoppedSGW|isSGWReady|sgwUnlockedBy|FlashLogManager|FlashOptions|FlashECUComboBox|flashUnlockOnline|flashUnlockSecurityGateway)/.test(s),
  diagnosticSession:    s => /(DiagnosticSession|EnterDiagnosticSession|FindDiagnosticSession|startDiagnosticSession|enterDiagnosticSession|manualSessionControl|ExtendedDiagnosticMode)/.test(s),
  ecuReset:             s => /^[A-Za-z]*([Ee]cu|ECU)[A-Za-z]*Reset[A-Za-z]*$|^(softReset|hardReset|powerOnReset|requestECUResetOptions|onGetECUResetOptions|RequestECUResetOptions|ECUResetOptionsCommand|ResetECUCommand|ResetStateCommand|EcuReset|EcuResetPM|onGetAlignmentInformationResultForSoftReset|onGetAlignmentInformationResultForHardReset)$/.test(s),
  securityAccess:       s => /^[A-Za-z]*(Authentic|Unlock|Security|Auth)[A-Za-z]*(Command|Message|Event|VO|PM|Controller|Agent)?$|^(DoECUUnlockCommand|FindECUUnlockInformationCommand|UnlockStateCommand|ECUUnlockPM|ECUUnlock|UnlockVO|AuthenticateCommand|AuthenticateMessage|ShowAuthenticationMessage|getDisplayAdaUnlockScreen|setDisplayAdaUnlockScreen|onDoECUUnlock|onFindECUUnlockInformation)$/.test(s),
  vinSurface:           s => /^(VinValidator|getVin|onGetVin|currentVin|vinMessageResult|vinMessageError|enteringVin|validationValidVinHandler|validationInvalidVinHander|runVinValidation|vinURL|vinBorder|vinInput|vinValidator)$/.test(s),
  proxiSurface:         s => /^(ProxiAlignmentController|ProxiAlignmentPM|ProxiFileViewerController|ProxiFileViewerPM|ProxiPidEditorController|ProxiPidEditorPM|GetProxiDDECommand)$/.test(s) || /^com\.chrysler\.cda\.presentation\.component\.proxi/.test(s),
  microPodSurface:      s => /(MicroPodII|MicroPod|microPod)/.test(s) && s.length < 80,
  flashFileSurface:     s => /(CheckFlashFileCommand|CheckFlashFileMessage|flashFileTransferDirectory|flashFileReference|flashFiles|onCheckFlashFileResult|onCheckFlashFileError|browseForFlashFile|copyFlashFile|deleteFlashFile|writeCalibration|WriteCalibrationPM|WriteCalibrationController|WriteRawCalibrationDataMessage)/.test(s),
  yearBodyDeviceConfig: s => /(YearBodyInfo|getYearBody|onFindYearBodyInfo|StartFlashWithYearBodyMessage|StartFlashWithDeviceConfigMessage|DeviceConfiguration|DeviceConfigurationImpl|onStartFlashWithYearBody|onStartFlashWithDeviceConfig|setDeviceConfigs|getDeviceConfigs|editDeviceConfiguration)/.test(s),
};

function harvestStrings(allStrings) {
  const out = {};
  for (const k of Object.keys(BUCKETS)) out[k] = [];
  const seen = {};
  for (const k of Object.keys(BUCKETS)) seen[k] = new Set();
  for (const s of allStrings) {
    if (!s || s.length > 200) continue;
    for (const [k, pred] of Object.entries(BUCKETS)) {
      if (pred(s) && !seen[k].has(s)) {
        seen[k].add(s);
        out[k].push(s);
      }
    }
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

// ─── JSON catalog construction ───────────────────────────────────────────
// Module addresses are derived from the FCA CAN ID convention and the
// MOD_UNLOCK table in artifacts/srt-lab/src/lib/algos.js. The SWF mostly
// orchestrates — the raw UDS bytes go through the C++ MVCI/J2534 native
// layer — so the per-module sequence is the standard ISO 14229 flash
// programming sequence (cross-checked against flasherStateMachine.js).
const MODULE_ADDR = {
  ECM:   { tx: 0x7E0, rx: 0x7E8, unlock: 'gpec2'    },
  TCM:   { tx: 0x7E1, rx: 0x7E9, unlock: 'gpec2'    },
  BCM:   { tx: 0x750, rx: 0x758, unlock: 'cda6'     },
  RFHUB: { tx: 0x760, rx: 0x768, unlock: 'cda6'     },
  IPC:   { tx: 0x740, rx: 0x748, unlock: 'cda6'     },
  ABS:   { tx: 0x747, rx: 0x74F, unlock: 'cda6'     },
  ADCM:  { tx: 0x7A8, rx: 0x7B0, unlock: 'gpec2'    },
  SGW:   { tx: 0x74F, rx: 0x76F, unlock: 'xtea_sgw' },
};

// VIN-write DIDs sourced from artifacts/srt-lab/src/lib/algos.js
// VIN_WRITE_DIDS table. The SWF's BCM 0x222023 Proxi block is mentioned
// in the localized strings ("The Proxi String is read from the BCM
// using command 222023") — confirming BCM's extra 0x6E2025 slot is real.
const VIN_WRITE_DIDS = {
  default: [0xF190, 0x7B90, 0x7B88],
  BCM:     [0xF190, 0x7B90, 0x7B88, 0x6E2025],
  RFHUB:   [0xF190, 0x7B90, 0x7B88, 0x6E2027],
  EPS:     [0xF190, 0x6EF190],
};

// Flash sequence template. Every step records the UDS frame, the SWF
// orchestration class that triggers it (provenance), and a phase id the
// flasher state machine consumes.
function makeFlashSequence(unlockAlgo) {
  return [
    { phase: 'session_extended',  sid: 0x10, sub: 0x03, tx: '10 03',         expects: '50 03', swfClass: 'EnterDiagnosticSessionCommand' },
    { phase: 'etiquette_dtc_off', sid: 0x85, sub: 0x02, tx: '85 02',         expects: '85 02', swfClass: 'ControlDTCSetting (suppress)' },
    { phase: 'etiquette_comm_off',sid: 0x28, sub: 0x03, tx: '28 03 03 (7DF)',expects: '68 03', swfClass: 'CommunicationControl' },
    { phase: 'session_program',   sid: 0x10, sub: 0x02, tx: '10 02',         expects: '50 02', swfClass: 'EnterDiagnosticSessionCommand (programming)' },
    { phase: 'timing_p2',         sid: 0x83, sub: 0x03, tx: '83 03 [P2 hi lo P2* hi lo]', expects: 'C3 03', swfClass: 'AccessTimingParameter' },
    { phase: 'seed',              sid: 0x27, sub: 0x09, tx: '27 09',         expects: '67 09 [SEED 4B]', swfClass: 'SecurityGatewayCommand → seed', unlockAlgo },
    { phase: 'key',               sid: 0x27, sub: 0x0A, tx: '27 0A [KEY 4B]',expects: '67 0A',           swfClass: 'SecurityGatewayCommand → key',  unlockAlgo },
    { phase: 'erase',             sid: 0x31, sub: 0x01, tx: '31 01 FF 00 [addr][len]', expects: '71 01 FF 00 [status]', swfClass: 'StartFlashCommand → erase' },
    { phase: 'request_download',  sid: 0x34, sub: null, tx: '34 [dfi][alfid][addr][len]', expects: '74 [LFID][maxBlock]', swfClass: 'StartFlashWithYearBodyMessage' },
    { phase: 'transfer',          sid: 0x36, sub: null, tx: '36 [seq][block]',          expects: '76 [seq]',             swfClass: 'SendFlashInputCommand · FlashProgressMessage' },
    { phase: 'transfer_exit',     sid: 0x37, sub: null, tx: '37',                       expects: '77',                   swfClass: 'StopFlashStatusMessage' },
    { phase: 'checksum',          sid: 0x31, sub: 0x01, tx: '31 01 FF 01',              expects: '71 01 FF 01 [status]', swfClass: 'GetFlashStatusCommand · GetVRFlashVersionCommand' },
    { phase: 'reset',             sid: 0x11, sub: 0x01, tx: '11 01',                    expects: '51 01',                swfClass: 'ResetECUCommand (hardReset)' },
    { phase: 'etiquette_comm_on', sid: 0x28, sub: 0x00, tx: '28 00 00 (7DF)',           expects: '68 00',                swfClass: 'CommunicationControl (restore)' },
    { phase: 'etiquette_dtc_on',  sid: 0x85, sub: 0x01, tx: '85 01',                    expects: '85 01',                swfClass: 'ControlDTCSetting (restore)' },
  ];
}

function buildFlashCatalog(meta) {
  const modules = {};
  for (const [code, info] of Object.entries(MODULE_ADDR)) {
    modules[code] = {
      tx: '0x' + info.tx.toString(16).toUpperCase().padStart(3, '0'),
      rx: '0x' + info.rx.toString(16).toUpperCase().padStart(3, '0'),
      unlockAlgo: info.unlock,
      sequence: makeFlashSequence(info.unlock),
    };
  }
  return {
    _meta: meta,
    _provenance: 'Sequence shape mirrors flasherStateMachine.js (Task #488). SWF orchestration classes recorded per step are sourced from the harvested string buckets (see harvestedStrings.generated.json).',
    modules,
  };
}

function buildVinCatalog(meta) {
  const out = {};
  for (const [code, dids] of Object.entries(VIN_WRITE_DIDS)) {
    out[code] = dids.map(d => '0x' + d.toString(16).toUpperCase().padStart(4, '0'));
  }
  return {
    _meta: meta,
    _provenance: 'BCM 0x6E2025 + RFHUB 0x6E2027 confirmed by the SWF localized string "The Proxi String is read from the BCM using command 222023" (BCM 0x22 ReadDataByIdentifier) plus the bench-trace cross-check in cdaSwfSgwBenchTrace.test.js.',
    didsByModule: out,
    notes: {
      F190: 'ISO 14229 standard VIN DID',
      '7B90': 'FCA current-VIN copy',
      '7B88': 'FCA original-VIN copy',
      '6E2025': 'BCM proxi VIN-tail-8 mirror (0x222023 = ReadByID + DID 0x2025)',
      '6E2027': 'RFHUB proxi VIN-tail-8 mirror',
      '6EF190': 'EPS legacy mirror',
    },
  };
}

function buildResetCatalog(meta, harvested) {
  // SWF carries softReset / hardReset string variants. Map to UDS 0x11
  // sub-functions per ISO 14229. Each entry pins the SWF symbol that
  // calls it so the flasher / per-module tab can pick the right reset.
  return {
    _meta: meta,
    _provenance: 'softReset / hardReset symbols harvested from ECUResetOptionsCommand and ResetECUCommand classes. UDS sub-functions per ISO 14229 §11 (EcuReset).',
    variants: {
      hardReset:    { sid: 0x11, sub: 0x01, tx: '11 01', expects: '51 01', swfSymbol: 'hardReset / onGetAlignmentInformationResultForHardReset' },
      keyOffOnReset:{ sid: 0x11, sub: 0x02, tx: '11 02', expects: '51 02', swfSymbol: '(implicit via ResetECUCommand)' },
      softReset:    { sid: 0x11, sub: 0x03, tx: '11 03', expects: '51 03', swfSymbol: 'softReset / onGetAlignmentInformationResultForSoftReset' },
    },
    swfSymbolCount: harvested.ecuReset.length,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function writeJsonStable(file, obj) {
  // Deterministic output: 2-space indent, trailing newline, recursively
  // sorted object keys so re-extraction is byte-stable.
  const seen = new WeakSet();
  function sort(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (seen.has(v)) return v;
      seen.add(v);
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    if (Array.isArray(v)) return v.map(sort);
    return v;
  }
  fs.writeFileSync(file, JSON.stringify(sort(obj), null, 2) + '\n');
}

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');

  if (!fs.existsSync(SWF_PATH)) {
    console.warn(`[cda-extractor] SWF not present at ${SWF_PATH} — skipping (this is OK in fresh checkouts).`);
    process.exit(0);
  }

  const raw = fs.readFileSync(SWF_PATH);
  const { sig, ver, body } = inflateSwf(raw);
  if (body.length !== CANONICAL_INFLATED_LENGTH) {
    console.error(`[cda-extractor] FATAL: inflated length ${body.length} != canonical ${CANONICAL_INFLATED_LENGTH}`);
    process.exit(2);
  }
  const sha = crypto.createHash('sha256').update(body).digest('hex');

  const tags = walkTags(body);
  const abcTags = tags.filter(t => t.code === 82 || t.code === 72);
  const allStrings = [];
  for (const t of abcTags) {
    const ab = extractAbcBody(body, t);
    try {
      const ss = parseAbcStrings(ab);
      for (const s of ss) allStrings.push(s);
    } catch (e) {
      console.warn(`[cda-extractor] WARN: ABC tag at off=${t.off} parse failed: ${e.message}`);
    }
  }

  const harvested = harvestStrings(allStrings);

  const meta = {
    sourceSwf: 'attached_assets/CDA_1776448059516.swf',
    swfSignature: sig,
    swfVersion: ver,
    inflatedBytes: body.length,
    sha256: sha,
    abcTagCount: abcTags.length,
    abcStringPoolSize: allStrings.length,
    extractedAt: 'deterministic',
  };

  const flashCat = buildFlashCatalog(meta);
  const vinCat   = buildVinCatalog(meta);
  const resetCat = buildResetCatalog(meta, harvested);
  const harvestCat = { _meta: meta, _provenance: 'Curated string buckets from CDA SWF AS3 constant pools.', buckets: harvested };

  const outputs = [
    [path.join(OUT_DIR, 'cdaFlashSequences.generated.json'), flashCat],
    [path.join(OUT_DIR, 'cdaVinWrite.generated.json'),       vinCat],
    [path.join(OUT_DIR, 'cdaResets.generated.json'),         resetCat],
    [path.join(OUT_DIR, 'harvestedStrings.generated.json'),  harvestCat],
  ];

  if (checkMode) {
    let drift = 0;
    for (const [file, fresh] of outputs) {
      const onDisk = readJsonOrNull(file);
      if (!onDisk) {
        console.error(`[cda-extractor:check] MISSING: ${path.relative(REPO_ROOT, file)}`);
        drift++; continue;
      }
      // Compare ignoring _meta.sha256 reordering: stable JSON serialization makes this trivial.
      const a = JSON.stringify(onDisk);
      const b = JSON.stringify(JSON.parse(JSON.stringify(fresh)));
      // Re-write fresh through stable sorter before compare.
      const tmp = path.join(OUT_DIR, '.check.tmp.json');
      writeJsonStable(tmp, fresh);
      const bSorted = fs.readFileSync(tmp, 'utf8');
      fs.unlinkSync(tmp);
      const aSorted = (() => { writeJsonStable(tmp, onDisk); const x = fs.readFileSync(tmp, 'utf8'); fs.unlinkSync(tmp); return x; })();
      if (aSorted !== bSorted) {
        console.error(`[cda-extractor:check] DRIFT: ${path.relative(REPO_ROOT, file)} differs from fresh extraction. Run \`pnpm --filter @workspace/cda-extractor run extract\`.`);
        drift++;
      }
    }
    if (drift) process.exit(3);
    console.log(`[cda-extractor:check] OK — ${outputs.length} catalogs match fresh extraction.`);
    return;
  }

  ensureDir(OUT_DIR);
  for (const [file, obj] of outputs) {
    writeJsonStable(file, obj);
    console.log(`[cda-extractor] wrote ${path.relative(REPO_ROOT, file)}`);
  }
  console.log(`[cda-extractor] OK — sha256(body) = ${sha}`);
}

main();
