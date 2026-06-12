/* engBcmParse.js — pure, node-importable BCM (MPC5605B/06B DFLASH) parser,
 * extracted verbatim from ModuleSync.jsx's engParseBcm so it can be unit-tested
 * and reused without pulling the 4,800-line JSX tab into Node/vitest.
 *
 * This is the resolution model the ModuleSync write actions read from
 * (sec16Records / sec16Mirrors). It is kept here so an equivalence test can
 * prove, byte-for-byte, where it agrees with parseModule.resolveBcmSec16 (the
 * engine's resolver) and where it diverges — notably the legacy 2014-era mirror
 * format at 0x00C8/0x00F0 that the engine did not originally handle.
 *
 * engCrc16(data, 0xFFFF, 0x1021) === crc16ccitt(data) (crc.js), so we reuse it.
 */
import { bcmTooSmall } from './parseModule.js';
import { crc16ccitt as engCrc16 } from './crc.js';

const VIN_RE = /^[12345][A-HJ-NPR-Z0-9]{16}$/;
const BCM_SLOT_TYPES = [0x46, 0x52, 0x53, 0x56, 0x57];
const VIN_LEN = 17;

export function engParseBcm(bytes, filename) {
  const small = bcmTooSmall(bytes, filename);
  if (small) {
    return {
      ok: false, kind: 'BCM', size: bytes.length,
      tooSmall: true, minSize: small.min, fileExt: small.ext,
      vinSlots: [], vin: null, vinConsistent: false,
      partNumbers: [], supplierSerial: null,
      sec16Records: [], sec16Mirrors: [], sec16Consistent: false, sec16Hex: null, sec16MirrorHex: null,
      banks: null,
    };
  }
  const r = {
    ok: false, kind: 'BCM', size: bytes.length,
    vinSlots: [], vin: null, vinConsistent: false,
    partNumbers: [], supplierSerial: null,
    sec16Records: [], sec16Mirrors: [], sec16Consistent: false, sec16Hex: null, sec16MirrorHex: null,
    banks: null,
  };

  const text = new TextDecoder('latin1').decode(bytes);
  r.partNumbers = [...new Set([...text.matchAll(/68\d{6}/g)].map(m => m[0]))];
  const sup = text.match(/TY[A-Z]\d{5}/);
  if (sup) r.supplierSerial = sup[0];

  /* Full VIN slots (00 46 XX 00 + 17 VIN bytes + CRC-16) */
  for (let i = 0; i < bytes.length - 21; i++) {
    if (bytes[i] !== 0x00 || bytes[i+1] !== 0x46) continue;
    if (!BCM_SLOT_TYPES.includes(bytes[i+2])) continue;
    if (bytes[i+3] !== 0x00) continue;
    const vs = i + 4;
    if (vs + 19 > bytes.length) continue;
    let vin = '', valid = true;
    for (let k = 0; k < VIN_LEN; k++) {
      const b = bytes[vs + k];
      if (b < 0x20 || b > 0x7E) { valid = false; break; }
      vin += String.fromCharCode(b);
    }
    if (!valid || !VIN_RE.test(vin)) continue;
    const storedCrc  = (bytes[vs + 17] << 8) | bytes[vs + 18];
    const computedCrc = engCrc16(bytes.slice(vs, vs + 17));
    r.vinSlots.push({ offset: vs, slotType: bytes[i+2], vin, storedCrc, computedCrc, crcOk: storedCrc === computedCrc });
  }

  if (r.vinSlots.length > 0) {
    const c = {}; for (const s of r.vinSlots) c[s.vin] = (c[s.vin] || 0) + 1;
    r.vin = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
    r.vinConsistent = Object.keys(c).length === 1;
  }

  /* SEC16 split records (bank 2 at 0x81A0/C0/E0, 7+9 byte format) */
  for (let i = 0; i < bytes.length - 32; i++) {
    if (bytes[i] !== 0xFF || bytes[i+1] !== 0xFF) continue;
    let hdrOk = true;
    for (let j = 2; j < 8; j++) if (bytes[i+j] !== 0x00) { hdrOk = false; break; }
    if (!hdrOk) continue;
    const idx = bytes[i+8]; if (idx !== 0x01 && idx !== 0x02) continue;
    if (bytes[i+16] !== 0x04 || bytes[i+17] !== 0x04 || bytes[i+18] !== 0x00 || bytes[i+19] !== 0x14) continue;
    const prefix = bytes.slice(i+9,  i+16);
    const suffix = bytes.slice(i+20, i+29);
    const sec16  = new Uint8Array(16);
    sec16.set(prefix, 0); sec16.set(suffix, 7);
    r.sec16Records.push({ offset: i, format: 'split', idx, sec16, trailer: bytes[i+29] });
  }

  /* Mirror records (slot 0xEB size 0x18, slot 0xCA size 0x28) in either bank */
  const findMirrorsInBank = (bankBase, slotType, sizeByte, kind) => {
    const bankEnd = Math.min(bankBase + 0x4000, bytes.length);
    for (let i = bankBase; i < bankEnd - 32; i++) {
      if (bytes[i]   === 0x00 && bytes[i+1] === 0x00 && bytes[i+2] === 0x00 &&
          bytes[i+3] === sizeByte && bytes[i+4] === 0x00 && bytes[i+5] === 0x46 &&
          bytes[i+6] === slotType && bytes[i+7] === 0x00) {
        const idx   = bytes[i+8];
        const sec16 = bytes.slice(i+9, i+25);
        const allZero = sec16.every(b => b === 0x00);
        const allFf   = sec16.every(b => b === 0xFF);
        const storedCrc = (bytes[i+28] << 8) | bytes[i+29];
        const crcInput  = new Uint8Array(20);
        crcInput[0] = idx;
        for (let k = 0; k < 16; k++) crcInput[1+k] = sec16[k];
        crcInput[17] = bytes[i+25]; crcInput[18] = bytes[i+26]; crcInput[19] = bytes[i+27];
        const computedCrc = engCrc16(crcInput);
        r.sec16Mirrors.push({
          offset: i, kind, slotType, sizeByte, idx, sec16,
          populated: !allZero && !allFf, allZero, allFf,
          storedCrc, computedCrc, crcOk: computedCrc === storedCrc,
          bank: bankBase === 0 ? 'bank0' : 'bank1',
        });
      }
    }
  };
  if (bytes.length >= 0x8000) {
    findMirrorsInBank(0x0000, 0xEB, 0x18, 'mirror1');
    findMirrorsInBank(0x0000, 0xCA, 0x28, 'mirror2');
    findMirrorsInBank(0x4000, 0xEB, 0x18, 'mirror1');
    findMirrorsInBank(0x4000, 0xCA, 0x28, 'mirror2');
  }

  /* Legacy mirror format (older 2014-era BCM family — e.g. 68396563AC on a
   * 2014 LX Charger). Two SEC16 mirror records at fixed early-flash offsets
   * 0x00C8 and 0x00F0, BEFORE the bank header. 22-byte layout:
   *   +0 idx · +1..+16 SEC16 · +17 tag 0x8F · +18..+19 FF FF · +20..+21 CRC16-BE */
  const findLegacyMirror = (off) => {
    if (off + 22 > bytes.length) return;
    if (bytes[off + 17] !== 0x8F || bytes[off + 18] !== 0xFF || bytes[off + 19] !== 0xFF) return;
    const idx = bytes[off];
    const sec16 = bytes.slice(off + 1, off + 17);
    const allZero = sec16.every(b => b === 0x00);
    const allFf   = sec16.every(b => b === 0xFF);
    const storedCrc = (bytes[off + 20] << 8) | bytes[off + 21];
    const crcInput = new Uint8Array(20);
    crcInput[0] = idx;
    for (let k = 0; k < 16; k++) crcInput[1 + k] = sec16[k];
    crcInput[17] = 0x8F; crcInput[18] = 0xFF; crcInput[19] = 0xFF;
    const computedCrc = engCrc16(crcInput);
    if (computedCrc !== storedCrc) return;
    r.sec16Mirrors.push({
      offset: off, kind: 'mirror_legacy', slotType: null, sizeByte: null, idx, sec16,
      populated: !allZero && !allFf, allZero, allFf,
      storedCrc, computedCrc, crcOk: true, bank: 'bank0',
    });
  };
  findLegacyMirror(0x00C8);
  findLegacyMirror(0x00F0);

  /* Active / inactive banks */
  if (bytes.length >= 0x8000) {
    const bank0Seq = (bytes[0x0002] << 8) | bytes[0x0003];
    const bank1Seq = (bytes[0x4002] << 8) | bytes[0x4003];
    r.banks = {
      bank0Seq, bank1Seq,
      activeBank:    bank0Seq >= bank1Seq ? 0 : 1,
      inactiveBase:  bank0Seq >= bank1Seq ? 0x4000 : 0x0000,
    };
  }

  /* Summary */
  if (r.sec16Records.length > 0) {
    const hx = r.sec16Records.map(x => [...x.sec16].map(b => b.toString(16).padStart(2,'0')).join(''));
    r.sec16Consistent = hx.every(h => h === hx[0]);
    r.sec16Hex = hx[0];
  }
  const populated = r.sec16Mirrors.filter(m => m.populated && m.crcOk);
  if (populated.length > 0) {
    const mh = [...populated[0].sec16].map(b => b.toString(16).padStart(2,'0')).join('');
    if (!r.sec16Hex) r.sec16Hex = mh;
    r.sec16MirrorHex = mh;
    r.mirrorsPopulated = populated.length;
  }

  /* sec16Absent: no real SEC16 found (mirrors the allBlank gate in
   * parseModule.resolveBcmSec16 — absent only when every candidate, incl. the
   * flat 0x40C9 slice, is structurally blank). */
  const flatSlice = bytes.length >= 0x40D9 ? bytes.slice(0x40C9, 0x40D9) : null;
  const flatBlank = !flatSlice || Array.from(flatSlice).every(b => b === 0xFF || b === 0x00);
  r.sec16Absent = r.sec16Records.length === 0 && !r.mirrorsPopulated && flatBlank;

  r.ok = r.vin !== null;
  return r;
}

/* The SEC16 the ModuleSync write actions actually use: first split record,
 * else the first populated+crcOk mirror. Exposed so the engine and the
 * equivalence test resolve "the BCM secret" the same single way. */
export function engResolveBcmSec16(parsedOrBytes, filename) {
  const p = parsedOrBytes instanceof Uint8Array ? engParseBcm(parsedOrBytes, filename) : parsedOrBytes;
  return p?.sec16Records?.[0]?.sec16
      ?? p?.sec16Mirrors?.find((m) => m.populated && m.crcOk)?.sec16
      ?? null;
}
