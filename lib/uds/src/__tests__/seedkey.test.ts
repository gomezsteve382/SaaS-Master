/**
 * Proves every TypeScript seed→key port in src/seedkey.ts is byte-identical to
 * the verified Python source of truth (tools/python-bridge/.../canflash_seedkey.py),
 * via the golden vectors in unlock_vectors.generated.json. Those vectors are
 * anchored to real factory-DLL self-test outputs, so green == DLL-correct.
 *
 * Regenerate vectors: python lib/uds/scripts/gen_unlock_vectors.py
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  UNLOCKS,
  unlockByModule,
  unlockKeyBytesByModule,
  VERIFIED_BY_CODE,
  type UnlockFn,
} from '../seedkey.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(join(here, 'unlock_vectors.generated.json'), 'utf8'),
) as {
  algorithms: Record<string, { argc: number; vectors: [number | [number, number], number][] }>;
};

describe('seedkey ports are byte-identical to verified Python (factory DLL) vectors', () => {
  for (const [name, { argc, vectors }] of Object.entries(golden.algorithms)) {
    it(name, () => {
      const fn = UNLOCKS[name] as UnlockFn | undefined;
      expect(fn, `UNLOCKS['${name}'] is missing`).toBeTypeOf('function');
      for (const [input, expected] of vectors) {
        const got =
          argc === 2 && Array.isArray(input)
            ? fn!(input[0], input[1])
            : fn!(input as number);
        expect(got >>> 0, `${name}(${JSON.stringify(input)})`).toBe(expected >>> 0);
      }
    });
  }
});

describe('anchored factory-DLL self-test vectors', () => {
  it('huntsville_bcm(0x1234) = 0x526C', () => expect(unlockByModule('BCM', 0x1234)).toBe(0x526c));
  it('motorola_tipm7(0x2736) = 0x64EE', () => expect(unlockByModule('TIPM_7', 0x2736)).toBe(0x64ee));
  it('trw_abs(0x0101) = 0x2AD4', () => expect(unlockByModule('ABS_TRW', 0x0101)).toBe(0x2ad4));
  it('bosch_abs(0xA864) = 0x6C34', () => expect(unlockByModule('ABS_BOSCH', 0xa864)).toBe(0x6c34));
  it('venom_pcm(1) = 0x0705', () => expect(unlockByModule('PCM_VENOM', 1)).toBe(0x0705));
  it('lear_wcm self-test = 0x57D0B3AC', () =>
    expect(unlockByModule('WCM_LEAR', 0xf5377b24, 0xf5377b4b)).toBe(0x57d0b3ac));
  it('unknown module returns null', () => expect(unlockByModule('NOPE', 1)).toBeNull());
});

describe('unlockKeyBytesByModule — wire-byte framing (seed-width = key-width, BE)', () => {
  it('huntsville_bcm 2-byte seed 12 34 → key 52 6C', () =>
    expect(unlockKeyBytesByModule('huntsville_bcm', [0x12, 0x34])).toEqual([0x52, 0x6c]));
  it('BCM (logical) matches the DLL name', () =>
    expect(unlockKeyBytesByModule('BCM', [0x12, 0x34])).toEqual([0x52, 0x6c]));
  it('trw_abs 2-byte seed 01 01 → key 2A D4', () =>
    expect(unlockKeyBytesByModule('trw_abs', [0x01, 0x01])).toEqual([0x2a, 0xd4]));
  it('gpec 4-byte seed 12 34 56 78 → key 01 C4 28 92', () =>
    expect(unlockKeyBytesByModule('gpec', [0x12, 0x34, 0x56, 0x78])).toEqual([0x01, 0xc4, 0x28, 0x92]));
  it('lear_wcm 8-byte seed (two 32-bit halves) → 4-byte key (self-test vector)', () =>
    expect(unlockKeyBytesByModule('WCM_LEAR', [0xf5, 0x37, 0x7b, 0x24, 0xf5, 0x37, 0x7b, 0x4b])).toEqual([
      0x57, 0xd0, 0xb3, 0xac,
    ]));
  it('unknown module → null', () => expect(unlockKeyBytesByModule('NOPE', [0x12, 0x34])).toBeNull());
  it('empty seed → null', () => expect(unlockKeyBytesByModule('BCM', [])).toBeNull());

  it('VERIFIED_BY_CODE entries all resolve to real algorithms', () => {
    for (const [code, names] of Object.entries(VERIFIED_BY_CODE)) {
      for (const n of names) {
        expect(UNLOCKS[n], `${code} → ${n} missing from UNLOCKS`).toBeTypeOf('function');
      }
    }
  });
});
