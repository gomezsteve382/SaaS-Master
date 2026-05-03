import { describe, it, expect } from 'vitest';
import {
  UNLOCK_FLAG_OFFSET,
  UNLOCK_FLAG_BYTE,
  patchGpec2aFile,
  isAlreadyUnlocked,
  detectGeneration,
  PATTERNS_AVAILABLE,
} from '../gpec2aUnlocker.js';

/* ── Synthetic stand-in patterns ──────────────────────────────────────────
 * These substitute for the real FieldRVA patterns (WinLicense-protected).
 * The opts injection mechanism allows the patcher core to be tested with
 * any 4-byte arrays without mutating the module-level constants.
 */
const FAKE_GEN_DETECT       = [0xAA, 0xBB, 0xCC, 0xDD];
const FAKE_UNLOCK_TARGET    = [0x12, 0x34, 0x56, 0x78];
const FAKE_ALREADY_UNLOCKED = [0x34, 0x56, 0x78, 0x9A]; // bytes K+1..K+4 after unlock

const FAKE_OPTS = {
  genDetectPattern:       FAKE_GEN_DETECT,
  alreadyUnlockedPattern: FAKE_ALREADY_UNLOCKED,
  unlockTargetPattern:    FAKE_UNLOCK_TARGET,
};

/* Build a minimal test firmware buffer */
function makeFile(size, opts = {}) {
  const buf = new Uint8Array(size);
  if (opts.genDetectAt != null)        buf.set(FAKE_GEN_DETECT, opts.genDetectAt);
  if (opts.unlockTargetAt != null)     buf.set(FAKE_UNLOCK_TARGET, opts.unlockTargetAt);
  if (opts.alreadyUnlockedAt != null) {
    buf[opts.alreadyUnlockedAt - 1] = 0xE8;
    buf.set(FAKE_ALREADY_UNLOCKED, opts.alreadyUnlockedAt);
  }
  if (opts.flagByte != null && size > UNLOCK_FLAG_OFFSET) {
    buf[UNLOCK_FLAG_OFFSET] = opts.flagByte;
  }
  return buf;
}

/* ══════════════════════════════════════════════════════════════════════════
 * TEST SUITE
 * ══════════════════════════════════════════════════════════════════════════ */

describe('gpec2aUnlocker — PATTERN_MISSING guard', () => {
  it('module starts with PATTERNS_AVAILABLE = false', () => {
    expect(PATTERNS_AVAILABLE).toBe(false);
  });

  it('returns PATTERN_MISSING when no opts and PATTERNS_AVAILABLE is false', () => {
    const file = new Uint8Array(256 * 1024);
    const r = patchGpec2aFile(file);
    expect(r.status).toBe('PATTERN_MISSING');
    expect(r.matchOffset).toBeNull();
    expect(r.patched).toBeInstanceOf(Uint8Array);
    expect(r.patched.length).toBe(file.length);
  });
});

describe('gpec2aUnlocker — locked file is patched correctly', () => {
  const SIZE = UNLOCK_FLAG_OFFSET + 100;

  it('writes 0xE8 at the match offset', () => {
    const PATTERN_OFF = 0x1000;
    const file = makeFile(SIZE, { unlockTargetAt: PATTERN_OFF });
    const r = patchGpec2aFile(file, FAKE_OPTS);

    expect(r.status).toBe('unlocked');
    expect(r.matchOffset).toBe(PATTERN_OFF);
    expect(r.patched[PATTERN_OFF]).toBe(0xE8);
    expect(r.patched[PATTERN_OFF + 1]).toBe(FAKE_UNLOCK_TARGET[1]);
    expect(r.patched[PATTERN_OFF + 2]).toBe(FAKE_UNLOCK_TARGET[2]);
    expect(r.patched[PATTERN_OFF + 3]).toBe(FAKE_UNLOCK_TARGET[3]);
  });

  it('sets 0x96 at UNLOCK_FLAG_OFFSET when file is large enough', () => {
    const file = makeFile(SIZE, { unlockTargetAt: 0x500 });
    const r = patchGpec2aFile(file, FAKE_OPTS);
    expect(r.flagSet).toBe(true);
    expect(r.patched[UNLOCK_FLAG_OFFSET]).toBe(UNLOCK_FLAG_BYTE);
  });

  it('does not modify the input array (returns a copy)', () => {
    const PATTERN_OFF = 0x800;
    const file = makeFile(SIZE, { unlockTargetAt: PATTERN_OFF });
    const originalByte = file[PATTERN_OFF];
    patchGpec2aFile(file, FAKE_OPTS);
    expect(file[PATTERN_OFF]).toBe(originalByte);
  });
});

