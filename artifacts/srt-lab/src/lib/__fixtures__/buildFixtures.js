import {crc16,crc8rf,rfhGen2VinCs,rfhSec16Cs} from '../crc.js';
import {IMMO_REC,IMMO_KC,IMMO_BLOCK} from '../constants.js';

const VIN_DEFAULT = '2C3CDXKT3FH796320';

function fill(buf, offset, bytes) {
  for (let i = 0; i < bytes.length; i++) buf[offset + i] = bytes[i];
}
function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function writeBE32(buf, off, val) {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}
function writeBE16(buf, off, val) {
  buf[off] = (val >>> 8) & 0xff;
  buf[off + 1] = val & 0xff;
}

// 65536-byte BCM D-FLASH fixture.
// Slots: VIN @ 0x5320/0x5340/0x5360/0x5380; partial VIN @ 0x4098/0x40B0;
// vehicle secret @ 0x40C9; security lock @ 0x8028; FOBIK count @ 0x5862;
// IMMO records @ 0x40C0 (primary) and 0x2000 (backup); IMMO keys @ 0x81a4/0x81c4/0x81e4.
function makeBcm({
  size = 65536,
  vin = VIN_DEFAULT,
  partialTail = 'FH796320',
  partialBadCrc = false,
  vehicleSecret = null,
  fobikCount = 4,
  securityLocked = true,
  immoBackupSynced = true,
  immoRecsCount = 3,
} = {}) {
  const buf = new Uint8Array(size).fill(0xFF);
  for (const off of [0x5320, 0x5340, 0x5360, 0x5380]) fill(buf, off, asciiBytes(vin));

  for (const off of [0x4098, 0x40B0]) {
    const tail = asciiBytes(partialTail);
    fill(buf, off, tail);
    let crc = crc16(tail);
    if (partialBadCrc) crc ^= 0x1234;
    writeBE16(buf, off + 8, crc);
  }

  const secret = vehicleSecret || new Uint8Array([
    0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88,
    0x99,0xAA,0xBB,0xCC,0xDD,0xEE,0xF0,0x01,
  ]);
  fill(buf, 0x40C9, secret);

  buf[0x8028] = securityLocked ? 0x5A : 0x00;
  buf[0x5862] = fobikCount;

  for (const off of [0x81a4, 0x81c4, 0x81e4]) {
    fill(buf, off, new Uint8Array(16).map((_, i) => (off + i) & 0xff));
  }

  // FOBIK part-number string at 0x5818 (10 bytes ASCII).
  fill(buf, 0x5818, asciiBytes('P68234567A'));

  // IMMO records at primary 0x40C0; first N records non-blank, rest 0xFF.
  for (let i = 0; i < IMMO_KC; i++) {
    const off = 0x40C0 + i * IMMO_REC;
    if (i < immoRecsCount) {
      const rec = new Uint8Array(IMMO_REC).map((_, j) => (i * 7 + j + 1) & 0xff);
      fill(buf, off, rec);
    }
  }
  // Backup at 0x2000: copy primary if synced, else fill with different non-blank pattern.
  for (let i = 0; i < IMMO_BLOCK; i++) {
    if (immoBackupSynced) buf[0x2000 + i] = buf[0x40C0 + i];
    else if (i < immoRecsCount * IMMO_REC) buf[0x2000 + i] = 0xA5;
  }

  return buf;
}

