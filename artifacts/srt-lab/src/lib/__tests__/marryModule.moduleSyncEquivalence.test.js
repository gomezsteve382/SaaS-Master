import { describe, it, expect } from 'vitest';
import { marryModule } from '../marryModule.js';
import { resolveBcmSec16 } from '../parseModule.js';
import { writeBcmSec16Gen2, writeBcmFlatSec16, writePcmSec6, writeRfhSec16FromBcm } from '../securityBytes.js';
import { rekeyVirginBcmFromRfhub } from '../mpc5606bBcm.js';
import { reverse16 } from '../immoSecret.js';

/* marryModule must produce BYTE-IDENTICAL output to ModuleSync's secret-write
 * sequence (the canonical securityBytes writers ModuleSync's sec16-only /
 * sync-all / rekey-virgin actions call directly). This locks the engine and
 * ModuleSync to the same bytes so they can never silently diverge — the
 * single-write-path guarantee, enforced. If a future change makes marryModule
 * and ModuleSync's writers disagree, this fails. */

const ROOT = Uint8Array.from({ length: 16 }, (_, i) => (i * 31 + 7) & 0xff);
const OTHER = Uint8Array.from({ length: 16 }, (_, i) => (i * 7 + 200) & 0xff);
const BCMROOT = reverse16(ROOT);
const arr = (b) => Array.from(b);

const rfhGen2 = () => { const b = new Uint8Array(4096); b[0x500] = 0xAA; b[0x501] = 0x55; b[0x502] = 0x31; b[0x503] = 0x01; return b; };
const rfhSrc = () => writeRfhSec16FromBcm(rfhGen2(), BCMROOT).bytes;
const gpec2a = () => { const b = new Uint8Array(4096); const v = '2C3CDXBG1KH100001'; for (let i = 0; i < 17; i++) b[i] = v.charCodeAt(i); return b; };

// ModuleSync sec16-only BCM sequence: writeBcmSec16Gen2 then the canonical flat
// repair (chainBcmFlatRepairIfStale === writeBcmFlatSec16 canonical on the
// resolved secret).
function moduleSyncBcmWrite(bcmBytes, rfhSec16) {
  const r1 = writeBcmSec16Gen2(bcmBytes, rfhSec16);
  const resolved = resolveBcmSec16(r1.bytes);
  if (!resolved || !resolved.bytes || resolved.blank) return r1.bytes;
  return writeBcmFlatSec16(r1.bytes, resolved.bytes, { mode: 'canonical' }).bytes;
}

describe('marryModule ≡ ModuleSync writer sequence (single-write-path lock)', () => {
  it('RFH→BCM (split-record BCM) matches writeBcmSec16Gen2 + flat', () => {
    const bcm = rekeyVirginBcmFromRfhub(new Uint8Array(65536).fill(0xFF), OTHER).bytes;
    const ms = moduleSyncBcmWrite(bcm, ROOT);
    const mm = marryModule({ source: { bytes: rfhSrc() }, target: { bytes: bcm } });
    expect(mm.ok).toBe(true);
    expect(arr(mm.bytes)).toEqual(arr(ms));
  });

  it('RFH→virgin BCM matches rekeyVirginBcmFromRfhub', () => {
    const bcm = new Uint8Array(65536).fill(0xFF);
    const ms = rekeyVirginBcmFromRfhub(bcm, ROOT).bytes;
    const mm = marryModule({ source: { bytes: rfhSrc() }, target: { bytes: bcm } });
    expect(arr(mm.bytes)).toEqual(arr(ms));
  });

  it('RFH→PCM matches writePcmSec6', () => {
    const pcm = gpec2a();
    const ms = writePcmSec6(pcm, ROOT).bytes;
    const mm = marryModule({ source: { bytes: rfhSrc() }, target: { bytes: pcm } });
    expect(arr(mm.bytes)).toEqual(arr(ms));
  });
});