describe('gpec2aUnlocker — already-unlocked file is a no-op', () => {
  const SIZE = UNLOCK_FLAG_OFFSET + 100;

  it('detects already-unlocked via flag byte and returns already_unlocked', () => {
    const file = makeFile(SIZE, { flagByte: UNLOCK_FLAG_BYTE });
    const r = patchGpec2aFile(file, FAKE_OPTS);
    expect(r.status).toBe('already_unlocked');
    expect(r.matchOffset).toBeNull();
  });

  it('does not write 0xE8 a second time when flag byte is set', () => {
    const PATTERN_OFF = 0x2000;
    const file = makeFile(SIZE, { flagByte: UNLOCK_FLAG_BYTE });
    file[PATTERN_OFF] = 0xE8;
    file.set(FAKE_UNLOCK_TARGET.slice(1), PATTERN_OFF + 1);
    const r = patchGpec2aFile(file, FAKE_OPTS);
    expect(r.status).toBe('already_unlocked');
    expect(r.patched[PATTERN_OFF]).toBe(0xE8);
  });

  it('detects already-unlocked via look-behind pattern heuristic', () => {
    const file = makeFile(SIZE);
    const LOOK_BEHIND_OFF = 0x3000;
    file[LOOK_BEHIND_OFF - 1] = 0xE8;
    file.set(FAKE_ALREADY_UNLOCKED, LOOK_BEHIND_OFF);
    const r = patchGpec2aFile(file, FAKE_OPTS);
    expect(r.status).toBe('already_unlocked');
  });
});

describe('gpec2aUnlocker — small file skips offset flag', () => {
  it('does not set flag byte when file is shorter than UNLOCK_FLAG_OFFSET', () => {
    const SIZE = UNLOCK_FLAG_OFFSET - 10;
    const PATTERN_OFF = 0x100;
    const file = makeFile(SIZE, { unlockTargetAt: PATTERN_OFF });
    const r = patchGpec2aFile(file, FAKE_OPTS);
    expect(r.flagSet).toBe(false);
    expect(r.patched.length).toBe(SIZE);
    expect(r.status).toBe('unlocked');
    expect(r.patched[PATTERN_OFF]).toBe(0xE8);
  });
});

describe('gpec2aUnlocker — pattern-not-found case', () => {
  it('returns offset_only when pattern is absent but file is large enough', () => {
    const SIZE = UNLOCK_FLAG_OFFSET + 50;
    const file = new Uint8Array(SIZE);
    const r = patchGpec2aFile(file, FAKE_OPTS);
    expect(r.status).toBe('offset_only');
    expect(r.matchOffset).toBeNull();
    expect(r.flagSet).toBe(true);
    expect(r.patched[UNLOCK_FLAG_OFFSET]).toBe(UNLOCK_FLAG_BYTE);
  });

  it('returns pattern_not_found when pattern absent and file is small', () => {
    const SIZE = UNLOCK_FLAG_OFFSET - 10;
    const file = new Uint8Array(SIZE);
    const r = patchGpec2aFile(file, FAKE_OPTS);
    expect(r.status).toBe('pattern_not_found');
    expect(r.matchOffset).toBeNull();
    expect(r.flagSet).toBe(false);
  });
});

describe('gpec2aUnlocker — generation detection', () => {
  it('returns PATTERN_MISSING when no opts and patterns unavailable', () => {
    const file = new Uint8Array(1024);
    expect(detectGeneration(file)).toBe('PATTERN_MISSING');
  });

  it('identifies 2015-2018 generation when GEN_DETECT_PATTERN is present', () => {
    const file = new Uint8Array(1024);
    file.set(FAKE_GEN_DETECT, 0x100);
    const gen = detectGeneration(file, { genDetectPattern: FAKE_GEN_DETECT });
    expect(gen).toBe('2015-2018 FILE FLASH');
  });

  it('identifies 2018+ generation when GEN_DETECT_PATTERN is not present', () => {
    const file = new Uint8Array(1024);
    const gen = detectGeneration(file, { genDetectPattern: FAKE_GEN_DETECT });
    expect(gen).toBe('NEW 2018+ FILE FLASH');
  });
});

describe('gpec2aUnlocker — isAlreadyUnlocked', () => {
  it('returns false for a fresh file with no flag and no opts', () => {
    const file = new Uint8Array(UNLOCK_FLAG_OFFSET + 10);
    expect(isAlreadyUnlocked(file)).toBe(false);
  });

  it('returns true when flag byte is set (no pattern opts needed)', () => {
    const file = new Uint8Array(UNLOCK_FLAG_OFFSET + 10);
    file[UNLOCK_FLAG_OFFSET] = UNLOCK_FLAG_BYTE;
    expect(isAlreadyUnlocked(file)).toBe(true);
  });

  it('returns true via look-behind when ALREADY_UNLOCKED_PATTERN opts provided', () => {
    const file = new Uint8Array(0x5000);
    const OFF = 0x2000;
    file[OFF - 1] = 0xE8;
    file.set(FAKE_ALREADY_UNLOCKED, OFF);
    expect(isAlreadyUnlocked(file, { alreadyUnlockedPattern: FAKE_ALREADY_UNLOCKED })).toBe(true);
  });
});

describe('gpec2aUnlocker — constants', () => {
  it('UNLOCK_FLAG_OFFSET equals 0x2FFFC (196604)', () => {
    expect(UNLOCK_FLAG_OFFSET).toBe(196604);
    expect(UNLOCK_FLAG_OFFSET).toBe(0x2FFFC);
  });

  it('UNLOCK_FLAG_BYTE equals 0x96 (150)', () => {
    expect(UNLOCK_FLAG_BYTE).toBe(0x96);
    expect(UNLOCK_FLAG_BYTE).toBe(150);
  });
});
