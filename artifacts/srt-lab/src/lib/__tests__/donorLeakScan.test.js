import { describe, it, expect } from 'vitest';

import {
  getDocumentedSlotWindows,
  scanBufferForDonorLeak,
  BCM_FULL_VIN_BASES,
  BCM_PARTIAL_VIN_OFFSETS,
  RFH_GEN2_VIN_OFFSETS,
  PCM_VIN_OFFSETS,
  vinAsBytes,
  reverseBytes,
  VIN_LEN,
} from '../donorLeakScan.js';
import {
  scanBufferForDonorLeak as scanFromScript,
  getDocumentedSlotWindows as windowsFromScript,
} from '../../../scripts/anonymize-real-dump.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Task #447 — pin the browser-safe scanner contract.
//
// The scanner moved out of `scripts/anonymize-real-dump.mjs` into this
// pure-JS module so the in-app pre-share leak check can import it without
// dragging in `node:fs|path|url`. The script re-exports the same symbols
// so existing tests keep passing — these tests assert that:
//
//   1. The pure module behaves correctly on every leak shape the helper
//      script's CLI cares about (forward VIN, reversed VIN, donor tail
//      forward / reversed outside the documented slot windows).
//   2. The script's re-exports are referentially the same callables —
//      not look-alikes — so we cannot accidentally fork the
//      implementation in a future refactor.
//   3. `getDocumentedSlotWindows` covers every documented slot the
//      anonymizer scrubbers know about, so the masked-region test
//      cannot start emitting false positives when a parser grows a new
//      slot offset and somebody only updates the scrubber.
// ─────────────────────────────────────────────────────────────────────────────

const DONOR = 'JC3CDXBT5HW123456';   // valid 17-char VIN (no I/O/Q)
const ANON  = 'ZZZZZZZZZZZZZZZZZ';   // distinct, valid placeholder

describe('donorLeakScan — module/script parity', () => {
  it('script re-exports the same callable references as this module', () => {
    expect(scanFromScript).toBe(scanBufferForDonorLeak);
    expect(windowsFromScript).toBe(getDocumentedSlotWindows);
  });
});

describe('donorLeakScan — getDocumentedSlotWindows', () => {
  it('covers every documented BCM slot (full + partial)', () => {
    const w = getDocumentedSlotWindows('bcm');
    // 5 full bases × 2 layouts (base+0, base+8) + 2 partial-VIN offsets
    expect(w.length).toBe(BCM_FULL_VIN_BASES.length * 2 + BCM_PARTIAL_VIN_OFFSETS.length);
    for (const base of BCM_FULL_VIN_BASES) {
      expect(w).toContainEqual({ kind: 'bcm-full-base+0', offset: base,     length: VIN_LEN });
      expect(w).toContainEqual({ kind: 'bcm-full-base+8', offset: base + 8, length: VIN_LEN });
    }
    for (const po of BCM_PARTIAL_VIN_OFFSETS) {
      expect(w).toContainEqual({ kind: 'bcm-partial', offset: po, length: 8 });
    }
  });

  it('covers every documented RFHUB Gen2 reversed-VIN slot', () => {
    const w = getDocumentedSlotWindows('rfhub');
    expect(w.length).toBe(RFH_GEN2_VIN_OFFSETS.length);
    for (const off of RFH_GEN2_VIN_OFFSETS) {
      expect(w).toContainEqual({ kind: 'rfh-rev-vin', offset: off, length: VIN_LEN });
    }
  });

  it('covers every documented PCM full-VIN slot', () => {
    const w = getDocumentedSlotWindows('pcm');
    expect(w.length).toBe(PCM_VIN_OFFSETS.length);
    for (const off of PCM_VIN_OFFSETS) {
      expect(w).toContainEqual({ kind: 'pcm-full', offset: off, length: VIN_LEN });
    }
  });

  it('throws on unsupported module type', () => {
    expect(() => getDocumentedSlotWindows('ecm')).toThrow(/unsupported module type/i);
    expect(() => getDocumentedSlotWindows(null)).toThrow(/unsupported module type/i);
  });
});