// 4096-byte RFHUB Gen2 (24C32) fixture.
// VINs stored byte-reversed at 0x0ea5/0x0eb9/0x0ecd/0x0ee1; CS at +17 = XOR^magic.
// Vehicle secret @ 0x050E; SEC16 slot1 @ 0x050E, slot2 @ 0x0522 (CS = crc8_65 << 8).
// VIN@0x92 with CRC16 (CCITT) BE at +17.
function makeRfhubGen2({
  vin = VIN_DEFAULT,
  vinMagic = 0xDB,
  vinCount = 4,
  vinBadCrc = false,
  vinBadCrcSlot = 1,
  vehicleSecret = null,
  sec16Bad = false,
  fobikSlots = 2,
  withVin92 = true,
  vin92BadCrc = false,
} = {}) {
  const sz = 4096;
  const buf = new Uint8Array(sz).fill(0xFF);

  const vinAscii = asciiBytes(vin);
  const reversed = new Uint8Array(17);
  for (let i = 0; i < 17; i++) reversed[i] = vinAscii[16 - i];

  const offsets = [0x0ea5, 0x0eb9, 0x0ecd, 0x0ee1];
  for (let k = 0; k < vinCount; k++) {
    const off = offsets[k];
    fill(buf, off, reversed);
    let cs = rfhGen2VinCs(reversed, vinMagic);
    if (vinBadCrc && k === vinBadCrcSlot) cs ^= 0x55;
    buf[off + 17] = cs & 0xff;
  }

  // Gen2 RFHUB header signature at 0x0500 (AA 55 31 01) — used by
  // writeRfhSec16FromBcm and rfhubKeySlots writers to confirm the dump
  // is actually an RFHUB image before mutating it.
  fill(buf, 0x0500, new Uint8Array([0xAA, 0x55, 0x31, 0x01]));

  // Vehicle secret + SEC16 slot 1 share the same 16 bytes at 0x050E.
  const secret = vehicleSecret || new Uint8Array([
    0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,
    0x09,0x0a,0x0b,0x0c,0x0d,0x0e,0x0f,0x10,
  ]);
  fill(buf, 0x050E, secret);
  let cs1 = rfhSec16Cs(secret); // (crc8_65<<8)|0x00
  if (sec16Bad) cs1 ^= 0x0100;
  buf[0x050E + 16] = (cs1 >>> 8) & 0xff;
  buf[0x050E + 17] = cs1 & 0xff;
  // Slot 2: copy of slot 1 raw + valid CS.
  fill(buf, 0x0522, secret);
  const cs2 = rfhSec16Cs(secret);
  buf[0x0522 + 16] = (cs2 >>> 8) & 0xff;
  buf[0x0522 + 17] = cs2 & 0xff;

  // FOBIK slots: AA 50 markers at 0x0880 step 2.
  for (let i = 0; i < fobikSlots; i++) {
    buf[0x0880 + i * 2] = 0xAA;
    buf[0x0880 + i * 2 + 1] = 0x50;
  }

  // CC 66 AA 55 security marker pattern (one occurrence).
  fill(buf, 0x0900, new Uint8Array([0xCC, 0x66, 0xAA, 0x55]));
  // ZZZZ block (5A 5A 5A 5A) once.
  fill(buf, 0x0904, new Uint8Array([0x5A, 0x5A, 0x5A, 0x5A]));

  // Part numbers (ASCII) at 0x0808 / 0x0812 / 0x082C.
  fill(buf, 0x0808, asciiBytes('HW12345678'));
  fill(buf, 0x0812, asciiBytes('SW87654321'));
  fill(buf, 0x082C, asciiBytes('CALABCDEFGH123'));

  // skey @ 0x40, 16 bytes non-FF.
  fill(buf, 0x40, new Uint8Array(16).map((_, i) => (0x10 + i) & 0xff));

  if (withVin92) {
    fill(buf, 0x92, vinAscii);
    let cs = crc16(vinAscii);
    if (vin92BadCrc) cs ^= 0x4242;
    writeBE16(buf, 0x92 + 17, cs);
  }

  return buf;
}

// 2048-byte RFHUB Gen1 (24C16) fixture.
// VIN @ 0x92 with CRC16 BE at +17 (the only VIN copy a 2 KB image carries —
// the 0xEA5+ Gen2 slot table is past the end of a 24C16). SEC16 at 0x00AE
// (slot 1) / 0x00C0 (slot 2). Task #365 wired sz===2048 → RFHUB into
// parseModule and the Key Prog wizard; this fixture matches that layout.
function makeRfhubGen1({
  vin = VIN_DEFAULT,
  vinCount = 4,
  sec16Bytes = null,
} = {}) {
  const sz = 2048;
  const buf = new Uint8Array(sz).fill(0xFF);
  const vinAscii = asciiBytes(vin);
  const offsets = [0x0ea5, 0x0eb9, 0x0ecd, 0x0ee1];
  for (let k = 0; k < vinCount; k++) {
    if (offsets[k] + 18 > sz) continue;
    const off = offsets[k];
    fill(buf, off, vinAscii);
    buf[off + 17] = crc8rf(vinAscii);
  }
  const sec = sec16Bytes || new Uint8Array(16).map((_, i) => 0xB0 + i);
  fill(buf, 0x00AE, sec);
  fill(buf, 0x00C0, sec);
  // VIN @ 0x92 with CRC16 (CCITT) BE at +17. The Gen1 24C16 image is too
  // small for the Gen2 0xEA5+ slot table, so the 0x92 record is where the
  // module's only VIN copy actually lives.
  fill(buf, 0x92, vinAscii);
  writeBE16(buf, 0x92 + 17, crc16(vinAscii));
  return buf;
}

