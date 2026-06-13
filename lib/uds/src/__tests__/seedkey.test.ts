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

import { UNLOCKS, unlockByModule, type UnlockFn } from '../seedkey.js';

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
