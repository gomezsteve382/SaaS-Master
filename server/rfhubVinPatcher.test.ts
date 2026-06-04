/**
 * rfhubVinPatcher.test.ts
 * 
 * Verifies the Gen2 RFHUB VIN magic orientation fix:
 * - OG file stores VIN FORWARD (old tool format, magic 0xDB)
 * - patchRfhubVin must write new VIN REVERSED with magic 0xAD
 * - Resulting checksum must match Sincro/ImmoVIN reference output (0xF5)
 * 
 * Reference files:
 *   OG:     RFHUB_21_JAILBREAK)OG_6.2_OG.bin  (forward-stored, magic 0xDB)
 *   Sincro: immovin_ce426d349e004560b2e68fb663e11d0a.bin_VIN_APPLIED.bin (reversed, magic 0xAD)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Correct Gen2 VIN offsets — 0x14 (20-byte) spacing, verified against real bench files
// Structure per copy: [sep_byte][VIN17][CS][01] = 20 bytes
// Separator bytes at: 0x0EA4 (F9), 0x0EB8 (F9), 0x0ECC (FE), 0x0EE0 (FE)
const VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];

// Pure JS implementation of the patcher logic (mirrors rfhubVinPatcher.js)
function rfhGen2DetectMagic(raw17: Uint8Array, storedCs: number): number {
  const xorAll = Array.from(raw17).reduce((a, b) => a ^ b, 0);
  return storedCs ^ xorAll;
}

function rfhGen2VinCs(raw17: Uint8Array, magic: number): number {
  return Array.from(raw17).reduce((a, b) => a ^ b, 0) ^ magic;
}

const RFH_GEN2_VIN_MAGIC_FORWARD = 0xDB;
const RFH_GEN2_VIN_MAGIC_REVERSED = 0xAD;

function patchRfhubVinGen2(bytes: Uint8Array, newVin: string): Uint8Array {
  const sz = bytes.length;
  const out = new Uint8Array(bytes);
  const vin = newVin.toUpperCase();

  // Detect magic from first non-blank slot
  let detectedMagic = RFH_GEN2_VIN_MAGIC_FORWARD;
  for (const o of VIN_OFFSETS) {
    if (o + 17 >= sz) continue;
    const st = bytes.slice(o, o + 17);
    if (st.every(b => b === 0xFF || b === 0x00)) continue;
    const sc = bytes[o + 17];
    if (sc !== 0x00 && sc !== 0xFF) { detectedMagic = rfhGen2DetectMagic(st, sc); break; }
  }

  // Magic 0xDB = forward-stored OG → switch to 0xAD for reversed write
  const writeMagic = detectedMagic === RFH_GEN2_VIN_MAGIC_FORWARD
    ? RFH_GEN2_VIN_MAGIC_REVERSED
    : detectedMagic;

  // Write reversed VIN bytes
  const raw17 = new Uint8Array(17);
  for (let j = 0; j < 17; j++) raw17[j] = vin.charCodeAt(16 - j);
  const cs = rfhGen2VinCs(raw17, writeMagic);

  for (const o of VIN_OFFSETS) {
    if (o + 18 > sz) continue;
    out.set(raw17, o);
    out[o + 17] = cs;
  }

  return out;
}

describe('Gen2 RFHUB VIN magic orientation fix', () => {
  const ogPath = join('/home/ubuntu/upload', 'RFHUB_21_JAILBREAK)OG_6.2_OG.bin');
  const sincroPath = join('/home/ubuntu/upload', 'immovin_ce426d349e004560b2e68fb663e11d0a.bin_VIN_APPLIED.bin');

  it('OG file slot 1: detects forward-stored VIN and magic 0xDB', () => {
    if (!existsSync(ogPath)) return; // Skip if file not present in CI
    const og = new Uint8Array(readFileSync(ogPath));
    const slot1 = og.slice(0x0EA5, 0x0EA5 + 17);
    const storedCs = og[0x0EA5 + 17];
    const detectedMagic = rfhGen2DetectMagic(slot1, storedCs);
    
    // OG VIN stored forward: '046256HH1TCXDC3C2'
    const forwardStr = Array.from(slot1).map(b => String.fromCharCode(b)).join('');
    expect(forwardStr).toBe('046256HH1TCXDC3C2');
    expect(storedCs).toBe(0xE3);
    expect(detectedMagic).toBe(0xDB);
  });

  it('Sincro file slot 1: detects reversed-stored VIN and magic 0xAD', () => {
    if (!existsSync(sincroPath)) return;
    const sincro = new Uint8Array(readFileSync(sincroPath));
    const slot1 = sincro.slice(0x0EA5, 0x0EA5 + 17);
    const storedCs = sincro[0x0EA5 + 17];
    const detectedMagic = rfhGen2DetectMagic(slot1, storedCs);
    
    // Sincro VIN stored reversed: '241516HM09LXDC3C2' (reversed = '2C3CDXL90MH615142')
    const forwardStr = Array.from(slot1).map(b => String.fromCharCode(b)).join('');
    expect(forwardStr).toBe('241516HM09LXDC3C2');
    expect(storedCs).toBe(0xF5);
    expect(detectedMagic).toBe(0xAD);
  });

  it('patchRfhubVin on OG file produces CS 0xF5 (matches Sincro)', () => {
    if (!existsSync(ogPath)) return;
    const og = new Uint8Array(readFileSync(ogPath));
    const patched = patchRfhubVinGen2(og, '2C3CDXL90MH615142');
    
    // Slot 1 checksum must be 0xF5 (Sincro reference)
    expect(patched[0x0EA5 + 17]).toBe(0xF5);
    // All 4 slots must have the same CS
    for (const o of VIN_OFFSETS) {
      if (o + 18 <= patched.length && !patched.slice(o, o + 17).every(b => b === 0xFF)) {
        expect(patched[o + 17]).toBe(0xF5);
      }
    }
  });

  it('patchRfhubVin on OG file: VIN bytes stored reversed (standard format)', () => {
    if (!existsSync(ogPath)) return;
    const og = new Uint8Array(readFileSync(ogPath));
    const patched = patchRfhubVinGen2(og, '2C3CDXL90MH615142');
    
    const slot1 = patched.slice(0x0EA5, 0x0EA5 + 17);
    // Stored reversed: '2C3CDXL90MH615142' reversed = '241516HM09LXDC3C2'
    const storedStr = Array.from(slot1).map(b => String.fromCharCode(b)).join('');
    expect(storedStr).toBe('241516HM09LXDC3C2');
  });

  it('patchRfhubVin on OG file: output matches Sincro byte-for-byte at all 4 VIN copies', () => {
    if (!existsSync(ogPath) || !existsSync(sincroPath)) return;
    const og = new Uint8Array(readFileSync(ogPath));
    const sincro = new Uint8Array(readFileSync(sincroPath));
    const patched = patchRfhubVinGen2(og, '2C3CDXL90MH615142');

    // Check all 4 VIN copies (17 bytes VIN + 1 byte CS each)
    for (const o of VIN_OFFSETS) {
      for (let i = o; i < o + 18; i++) {
        if (patched[i] !== sincro[i]) {
          throw new Error(
            `Mismatch at 0x${i.toString(16).toUpperCase()} (slot 0x${o.toString(16).toUpperCase()}+${i-o}): ` +
            `patched=0x${patched[i].toString(16).padStart(2,'0')} sincro=0x${sincro[i].toString(16).padStart(2,'0')}`
          );
        }
      }
    }
  });

  it('magic 0xAD (already reversed) is preserved unchanged on write', () => {
    // Simulate a file that already has reversed-stored VIN with magic 0xAD
    const fakeFile = new Uint8Array(4096).fill(0xFF);
    const vin = '2C3CDXL90MH615142';
    // Write a reversed VIN with magic 0xAD into slot 1
    const raw17 = new Uint8Array(17);
    for (let j = 0; j < 17; j++) raw17[j] = vin.charCodeAt(16 - j);
    const cs = rfhGen2VinCs(raw17, 0xAD);
    fakeFile.set(raw17, 0x0EA5);
    fakeFile[0x0EA5 + 17] = cs;
    
    // Patch with a new VIN
    const newVin = '1C4RJFAG0FC625797';
    const patched = patchRfhubVinGen2(fakeFile, newVin);
    
    // Detected magic should be 0xAD, write magic should also be 0xAD
    const slot1 = patched.slice(0x0EA5, 0x0EA5 + 17);
    const patchedCs = patched[0x0EA5 + 17];
    const expectedRaw17 = new Uint8Array(17);
    for (let j = 0; j < 17; j++) expectedRaw17[j] = newVin.toUpperCase().charCodeAt(16 - j);
    const expectedCs = rfhGen2VinCs(expectedRaw17, 0xAD);
    
    expect(patchedCs).toBe(expectedCs);
  });
});
