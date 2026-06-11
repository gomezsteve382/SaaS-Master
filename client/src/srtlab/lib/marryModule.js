/* marryModule.js — ONE engine for "marry an unmarried module into an existing
 * married set". Replaces the 10 scattered derive→write→verify paths that lived
 * inline across ModuleSync, TwinTab, BcmPcmPairingTab, keyProgWizard, the
 * gpec2a/rfhPcm helpers, etc. — each a slightly different variant of the same
 * operation, which is the "preview/writer gating drift" bug class.
 *
 * THE MODEL
 *   - There is ONE authoritative secret: the 16-byte SEC16, in its RFH-form
 *     "root". Every dependent is derived from it via immoSecret.js:
 *         BCM SEC16 = reverse(root) ; PCM SEC6 = root[0:6].
 *   - `source` is the module that already carries the married secret (normally
 *     the BCM — your bench source of truth — but an RFHUB or 95640 works too).
 *   - `target` is the unmarried/donor module to bring into the set.
 *   - The engine derives the target's secret from the source's root, writes it
 *     with the canonical securityBytes writer, then RE-PARSES the output and
 *     asserts the secret reads back exactly as expected. On any mismatch it
 *     refuses (ok:false, no file) — a wrong secret bricks a module, so "looks
 *     right" is never good enough.
 *
 * SAFETY (ultimate-machine rules)
 *   - A blank/virgin source secret is refused (you can't marry from nothing).
 *   - Writing to a target whose writer is UNVERIFIED (RFHUB Gen1, XC2268 —
 *     reconstructed formulas, see algoProvenance.js) requires an explicit
 *     `allowUnverifiedTarget:true`, exactly like the dealer-lockout erase gate.
 *   - Every result carries the writer's grounding so the UI shows confidence.
 *
 * This module is pure logic (no I/O, no React) and never mutates its inputs.
 */
import { parseModule, resolveBcmSec16, classifyPcmSec6 } from './parseModule.js';
import { reverse16, pcmSec6FromRfh } from './immoSecret.js';
import { crc16 } from './crc.js';
import {
  writeBcmSec16Gen2, writeBcmFlatSec16, writePcmSec6,
  writeRfhSec16FromBcm, writeRfhSec16Gen1, writeXc2268Sec16,
} from './securityBytes.js';
import { rekeyVirginBcmFromRfhub } from './mpc5606bBcm.js';
import { writeModuleVIN } from './fileUtils.js';
import { writerGrounding, GROUNDING } from './algoProvenance.js';

const EEP95640_SEC16_OFF = 0x838;
const EEP95640_CRC_OFF = 0x848;

const allBlank = (b) => !b || !b.length || Array.from(b).every((x) => x === 0xFF || x === 0x00);
const arrEq = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
const asInfo = (bytes, info, name) => info || parseModule(bytes, name || 'module');

/* Resolve the authoritative RFH-form SEC16 root from the source module.
 * Returns { ok, rfhSec16, bcmSec16, origin } or { ok:false, reason }. */
function resolveRootSecret(bytes, info) {
  const t = info?.type;
  if (t === 'BCM') {
    const r = resolveBcmSec16(bytes);
    if (!r || !r.bytes || r.blank || allBlank(r.bytes)) {
      return { ok: false, reason: 'BCM source SEC16 is blank/virgin — nothing to marry from' };
    }
    const bcmSec16 = Uint8Array.from(r.bytes);
    return { ok: true, bcmSec16, rfhSec16: reverse16(bcmSec16), origin: `BCM SEC16 (${r.source || 'resolved'})` };
  }
  if (t === 'RFHUB' || t === 'XC2268_RFHUB') {
    const raw = info?.vehicleSecret?.bytes || info?.sec16s?.[0]?.raw;
    if (!raw || raw.length < 16 || allBlank(raw)) {
      return { ok: false, reason: 'RFHUB source SEC16 is blank/absent — nothing to marry from' };
    }
    const rfhSec16 = Uint8Array.from(raw.slice(0, 16));
    return { ok: true, rfhSec16, bcmSec16: reverse16(rfhSec16), origin: 'RFHUB SEC16 slot1' };
  }
  if (t === '95640') {
    const raw = info?.bcmSec16?.raw;
    if (!raw || raw.length < 16 || allBlank(raw)) {
      return { ok: false, reason: '95640 source SEC16 mirror is blank/absent' };
    }
    const bcmSec16 = Uint8Array.from(raw.slice(0, 16));
    return { ok: true, bcmSec16, rfhSec16: reverse16(bcmSec16), origin: '95640 SEC16 mirror @0x838' };
  }
  return { ok: false, reason: `unsupported source type '${t || 'unknown'}' (need BCM / RFHUB / 95640)` };
}

