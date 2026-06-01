// @vitest-environment jsdom
/* ============================================================================
 * keyHistorySync.test.js — Task #991
 *
 * Per-vehicle key history must round-trip through the project database so the
 * captured-key list survives a browser-data wipe and shows up on a second
 * bench laptop for the same VIN. localStorage stays an offline cache that
 * mirrors the server. These tests exercise the server-sync layer:
 *   - saveKeyToHistory writes through to the API and keeps a local copy
 *   - removeKeyFromHistory / clearKeyHistory propagate deletes to the server
 *   - refreshKeyHistoryFromServer hydrates from the server, migrates local-only
 *     entries once, and falls back to the local cache when the server is down
 * ========================================================================== */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveKeyToHistory,
  removeKeyFromHistory,
  clearKeyHistory,
  loadKeyHistory,
  refreshKeyHistoryFromServer,
  KEY_HISTORY_KEY,
  KEY_HISTORY_MIGRATED_PREFIX,
} from '../keyWriter/keyHistory.js';

const VIN_A = '2C3CDXL95KH123456';

const baseRecord = {
  chipId: 'id46',
  uidHex: '00 77 A2 9B',
  skHex: '4F 4E 4D 49 4B 52',
  flags: { locked: false, cloneable: true },
  label: 'spare fob #2',
  slotIdx: 1,
};

beforeEach(() => {
  globalThis.localStorage?.removeItem(KEY_HISTORY_KEY);
  globalThis.localStorage?.removeItem(`${KEY_HISTORY_MIGRATED_PREFIX}${VIN_A}`);
  vi.restoreAllMocks();
});

describe('saveKeyToHistory server write-through', () => {
  it('POSTs the entry to /api/key-history and keeps a local copy', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock;

    const res = saveKeyToHistory(VIN_A, baseRecord);
    expect(res.ok).toBe(true);
    expect(loadKeyHistory(VIN_A)).toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/key-history');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.vin).toBe(VIN_A);
    expect(body.id).toBe(res.entry.id);
    expect(body.chipId).toBe('id46');
    expect(typeof body.capturedAt).toBe('number');
  });

  it('still succeeds locally when the server write fails', () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const res = saveKeyToHistory(VIN_A, baseRecord);
    expect(res.ok).toBe(true);
    expect(loadKeyHistory(VIN_A)).toHaveLength(1);
  });
});

describe('delete propagation', () => {
  it('removeKeyFromHistory DELETEs the entry by id', () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const saved = saveKeyToHistory(VIN_A, baseRecord);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock;

    const res = removeKeyFromHistory(VIN_A, saved.entry.id);
    expect(res.ok).toBe(true);
    expect(loadKeyHistory(VIN_A)).toHaveLength(0);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/key-history/${encodeURIComponent(saved.entry.id)}`);
    expect(opts.method).toBe('DELETE');
  });

  it('clearKeyHistory DELETEs the whole VIN scope', () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    saveKeyToHistory(VIN_A, baseRecord);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock;

    const res = clearKeyHistory(VIN_A);
    expect(res.ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/key-history?vin=${encodeURIComponent(VIN_A)}`);
    expect(opts.method).toBe('DELETE');
  });
});

describe('refreshKeyHistoryFromServer', () => {
  it('hydrates the local cache from server rows (cross-device)', async () => {
    const serverRow = {
      id: 'keyh-server-1',
      vin: VIN_A,
      chipId: 'id48',
      uidHex: 'AA BB CC DD',
      skHex: '11 22 33',
      flags: { cloneable: true },
      label: 'from other laptop',
      slotIdx: 2,
      capturedAt: 1700000000000,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [serverRow] }),
    });

    const list = await refreshKeyHistoryFromServer(VIN_A);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('keyh-server-1');
    expect(list[0].label).toBe('from other laptop');
    expect(list[0].capturedAt).toBe(1700000000000);
    // local cache was refreshed
    expect(loadKeyHistory(VIN_A)).toHaveLength(1);
  });

  it('migrates a local-only entry up to the server on first run', async () => {
    // Seed a local-only entry without contacting the server.
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const saved = saveKeyToHistory(VIN_A, baseRecord);
    expect(loadKeyHistory(VIN_A)).toHaveLength(1);

    const posted = [];
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === 'POST') {
        posted.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      // GET: first call returns empty server, later calls return migrated rows
      return Promise.resolve({ ok: true, json: async () => ({ entries: posted.map((p) => p) }) });
    });

    const list = await refreshKeyHistoryFromServer(VIN_A);
    expect(posted).toHaveLength(1);
    expect(posted[0].id).toBe(saved.entry.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(saved.entry.id);
    // marker set so a second refresh does not re-migrate
    expect(globalThis.localStorage.getItem(`${KEY_HISTORY_MIGRATED_PREFIX}${VIN_A}`)).toBeTruthy();
  });

  it('falls back to the local cache when the server is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    saveKeyToHistory(VIN_A, baseRecord);
    const list = await refreshKeyHistoryFromServer(VIN_A);
    expect(list).toHaveLength(1);
  });

  it('returns [] for an invalid VIN without hitting the network', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const list = await refreshKeyHistoryFromServer('bad-vin');
    expect(list).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
