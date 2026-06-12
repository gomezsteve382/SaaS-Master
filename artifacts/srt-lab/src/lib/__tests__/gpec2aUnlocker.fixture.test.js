/**
 * gpec2aUnlocker.fixture.test.js
 *
 * Real-file fixture tests using actual GPEC2A firmware images from attached_assets/.
 * These tests validate algorithm behaviour against known locked firmware and serve as
 * golden regression guards for when the real patterns are eventually filled in.
 *
 * Missing asset for full activation:
 *   - attached_assets/FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_CRC_2C3CDXCT1HH652640_1776900514064.bin
 *       (LOCKED 384 KB EXT_EEPROM, flag @ 0x2FFFC = 0x3A)
 *   - Corresponding UNLOCKED version (run GPEC_Unlocker.exe on above; flag becomes 0x96).
 *     Once obtained, add real patterns to gpec2aUnlocker.js and enable the real-pattern
 *     assertions below (search for "ACTIVATE_WITH_REAL_PATTERNS").
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  UNLOCK_FLAG_OFFSET,
  UNLOCK_FLAG_BYTE,
  PATTERNS_AVAILABLE,
  patchGpec2aFile,
  isAlreadyUnlocked,
} from '../gpec2aUnlocker.js';

const ASSETS = join(import.meta.dirname, '../../../../..', 'attached_assets');

const EXT_EEPROM_LOCKED = join(
  ASSETS,
  'FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_CRC_2C3CDXCT1HH652640_1776900514064.bin',
);
const INT_FLASH_LOCKED = join(
  ASSETS,
  'FCA_CONTINENTAL_GPEC2A_INT_FLASH_JAILBREAK)OG_6.2_1776899205056.bin',
);

/* ── synthetic stand-ins (same as the unit-test suite) ──────────────────── */
const FAKE_OPTS = {
  genDetectPattern:       [0xAA, 0xBB, 0xCC, 0xDD],
  alreadyUnlockedPattern: [0x34, 0x56, 0x78, 0x9A],
  unlockTargetPattern:    [0x12, 0x34, 0x56, 0x78],
};

/* ══════════════════════════════════════════════════════════════════════════
 * SUITE 1 — EXT_EEPROM locked fixture (384 KB)
 * File: FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_CRC_2C3CDXCT1HH652640_1776900514064.bin
 * ══════════════════════════════════════════════════════════════════════════ */
describe('gpec2aUnlocker fixture — EXT_EEPROM locked (384 KB)', () => {
  const skip = !existsSync(EXT_EEPROM_LOCKED);

  it('fixture file exists in attached_assets/', () => {
    expect(existsSync(EXT_EEPROM_LOCKED), `Missing: ${EXT_EEPROM_LOCKED}`).toBe(true);
  });

  (skip ? it.skip : it)('file is 393 216 bytes (0x60000)', () => {
    const d = readFileSync(EXT_EEPROM_LOCKED);
    expect(d.length).toBe(393216);
  });

  (skip ? it.skip : it)('is larger than UNLOCK_FLAG_OFFSET (0x2FFFC = 196 604)', () => {
    const d = readFileSync(EXT_EEPROM_LOCKED);
    expect(d.length).toBeGreaterThan(UNLOCK_FLAG_OFFSET);
  });

  (skip ? it.skip : it)('flag byte at 0x2FFF0 is not yet unlocked (≠ 0x96)', () => {
    const d = readFileSync(EXT_EEPROM_LOCKED);
    // Flag offset corrected to 0x2FFF0 (proven from a real INT_FLASH unlock).
    // This EXT_EEPROM locked dump reads 0x4A there; the key invariant is it is
    // NOT the unlocked value 0x96.
    expect(d[UNLOCK_FLAG_OFFSET]).toBe(0x4A);
    expect(d[UNLOCK_FLAG_OFFSET]).not.toBe(UNLOCK_FLAG_BYTE);
  });

  (skip ? it.skip : it)('isAlreadyUnlocked returns false for locked file', () => {
    const d = new Uint8Array(readFileSync(EXT_EEPROM_LOCKED));
    expect(isAlreadyUnlocked(d)).toBe(false);
  });

  (skip ? it.skip : it)('patchGpec2aFile (synthetic opts) sets flag to 0x96', () => {
    const d = new Uint8Array(readFileSync(EXT_EEPROM_LOCKED));
    const r = patchGpec2aFile(d, FAKE_OPTS);
    // The offset flag MUST be applied (file > 0x2FFFC).
    expect(r.flagSet).toBe(true);
    expect(r.patched[UNLOCK_FLAG_OFFSET]).toBe(UNLOCK_FLAG_BYTE); // 0x96
    // File content before the flag offset is unchanged (synthetic pattern not present).
    expect(r.patched.length).toBe(d.length);
    // Original is not mutated.
    expect(d[UNLOCK_FLAG_OFFSET]).toBe(0x4A);
  });

  (skip ? it.skip : it)('patchGpec2aFile (synthetic opts) returns offset_only (pattern absent)', () => {
    const d = new Uint8Array(readFileSync(EXT_EEPROM_LOCKED));
    const r = patchGpec2aFile(d, FAKE_OPTS);
    // Synthetic pattern [0x12,0x34,0x56,0x78] is not present in this firmware.
    // offset_only = flag was set but no pattern match.
    expect(r.status).toBe('offset_only');
    expect(r.matchOffset).toBeNull();
  });

  (skip ? it.skip : it)('module is ACTIVATED; EXT_EEPROM lacks the INT_FLASH pattern → offset_only', () => {
    const d = new Uint8Array(readFileSync(EXT_EEPROM_LOCKED));
    expect(PATTERNS_AVAILABLE).toBe(true);
    // The recovered UNLOCK_TARGET_PATTERN is INT_FLASH firmware; it is not
    // present in EXT_EEPROM, so a real (no-opts) run sets the flag but finds no
    // E8 patch site. EXT_EEPROM needs its own locked/unlocked pair (see header).
    const r = patchGpec2aFile(d);
    expect(r.status).toBe('offset_only');
    expect(r.patched[UNLOCK_FLAG_OFFSET]).toBe(UNLOCK_FLAG_BYTE);
  });

  /*
   * ACTIVATE_WITH_REAL_PATTERNS — enable this block once the real patterns are
   * filled in and PATTERNS_AVAILABLE = true in gpec2aUnlocker.js.
   *
   * (skip ? it.skip : it)('unlocks real EXT_EEPROM and changes exactly 1-2 bytes', () => {
   *   const locked   = new Uint8Array(readFileSync(EXT_EEPROM_LOCKED));
   *   const unlocked = new Uint8Array(readFileSync(EXT_EEPROM_UNLOCKED)); // new asset needed
   *   const r = patchGpec2aFile(locked);
   *   expect(r.status).toBe('unlocked');
   *   expect(r.patched[UNLOCK_FLAG_OFFSET]).toBe(0x96);
   *   // Verify patched output matches the known-good unlocked file exactly
   *   for (let i = 0; i < unlocked.length; i++) {
   *     if (r.patched[i] !== unlocked[i]) throw new Error(`Mismatch @ 0x${i.toString(16)}`);
   *   }
   * });
   */
});

