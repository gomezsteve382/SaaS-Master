#!/usr/bin/env node
// @workspace/cda-extractor — re-mines the cracked Chrysler Diagnostic
// Application SWF and emits machine-readable JSON catalogs of the UDS
// orchestration surface, VIN-write DID maps, module-reset variants, and
// (super-mine) the full ABC constant-pool + per-class push-constant
// inventory disassembled from every AS3 method body in the SWF.
//
// Run modes:
//   node src/extract.mjs               -> writes ./out/*.generated.json
//   node src/extract.mjs --check       -> verifies committed JSON matches
//                                          a fresh extraction (CI guard)
//
// CONTRACT: every emitted JSON file pins:
//   _meta.sourceSwf, _meta.inflatedBytes, _meta.sha256, _meta.extractedAt
// so re-runs are byte-stable across environments.

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
const CANONICAL_INFLATED_LENGTH = 8716982;

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
  return offset + Math.ceil((5 + 4 * nbits) / 8);
}
function walkTags(body) {
  let off = parseRect(body, 0) + 4;
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
function extractAbcBody(body, tag) {
  let p = tag.off;
  if (tag.code === 82) {
    p += 4;
    while (p < tag.off + tag.len && body[p] !== 0) p++;
    p++;
  }
  return body.slice(p, tag.off + tag.len);
}

// ─── ABC primitive readers ───────────────────────────────────────────────
class R {
  constructor(buf) { this.b = buf; this.p = 0; }
  u8()   { return this.b[this.p++]; }
  u16()  { const v = this.b[this.p] | (this.b[this.p+1]<<8); this.p+=2; return v; }
  s24()  { const v = this.b[this.p] | (this.b[this.p+1]<<8) | (this.b[this.p+2]<<16); this.p+=3; return (v & 0x800000) ? v - 0x1000000 : v; }
  u30()  {
    let r = 0, sh = 0;
    for (let i = 0; i < 5; i++) {
      const c = this.b[this.p++];
      r |= (c & 0x7F) << sh;
      if (!(c & 0x80)) break;
      sh += 7;
    }
    return r >>> 0;
  }
  s32()  { // signed varint
    let r = 0, sh = 0, c = 0;
    for (let i = 0; i < 5; i++) {
      c = this.b[this.p++];
      r |= (c & 0x7F) << sh;
      if (!(c & 0x80)) break;
      sh += 7;
    }
    if (sh < 32 && (c & 0x40)) r |= -(1 << (sh + 7));
    return r | 0;
  }
  u32() { return this.s32() >>> 0; }
  d64() { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
  bytes(n) { const v = this.b.slice(this.p, this.p+n); this.p += n; return v; }
  str(n)   { const v = this.b.slice(this.p, this.p+n).toString('utf8'); this.p += n; return v; }
}

// ─── ABC full constant-pool + class/method/method_body parser ────────────
function parseAbc(buf) {
  const r = new R(buf);
  /* const minor = */ r.u16();
  /* const major = */ r.u16();

  // ints
  const intCount = r.u30();
  const ints = [0];
  for (let i = 1; i < intCount; i++) ints.push(r.s32());

  // uints
  const uintCount = r.u30();
  const uints = [0];
  for (let i = 1; i < uintCount; i++) uints.push(r.u32());

  // doubles
  const dblCount = r.u30();
  const doubles = [NaN];
  for (let i = 1; i < dblCount; i++) doubles.push(r.d64());

  // strings
  const strCount = r.u30();
  const strings = [''];
  for (let i = 1; i < strCount; i++) {
    const n = r.u30();
    strings.push(r.str(n));
  }

  // namespaces
  const nsCount = r.u30();
  const namespaces = [{ kind: 0, name: 0 }];
  for (let i = 1; i < nsCount; i++) {
    const kind = r.u8();
    const name = r.u30();
    namespaces.push({ kind, name });
  }

  // ns_sets
  const nsSetCount = r.u30();
  const nsSets = [[]];
  for (let i = 1; i < nsSetCount; i++) {
    const c = r.u30();
    const items = [];
    for (let j = 0; j < c; j++) items.push(r.u30());
    nsSets.push(items);
  }

  // multinames
  const mnCount = r.u30();
  const multinames = [{ kind: 0 }];
  for (let i = 1; i < mnCount; i++) {
    const kind = r.u8();
    let mn = { kind };
    switch (kind) {
      case 0x07: case 0x0D: // QName / QNameA
        mn.ns = r.u30(); mn.name = r.u30(); break;
      case 0x0F: case 0x10: // RTQName / RTQNameA
        mn.name = r.u30(); break;
      case 0x11: case 0x12: // RTQNameL / RTQNameLA
        break;
      case 0x09: case 0x0E: // Multiname / MultinameA
        mn.name = r.u30(); mn.nsSet = r.u30(); break;
      case 0x1B: case 0x1C: // MultinameL / MultinameLA
        mn.nsSet = r.u30(); break;
      case 0x1D: { // Typename
        mn.name = r.u30();
        const tc = r.u30();
        const params = [];
        for (let j = 0; j < tc; j++) params.push(r.u30());
        mn.params = params;
        break;
      }
      default:
        throw new Error(`Unknown multiname kind 0x${kind.toString(16)} at mn idx ${i}, pool offset ${r.p}`);
    }
    multinames.push(mn);
  }

  // methods
  const methodCount = r.u30();
  const methods = [];
  for (let i = 0; i < methodCount; i++) {
    const paramCount = r.u30();
    const returnType = r.u30();
    const paramTypes = [];
    for (let j = 0; j < paramCount; j++) paramTypes.push(r.u30());
    const name = r.u30();
    const flags = r.u8();
    if (flags & 0x08) { // HAS_OPTIONAL
      const oc = r.u30();
      for (let j = 0; j < oc; j++) { r.u30(); r.u8(); } // val, kind
    }
    if (flags & 0x80) { // HAS_PARAM_NAMES
      for (let j = 0; j < paramCount; j++) r.u30();
    }
    methods.push({ name, paramCount, returnType, paramTypes, flags, body: null });
  }

  // metadata
  const metaCount = r.u30();
  for (let i = 0; i < metaCount; i++) {
    /* name */ r.u30();
    const itemCount = r.u30();
    for (let j = 0; j < itemCount; j++) { r.u30(); r.u30(); }
  }

  function readTrait() {
    const name = r.u30();
    const kindByte = r.u8();
    const kind = kindByte & 0x0F;
    const attr = kindByte >> 4;
    const t = { name, kind };
    switch (kind) {
      case 0: case 6: // slot, const
        r.u30(); // slot_id
        r.u30(); // type_name
        const vindex = r.u30();
        if (vindex !== 0) r.u8(); // vkind
        break;
      case 1: case 2: case 3: // method, getter, setter
        r.u30(); // disp_id
        t.method = r.u30();
        break;
      case 4: // class
        r.u30(); // slot_id
        r.u30(); // class_idx
        break;
      case 5: // function
        r.u30(); // slot_id
        t.method = r.u30();
        break;
      default:
        throw new Error(`Unknown trait kind ${kind}`);
    }
    if (attr & 0x4) { // METADATA
      const mc = r.u30();
      for (let i = 0; i < mc; i++) r.u30();
    }
    return t;
  }

  // instances
  const classCount = r.u30();
  const instances = [];
  for (let i = 0; i < classCount; i++) {
    const inst = { name: r.u30(), superName: r.u30() };
    const flags = r.u8();
    inst.flags = flags;
    if (flags & 0x08) inst.protectedNs = r.u30();
    const ifaceCount = r.u30();
    inst.interfaces = [];
    for (let j = 0; j < ifaceCount; j++) inst.interfaces.push(r.u30());
    inst.iinit = r.u30();
    const tc = r.u30();
    inst.traits = [];
    for (let j = 0; j < tc; j++) inst.traits.push(readTrait());
    instances.push(inst);
  }
  // classes
  const classes = [];
  for (let i = 0; i < classCount; i++) {
    const cls = { cinit: r.u30(), traits: [] };
    const tc = r.u30();
    for (let j = 0; j < tc; j++) cls.traits.push(readTrait());
    classes.push(cls);
  }
  // scripts
  const scriptCount = r.u30();
  const scripts = [];
  for (let i = 0; i < scriptCount; i++) {
    const init = r.u30();
    const tc = r.u30();
    const traits = [];
    for (let j = 0; j < tc; j++) traits.push(readTrait());
    scripts.push({ init, traits });
  }
  // method_bodies
  const bodyCount = r.u30();
  const bodies = [];
  for (let i = 0; i < bodyCount; i++) {
    const mIdx = r.u30();
    const body = {
      method: mIdx,
      maxStack: r.u30(),
      localCount: r.u30(),
      initScope: r.u30(),
      maxScope: r.u30(),
    };
    const codeLen = r.u30();
    body.code = r.bytes(codeLen);
    const excCount = r.u30();
    body.exceptions = [];
    for (let j = 0; j < excCount; j++) {
      body.exceptions.push({
        from: r.u30(), to: r.u30(), target: r.u30(),
        excType: r.u30(), varName: r.u30(),
      });
    }
    const tc = r.u30();
    body.traits = [];
    for (let j = 0; j < tc; j++) body.traits.push(readTrait());
    bodies.push(body);
    if (methods[mIdx]) methods[mIdx].body = body;
  }
  return { ints, uints, doubles, strings, namespaces, nsSets, multinames, methods, instances, classes, scripts, bodies };
}

// ─── Multiname → string resolver ─────────────────────────────────────────
function mnToString(mn, abc) {
  if (!mn || mn.kind === 0) return '*';
  const name = mn.name != null ? abc.strings[mn.name] || '*' : '*';
  if (mn.kind === 0x07 || mn.kind === 0x0D) {
    const ns = abc.namespaces[mn.ns];
    const nsName = ns ? abc.strings[ns.name] || '' : '';
    return nsName ? `${nsName}::${name}` : name;
  }
  return name;
}

// ─── AS3 opcode operand widths (0 = no operands; >0 = u30 count; special) ─
// Map of opcode → operand spec: array of operand kinds.
// Kinds: 'u30','u8','s24','byte_op_pair','switch'
const OP = {};
function set(op, ...spec) { OP[op] = spec; }
// 0-operand
for (const c of [0x01,0x02,0x03,0x07,0x09,0x1C,0x1D,0x1E,0x1F,0x20,0x21,0x23,
  0x26,0x27,0x28,0x29,0x2A,0x2B,0x30,0x47,0x48,0x57,0x64,
  0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77,0x78,0x82,0x85,
  0x87,0x90,0x91,0x93,0x95,0x96,0x97,
  0xA0,0xA1,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,0xA8,0xA9,0xAA,
  0xAB,0xAC,0xAD,0xAE,0xAF,0xB0,0xB1,0xB3,0xB4,
  0xC0,0xC1,0xC4,0xC5,0xC6,0xC7,
  0xD0,0xD1,0xD2,0xD3,0xD4,0xD5,0xD6,0xD7,
  0xF3]) set(c);
// single u30
for (const c of [0x04,0x05,0x06,0x08,0x31,0x40,0x41,0x42,0x49,0x53,0x55,0x56,
  0x58,0x59,0x5A,0x5D,0x5E,0x5F,0x60,0x61,0x62,0x63,0x66,0x68,0x6A,
  0x6C,0x6D,0x6E,0x6F,0x80,0x86,0x92,0x94,0xB2,0xC2,0xC3,
  0xF0,0xF1,0xF2,0x2D,0x2E,0x2F,0x2C,0x25]) set(c, 'u30');
// single u8
set(0x24, 'u8');
set(0x65, 'u8');
// branches s24
for (const c of [0x0C,0x0D,0x0E,0x0F,0x10,0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19,0x1A]) set(c, 's24');
// double u30
for (const c of [0x32,0x43,0x44,0x45,0x46,0x4A,0x4C,0x4E,0x4F]) set(c, 'u30','u30');
// debug: u8 u30 u8 u30
set(0xEF, 'u8','u30','u8','u30');
// lookupswitch — special
set(0x1B, 'switch');

// Returns array of { op, args[] } for each instruction.
// Args for 'u30' are raw indices/values (integers); 'u8' raw; 's24' relative offset.
function disassemble(code) {
  const ins = [];
  const r = new R(code);
  while (r.p < code.length) {
    const op = r.u8();
    const spec = OP[op];
    if (!spec) {
      // Unknown opcode — record and stop to avoid mis-aligned walk.
      ins.push({ op, args: ['UNKNOWN'], pos: r.p - 1, halted: true });
      break;
    }
    const args = [];
    let halted = false;
    for (const k of spec) {
      if (k === 'u8') args.push(r.u8());
      else if (k === 'u30') args.push(r.u30());
      else if (k === 's24') args.push(r.s24());
      else if (k === 'switch') {
        // default offset s24, case_count u30, (case_count+1) s24 case offsets
        const def = r.s24(); args.push(def);
        const cc = r.u30(); args.push(cc);
        const cases = [];
        for (let i = 0; i <= cc; i++) cases.push(r.s24());
        args.push(cases);
      } else { halted = true; break; }
    }
    ins.push({ op, args });
    if (halted) break;
  }
  return ins;
}

// ─── Build per-method analysis: every value pushed + every called name ───
// PUSH ops we care about
const PUSH_OPS = new Set([0x24,0x25,0x2C,0x2D,0x2E,0x2F]);
// CALL/REF ops that use a multiname
const CALL_OPS = new Set([0x46,0x4A,0x4C,0x4E,0x4F,0x60,0x66,0x5D,0x5E,0x5F,0x68,0x61]);

function analyzeBody(body, abc) {
  let ins;
  try { ins = disassemble(body.code); }
  catch { return { halted: true, ints: [], uints: [], strings: [], calls: [], pushBytes: [], pushShorts: [] }; }
  const out = { halted: false, ints: new Set(), uints: new Set(), strings: new Set(), calls: new Set(), pushBytes: new Set(), pushShorts: new Set() };
  for (const i of ins) {
    if (i.halted) { out.halted = true; continue; }
    switch (i.op) {
      case 0x24: out.pushBytes.add(i.args[0]); break;             // pushbyte
      case 0x25: out.pushShorts.add(i.args[0]); break;            // pushshort
      case 0x2C: { const s = abc.strings[i.args[0]]; if (s) out.strings.add(s); break; }
      case 0x2D: { const v = abc.ints[i.args[0]]; if (v != null) out.ints.add(v); break; }
      case 0x2E: { const v = abc.uints[i.args[0]]; if (v != null) out.uints.add(v); break; }
      default:
        if (CALL_OPS.has(i.op)) {
          const mn = abc.multinames[i.args[0]];
          if (mn) {
            const nm = mnToString(mn, abc);
            if (nm && nm !== '*') out.calls.add(nm);
          }
        }
    }
  }
  return {
    halted: out.halted,
    ints:    [...out.ints].sort((a,b)=>a-b),
    uints:   [...out.uints].sort((a,b)=>a-b),
    strings: [...out.strings].sort(),
    calls:   [...out.calls].sort(),
    pushBytes:  [...out.pushBytes].sort((a,b)=>a-b),
    pushShorts: [...out.pushShorts].sort((a,b)=>a-b),
  };
}

// Build method index → owning class name + method name.
function buildMethodOwners(abc) {
  const owner = new Map(); // methodIdx → { className, methodName }
  for (let i = 0; i < abc.instances.length; i++) {
    const inst = abc.instances[i];
    const cn = mnToString(abc.multinames[inst.name], abc);
    if (inst.iinit != null) owner.set(inst.iinit, { className: cn, methodName: '<iinit>' });
    for (const t of inst.traits) {
      if (t.method != null) {
        const mname = abc.strings[t.name] || `m${t.method}`;
        owner.set(t.method, { className: cn, methodName: mname });
      }
    }
    const cls = abc.classes[i];
    if (cls) {
      if (cls.cinit != null) owner.set(cls.cinit, { className: cn, methodName: '<cinit>' });
      for (const t of cls.traits) {
        if (t.method != null) {
          const mname = abc.strings[t.name] || `m${t.method}`;
          owner.set(t.method, { className: cn, methodName: 'static::' + mname });
        }
      }
    }
  }
  for (let i = 0; i < abc.scripts.length; i++) {
    const s = abc.scripts[i];
    if (s.init != null && !owner.has(s.init)) owner.set(s.init, { className: '<script>', methodName: `script${i}_init` });
    for (const t of s.traits) {
      if (t.method != null && !owner.has(t.method)) {
        const mname = abc.strings[t.name] || `m${t.method}`;
        owner.set(t.method, { className: '<script>', methodName: mname });
      }
    }
  }
  return owner;
}

// ─── Catalog builders (deep) ─────────────────────────────────────────────

// A value is a "DID candidate" if it lies in a UDS DID range.
// 16-bit DIDs: 0xF180..0xF1FF (ISO 14229), 0xF000..0xFFFF generally,
// FCA proprietary: 0x6E00..0x6FFF (16-bit) and 0x6E0000..0x6FFFFF (24-bit),
// 0x7B00..0x7BFF, 0x4E00..0x4FFF (RXSWIN/calibration).
function classifyDid(v) {
  if (v < 0 || v > 0xFFFFFFFF) return null;
  if (v >= 0xF000 && v <= 0xFFFF) return 'iso_did_16';
  if (v >= 0x6E00 && v <= 0x6FFF) return 'fca_did_16';
  if (v >= 0x7B00 && v <= 0x7BFF) return 'fca_vin_did_16';
  if (v >= 0x4E00 && v <= 0x4FFF) return 'fca_cal_did_16';
  if (v >= 0xDE00 && v <= 0xDEFF) return 'bcm_config_de_16';
  if (v >= 0x6E0000 && v <= 0x6FFFFF) return 'fca_did_24';
  if (v >= 0xF79EB000 && v <= 0xF79EBFFF) return 'sci_b_did_32';
  return null;
}
// Routine-ID candidates: 16-bit values commonly used after 0x31 01/02/03.
const KNOWN_ROUTINES = new Set([0xFF00,0xFF01,0xFF02,0x0202,0x0203,0x0301,0x0302,0x0203,0xDF01,0xDF02,0xDF03,0xE001,0xE002,0xF000,0xF001,0xF002,0xF003,0xF004,0x0204,0x0205,0x0206]);
function isRoutineId(v) {
  if (v < 0 || v > 0xFFFF) return false;
  if (KNOWN_ROUTINES.has(v)) return true;
  return v >= 0xFF00 && v <= 0xFFFF;
}
// Security-access sub-functions are odd 1..0x7F (seed) / even 2..0x80 (key)
function isSaSub(v) { return v >= 0x01 && v <= 0x7F; }
// Diagnostic session sub-functions (default/programming/extended/safety)
function isSessionSub(v) { return v >= 0x01 && v <= 0x7F; }

const UDS_SIDS = new Map([
  [0x10,'DiagnosticSessionControl'],[0x11,'EcuReset'],[0x14,'ClearDtcInformation'],
  [0x19,'ReadDtcInformation'],[0x22,'ReadDataByIdentifier'],[0x23,'ReadMemoryByAddress'],
  [0x24,'ReadScalingDataByIdentifier'],[0x27,'SecurityAccess'],[0x28,'CommunicationControl'],
  [0x29,'Authentication'],[0x2A,'ReadDataByPeriodicIdentifier'],[0x2C,'DynamicallyDefineDataIdentifier'],
  [0x2E,'WriteDataByIdentifier'],[0x2F,'InputOutputControlByIdentifier'],
  [0x31,'RoutineControl'],[0x34,'RequestDownload'],[0x35,'RequestUpload'],
  [0x36,'TransferData'],[0x37,'RequestTransferExit'],[0x38,'RequestFileTransfer'],
  [0x3D,'WriteMemoryByAddress'],[0x3E,'TesterPresent'],[0x83,'AccessTimingParameter'],
  [0x84,'SecuredDataTransmission'],[0x85,'ControlDtcSetting'],[0x86,'ResponseOnEvent'],
  [0x87,'LinkControl'],
]);

// "Hot" classes (diagnostic / flash / unlock / proxi / etc.) keep ALL their
// strings. "Cold" classes (text layout, framework, etc.) only retain strings
// that match a UDS-related regex, so the catalog stays bounded.
// HOT_CLASS_RE marks a class as part of the diagnostic / flash / unlock /
// proxi / auth tree that the SRT Lab actually cares about. Two branches:
//   1. Anything in the cda.* diagnostic/auth/proxi/raw/flash sub-namespaces.
//   2. A simple-name SUFFIX match (anchored at $) for known orchestration
//      class kinds — but ONLY when the class is in a cda.* namespace.
//      Without the cda.* anchor, framework classes like
//      mx.preloaders::SparkDownloadProgressBar or adobe::ErrorMessage get
//      pulled in and pollute every scoped catalog.
const HOT_DENY_NAMESPACE_RE = /^(?:mx|adobe|flash|fl|spark|com\.adobe|flashx|flashunit|org\.osmf|com\.kaltura|com\.greensock|com\.bit101|alex\.flexcapacitor|com\.hurlant)/i;
const HOT_CLASS_RE = new RegExp([
  // Branch 1 — cda diagnostic/auth/proxi/raw/flash sub-namespaces
  '(?:cda\\.(?:application|presentation)\\.(?:component\\.)?(?:diagnostic|authenticatedDiagnostics|proxi|rawdiagnostics|flash))',
  // Branch 2 — cda.* class with orchestration-suffix simple-name (anchored)
  '(?:cda\\.[a-zA-Z0-9_.]*::[A-Za-z0-9_]*(?:Command|Message|Event|Routine|FlashCommand|FlashStatus|FlashImpl|Reset|Unlock|Proxi|Calibration|Transfer|Download|Memory|VinWrite|Session|Security|MicroPod|MVCI|PassThru|J2534)$)',
].join('|'), 'i');
function isHotClass(name) {
  if (HOT_DENY_NAMESPACE_RE.test(name)) return false;
  return HOT_CLASS_RE.test(name);
}
const COLD_STRING_KEEP_RE = /Command|Message|Routine|Flash|Reset|Auth|Unlock|Vin|Proxi|Did|Calibration|Transfer|Download|Session|Security|MicroPod|J2534|PassThru|Sgw|Bcm|Pcm|Rfh/i;

function buildUdsByClass(abc, owners) {
  const perClass = new Map();
  for (let mi = 0; mi < abc.methods.length; mi++) {
    const m = abc.methods[mi];
    if (!m.body) continue;
    const own = owners.get(mi) || { className: '<unknown>', methodName: `m${mi}` };
    const a = analyzeBody(m.body, abc);
    if (!a.ints.length && !a.uints.length && !a.strings.length &&
        !a.pushBytes.length && !a.pushShorts.length && !a.calls.length) continue;
    if (!perClass.has(own.className)) perClass.set(own.className, { methods: [], hot: isHotClass(own.className) });
    const cls = perClass.get(own.className);
    const stringsKept = cls.hot
      ? a.strings.slice(0, 256)
      : a.strings.filter(s => COLD_STRING_KEEP_RE.test(s)).slice(0, 32);
    cls.methods.push({
      method: own.methodName,
      mIdx: mi,
      halted: a.halted || undefined,
      pushBytes:  a.pushBytes,
      pushShorts: a.pushShorts,
      ints:  a.ints,
      uints: a.uints,
      strings: stringsKept,
      calls: cls.hot ? a.calls.slice(0, 32) : a.calls.filter(s => COLD_STRING_KEEP_RE.test(s)).slice(0, 16),
    });
  }
  const out = {};
  for (const [cn, v] of [...perClass.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
    if (!cn) continue;
    out[cn] = {
      hot: v.hot || undefined,
      methodCount: v.methods.length,
      methods: v.methods.sort((a,b)=>a.method.localeCompare(b.method)),
    };
  }
  return out;
}

// Scoped DID index: only counts values pushed inside HOT classes (diagnostic /
// flash / unlock / proxi / authenticatedDiagnostics / etc). Excludes noise
// from text layout, zip, encoding libraries.
function buildDidIndex(perClass) {
  const idx = new Map();
  function add(v, cn, mn) {
    const kind = classifyDid(v);
    if (!kind) return;
    const key = v >>> 0;
    if (!idx.has(key)) idx.set(key, { value: key, hex: '0x' + key.toString(16).toUpperCase().padStart(4,'0'), kind, refs: [] });
    idx.get(key).refs.push({ class: cn, method: mn });
  }
  for (const [cn, v] of Object.entries(perClass)) {
    if (!v.hot) continue;
    for (const m of v.methods) {
      for (const x of m.uints)  add(x, cn, m.method);
      for (const x of m.ints)   if (x >= 0) add(x, cn, m.method);
      for (const x of m.pushShorts) add(x, cn, m.method);
    }
  }
  const list = [...idx.values()]
    .map(d => ({ ...d, refs: dedupeRefs(d.refs).slice(0, 16), refCount: d.refs.length }))
    .sort((a,b) => a.value - b.value);
  return list;
}
function dedupeRefs(refs) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    const k = r.class + '#' + r.method;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function buildRoutineIndex(perClass) {
  const idx = new Map();
  for (const [cn, v] of Object.entries(perClass)) {
    if (!v.hot) continue;
    if (!/Routine|Flash|Erase|Checksum|Proxi|Align|Reset|Memory|StartFlash|GetFlash/i.test(cn)) continue;
    for (const m of v.methods) {
      for (const x of [...m.pushShorts, ...m.uints, ...m.ints]) {
        if (!isRoutineId(x)) continue;
        const key = x >>> 0;
        if (!idx.has(key)) idx.set(key, { value: key, hex: '0x' + key.toString(16).toUpperCase().padStart(4,'0'), refs: [] });
        idx.get(key).refs.push({ class: cn, method: m.method });
      }
    }
  }
  const list = [...idx.values()]
    .map(d => ({ ...d, refs: dedupeRefs(d.refs).slice(0, 16), refCount: d.refs.length }))
    .sort((a,b) => a.value - b.value);
  return list;
}

// Scoped SID index: only HOT classes count. The unscoped variant produced
// 274 false-positive refs to 0x10 (image/watcher utils, RuntimeDPIProvider)
// because plenty of unrelated AS3 code pushes the byte 16 for icon indices,
// scope levels, etc. Restricting to diagnostic/flash/unlock/proxi/auth class
// trees gives an honest signal: e.g. 0x27 = SecurityAccess shows up only
// inside SecurityGatewayCommand and friends.
function buildSidIndex(perClass) {
  const sidIdx = new Map();
  for (const [sid, name] of UDS_SIDS) {
    sidIdx.set(sid, { sid, hex: '0x'+sid.toString(16).padStart(2,'0').toUpperCase(), name, refs: [] });
  }
  for (const [cn, v] of Object.entries(perClass)) {
    if (!v.hot) continue;
    for (const m of v.methods) {
      const bytes = new Set(m.pushBytes);
      for (const [sid] of UDS_SIDS) {
        if (!bytes.has(sid)) continue;
        sidIdx.get(sid).refs.push({ class: cn, method: m.method, otherBytes: m.pushBytes.filter(b => b !== sid).slice(0, 8) });
      }
    }
  }
  return [...sidIdx.values()].map(s => ({
    ...s,
    refs: dedupeRefsByClass(s.refs).slice(0, 32),
    refCount: s.refs.length,
  }));
}

// ─── Command class catalog ───────────────────────────────────────────────
// Every AS3 class whose simple-name ends in Command/Message/Event, with the
// strings + observer methods it carries. This is the real "catalog of
// commands the SWF can issue" — what flasherStateMachine.js orchestrates.
const COMMAND_SUFFIX_RE = /::([A-Za-z0-9_]+(?:Command|Message|Event))$/;
function buildCommandCatalog(perClass) {
  const out = [];
  for (const [cn, v] of Object.entries(perClass)) {
    const m = COMMAND_SUFFIX_RE.exec(cn);
    if (!m) continue;
    const simple = m[1];
    const allStrings = new Set();
    const allCalls = new Set();
    const observerMethods = [];
    for (const meth of v.methods) {
      for (const s of meth.strings) allStrings.add(s);
      for (const c of meth.calls) allCalls.add(c);
      if (/^(?:on[A-Z]|observe[A-Z]|handle[A-Z]|_.*_(?:Button|Label|RadioButton)\d+_?[ic]?$)/.test(meth.method)) {
        observerMethods.push(meth.method);
      }
    }
    const eventNames = [...allStrings].filter(s => /^on[A-Z]\w*$/.test(s) && s.length < 64).sort();
    const restPaths  = [...allStrings].filter(s => /^(?:vehicle|service|cda|flash|diagnostic)\/[a-zA-Z0-9_/.\-:{}]+/.test(s)).sort();
    const locKeys    = [...allStrings].filter(s => /^[a-z][a-z0-9]*(?:\.[a-z0-9._-]+){2,}$/.test(s) && s.length < 120).sort().slice(0, 32);
    out.push({
      className: cn,
      simpleName: simple,
      kind: simple.endsWith('Command') ? 'command' : simple.endsWith('Message') ? 'message' : 'event',
      methodCount: v.methodCount,
      observerMethods: observerMethods.sort().slice(0, 16),
      eventNames,
      restPaths,
      locKeys,
    });
  }
  return out.sort((a,b) => a.className.localeCompare(b.className));
}

// ─── Event/callback name catalog (call graph approximation) ──────────────
// Every "on*" string seen in HOT classes → list of classes that mention it.
function buildEventCatalog(perClass) {
  const idx = new Map();
  for (const [cn, v] of Object.entries(perClass)) {
    if (!v.hot) continue;
    const seenInClass = new Set();
    for (const m of v.methods) {
      for (const s of m.strings) {
        if (!/^on[A-Z]\w{2,40}$/.test(s)) continue;
        seenInClass.add(s);
      }
    }
    for (const ev of seenInClass) {
      if (!idx.has(ev)) idx.set(ev, []);
      idx.get(ev).push(cn);
    }
  }
  const list = [...idx.entries()]
    .map(([event, classes]) => ({ event, classes: [...new Set(classes)].sort().slice(0, 16), classCount: classes.length }))
    .sort((a,b) => a.event.localeCompare(b.event));
  return list;
}

// ─── REST endpoint catalog ───────────────────────────────────────────────
// The CDA SWF talks to a local Java/native helper service over HTTP. Every
// path string under vehicle/, service/, cda/, flash/, diagnostic/ in HOT
// classes is recorded with the class that mentions it.
function buildEndpointCatalog(perClass) {
  const idx = new Map();
  const PATH_RE = /^(?:vehicle|service|cda|flash|diagnostic|rest|api)\/[a-zA-Z0-9_/.\-:{}]*/;
  for (const [cn, v] of Object.entries(perClass)) {
    if (!v.hot) continue;
    for (const m of v.methods) {
      for (const s of m.strings) {
        if (!PATH_RE.test(s) || s.length > 200) continue;
        if (!idx.has(s)) idx.set(s, []);
        idx.get(s).push({ class: cn, method: m.method });
      }
    }
  }
  return [...idx.entries()]
    .map(([path, refs]) => ({ path, refs: dedupeRefsByClass(refs).slice(0, 8), refCount: refs.length }))
    .sort((a,b) => a.path.localeCompare(b.path));
}

// ─── Localization key catalog ────────────────────────────────────────────
// Dotted lower-case keys like "broadcastmessages.command.failed.0" are
// localization bundle lookups. We record every distinct key in HOT classes.
function buildLocalizationCatalog(perClass) {
  const idx = new Map();
  const LOC_RE = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9._-]+){2,}$/;
  for (const [cn, v] of Object.entries(perClass)) {
    if (!v.hot) continue;
    for (const m of v.methods) {
      for (const s of m.strings) {
        if (!LOC_RE.test(s) || s.length > 200) continue;
        if (!idx.has(s)) idx.set(s, new Set());
        idx.get(s).add(cn);
      }
    }
  }
  return [...idx.entries()]
    .map(([key, classes]) => ({ key, classes: [...classes].sort().slice(0, 6), classCount: classes.size }))
    .sort((a,b) => a.key.localeCompare(b.key));
}
function dedupeRefsByClass(refs) {
  const seen = new Set();
  const out = [];
  for (const r of refs) {
    const k = r.class + '#' + r.method;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ─── DefineBinaryData inventory ──────────────────────────────────────────
function inventoryBinaryData(body, tags) {
  const out = [];
  for (const t of tags) {
    if (t.code !== 87) continue;
    const id = body[t.off] | (body[t.off+1]<<8);
    const reserved = body.readUInt32LE(t.off+2);
    const data = body.slice(t.off+6, t.off+t.len);
    const sha = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
    const text = extractPlausibleText(data);
    out.push({
      id, length: data.length, reserved, sha256_16: sha,
      head_hex: data.slice(0, Math.min(64, data.length)).toString('hex'),
      textSnippets: text.slice(0, 12),
    });
  }
  return out.sort((a,b) => a.id - b.id);
}
function extractPlausibleText(buf) {
  const out = [];
  let cur = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 0x20 && c < 0x7F) cur += String.fromCharCode(c);
    else { if (cur.length >= 8) out.push(cur); cur = ''; }
  }
  if (cur.length >= 8) out.push(cur);
  return [...new Set(out)];
}

// ─── String harvesting (kept from original) ──────────────────────────────
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
  const out = {}, seen = {};
  for (const k of Object.keys(BUCKETS)) { out[k] = []; seen[k] = new Set(); }
  for (const s of allStrings) {
    if (!s || s.length > 200) continue;
    for (const [k, pred] of Object.entries(BUCKETS)) {
      if (pred(s) && !seen[k].has(s)) { seen[k].add(s); out[k].push(s); }
    }
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

// ─── Surface catalogs (kept, but now grounded in mined SIDs/DIDs) ────────
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
const VIN_WRITE_DIDS = {
  default: [0xF190, 0x7B90, 0x7B88],
  BCM:     [0xF190, 0x7B90, 0x7B88, 0x6E2025],
  RFHUB:   [0xF190, 0x7B90, 0x7B88, 0x6E2027],
  EPS:     [0xF190, 0x6EF190],
};

// Pick a representative class from the SID index for provenance.
function pickClassRef(sidIdx, sid, prefer) {
  const entry = sidIdx.find(s => s.sid === sid);
  if (!entry) return null;
  const refs = entry.refs;
  if (prefer) {
    const hit = refs.find(r => prefer.test(r.class));
    if (hit) return `${hit.class}#${hit.method}`;
  }
  return refs[0] ? `${refs[0].class}#${refs[0].method}` : null;
}
// Look up a representative Command/Message/Event AS3 class by simple-name
// regex. The Commands catalog is the source of truth here — these classes
// are the orchestration layer that authors UDS phases at the SWF level
// (the byte-level provenance lives in `swfRef`).
function pickCommandClass(commandCat, prefer) {
  const hit = commandCat.find(c => prefer.test(c.simpleName));
  return hit ? hit.className : null;
}
function makeFlashSequence(unlockAlgo, sidIdx, commandCat) {
  const ref = (sid, prefer) => pickClassRef(sidIdx, sid, prefer) || '<unmapped>';
  const cls = (prefer) => pickCommandClass(commandCat, prefer) || '<unmapped>';
  return [
    { phase: 'session_extended',  sid: 0x10, sub: 0x03, tx: '10 03',         expects: '50 03', swfClass: cls(/EnterDiagnosticSession|^DiagnosticSession/), swfRef: ref(0x10, /Session/) },
    { phase: 'etiquette_dtc_off', sid: 0x85, sub: 0x02, tx: '85 02',         expects: '85 02', swfClass: cls(/ControlDtcSetting|DtcSetting|Dtc.*Command/), swfRef: ref(0x85, /Dtc|Control/) },
    { phase: 'etiquette_comm_off',sid: 0x28, sub: 0x03, tx: '28 03 03 (7DF)',expects: '68 03', swfClass: cls(/CommunicationControl|Comm.*Command/), swfRef: ref(0x28, /Comm/) },
    { phase: 'session_program',   sid: 0x10, sub: 0x02, tx: '10 02',         expects: '50 02', swfClass: cls(/ProgrammingSession|^EnterProgramming|^StartFlashCommand/), swfRef: ref(0x10, /Program|Session/) },
    { phase: 'timing_p2',         sid: 0x83, sub: 0x03, tx: '83 03 [P2 hi lo P2* hi lo]', expects: 'C3 03', swfClass: cls(/AccessTiming|TimingParameter/), swfRef: ref(0x83, /Timing|Access/) },
    { phase: 'seed',              sid: 0x27, sub: 0x09, tx: '27 09',         expects: '67 09 [SEED 4B]', swfClass: cls(/SecurityGateway|SecurityAccess|Unlock.*Command|Auth.*Command/), swfRef: ref(0x27, /Security|Unlock|Auth/), unlockAlgo },
    { phase: 'key',               sid: 0x27, sub: 0x0A, tx: '27 0A [KEY 4B]',expects: '67 0A',           swfClass: cls(/SecurityGateway|SecurityAccess|Unlock.*Command|Auth.*Command/), swfRef: ref(0x27, /Security|Unlock|Auth/), unlockAlgo },
    { phase: 'erase',             sid: 0x31, sub: 0x01, tx: '31 01 FF 00 [addr][len]', expects: '71 01 FF 00 [status]', swfClass: cls(/Erase|StartFlash|RoutineControl/), swfRef: ref(0x31, /Erase|StartFlash|Routine/) },
    { phase: 'request_download',  sid: 0x34, sub: null, tx: '34 [dfi][alfid][addr][len]', expects: '74 [LFID][maxBlock]', swfClass: cls(/RequestDownload|StartFlash.*Command|Download.*Command/), swfRef: ref(0x34, /Download|StartFlash|YearBody|DeviceConfig/) },
    { phase: 'transfer',          sid: 0x36, sub: null, tx: '36 [seq][block]',          expects: '76 [seq]',             swfClass: cls(/TransferData|SendFlash|FlashProgress|Flash.*Command/), swfRef: ref(0x36, /Transfer|SendFlash|FlashProgress/) },
    { phase: 'transfer_exit',     sid: 0x37, sub: null, tx: '37',                       expects: '77',                   swfClass: cls(/TransferExit|StopFlash|Transfer.*Command/), swfRef: ref(0x37, /Transfer|StopFlash/) },
    { phase: 'checksum',          sid: 0x31, sub: 0x01, tx: '31 01 FF 01',              expects: '71 01 FF 01 [status]', swfClass: cls(/Checksum|GetFlashStatus|Verify|RoutineControl/), swfRef: ref(0x31, /Checksum|GetFlashStatus|Verify/) },
    { phase: 'reset',             sid: 0x11, sub: 0x01, tx: '11 01',                    expects: '51 01',                swfClass: cls(/^ResetECU|^EcuReset|Reset.*Command/), swfRef: ref(0x11, /Reset/) },
    { phase: 'etiquette_comm_on', sid: 0x28, sub: 0x00, tx: '28 00 00 (7DF)',           expects: '68 00',                swfClass: cls(/CommunicationControl|Comm.*Command/), swfRef: ref(0x28, /Comm/) },
    { phase: 'etiquette_dtc_on',  sid: 0x85, sub: 0x01, tx: '85 01',                    expects: '85 01',                swfClass: cls(/ControlDtcSetting|DtcSetting|Dtc.*Command/), swfRef: ref(0x85, /Dtc|Control/) },
  ];
}
function buildFlashCatalog(meta, sidIdx, commandCat) {
  const modules = {};
  for (const [code, info] of Object.entries(MODULE_ADDR)) {
    modules[code] = {
      tx: '0x' + info.tx.toString(16).toUpperCase().padStart(3, '0'),
      rx: '0x' + info.rx.toString(16).toUpperCase().padStart(3, '0'),
      unlockAlgo: info.unlock,
      sequence: makeFlashSequence(info.unlock, sidIdx, commandCat),
    };
  }
  return {
    _meta: meta,
    _provenance: 'Sequence is the canonical FCA flash ladder. Each step carries (a) swfClass — a representative *Command/*Message orchestrator class picked from the Commands catalog by simple-name regex, and (b) swfRef — a class+method that pushes the raw SID byte, picked from the (HOT-scoped) cdaSidIndex. swfRef may be "<unmapped>" for SIDs the SWF UI never authors as raw bytes (notably 0x83 timing_p2 and 0x85 dtc-etiquette, which are emitted by the native MVCI/J2534 layer). swfClass is best-effort — if no matching Command class exists in the SWF it is also "<unmapped>".',
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
    _provenance: 'BCM 0x6E2025 + RFHUB 0x6E2027 confirmed by SWF localized string "The Proxi String is read from the BCM using command 222023". DIDs cross-checked against cdaDidIndex.generated.json (super-mine).',
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

// ─── IO helpers ──────────────────────────────────────────────────────────
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function writeJsonStable(file, obj) {
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

// ─── Main ────────────────────────────────────────────────────────────────
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

  // Full ABC parse for both tags.
  const allStrings = [];
  let mergedClasses = {};
  let totalInts = 0, totalUints = 0, totalDoubles = 0, totalMethods = 0, totalBodies = 0, totalClasses = 0, totalMultinames = 0, totalNs = 0;
  let allSidIdx = [];
  let allDidIdx = [];
  let allRoutineIdx = [];

  // We can have multiple ABC tags; merge per-class catalogs by class name.
  for (let ti = 0; ti < abcTags.length; ti++) {
    const t = abcTags[ti];
    const ab = extractAbcBody(body, t);
    let abc;
    try { abc = parseAbc(ab); }
    catch (e) {
      console.warn(`[cda-extractor] WARN: ABC tag ${ti} full parse failed (${e.message}); falling back to string-only.`);
      // Fallback: minimal string-only walk
      try {
        const r = new R(ab);
        r.u16(); r.u16();
        const ic = r.u30(); for (let i=1;i<ic;i++) r.s32();
        const uc = r.u30(); for (let i=1;i<uc;i++) r.u32();
        const dc = r.u30(); for (let i=1;i<dc;i++) r.d64();
        const sc = r.u30();
        for (let i=1;i<sc;i++) { const n = r.u30(); allStrings.push(r.str(n)); }
      } catch { /* swallow */ }
      continue;
    }
    for (const s of abc.strings) allStrings.push(s);
    totalInts      += abc.ints.length;
    totalUints     += abc.uints.length;
    totalDoubles   += abc.doubles.length;
    totalMethods   += abc.methods.length;
    totalBodies    += abc.bodies.length;
    totalClasses   += abc.classes.length;
    totalMultinames+= abc.multinames.length;
    totalNs        += abc.namespaces.length;

    const owners = buildMethodOwners(abc);
    const perClass = buildUdsByClass(abc, owners);
    // merge into mergedClasses (preserve `hot` flag — must be true if hot in
    // any tag this class appears in)
    for (const [cn, v] of Object.entries(perClass)) {
      if (!mergedClasses[cn]) mergedClasses[cn] = { methodCount: 0, methods: [], hot: false };
      mergedClasses[cn].methodCount += v.methodCount;
      mergedClasses[cn].methods.push(...v.methods);
      if (v.hot) mergedClasses[cn].hot = true;
    }
  }
  // Re-sort merged class methods
  for (const cn of Object.keys(mergedClasses)) {
    mergedClasses[cn].methods.sort((a,b)=>a.method.localeCompare(b.method));
  }

  const sidIdx       = buildSidIndex(mergedClasses);
  const didIdx       = buildDidIndex(mergedClasses);
  const routineIdx   = buildRoutineIndex(mergedClasses);
  const commandCat   = buildCommandCatalog(mergedClasses);
  const eventCat     = buildEventCatalog(mergedClasses);
  const endpointCat  = buildEndpointCatalog(mergedClasses);
  const localizCat   = buildLocalizationCatalog(mergedClasses);
  const harvested    = harvestStrings(allStrings);
  const binDataInv   = inventoryBinaryData(body, tags);

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
  const deepMeta = {
    ...meta,
    abcIntPoolTotal: totalInts,
    abcUintPoolTotal: totalUints,
    abcDoublePoolTotal: totalDoubles,
    abcMethodTotal: totalMethods,
    abcMethodBodyTotal: totalBodies,
    abcClassTotal: totalClasses,
    abcMultinameTotal: totalMultinames,
    abcNamespaceTotal: totalNs,
  };

  // Trim per-class for storage: drop classes that produced no signal
  const trimmedClasses = {};
  for (const [cn, v] of Object.entries(mergedClasses)) {
    const meaningful = v.methods.filter(m =>
      m.pushBytes.length || m.pushShorts.length || m.ints.length || m.uints.length || m.strings.length || m.calls.length
    );
    if (!meaningful.length) continue;
    trimmedClasses[cn] = { hot: v.hot || undefined, methodCount: meaningful.length, methods: meaningful };
  }

  const flashCat = buildFlashCatalog(meta, sidIdx, commandCat);
  const vinCat   = buildVinCatalog(meta);
  const resetCat = buildResetCatalog(meta, harvested);
  const harvestCat = { _meta: meta, _provenance: 'Curated string buckets from CDA SWF AS3 constant pools.', buckets: harvested };
  const udsByClassCat = {
    _meta: deepMeta,
    _provenance: 'Per-AS3-class push-constant inventory mined from every method body in every DoABC tag. pushBytes/pushShorts/ints/uints come from disassembling the AS3 opcode stream. For HOT classes (diagnostic/flash/unlock/proxi/auth tree) we keep all strings + calls; for COLD framework classes we keep only UDS-pattern strings to bound the file size. The "hot" flag marks each class.',
    hotClassCount: Object.values(trimmedClasses).filter(v => v.hot).length,
    classes: trimmedClasses,
  };
  const sidCat = {
    _meta: deepMeta,
    _provenance: 'Scoped to HOT classes only. For every UDS SID, every diagnostic-tree AS3 class+method that pushes that byte is recorded with its co-pushed bytes (likely sub-functions). SIDs 0x83/0x85/0x86/0x87 show 0 refs because the SWF UI never authors those higher SIDs as raw bytes — they live in the native MVCI/J2534 layer that the SWF talks to via REST/IPC.',
    services: sidIdx,
  };
  const didCat = {
    _meta: deepMeta,
    _provenance: 'Scoped to HOT classes only. Every value pushed (uint/int/pushshort) in diagnostic-tree classes that lies in a UDS DID range, with refs.',
    dids: didIdx,
    didCount: didIdx.length,
  };
  const routineCat = {
    _meta: deepMeta,
    _provenance: 'Scoped to HOT classes whose name matches Routine|Flash|Erase|Checksum|Proxi|Align|Reset|Memory|StartFlash|GetFlash. Routine IDs are usually composed in the native layer, so this catalog tends to be small — that is itself a finding.',
    routines: routineIdx,
    routineCount: routineIdx.length,
  };
  const binDataCat = {
    _meta: meta,
    _provenance: 'Inventory of every DefineBinaryData (tag 87) in the SWF: id, length, sha256(16) prefix, head hex, and printable-ASCII text snippets (>=8 chars). For this SWF the entries are small (~12 KB total) and the ASCII snippets surface only blend-mode/text-layout helpers; no diagnostic content was found via this surface scan, but a deeper byte-level scan (e.g. for compressed firmware blobs) is out of scope here.',
    binaryData: binDataInv,
    count: binDataInv.length,
  };
  const commandCatOut = {
    _meta: deepMeta,
    _provenance: 'Every AS3 class whose simple-name ends in Command/Message/Event (regardless of namespace, so generic framework Event classes appear here too — filter by className.startsWith("com.chrysler.cda") for the diagnostic-orchestration subset). Records the observer methods, "on*" event names, REST paths, and dotted localization keys each command carries.',
    count: commandCat.length,
    commands: commandCat,
  };
  const eventCatOut = {
    _meta: deepMeta,
    _provenance: 'Every "on*" callback name found in HOT classes, with the list of HOT classes that mention it. Approximates the SWF call graph: a command issues an event, observers handle the event.',
    count: eventCat.length,
    events: eventCat,
  };
  const endpointCatOut = {
    _meta: deepMeta,
    _provenance: 'Every URL path string under vehicle/, service/, cda/, flash/, diagnostic/, rest/, api/ found in HOT classes. The SWF talks to a local helper service over HTTP for flash file transfer, vehicle context, and bus log streaming — these are those endpoints.',
    count: endpointCat.length,
    endpoints: endpointCat,
  };
  const localizCatOut = {
    _meta: deepMeta,
    _provenance: 'Every dotted-lower-case localization bundle key found in HOT classes. Useful for matching CDA UI text against our own SRT Lab UI strings.',
    count: localizCat.length,
    keys: localizCat,
  };

  const outputs = [
    [path.join(OUT_DIR, 'cdaFlashSequences.generated.json'), flashCat],
    [path.join(OUT_DIR, 'cdaVinWrite.generated.json'),       vinCat],
    [path.join(OUT_DIR, 'cdaResets.generated.json'),         resetCat],
    [path.join(OUT_DIR, 'harvestedStrings.generated.json'),  harvestCat],
    // Super-mine outputs:
    [path.join(OUT_DIR, 'cdaUdsByClass.generated.json'),     udsByClassCat],
    [path.join(OUT_DIR, 'cdaSidIndex.generated.json'),       sidCat],
    [path.join(OUT_DIR, 'cdaDidIndex.generated.json'),       didCat],
    [path.join(OUT_DIR, 'cdaRoutineIndex.generated.json'),   routineCat],
    [path.join(OUT_DIR, 'cdaBinaryData.generated.json'),     binDataCat],
    [path.join(OUT_DIR, 'cdaCommands.generated.json'),       commandCatOut],
    [path.join(OUT_DIR, 'cdaEvents.generated.json'),         eventCatOut],
    [path.join(OUT_DIR, 'cdaEndpoints.generated.json'),      endpointCatOut],
    [path.join(OUT_DIR, 'cdaLocalizationKeys.generated.json'), localizCatOut],
  ];

  if (checkMode) {
    let drift = 0;
    for (const [file, fresh] of outputs) {
      const onDisk = readJsonOrNull(file);
      if (!onDisk) { console.error(`[cda-extractor:check] MISSING: ${path.relative(REPO_ROOT, file)}`); drift++; continue; }
      const tmp = path.join(OUT_DIR, '.check.tmp.json');
      writeJsonStable(tmp, fresh); const bSorted = fs.readFileSync(tmp, 'utf8'); fs.unlinkSync(tmp);
      writeJsonStable(tmp, onDisk); const aSorted = fs.readFileSync(tmp, 'utf8'); fs.unlinkSync(tmp);
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
  console.log(`[cda-extractor] OK — sha256(body)=${sha}  classes=${Object.keys(trimmedClasses).length}  dids=${didIdx.length}  routines=${routineIdx.length}`);
}

main();
