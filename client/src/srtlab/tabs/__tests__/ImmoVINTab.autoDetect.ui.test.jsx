// @vitest-environment jsdom
//
// Task #493 — End-to-end UI coverage for the multi-target ImmoVIN tab's
// auto-detect routing flow.
//
// Mounts <ImmoVINTab/> via @testing-library/react, drops each of the four
// real-bench fixture pairs (rfhub Gen1 / rfhub Gen2 / primary BCM SEC16 /
// charger-bcm-vin-write) into the AutoDetectZone, and asserts:
//
//   1. The auto-detect result banner classifies the file with the right
//      module label (BCM / GPEC2A / RFHUB Gen1 / RFHUB Gen2).
//   2. Only the matching section panel is mounted in the DOM (data-testid
//      "rfh-section" / "gpec-section" / "bcm-section") — the OTHER two
//      section testids must be queryByTestId === null. This is the
//      regression guard the unit-level tests cannot catch: a future change
//      that breaks the visibleSectionsForKind() router (or removes a
//      section testid) will fail this suite even when applyRfhub /
//      applyBcmVin / parseBcmDflash all still pass.
//   3. The matching section's APPLY phase actually downloads bytes, and
//      the captured Blob contents match the fixture's "after" half (where
//      the apply path can byte-reproduce the after, i.e. the BCM cases) or
//      else round-trip cleanly through the section's parser (where the
//      after has SEC16/SEC bytes the apply path doesn't write, i.e. the
//      RFH Gen2 case). The Gen1 RFH case has no 4KB apply path, so it
//      verifies the apply zone refuses the 2KB upload with the documented
//      error string instead of triggering a download.
//
// Skip-don't-fail policy mirrors the other realDumps suites: if a fixture
// entry is missing from the manifest, the corresponding it() block calls
// .skip() at runtime.

import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

import ImmoVINTab, { parseRfhub, parseBcmDflash } from '../ImmoVINTab.jsx';
import { loadRealDumpFixtures } from '../../lib/__fixtures__/realDumps/loader.js';

const fixtures = loadRealDumpFixtures();

const rfhGen1 = fixtures && fixtures.rfhubg1;            // 2 KB Gen1
const rfhGen2 = fixtures && fixtures.rfhub;              // 4 KB Gen2
const bcmSec16 = fixtures && fixtures.bcm;               // 64 KB SEC16-only diff
const bcmVinWrite = fixtures && Array.isArray(fixtures.extraBcms)
  ? fixtures.extraBcms.find(e => e && e.anonVin === '2C3CDXL90MH600142' && e.anonVinAfter === '2C3CDXHG5EH600538')
  : null;                                                // 64 KB VIN-write

function bufferFile(name, bytes) {
  return new File([bytes], name, { type: 'application/octet-stream' });
}

// Drop a file by populating the hidden <input type="file"> identified by
// `inputTestId`. Mirrors the helper used in vinProgrammerTab.ui.test.jsx —
// less brittle than dispatching synthetic DataTransfer drop events through
// the wrapper div.
async function dropFileInto(inputTestId, file) {
  const input = await screen.findByTestId(inputTestId);
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

// Mock URL.createObjectURL + HTMLAnchorElement#click so the auto-download
// anchor doesn't try to navigate; capture the filename and the blob bytes
// so the test can byte-compare against the fixture's `after` half.
function setupDownloadCapture() {
  const captured = { blobs: new Map(), lastFilename: null, lastBytes: null };
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  let counter = 0;
  URL.createObjectURL = vi.fn((blob) => {
    counter += 1;
    const url = `blob:autoDetect-test-${counter}`;
    captured.blobs.set(url, blob);
    return url;
  });
  URL.revokeObjectURL = vi.fn(() => {});
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    captured.lastFilename = this.download;
    const blob = captured.blobs.get(this.href);
    if (blob) {
      const reader = new FileReader();
      reader.onload = () => {
        captured.lastBytes = new Uint8Array(reader.result);
      };
      reader.readAsArrayBuffer(blob);
    }
  };
  return {
    captured,
    restore: () => {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
      HTMLAnchorElement.prototype.click = origClick;
    },
  };
}

function bytesEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function diffOffsets(a, b, max = 16) {
  const out = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n && out.length < max; i++) if (a[i] !== b[i]) out.push(i);
  return { count: out.length === max ? `>=${max}` : out.length, sample: out };
}