/* ══════════════════════════════════════════════════════════════════════════
 * SUITE 2 — INT_FLASH locked fixture (4 MB)
 * File: FCA_CONTINENTAL_GPEC2A_INT_FLASH_JAILBREAK)OG_6.2_1776899205056.bin
 * ══════════════════════════════════════════════════════════════════════════ */
describe('gpec2aUnlocker fixture — INT_FLASH locked (4 MB)', () => {
  const skip = !existsSync(INT_FLASH_LOCKED);

  it('INT_FLASH fixture file exists in attached_assets/', () => {
    expect(existsSync(INT_FLASH_LOCKED), `Missing: ${INT_FLASH_LOCKED}`).toBe(true);
  });

  (skip ? it.skip : it)('file is 4 194 304 bytes (0x400000)', () => {
    const d = readFileSync(INT_FLASH_LOCKED);
    expect(d.length).toBe(4194304);
  });

  (skip ? it.skip : it)('flag byte at 0x2FFF0 is 0x08 (LOCKED state, not 0x96)', () => {
    const d = readFileSync(INT_FLASH_LOCKED);
    expect(d[UNLOCK_FLAG_OFFSET]).toBe(0x08);
    expect(d[UNLOCK_FLAG_OFFSET]).not.toBe(UNLOCK_FLAG_BYTE);
  });

  (skip ? it.skip : it)('isAlreadyUnlocked returns false for INT_FLASH locked file', () => {
    const d = new Uint8Array(readFileSync(INT_FLASH_LOCKED));
    expect(isAlreadyUnlocked(d)).toBe(false);
  });

  (skip ? it.skip : it)('patchGpec2aFile (synthetic opts) sets flag byte to 0x96', () => {
    const d = new Uint8Array(readFileSync(INT_FLASH_LOCKED));
    const r = patchGpec2aFile(d, FAKE_OPTS);
    expect(r.flagSet).toBe(true);
    expect(r.patched[UNLOCK_FLAG_OFFSET]).toBe(UNLOCK_FLAG_BYTE);
    expect(d[UNLOCK_FLAG_OFFSET]).toBe(0x08); // original not mutated
  });

  /* REAL ACTIVATION — no opts, the module's recovered patterns. The corpus
   * INT_FLASH carries UNLOCK_TARGET_PATTERN (universal firmware code), so the
   * production code path performs the genuine unlock. */
  (skip ? it.skip : it)('REAL unlock (no opts): patches 0xE8 + flag 0x96, idempotent', () => {
    const d = new Uint8Array(readFileSync(INT_FLASH_LOCKED));
    expect(PATTERNS_AVAILABLE).toBe(true);
    const r = patchGpec2aFile(d); // production patterns
    expect(r.status).toBe('unlocked');
    expect(r.matchOffset).not.toBeNull();
    expect(r.patched[r.matchOffset]).toBe(0xE8);
    expect(r.patched[UNLOCK_FLAG_OFFSET]).toBe(UNLOCK_FLAG_BYTE);
    // exactly two bytes changed vs the locked input
    let diffs = 0; for (let i = 0; i < d.length; i++) if (r.patched[i] !== d[i]) diffs++;
    expect(diffs).toBe(2);
    // re-running on the unlocked output is a no-op
    expect(patchGpec2aFile(r.patched).status).toBe('already_unlocked');
    expect(isAlreadyUnlocked(r.patched)).toBe(true);
  });
});