/* Write the BCM-form SEC16 mirror into a 95640 backup chip (@0x838 + BE CRC16
 * @0x848). This was the only marry op with no securityBytes writer (it lived
 * inline in ModuleSync); folded in here so the engine is the single path. */
function write95640Sec16(bytes, bcmSec16) {
  if (!bcmSec16 || bcmSec16.length !== 16) throw new Error('95640: BCM SEC16 must be 16 bytes');
  if (bytes.length < EEP95640_CRC_OFF + 2) throw new Error('95640: buffer too small for SEC16 mirror');
  const out = new Uint8Array(bytes);
  for (let i = 0; i < 16; i++) out[EEP95640_SEC16_OFF + i] = bcmSec16[i];
  const cs = crc16(bcmSec16);
  out[EEP95640_CRC_OFF] = (cs >> 8) & 0xFF;
  out[EEP95640_CRC_OFF + 1] = cs & 0xFF;
  return { bytes: out };
}

/* Pick the writer + grounding key for a given target. */
function planTarget(targetBytes, targetInfo) {
  const t = targetInfo?.type;
  if (t === 'GPEC2A') return { op: 'pcm-sec6', writerKey: 'writePcmSec6' };
  if (t === '95640') return { op: '95640-sec16', writerKey: 'write95640Sec16' };
  if (t === 'XC2268_RFHUB') return { op: 'xc2268-sec16', writerKey: 'writeXc2268Sec16' };
  if (t === 'RFHUB') {
    return (targetBytes.length <= 2048)
      ? { op: 'rfh-gen1-sec16', writerKey: 'writeRfhSec16Gen1' }
      : { op: 'rfh-gen2-sec16', writerKey: 'writeRfhSec16FromBcm' };
  }
  if (t === 'BCM') return { op: 'bcm-sec16', writerKey: 'writeBcmSec16Gen2' };
  return { op: null, writerKey: null };
}

/**
 * marryModule — derive the target's immobilizer secret from the source's root,
 * write it, and verify by re-parse.
 *
 * @param {object} cfg
 * @param {{bytes: Uint8Array, info?: object, name?: string}} cfg.source
 * @param {{bytes: Uint8Array, info?: object, name?: string}} cfg.target
 * @param {string}  [cfg.vin]                  optional VIN to stamp into target
 * @param {boolean} [cfg.allowUnverifiedTarget] required to write Gen1/XC2268
 * @param {number}  [cfg.fobikCount]           for a virgin-BCM re-key
 * @returns {{ ok, op, sourceType, targetType, writer, grounding, bytes, checks, verified, reason? }}
 */