// 4096-byte GPEC2A fixture.
function makeGpec2a({
  vin = VIN_DEFAULT,
  skim = 0x80,
  secret = null,
  keyMirror = true,
  zzzzIntact = true,
  pcmSec6Damaged = false,
  pcmSec6Bytes = null,
} = {}) {
  const sz = 4096;
  const buf = new Uint8Array(sz).fill(0xFF);

  const vinAscii = asciiBytes(vin);
  fill(buf, 0x0000, vinAscii);
  fill(buf, 0x01F0, vinAscii);
  fill(buf, 0x0224, vinAscii);

  buf[0x0011] = skim;

  const sk = secret || new Uint8Array([0xDE,0xAD,0xBE,0xEF,0x12,0x34,0x56,0x78]);
  fill(buf, 0x0203, sk);
  fill(buf, 0x0361, keyMirror ? sk : new Uint8Array(8).fill(0x00));

  // Transponder keys (4 × 4 bytes) at 0x0888 step 4.
  for (let i = 0; i < 4; i++) {
    fill(buf, 0x0888 + i * 4, new Uint8Array([0x10 + i, 0x20 + i, 0x30 + i, 0x40 + i]));
  }

  // ZZZZ tamper marker at 0x0c8c (8 bytes); intact = first byte 0x5A.
  fill(buf, 0x0C8C, new Uint8Array(8).fill(zzzzIntact ? 0x5A : 0x00));

  // Part number string (13 bytes ASCII) at 0x0FA1.
  fill(buf, 0x0FA1, asciiBytes('P05150000AB12'));

  // Runtime counters at 0x0E61/0x0E69/0x0E6D/0x0E75 (BE32).
  writeBE32(buf, 0x0E61, 0x00001234);
  writeBE32(buf, 0x0E69, 0x0000ABCD);
  writeBE32(buf, 0x0E6D, 0x0001E240);
  writeBE32(buf, 0x0E75, 0x00000050);

  // PCM SEC6 @ 0x3C8 (6 bytes).
  const sec6 = pcmSec6Bytes || (pcmSec6Damaged
    ? new Uint8Array([0xFF,0xFF,0xFF,0xFF,0xFF,0xFF])
    : new Uint8Array([0x01,0x02,0x03,0x04,0x05,0x06]));
  fill(buf, 0x3C8, sec6);

  return buf;
}

// 8192-byte 95640 fixture (no TCM/TIPM signature).
function make95640({
  vin = VIN_DEFAULT,
  withThirdVin = true,
  skeyBlank = false,
  bcmSec16Bytes = null,
  bcmSec16BadCrc = false,
} = {}) {
  const sz = 8192;
  const buf = new Uint8Array(sz).fill(0xFF);
  // Make sure no TCM/TIPM signature triggers — clear bytes 0..0x20 to 0x33 (non-marker).
  for (let i = 0; i < 0x40; i++) buf[i] = 0x33;

  const vinAscii = asciiBytes(vin);
  fill(buf, 0x275, vinAscii);
  fill(buf, 0x288, vinAscii);
  if (withThirdVin) fill(buf, 0x1B82, vinAscii);

  if (!skeyBlank) fill(buf, 0x40, new Uint8Array(16).map((_, i) => (0x10 + i) & 0xff));
  // Else leave 0xFF (blank).

  const sec16 = bcmSec16Bytes || new Uint8Array([
    0xA0,0xA1,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,
    0xA8,0xA9,0xAA,0xAB,0xAC,0xAD,0xAE,0xAF,
  ]);
  fill(buf, 0x838, sec16);
  let cs = crc16(sec16);
  if (bcmSec16BadCrc) cs ^= 0x9999;
  writeBE16(buf, 0x848, cs);

  return buf;
}

// 8192-byte TCM EEPROM fixture (signature-detected).
function makeTcm() {
  const sz = 8192;
  const buf = new Uint8Array(sz).fill(0xAA);
  buf[0] = 0x00; buf[1] = 0x00;        // hasTcmMarker
  buf[2] = 0xA5;                        // hasA5
  buf[0x10] = 0x03;                     // tcmClass 1..8
  return buf;
}

// 4096-byte TIPM EEPROM fixture (signature-detected).
function makeTipm() {
  const sz = 4096;
  const buf = new Uint8Array(sz).fill(0x10);
  buf[0] = 0x00; buf[1] = 0x00;
  buf[0x04] = 0x36;                     // tipmVariant
  for (let i = 0; i < 6; i++) buf[i + 4] = (i === 0) ? 0x36 : 0xAA; // ensures aaCount>=4 in first 16
  return buf;
}

// >131072 → FW classification.
function makeFirmware() {
  return new Uint8Array(131072 + 1024).fill(0x77);
}

export {
  makeBcm,
  makeRfhubGen1,
  makeRfhubGen2,
  makeGpec2a,
  make95640,
  makeTcm,
  makeTipm,
  makeFirmware,
  VIN_DEFAULT,
  asciiBytes,
};