describe('donorLeakScan — scanBufferForDonorLeak', () => {
  function bcmCleanBuffer() {
    // 64 KB of 0xFF (matches a virgin BCM EEPROM) + the anon VIN dropped
    // into every documented full-VIN base+8 slot. The anon VIN's tail
    // also lands in the partial-VIN records so the masked-region check
    // exercises the full BCM window table.
    const buf = new Uint8Array(0x10000).fill(0xFF);
    const anonBytes = vinAsBytes(ANON);
    for (const base of BCM_FULL_VIN_BASES) {
      const off = base + 8;
      for (let i = 0; i < VIN_LEN; i++) buf[off + i] = anonBytes[i];
    }
    const tail = anonBytes.slice(9); // last 8 chars
    for (const po of BCM_PARTIAL_VIN_OFFSETS) {
      for (let i = 0; i < 8; i++) buf[po + i] = tail[i];
    }
    return buf;
  }

  it('returns null for a fully-scrubbed BCM buffer', () => {
    const r = scanBufferForDonorLeak({
      buffer: bcmCleanBuffer(),
      donorVin: DONOR,
      moduleType: 'bcm',
    });
    expect(r).toBeNull();
  });

  it('detects donor VIN forward', () => {
    const buf = bcmCleanBuffer();
    const donorBytes = vinAsBytes(DONOR);
    // Drop the donor VIN at an undocumented offset — outside every
    // documented slot — so it has nowhere to hide.
    const leakOff = 0x1000;
    for (let i = 0; i < VIN_LEN; i++) buf[leakOff + i] = donorBytes[i];

    const r = scanBufferForDonorLeak({ buffer: buf, donorVin: DONOR, moduleType: 'bcm' });
    expect(r).not.toBeNull();
    expect(r.kind).toBe('donor-vin-forward');
    expect(r.offset).toBe(leakOff);
    expect(r.donorVin).toBe(DONOR);
    expect(r.message).toMatch(/donor VIN/i);
  });

  it('detects donor VIN byte-reversed', () => {
    const buf = bcmCleanBuffer();
    const rev = reverseBytes(vinAsBytes(DONOR));
    const leakOff = 0x2000;
    for (let i = 0; i < VIN_LEN; i++) buf[leakOff + i] = rev[i];

    const r = scanBufferForDonorLeak({ buffer: buf, donorVin: DONOR, moduleType: 'bcm' });
    expect(r).not.toBeNull();
    expect(r.kind).toBe('donor-vin-reversed');
    expect(r.offset).toBe(leakOff);
  });

  it('detects donor tail forward outside documented windows', () => {
    const buf = bcmCleanBuffer();
    const tail = vinAsBytes(DONOR.slice(-6));
    const leakOff = 0x3000;
    for (let i = 0; i < tail.length; i++) buf[leakOff + i] = tail[i];

    const r = scanBufferForDonorLeak({ buffer: buf, donorVin: DONOR, moduleType: 'bcm' });
    expect(r).not.toBeNull();
    expect(r.kind).toBe('donor-tail-forward');
    expect(r.offset).toBe(leakOff);
    expect(r.tail).toBe(DONOR.slice(-6));
  });

  it('does NOT flag donor-tail bytes that fall inside documented windows', () => {
    const buf = bcmCleanBuffer();
    const tail = vinAsBytes(DONOR.slice(-6));
    // Drop the tail INSIDE the partial-VIN window at 0x4098 — a legitimate
    // slot the scrubber owns. The mask must zero it out before the scan.
    for (let i = 0; i < tail.length; i++) buf[0x4098 + i] = tail[i];

    const r = scanBufferForDonorLeak({ buffer: buf, donorVin: DONOR, moduleType: 'bcm' });
    expect(r).toBeNull();
  });

  it('detects donor tail byte-reversed outside documented windows', () => {
    const buf = bcmCleanBuffer();
    const tailRev = reverseBytes(vinAsBytes(DONOR.slice(-6)));
    const leakOff = 0x3500;
    for (let i = 0; i < tailRev.length; i++) buf[leakOff + i] = tailRev[i];

    const r = scanBufferForDonorLeak({ buffer: buf, donorVin: DONOR, moduleType: 'bcm' });
    expect(r).not.toBeNull();
    expect(r.kind).toBe('donor-tail-reversed');
    expect(r.offset).toBe(leakOff);
  });

  it('honours an explicit `slotWindows` override (tighter than the documented default)', () => {
    const buf = bcmCleanBuffer();
    const tail = vinAsBytes(DONOR.slice(-6));
    // Same in-window plant as the "does NOT flag" case above — but pass an
    // EMPTY slotWindows array so the mask skips it. Now it MUST fire.
    for (let i = 0; i < tail.length; i++) buf[0x4098 + i] = tail[i];

    const r = scanBufferForDonorLeak({
      buffer: buf,
      donorVin: DONOR,
      moduleType: 'bcm',
      slotWindows: [],
    });
    expect(r).not.toBeNull();
    expect(r.kind).toBe('donor-tail-forward');
    expect(r.offset).toBe(0x4098);
  });

  it('rejects bad inputs with a clear error', () => {
    expect(() => scanBufferForDonorLeak({ buffer: [1, 2, 3], donorVin: DONOR, moduleType: 'bcm' }))
      .toThrow(/Uint8Array/);
    expect(() => scanBufferForDonorLeak({ buffer: new Uint8Array(8), donorVin: 'TOO-SHORT', moduleType: 'bcm' }))
      .toThrow(/17-character/);
    expect(() => scanBufferForDonorLeak({ buffer: new Uint8Array(8), donorVin: DONOR, moduleType: 'ecm' }))
      .toThrow(/unsupported module type/i);
  });
});
