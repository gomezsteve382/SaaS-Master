import { describe, it, expect } from 'vitest';

import { checkExportSafety, formatBlockingMessage } from '../exportSafetyGate.js';
import { writeBcmSec16Gen2, writePcmSec6, writeBcmFlatSec16 } from '../securityBytes.js';
import { runRfhBcmSync } from '../keyProgWizard.js';
import { parseModule, resolveBcmSec16 } from '../parseModule.js';
import { rekeyVirginBcmFromRfhub } from '../mpc5606bBcm.js';
import { engParseEep95640, engWriteBcmVin, engWriteRfhVin } from '../../tabs/ModuleSync.jsx';
import { loadRealDumpFixtures } from '../__fixtures__/realDumps/loader.js';

// ─────────────────────────────────────────────────────────────────────────────
// Task #1023 — pre-download safety gate tests.
//
// Root problem this guards against: a "Sync all" run that exported an RFH whose
// SEC16 did not match the BCM, labeled BOTH files _SYNCED, and reported success
// — a brick-risk, because flashing a mismatched immobilizer secret pair locks
// the car. checkExportSafety reparses the OUTGOING bytes (the actual files
// about to hit disk), runs per-file checksum self-checks, and runs crossValidate
// across the outgoing + context set. Any blocking inconsistency flips ok=false
// so the UI refuses the download instead of shipping a _SYNCED brick.
//
// These tests drive REAL bench dumps through the REAL export engine primitives
// (writeBcmSec16Gen2 / writePcmSec6 / runRfhBcmSync — the same functions the
// ModuleSync tab calls) and assert:
//   1. a correctly-synced, internally-consistent set PASSES the gate, and
//   2. a BCM that holds a DIFFERENT secret than the RFH it is paired with is
//      REFUSED (ok=false) with a clear SEC16-mismatch blocking message.
//
// Fixtures load from src/lib/__fixtures__/realDumps/ via the shared loader; if
// the dumps are not committed the loader returns null and every suite below is
// describe.skip'd so the build stays green.
// ─────────────────────────────────────────────────────────────────────────────

const fixtures = loadRealDumpFixtures();
const haveAny = fixtures !== null;

const hex = (u) => (u ? Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('') : null);

/* Locate the extraBcm whose captured SEC16 secret matches the primary RFHUB
 * fixture — the rfhub / pcm / matching-extraBcm entries in the manifest were
 * all captured from the SAME anonymized vehicle (VIN ...600000, secret
 * 816531...), so together they form a coherent, flash-safe module set. */
function coherentSet(fx) {
  const rfhSecHex = hex(fx?.rfhub?.rfhSec16);
  const bcm = (fx?.extraBcms || []).find((b) => hex(b.rfhSec16) === rfhSecHex);
  if (!bcm || !fx?.rfhub || !fx?.pcm) return null;
  return { bcm, rfhub: fx.rfhub, pcm: fx.pcm, rfhSec16: fx.rfhub.rfhSec16 };
}