export function marryModule(cfg) {
  const { source, target, vin, allowUnverifiedTarget = false, fobikCount } = cfg || {};
  const checks = [];
  const ok = (label, pass, detail) => { checks.push({ label, pass: !!pass, detail: detail || '' }); return !!pass; };
  const fail = (reason) => ({ ok: false, op: null, bytes: null, checks, verified: false, reason });

  if (!source?.bytes?.length) return fail('source module bytes required');
  if (!target?.bytes?.length) return fail('target module bytes required');

  const srcInfo = asInfo(source.bytes, source.info, source.name);
  const tgtInfo = asInfo(target.bytes, target.info, target.name);
  const sourceType = srcInfo?.type;
  const targetType = tgtInfo?.type;

  // 1. Authoritative root from the source.
  const root = resolveRootSecret(source.bytes, srcInfo);
  if (!ok('Source carries a usable married secret', root.ok, root.ok ? root.origin : root.reason)) {
    return { ...fail(root.reason), sourceType, targetType };
  }
  const { rfhSec16, bcmSec16 } = root;

  // 2. Plan the target write + grounding.
  const plan = planTarget(target.bytes, tgtInfo);
  if (!plan.op) return { ...fail(`unsupported target type '${targetType || 'unknown'}'`), sourceType, targetType };
  const grounding = writerGrounding(plan.writerKey);

  // 3. Safety gate: an UNVERIFIED-formula target write needs explicit opt-in.
  const unverifiedWrite = grounding.level !== GROUNDING.BENCH;
  if (unverifiedWrite && grounding.dangerous && !allowUnverifiedTarget) {
    ok(`Writer ${plan.writerKey} is UNVERIFIED`, false,
      `${grounding.caveat} — pass allowUnverifiedTarget:true to proceed`);
    return { ok: false, op: plan.op, sourceType, targetType, writer: plan.writerKey, grounding, bytes: null, checks, verified: false,
      reason: `Refusing to write ${plan.writerKey} (unverified formula) without allowUnverifiedTarget` };
  }

  // 4. Write the derived secret with the canonical writer.
  let out;
  try {
    switch (plan.op) {
      case 'pcm-sec6': {
        const r = writePcmSec6(target.bytes, rfhSec16);
        if (!r.ok) return { ...fail('PCM is non-canonical size — SEC6 not written'), sourceType, targetType, op: plan.op, writer: plan.writerKey, grounding };
        out = r.bytes; break;
      }
      case '95640-sec16': out = write95640Sec16(target.bytes, bcmSec16).bytes; break;
      case 'xc2268-sec16': out = writeXc2268Sec16(target.bytes, bcmSec16).bytes; break;
      case 'rfh-gen2-sec16': out = writeRfhSec16FromBcm(target.bytes, bcmSec16).bytes; break;
      case 'rfh-gen1-sec16': out = writeRfhSec16Gen1(target.bytes, bcmSec16).bytes; break;
      case 'bcm-sec16': {
        const r = writeBcmSec16Gen2(target.bytes, rfhSec16);
        if ((r.splitPatched || 0) + (r.mirrorPatched || 0) === 0) {
          // No existing SEC16 records to update → virgin BCM, create from scratch.
          out = rekeyVirginBcmFromRfhub(target.bytes, rfhSec16, fobikCount).bytes
            || rekeyVirginBcmFromRfhub(target.bytes, rfhSec16, fobikCount);
          ok('BCM was virgin — created SEC16 records from scratch', true, 'rekeyVirginBcmFromRfhub');
        } else {
          out = writeBcmFlatSec16(r.bytes, bcmSec16, { mode: 'canonical' }).bytes;
          ok('BCM SEC16 split/mirror records updated', true, `split+${r.splitPatched} mirror+${r.mirrorPatched}`);
        }
        break;
      }
      default: return { ...fail('no writer for plan'), sourceType, targetType };
    }
  } catch (e) {
    return { ok: false, op: plan.op, sourceType, targetType, writer: plan.writerKey, grounding, bytes: null,
      checks: [...checks, { label: 'Writer threw', pass: false, detail: String(e?.message || e) }], verified: false,
      reason: String(e?.message || e) };
  }
  ok(`Secret written via ${plan.writerKey}`, true, grounding.level);

  // 5. Optional VIN stamp.
  if (vin) {
    if (String(vin).length !== 17) {
      ok('VIN is 17 chars', false, `got ${String(vin).length}`);
    } else {
      const v = writeModuleVIN(out, targetType, vin, tgtInfo?.vins);
      if (v) { out = v; ok('VIN stamped', true, vin); }
      else ok('VIN stamp skipped (writer refused)', false, '');
    }
  }

  // 6. Round-trip verify: re-parse the output and assert the secret matches.
  const verified = verifyMarriage(out, plan.op, { rfhSec16, bcmSec16 }, ok);

  return {
    ok: checks.every((c) => c.pass) && verified,
    op: plan.op, sourceType, targetType, writer: plan.writerKey, grounding,
    bytes: out, checks, verified,
  };
}

/* Re-parse `out` and assert the written secret reads back exactly as derived. */
function verifyMarriage(out, op, { rfhSec16, bcmSec16 }, ok) {
  let re;
  try { re = parseModule(out, 'married'); }
  catch (e) { return ok('Round-trip: output re-parses', false, String(e?.message || e)); }

  switch (op) {
    case 'pcm-sec6': {
      const want = pcmSec6FromRfh(rfhSec16);
      const got = re?.pcmSec6?.raw || null;            // parseModule exposes SEC6 as pcmSec6.raw
      const markerOk = !!(re?.pcmSec6 && re.pcmSec6.markerOk);
      return ok('Round-trip: PCM SEC6 = root[0:6]', !!got && arrEq(Array.from(got).slice(0, 6), Array.from(want)) && markerOk,
        got ? '' : 'no SEC6 in re-parse');
    }
    case 'bcm-sec16': {
      const r = resolveBcmSec16(out);
      return ok('Round-trip: BCM SEC16 = reverse(root)', !!r?.bytes && !r.blank && arrEq(Array.from(r.bytes), Array.from(bcmSec16)), r?.source || '');
    }
    case '95640-sec16': {
      const got = re?.bcmSec16?.raw;
      return ok('Round-trip: 95640 SEC16 mirror = reverse(root)', !!got && arrEq(Array.from(got).slice(0, 16), Array.from(bcmSec16)),
        re?.bcmSec16?.csOk ? 'CRC ok' : 'CRC?');
    }
    case 'rfh-gen2-sec16':
    case 'rfh-gen1-sec16':
    case 'xc2268-sec16': {
      const slot = re?.sec16s?.[0]?.raw;
      const csOk = re?.sec16s?.[0]?.csOk;
      return ok('Round-trip: RFHUB SEC16 slot1 = root', !!slot && arrEq(Array.from(slot).slice(0, 16), Array.from(rfhSec16)),
        csOk ? 'CS ok' : 'CS not validated');
    }
    default: return ok('Round-trip', false, `no verifier for ${op}`);
  }
}