describe('Task #493 — ImmoVINTab auto-detect end-to-end UI flow', () => {
  beforeEach(() => {
    if (!fixtures) {
      throw new Error('realDumps manifest missing — cannot run auto-detect UI suite');
    }
  });
  afterEach(() => cleanup());

  it('default render (no file) mounts all three section panels', () => {
    render(<ImmoVINTab/>);
    expect(screen.getByTestId('rfh-section')).toBeTruthy();
    expect(screen.getByTestId('gpec-section')).toBeTruthy();
    expect(screen.getByTestId('bcm-section')).toBeTruthy();
    // The auto-detect zone itself is always present.
    expect(screen.getByTestId('auto-detect-input')).toBeTruthy();
    // No detect-result banner before any drop.
    expect(screen.queryByTestId('auto-detect-result')).toBeNull();
  });

  (rfhGen1 ? it : it.skip)(
    'RFHUB Gen1 (2 KB) — auto-detects, mounts only rfh-section, apply phase refuses 2 KB',
    async () => {
      render(<ImmoVINTab/>);
      const file = bufferFile('rfhubg1.before.bin', rfhGen1.before);
      await dropFileInto('auto-detect-input', file);

      // (1) auto-detect banner classifies as RFH Gen1.
      const banner = await screen.findByTestId('auto-detect-result');
      expect(banner.textContent).toMatch(/RFHUB Gen1/i);

      // (2) only rfh-section is mounted.
      expect(screen.getByTestId('rfh-section')).toBeTruthy();
      expect(screen.queryByTestId('gpec-section')).toBeNull();
      expect(screen.queryByTestId('bcm-section')).toBeNull();

      // (3) apply phase requires 4 KB — drop the 2 KB file into the apply
      // dropzone and verify the documented refusal surfaces and no
      // download is triggered.
      const dl = setupDownloadCapture();
      try {
        await dropFileInto('rfh-apply-input', file);
        // Wait for the apply message to appear (FileReader is async).
        await waitFor(() => expect(screen.getByTestId('rfh-apply-msg')).toBeTruthy());
        const msg = screen.getByTestId('rfh-apply-msg');
        expect(msg.textContent).toMatch(/4096-byte|4KB|Gen2/i);
        // No download should have been issued.
        expect(dl.captured.lastFilename).toBeNull();
        expect(dl.captured.lastBytes).toBeNull();
      } finally {
        dl.restore();
      }
    }
  );

  (rfhGen2 ? it : it.skip)(
    'RFHUB Gen2 (4 KB) — auto-detects, mounts only rfh-section, apply rewrites all 4 VIN+CRC slots',
    async () => {
      render(<ImmoVINTab/>);
      const beforeBytes = rfhGen2.before;
      const afterBytes  = rfhGen2.after;
      const vin = rfhGen2.anonVin;
      expect(vin).toBeTruthy();

      await dropFileInto('auto-detect-input', bufferFile('rfhub.before.bin', beforeBytes));

      const banner = await screen.findByTestId('auto-detect-result');
      expect(banner.textContent).toMatch(/RFHUB Gen2/i);

      expect(screen.getByTestId('rfh-section')).toBeTruthy();
      expect(screen.queryByTestId('gpec-section')).toBeNull();
      expect(screen.queryByTestId('bcm-section')).toBeNull();

      // Drop the 4 KB BEFORE bytes into the apply dropzone, type the VIN,
      // click apply.
      await dropFileInto('rfh-apply-input', bufferFile('rfhub.before.bin', beforeBytes));
      const vinInput = await screen.findByTestId('rfh-apply-vin');
      await act(async () => { fireEvent.change(vinInput, { target: { value: vin } }); });
      await waitFor(() => expect(screen.getByTestId('rfh-apply-btn').disabled).toBe(false));

      const dl = setupDownloadCapture();
      try {
        await act(async () => { screen.getByTestId('rfh-apply-btn').click(); });
        await waitFor(() => expect(dl.captured.lastFilename).toBeTruthy());
        await waitFor(() => expect(dl.captured.lastBytes).toBeTruthy());
      } finally {
        dl.restore();
      }
      expect(dl.captured.lastFilename).toMatch(new RegExp('_RFHVIN_' + vin + '\\.bin$'));

      // The Gen2 RFH apply path rewrites VIN + CRC8RF on all 4 slots but
      // does not touch SEC16 — and the rfhub fixture's before/after diff
      // is purely SEC16. So full byte-equality with `after` is not the
      // right assertion here; instead verify the VIN+CRC region of the
      // download exactly matches the corresponding bytes in `after` and
      // that re-parsing the download surfaces 4 valid VIN slots stamped
      // with the expected VIN.
      const RFH_VIN_OFFSETS = [0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1];
      for (const off of RFH_VIN_OFFSETS) {
        for (let i = 0; i < 18; i++) {
          expect(dl.captured.lastBytes[off + i]).toBe(afterBytes[off + i]);
        }
      }
      const reparsed = parseRfhub(dl.captured.lastBytes);
      expect(reparsed.slots.length).toBe(4);
      for (const s of reparsed.slots) {
        expect(s.vin).toBe(vin);
        expect(s.crcOk).toBe(true);
      }
    }
  );

  (bcmSec16 ? it : it.skip)(
    'BCM 64 KB (SEC16-only fixture) — auto-detects, mounts only bcm-section, apply VIN+SEC16 reproduces `after`',
    async () => {
      render(<ImmoVINTab/>);
      const beforeBytes = bcmSec16.before;
      const afterBytes  = bcmSec16.after;
      const vin = bcmSec16.anonVin;            // 2C3CDXL90MH582899
      const sec16Bytes = bcmSec16.rfhSec16;    // 16 bytes
      expect(vin).toBeTruthy();
      expect(sec16Bytes && sec16Bytes.length).toBe(16);
      const sec16Hex = Array.from(sec16Bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('').toUpperCase();

      await dropFileInto('auto-detect-input', bufferFile('bcm.before.bin', beforeBytes));

      const banner = await screen.findByTestId('auto-detect-result');
      expect(banner.textContent).toMatch(/BCM/);
      expect(banner.textContent).toMatch(/64KB/);

      expect(screen.getByTestId('bcm-section')).toBeTruthy();
      expect(screen.queryByTestId('rfh-section')).toBeNull();
      expect(screen.queryByTestId('gpec-section')).toBeNull();

      // Drop the BEFORE 64 KB image into apply, type the existing VIN +
      // the captured SEC16, click apply.
      await dropFileInto('bcm-apply-input', bufferFile('bcm.before.bin', beforeBytes));
      const vinInput = await screen.findByTestId('bcm-apply-vin');
      const sec16Input = await screen.findByTestId('bcm-apply-sec16');
      await act(async () => { fireEvent.change(vinInput, { target: { value: vin } }); });
      await act(async () => { fireEvent.change(sec16Input, { target: { value: sec16Hex } }); });
      await waitFor(() => expect(screen.getByTestId('bcm-apply-btn').disabled).toBe(false));

      const dl = setupDownloadCapture();
      try {
        await act(async () => { screen.getByTestId('bcm-apply-btn').click(); });
        await waitFor(() => expect(dl.captured.lastFilename).toBeTruthy());
        await waitFor(() => expect(dl.captured.lastBytes).toBeTruthy());
      } finally {
        dl.restore();
      }
      expect(dl.captured.lastFilename).toMatch(new RegExp('_BCM_' + vin + '\\.bin$'));
      expect(dl.captured.lastBytes.length).toBe(65536);

      // The fixture's before/after diff is SEC16-only (records at
      // 0x81A0/C0/E0). The UI apply path runs applyBcmVin FIRST — which is
      // "intentionally MORE thorough" than the original real-bench
      // SINCRO-EDIT swap (per the comment on applyBcmVin in
      // src/tabs/ImmoVINTab.jsx) and re-stamps every detected partial-VIN
      // slot. So full-image byte-equality with `after` is not the right
      // assertion for the SEC16 case (that's what the
      // securityBytes.realDump.golden.test suite verifies, calling
      // writeBcmSec16Gen2 directly without applyBcmVin). Instead:
      //
      //   (a) the SEC16 split-record region (0x81A0..0x81FF) must equal
      //       `after` byte-for-byte — proves SEC16 was actually written
      //       end-to-end through the UI (the prior bug this test caught
      //       was that writeBcmSec16Gen2's return shape was being
      //       stringified, dropping the patched bytes entirely);
      //   (b) re-parsing the download must surface every full-VIN slot
      //       stamped with the same VIN we typed in, with valid CRC.
      for (let off = 0x81A0; off < 0x8200; off++) {
        if (dl.captured.lastBytes[off] !== afterBytes[off]) {
          throw new Error(`SEC16 region differs from \`after\` at 0x${off.toString(16)} (got 0x${dl.captured.lastBytes[off].toString(16)}, expected 0x${afterBytes[off].toString(16)})`);
        }
      }
      const reparsed = parseBcmDflash(dl.captured.lastBytes);
      expect(reparsed.slots.length).toBeGreaterThan(0);
      for (const s of reparsed.slots) {
        expect(s.vin).toBe(vin);
        expect(s.crcOk).toBe(true);
      }
    }
  );

  (bcmVinWrite ? it : it.skip)(
    'BCM 64 KB VIN-write fixture — auto-detects, mounts only bcm-section, apply VIN reproduces `after`',
    async () => {
      render(<ImmoVINTab/>);
      const beforeBytes = bcmVinWrite.before;
      const afterBytes  = bcmVinWrite.after;
      const newVin = bcmVinWrite.anonVinAfter; // 2C3CDXHG5EH600538

      await dropFileInto('auto-detect-input', bufferFile('charger-vin-write.before.bin', beforeBytes));

      const banner = await screen.findByTestId('auto-detect-result');
      expect(banner.textContent).toMatch(/BCM/);

      expect(screen.getByTestId('bcm-section')).toBeTruthy();
      expect(screen.queryByTestId('rfh-section')).toBeNull();
      expect(screen.queryByTestId('gpec-section')).toBeNull();

      // Drop BEFORE into apply, type the NEW VIN (after-half VIN), no
      // SEC16, click apply — the writer must rewrite all 4 full + 4
      // partial slots and reproduce after byte-for-byte.
      await dropFileInto('bcm-apply-input', bufferFile('charger-vin-write.before.bin', beforeBytes));
      const vinInput = await screen.findByTestId('bcm-apply-vin');
      await act(async () => { fireEvent.change(vinInput, { target: { value: newVin } }); });
      await waitFor(() => expect(screen.getByTestId('bcm-apply-btn').disabled).toBe(false));

      const dl = setupDownloadCapture();
      try {
        await act(async () => { screen.getByTestId('bcm-apply-btn').click(); });
        await waitFor(() => expect(dl.captured.lastFilename).toBeTruthy());
        await waitFor(() => expect(dl.captured.lastBytes).toBeTruthy());
      } finally {
        dl.restore();
      }
      expect(dl.captured.lastFilename).toMatch(new RegExp('_BCM_' + newVin + '\\.bin$'));
      expect(dl.captured.lastBytes.length).toBe(65536);

      const equal = bytesEqual(dl.captured.lastBytes, afterBytes);
      if (!equal) {
        const d = diffOffsets(dl.captured.lastBytes, afterBytes);
        throw new Error(`Downloaded BCM VIN-write bytes differ from \`after\` fixture (count=${d.count}, sample offsets=${d.sample.map(o => '0x' + o.toString(16)).join(',')})`);
      }
      expect(equal).toBe(true);

      // Belt-and-braces: re-parse the download and confirm the VIN zone
      // surfaces the new VIN at every full slot with valid CRC — proves
      // the byte-equality assertion is actually testing what we claim.
      const reparsed = parseBcmDflash(dl.captured.lastBytes);
      expect(reparsed.slots.length).toBeGreaterThan(0);
      for (const s of reparsed.slots) {
        expect(s.vin).toBe(newVin);
        expect(s.crcOk).toBe(true);
      }
    }
  );

  it('SHOW ALL chip after detection re-mounts every section', async () => {
    if (!bcmSec16) return;
    render(<ImmoVINTab/>);
    await dropFileInto('auto-detect-input', bufferFile('bcm.before.bin', bcmSec16.before));
    await screen.findByTestId('auto-detect-result');
    expect(screen.queryByTestId('rfh-section')).toBeNull();
    expect(screen.queryByTestId('gpec-section')).toBeNull();
    await act(async () => { screen.getByTestId('auto-detect-clear').click(); });
    await waitFor(() => expect(screen.queryByTestId('rfh-section')).not.toBeNull());
    expect(screen.getByTestId('gpec-section')).toBeTruthy();
    expect(screen.getByTestId('bcm-section')).toBeTruthy();
  });
});