describe.skipIf(!haveAny)('checkExportSafety — golden round-trip (real export paths)', () => {
  const set = coherentSet(fixtures);

  it.skipIf(!set)('PASSES for a coherent BCM + RFH + PCM set built by the real writers', () => {
    const bcmSynced = writeBcmSec16Gen2(set.bcm.before, set.bcm.rfhSec16).bytes;
    const pcmSynced = writePcmSec6(set.pcm.before, set.pcm.rfhSec16).bytes;
    const rfhAfter = set.rfhub.after; // real captured synced RFHUB

    // Sanity: the three modules genuinely share one VIN + one secret.
    const bi = parseModule(bcmSynced, 'BCM');
    const ri = parseModule(rfhAfter, 'RFH');
    expect(bi.vins?.[0]?.vin).toBe(ri.vins?.[0]?.vin);
    expect(hex(ri.vehicleSecret?.bytes)).toBe(hex(set.rfhSec16));

    const verdict = checkExportSafety({
      outgoing: [
        { role: 'BCM', bytes: bcmSynced, name: 'BCM_SYNCED.bin' },
        { role: 'RFH', bytes: rfhAfter, name: 'RFH_SYNCED.bin' },
        { role: 'PCM', bytes: pcmSynced, name: 'PCM_SYNCED.bin' },
      ],
    });

    expect(verdict.blocking).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it.skipIf(!fixtures?.bcm || !fixtures?.rfhub)(
    'PASSES the runRfhBcmSync (RFH→BCM) output against its source RFH',
    () => {
      const sync = runRfhBcmSync({
        rfh: { name: 'RFH.bin', data: fixtures.rfhub.after },
        bcm: { name: 'BCM.bin', data: fixtures.bcm.before },
        direction: 'RFH_TO_BCM',
      });
      // The wizard self-gates via round-trip; only assert the gate when it
      // produced a file (some fixtures may not satisfy the wizard's matchers).
      const out = sync?.files?.find((f) => /bcm/i.test(f.name || ''))?.data || sync?.files?.[0]?.data;
      if (!sync?.ok || !out) return;

      const verdict = checkExportSafety({
        outgoing: [{ role: 'BCM', bytes: out, name: 'BCM_SYNCED.bin' }],
        context: [{ role: 'RFH', bytes: fixtures.rfhub.after, name: 'RFH.bin' }],
      });
      expect(verdict.ok).toBe(true);
    },
  );
});

describe.skipIf(!haveAny)('checkExportSafety — BCM-holds-secret mismatch regression', () => {
  const set = coherentSet(fixtures);

  it.skipIf(!set)('REFUSES a BCM synced to a different secret than the paired RFH', () => {
    // BCM is synced to the PRIMARY bcm fixture's secret (86fa72...), while the
    // RFH carries the coherent-set secret (816531...). This is exactly the
    // brick-risk the task fixes: two _SYNCED files whose immobilizer secrets
    // disagree.
    const wrongSecret = fixtures.bcm.rfhSec16;
    expect(hex(wrongSecret)).not.toBe(hex(set.rfhSec16)); // guard the premise

    const bcmWrong = writeBcmSec16Gen2(set.bcm.before, wrongSecret).bytes;
    const rfhAfter = set.rfhub.after;

    const verdict = checkExportSafety({
      outgoing: [
        { role: 'BCM', bytes: bcmWrong, name: 'BCM_SYNCED.bin' },
        { role: 'RFH', bytes: rfhAfter, name: 'RFH_SYNCED.bin' },
      ],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.blocking.some((m) => /MISMATCH/i.test(m))).toBe(true);

    // formatBlockingMessage must surface the refusal for the UI log.
    const msg = formatBlockingMessage(verdict);
    expect(msg).toMatch(/MISMATCH/i);
    expect(msg.length).toBeGreaterThan(0);
  });

  it.skipIf(!set)('per-file mode (crossModule:false) ignores the cross-secret mismatch', () => {
    // virginize / single-file exports gate per-file only; a cross-secret
    // mismatch must NOT block them (the RFH secret is intentionally absent).
    const bcmWrong = writeBcmSec16Gen2(set.bcm.before, fixtures.bcm.rfhSec16).bytes;
    const verdict = checkExportSafety({
      outgoing: [
        { role: 'BCM', bytes: bcmWrong, name: 'BCM.bin' },
        { role: 'RFH', bytes: set.rfhub.after, name: 'RFH.bin' },
      ],
      crossModule: false,
    });
    // No cross-module secret check ran, so the set is not refused on mismatch.
    expect(verdict.blocking.some((m) => /vehicle secret.*MISMATCH/i.test(m))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task #1023 — regressions for the four export paths gated AFTER the first pass
// (rekey-virgin-bcm, rekey-95640-from-rfh, and the canonical/legacy flat-repair
// copies in the single + double-emit branches). Each is a brick-risk export that
// previously shipped without running through checkExportSafety.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!haveAny)('checkExportSafety — rekey-virgin-bcm regression', () => {
  const set = coherentSet(fixtures);

  it.skipIf(!set)('PASSES a virgin BCM re-keyed from the RFHUB master it pairs with', () => {
    // Re-keying a virgin BCM creates the split/mirror SEC16 records from
    // scratch off reverse(RFHUB SEC16). Gated cross-module against the RFH.
    const rk = rekeyVirginBcmFromRfhub(set.bcm.before, set.rfhSec16, null);
    const verdict = checkExportSafety({
      outgoing: [{ role: 'BCM', bytes: rk.bytes, name: 'BCM_REKEYED.bin' }],
      context: [{ role: 'RFH', bytes: set.rfhub.after, name: 'RFH.bin' }],
    });
    expect(verdict.blocking).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it.skipIf(!set || !fixtures?.rfhubg1)(
    'REFUSES a virgin BCM re-keyed from a DIFFERENT secret than the paired RFH',
    () => {
      // Re-key off rfhubg1's secret (1bcf82...) but gate against the coherent
      // RFH (816531...). The freshly-written BCM SEC16 does not mirror the RFH
      // it ships alongside — exactly the brick the gate must refuse _REKEYED.
      const wrongSecret = fixtures.rfhubg1.rfhSec16;
      expect(hex(wrongSecret)).not.toBe(hex(set.rfhSec16)); // guard the premise
      const rk = rekeyVirginBcmFromRfhub(set.bcm.before, wrongSecret, null);
      const verdict = checkExportSafety({
        outgoing: [{ role: 'BCM', bytes: rk.bytes, name: 'BCM_REKEYED.bin' }],
        context: [{ role: 'RFH', bytes: set.rfhub.after, name: 'RFH.bin' }],
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.blocking.some((m) => /MISMATCH/i.test(m))).toBe(true);
    },
  );
});

describe.skipIf(!haveAny)('checkExportSafety — bcm-flat-from-resolved (single + double-emit) regression', () => {
  const set = coherentSet(fixtures);

  it.skipIf(!set)('PASSES the CANONICAL flat-repair copy under the full SEC16 self-check', () => {
    // Canonical mode leaves the split + mirror records intact, so the copy must
    // survive the full ['vin','partials','sec16'] self-check the branch runs.
    const rs = resolveBcmSec16(set.bcm.after);
    expect(rs?.source).not.toBe('flat');
    const wr = writeBcmFlatSec16(set.bcm.after, rs.bytes, { mode: 'canonical' });
    const verdict = checkExportSafety({
      outgoing: [{ role: 'BCM', bytes: wr.bytes, name: 'BCM_FLAT40C9_REPAIRED_CANONICAL.bin' }],
      crossModule: false,
      selfChecks: ['vin', 'partials', 'sec16'],
    });
    expect(verdict.blocking).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it.skipIf(!set)('PASSES the LEGACYFLAT copy under the VIN-scoped self-check', () => {
    // Legacy-flat may clobber mirror1 (intentional — master split records stay
    // valid), so the branch scopes its gate to ['vin','partials']. VIN slots
    // must still verify.
    const rs = resolveBcmSec16(set.bcm.after);
    const wr = writeBcmFlatSec16(set.bcm.after, rs.bytes, { mode: 'legacy-flat' });
    const verdict = checkExportSafety({
      outgoing: [{ role: 'BCM', bytes: wr.bytes, name: 'BCM_FLAT40C9_REPAIRED_LEGACYFLAT.bin' }],
      crossModule: false,
      selfChecks: ['vin', 'partials'],
    });
    expect(verdict.blocking).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it.skipIf(!set)('REFUSES the CANONICAL copy when a VIN slot is corrupted', () => {
    // Corrupt one full-VIN byte so its CRC no longer verifies, then run the
    // flat repair: the full self-check must catch it and refuse the download
    // (the canonical copy is the vaulted source of truth).
    const rs = resolveBcmSec16(set.bcm.after);
    const wr = writeBcmFlatSec16(set.bcm.after, rs.bytes, { mode: 'canonical' });
    const corrupt = new Uint8Array(wr.bytes);
    const pre = parseModule(corrupt, 'BCM');
    const vinOff = pre.vins?.[0]?.offset;
    expect(typeof vinOff).toBe('number'); // guard the premise
    // Swap the last VIN char between two VIN-valid digits so the slot is still
    // parsed as a VIN but its stored CRC no longer matches (an XOR-0xFF would
    // make the byte non-printable and drop the slot from info.vins entirely).
    const last = vinOff + 16;
    corrupt[last] = corrupt[last] === 0x30 ? 0x31 : 0x30; // '0' <-> '1'
    const verdict = checkExportSafety({
      outgoing: [{ role: 'BCM', bytes: corrupt, name: 'BCM_FLAT40C9_REPAIRED_CANONICAL.bin' }],
      crossModule: false,
      selfChecks: ['vin', 'partials', 'sec16'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.blocking.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!haveAny)('checkExportSafety — rekey-95640-from-rfh regression', () => {
  const set = coherentSet(fixtures);

  // CRC16/CCITT-FALSE, identical to engCrc16 in ModuleSync (init 0xFFFF, poly
  // 0x1021, no reflection) — used to stamp a faithful 95640 backup in-memory
  // (no 95640 capture is committed, so we synthesize the canonical layout).
  const crc16ccitt = (data) => {
    let c = 0xFFFF;
    for (const b of data) {
      c ^= b << 8;
      for (let j = 0; j < 8; j++) c = (c & 0x8000) ? (((c << 1) ^ 0x1021) & 0xFFFF) : ((c << 1) & 0xFFFF);
    }
    return c & 0xFFFF;
  };

  // Build an 8 KB 95640 BCM-backup carrying reverse(rfhSec16) @0x838 + CRC16
  // @0x848, mirroring engWriteEep95640FromRfh.
  const build95640 = (rfhSec16, { badCrc = false } = {}) => {
    const buf = new Uint8Array(8192).fill(0xFF);
    const rev = new Uint8Array(16);
    for (let i = 0; i < 16; i++) rev[i] = rfhSec16[15 - i];
    buf.set(rev, 0x838);
    const crc = crc16ccitt(rev) ^ (badCrc ? 0xFFFF : 0x0000);
    buf[0x848] = (crc >> 8) & 0xFF;
    buf[0x849] = crc & 0xFF;
    return buf;
  };

  it.skipIf(!set)('the gated invariant HOLDS for a faithful 95640 re-key', () => {
    const buf = build95640(set.rfhSec16);
    const reparsed = engParseEep95640(buf, '95640.bin');
    // The engine writes reverse(RFHUB SEC16) @0x838 — the check compares the
    // reparsed SEC16 against that reversed value (== wr.sec16Hex in the branch).
    const rev = new Uint8Array(16);
    for (let i = 0; i < 16; i++) rev[i] = set.rfhSec16[15 - i];
    const expectedSec16 = Array.from(rev).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    // The exact pre-download check the rekey-95640 branch runs:
    expect(reparsed.bcmSec16CrcOk).toBe(true);
    expect(reparsed.bcmSec16Hex).toBe(expectedSec16);
    // The VIN-scoped shared gate must not false-refuse (no VIN slots present).
    const verdict = checkExportSafety({
      outgoing: [{ role: '95640', bytes: buf, name: 'EEP95640_REKEYED.bin' }],
      context: [{ role: 'RFH', bytes: set.rfhub.after, name: 'RFH.bin' }],
      crossModule: false,
      selfChecks: ['vin'],
    });
    expect(verdict.ok).toBe(true);
  });

  it.skipIf(!set)('the gated invariant FAILS when the written CRC16 is wrong', () => {
    const buf = build95640(set.rfhSec16, { badCrc: true });
    const reparsed = engParseEep95640(buf, '95640.bin');
    // bcmSec16CrcOk is the guard the branch refuses the download on.
    expect(reparsed.bcmSec16CrcOk).toBe(false);
  });
});

describe.skipIf(!haveAny)('checkExportSafety — VIN-only single-module stamps (rfh-to-bcm / bcm-to-rfh)', () => {
  const set = coherentSet(fixtures);
  const VIN = '2C3CDXCT1HH600000'; // valid 17-char FCA VIN

  it.skipIf(!set)('PASSES the rfh-to-bcm BCM stamp under the VIN-scoped gate', () => {
    // Exactly what the rfh-to-bcm branch ships: BCM VIN rewritten by the real
    // engine writer, gated crossModule:false / ['vin','partials'].
    const r = engWriteBcmVin(set.bcm.before, VIN);
    const verdict = checkExportSafety({
      outgoing: [{ role: 'BCM', bytes: r.bytes, name: `BCM_SYNCED_${VIN}.bin` }],
      crossModule: false,
      selfChecks: ['vin', 'partials'],
    });
    expect(verdict.blocking).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it.skipIf(!set)('PASSES the bcm-to-rfh RFH stamp under the VIN-scoped gate', () => {
    const r = engWriteRfhVin(set.rfhub.before, VIN, false);
    const verdict = checkExportSafety({
      outgoing: [{ role: 'RFH', bytes: r.bytes, name: `RFH_SYNCED_${VIN}.bin` }],
      crossModule: false,
      selfChecks: ['vin', 'partials'],
    });
    expect(verdict.blocking).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it.skipIf(!set)('REFUSES the rfh-to-bcm stamp when a written VIN slot is corrupted', () => {
    // Corrupt one full-VIN byte so its stored CRC no longer verifies; the
    // branch's gate must refuse the _SYNCED download (no file written).
    const r = engWriteBcmVin(set.bcm.before, VIN);
    const corrupt = new Uint8Array(r.bytes);
    const pre = parseModule(corrupt, 'BCM');
    const vinOff = pre.vins?.[0]?.offset;
    expect(typeof vinOff).toBe('number'); // guard the premise
    const last = vinOff + 16;
    corrupt[last] = corrupt[last] === 0x30 ? 0x31 : 0x30; // '0' <-> '1', stays VIN-valid
    const verdict = checkExportSafety({
      outgoing: [{ role: 'BCM', bytes: corrupt, name: `BCM_SYNCED_${VIN}.bin` }],
      crossModule: false,
      selfChecks: ['vin', 'partials'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.blocking.length).toBeGreaterThan(0);
  });
});

describe('checkExportSafety — contract', () => {
  it('returns the documented shape for an empty outgoing set', () => {
    const verdict = checkExportSafety({ outgoing: [] });
    expect(verdict).toHaveProperty('ok');
    expect(verdict).toHaveProperty('blocking');
    expect(verdict).toHaveProperty('warnings');
    expect(verdict).toHaveProperty('passed');
    expect(Array.isArray(verdict.blocking)).toBe(true);
  });
});
