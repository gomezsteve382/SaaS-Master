// @vitest-environment jsdom
/* Task #407 — UI test for the dual-pane RFHub Key Manager.
 * Drives the tab end-to-end through the React DOM:
 *   1. Load File A (Gen2, 2 fobs) and File B (Gen2, 0 fobs).
 *   2. Send slot #0 from A → B; B becomes dirty and slot 0 occupied.
 *   3. Add Manually on B fills the next free slot (#1).
 *   4. Delete slot #0 on B clears the AA-50 marker.
 *   5. Save B downloads a patched bin (capture via URL.createObjectURL).
 *   6. Refusal path: cross-gen mismatch banner blocks Send / Copy Master.
 */
import React from 'react';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import KeyManagerTab from '../tabs/KeyManagerTab.jsx';
import { makeRfhubGen2, makeRfhubGen1 } from '../lib/__fixtures__/buildFixtures.js';

class StubFileReader {
  constructor() { this.onload = null; }
  readAsArrayBuffer(file) {
    file.arrayBuffer().then((buf) => {
      this.result = buf;
      if (this.onload) this.onload({ target: { result: buf } });
    });
  }
}

function bytesToFile(name, bytes) {
  return new File([bytes], name, { type: 'application/octet-stream' });
}

async function uploadInto(testId, file) {
  const input = screen.getByTestId(testId);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { fireEvent.change(input); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('KeyManagerTab UI (Task #407)', () => {
  let originalFR;
  let originalCreateObjectURL;
  let originalRevokeObjectURL;
  let downloads;

  beforeEach(() => {
    originalFR = globalThis.FileReader;
    globalThis.FileReader = StubFileReader;
    downloads = [];
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob) => {
      // Capture the blob so the save assertion can verify it ran.
      downloads.push({ size: blob.size, type: blob.type });
      return 'blob:stub-' + downloads.length;
    });
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    globalThis.FileReader = originalFR;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    cleanup();
  });

  it('drives the full transfer / add / delete / save loop with two Gen2 dumps', async () => {
    render(<KeyManagerTab />);

    // Layout-honesty banner is always visible.
    expect(screen.getByTestId('keymgr-layout-banner')).toBeTruthy();

    // Both panes start as drop zones.
    expect(screen.getByTestId('keymgr-pane-A-drop')).toBeTruthy();
    expect(screen.getByTestId('keymgr-pane-B-drop')).toBeTruthy();

    // Load A (Gen2, 2 fobs).
    const aBytes = makeRfhubGen2({ fobikSlots: 2 });
    await uploadInto('keymgr-pane-A-input', bytesToFile('source_A.bin', aBytes));
    await waitFor(() => expect(screen.getByTestId('keymgr-pane-A-loaded')).toBeTruthy());

    // Load B (Gen2, 0 fobs).
    const bBytes = makeRfhubGen2({ fobikSlots: 0 });
    await uploadInto('keymgr-pane-B-input', bytesToFile('target_B.bin', bBytes));
    await waitFor(() => expect(screen.getByTestId('keymgr-pane-B-loaded')).toBeTruthy());

    // Initial state: A slot 0 occupied, B slot 0 empty.
    expect(screen.getByTestId('keymgr-slot-A-0').getAttribute('data-occupied')).toBe('1');
    expect(screen.getByTestId('keymgr-slot-B-0').getAttribute('data-occupied')).toBe('0');

    // SEND A→B slot 0. The button lives on the source-row of pane A.
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-slot-A-0-send')); });
    await waitFor(() => {
      expect(screen.getByTestId('keymgr-slot-B-0').getAttribute('data-occupied')).toBe('1');
    });

    // Save B should now be enabled (B is dirty).
    const saveB = screen.getByTestId('keymgr-pane-B-save');
    expect(saveB.disabled).toBe(false);

    // Add Manually on B → fills next free slot (#1).
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-pane-B-add-manual')); });
    await waitFor(() => {
      expect(screen.getByTestId('keymgr-slot-B-1').getAttribute('data-occupied')).toBe('1');
    });

    // Delete slot #0 on B.
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-slot-B-0-delete')); });
    await waitFor(() => {
      expect(screen.getByTestId('keymgr-slot-B-0').getAttribute('data-occupied')).toBe('0');
    });

    // Copy Master from A → B. A pane's "copy-master" button copies FROM B INTO A
    // (label says "Copy Master ← B"); we need pane B's button which copies from A.
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-pane-B-copy-master')); });

    // Save B → triggers downloadBin → URL.createObjectURL captured.
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-pane-B-save')); });
    expect(downloads.length).toBe(1);
    expect(downloads[0].size).toBe(bBytes.length);

    // Activity log carries pass / error rows.
    const logRows = screen.getAllByTestId(/^keymgr-log-row-/);
    expect(logRows.length).toBeGreaterThan(0);
    const passRows = logRows.filter(r => r.getAttribute('data-log-type') === 'pass');
    expect(passRows.length).toBeGreaterThan(0);
  });

  it('refuses Send / Copy Master across Gen1 ↔ Gen2 and surfaces the mismatch banner', async () => {
    render(<KeyManagerTab />);

    await uploadInto('keymgr-pane-A-input', bytesToFile('gen2.bin', makeRfhubGen2({})));
    await uploadInto('keymgr-pane-B-input', bytesToFile('gen1.bin', makeRfhubGen1()));

    await waitFor(() => expect(screen.getByTestId('keymgr-gen-mismatch')).toBeTruthy());

    // Send button on A is disabled when other pane is loaded with mismatched gen.
    const sendA0 = screen.getByTestId('keymgr-slot-A-0-send');
    expect(sendA0.disabled).toBe(true);

    // Copy Master button is also disabled.
    const copyMasterB = screen.getByTestId('keymgr-pane-B-copy-master');
    expect(copyMasterB.disabled).toBe(true);
  });

  it('writes a snapshot + enriched audit-log row per Add/Delete/Transfer/Copy-Master and surfaces them in View History (Task #410)', async () => {
    /* Pre-clear the keymgr audit ring buffer so the assertions are stable
     * across runs that share the jsdom localStorage instance. */
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch {}
    try { globalThis.localStorage?.removeItem('srtlab_backup_index'); } catch {}

    /* Stub fetch so writeKeymgrSnapshot's POST /api/backups returns ok and
     * we can count the per-edit snapshot writes. */
    const fetchCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({}) };
    });

    try {
      render(<KeyManagerTab />);

      const aBytes = makeRfhubGen2({ fobikSlots: 2 });
      const bBytes = makeRfhubGen2({ fobikSlots: 0 });
      await uploadInto('keymgr-pane-A-input', bytesToFile('source_A.bin', aBytes));
      await uploadInto('keymgr-pane-B-input', bytesToFile('target_B.bin', bBytes));
      await waitFor(() => expect(screen.getByTestId('keymgr-pane-B-loaded')).toBeTruthy());

      // Drive a successful transfer (Send A → B, slot 0). The pane state
      // commits synchronously inside the React batch, but the snapshot POST
      // + audit row land on the next microtask wave — so we wait for the
      // audit ring buffer (the canonical record), not just data-occupied.
      await act(async () => { fireEvent.click(screen.getByTestId('keymgr-slot-A-0-send')); });
      await waitFor(() => {
        expect(screen.getByTestId('keymgr-slot-B-0').getAttribute('data-occupied')).toBe('1');
        const a = JSON.parse(globalThis.localStorage.getItem('srt-lab.keymgr.audit.v1') || '[]');
        expect(a.some(e => e.op?.includes('transfer slot #0 from A') && e.ok === true)).toBe(true);
      });

      // Follow up with a delete on the freshly-occupied slot so the audit
      // trail picks up an AA50 → FFFF transition row to assert against.
      await act(async () => { fireEvent.click(screen.getByTestId('keymgr-slot-B-0-delete')); });
      await waitFor(() => {
        expect(screen.getByTestId('keymgr-slot-B-0').getAttribute('data-occupied')).toBe('0');
        const a = JSON.parse(globalThis.localStorage.getItem('srt-lab.keymgr.audit.v1') || '[]');
        expect(a.some(e => e.op?.includes('delete slot #0') && e.ok === true)).toBe(true);
      });

      // The audit log must now carry both rows (success + the prior load entry).
      const audit = JSON.parse(globalThis.localStorage.getItem('srt-lab.keymgr.audit.v1') || '[]');
      const transfer = audit.find(e => e.op?.includes('transfer slot #0 from A') && e.ok === true);
      expect(transfer).toBeTruthy();
      expect(transfer.slotIdx).toBe(0);
      expect(transfer.markerBefore).toBe('FFFF');
      expect(transfer.markerAfter).toBe('AA50');
      expect(transfer.snapshotKey).toMatch(/^srtlab_backup_RFHUB_/);
      expect(Array.isArray(transfer.sec16Cs)).toBe(true);
      // file hash may be null in jsdom envs without crypto.subtle; if present
      // it should be a 64-char hex string.
      if (transfer.fileHash) expect(transfer.fileHash).toMatch(/^[0-9a-f]{64}$/);

      const del = audit.find(e => e.op?.includes('delete slot #0') && e.ok === true);
      expect(del).toBeTruthy();
      expect(del.markerBefore).toBe('AA50');
      expect(del.markerAfter).toBe('FFFF');

      // Per-edit snapshots must POST through /api/backups (same store the
      // rest of the app uses) — at least one keymgr-edit POST per success.
      const editPosts = fetchCalls.filter(c =>
        c.url === '/api/backups' && c.body?.snapshotKind === 'keymgr-edit');
      expect(editPosts.length).toBeGreaterThanOrEqual(2);

      // View History modal opens filtered for the loaded filename.
      await act(async () => { fireEvent.click(screen.getByTestId('keymgr-pane-B-view-history')); });
      const filterLine = screen.getByTestId('keymgr-history-filter');
      expect(filterLine.textContent).toMatch(/target_B\.bin/);
      const rows = screen.getAllByTestId(/^keymgr-history-row-/);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      // Refusal rows render with data-ok="0".
      const okRows = rows.filter(r => r.getAttribute('data-ok') === '1');
      expect(okRows.length).toBeGreaterThanOrEqual(2);

      // Closing the modal removes it.
      await act(async () => { fireEvent.click(screen.getByTestId('keymgr-history-close')); });
      expect(screen.queryByTestId('keymgr-history-modal')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('records refusals (ok:false) with op so a refused click is still in the trail (Task #410)', async () => {
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch {}
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    try {
      render(<KeyManagerTab />);
      await uploadInto('keymgr-pane-A-input', bytesToFile('full.bin', makeRfhubGen2({ fobikSlots: 4 })));
      await waitFor(() => expect(screen.getByTestId('keymgr-pane-A-loaded')).toBeTruthy());
      // All 4 slots occupied → Add Manually is refused with "no free slot".
      await act(async () => { fireEvent.click(screen.getByTestId('keymgr-pane-A-add-manual')); });

      const audit = JSON.parse(globalThis.localStorage.getItem('srt-lab.keymgr.audit.v1') || '[]');
      const refusal = audit.find(e => e.ok === false && e.op?.includes('first-free'));
      expect(refusal).toBeTruthy();
      expect(refusal.error).toBe('no free slot');
      expect(refusal.filename).toBe('full.bin');
      expect(refusal.vin).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses an edit and leaves pane bytes untouched when both remote and local snapshot persistence fail (Task #410)', async () => {
    try { globalThis.localStorage?.removeItem('srt-lab.keymgr.audit.v1'); } catch {}
    /* Force remote persistence to fail (res.ok=false) AND local persistence
     * to throw. The applied result must NOT mutate pane bytes — slot 0 must
     * stay occupied — and the audit row must be ok:false. */
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) {
      // Allow the audit ring write so the refusal row can be observed.
      if (k === 'srt-lab.keymgr.audit.v1') {
        return originalSetItem.call(this, k, v);
      }
      // Block backup snapshot writes (key + index) so persisted=false.
      if (k.startsWith('srtlab_backup_')) {
        throw new Error('quota exceeded (simulated)');
      }
      return originalSetItem.call(this, k, v);
    });
    try {
      render(<KeyManagerTab />);
      await uploadInto('keymgr-pane-A-input', bytesToFile('persist_fail.bin', makeRfhubGen2({ fobikSlots: 2 })));
      await waitFor(() => expect(screen.getByTestId('keymgr-pane-A-loaded')).toBeTruthy());
      // Slot 0 starts occupied because makeRfhubGen2 fills fobikSlots.
      expect(screen.getByTestId('keymgr-slot-A-0').getAttribute('data-occupied')).toBe('1');

      await act(async () => { fireEvent.click(screen.getByTestId('keymgr-slot-A-0-delete')); });
      // Audit row must reflect a refusal — wait for it to land.
      await waitFor(() => {
        const a = JSON.parse(globalThis.localStorage.getItem('srt-lab.keymgr.audit.v1') || '[]');
        expect(a.some(e => e.ok === false && e.error === 'snapshot persistence failed')).toBe(true);
      });
      // CRITICAL: pane bytes must NOT have been mutated — slot stays occupied.
      expect(screen.getByTestId('keymgr-slot-A-0').getAttribute('data-occupied')).toBe('1');
      const audit = JSON.parse(globalThis.localStorage.getItem('srt-lab.keymgr.audit.v1') || '[]');
      const refusal = audit.find(e => e.ok === false && e.error === 'snapshot persistence failed');
      expect(refusal.savedRemote).toBe(false);
      expect(refusal.savedLocal).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      setItemSpy.mockRestore();
    }
  });

  it('logs KEYMOD REFUSED in red when adding to an already-occupied slot', async () => {
    render(<KeyManagerTab />);
    await uploadInto('keymgr-pane-A-input', bytesToFile('a.bin', makeRfhubGen2({ fobikSlots: 4 })));
    await waitFor(() => expect(screen.getByTestId('keymgr-pane-A-loaded')).toBeTruthy());

    // All 4 slots occupied → Add Manually has no free slot.
    await act(async () => { fireEvent.click(screen.getByTestId('keymgr-pane-A-add-manual')); });
    const errRows = screen.getAllByTestId(/^keymgr-log-row-/).filter(r => r.getAttribute('data-log-type') === 'error');
    expect(errRows.length).toBeGreaterThan(0);
    expect(errRows[0].textContent).toMatch(/KEYMOD REFUSED/);
  });
});
