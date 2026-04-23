/* Task #394 — saved Key Prog archive history must round-trip through the
 * project database the same way module backups and diff reports do, so a
 * locksmith who downloads a ZIP on the shop laptop sees that row when they
 * later open SRT Lab on their bench tablet. */
import { describe, it, expect, beforeEach, vi } from 'vitest';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i) => Array.from(store.keys())[i] || null,
    get length() { return store.size; },
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    localStorage: globalThis.localStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}

import {
  STORAGE_KEY,
  MIGRATED_KEY,
  loadArchives,
  recordArchive,
  deleteArchive,
  clearArchives,
  refreshArchivesFromServer,
  exportArchives,
  importArchives,
} from '../keyProgArchiveHistory.js';

function resetStorage() {
  globalThis.localStorage.clear();
}

beforeEach(() => {
  resetStorage();
  vi.restoreAllMocks();
});

describe('keyProgArchiveHistory server sync (Task #394)', () => {
  it('recordArchive writes through to the API and keeps a local copy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock;

    const entry = recordArchive({
      vin: '1ABC23DEFGH456789',
      zipName: 'KEYPROG_1ABC23DEFGH456789.zip',
      bcmSec16: { source: 'split', label: 'split @0x81A0', blank: false, offsetHex: '0x81A0', beHex: 'AB' },
    });

    expect(loadArchives()).toHaveLength(1);
    expect(loadArchives()[0].id).toBe(entry.id);
    // Allow the fire-and-forget POST to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/key-prog-archives');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.id).toBe(entry.id);
    expect(body.bcmSec16.source).toBe('split');
  });

  it('deleteArchive and clearArchives notify the API', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const a = recordArchive({ vin: 'X', zipName: 'a.zip' });
    const b = recordArchive({ vin: 'Y', zipName: 'b.zip' });
    globalThis.fetch.mockClear();

    deleteArchive(a.id);
    expect(loadArchives().some((x) => x.id === a.id)).toBe(false);
    expect(loadArchives().some((x) => x.id === b.id)).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/key-prog-archives/' + encodeURIComponent(a.id),
      expect.objectContaining({ method: 'DELETE' }),
    );

    globalThis.fetch.mockClear();
    clearArchives();
    expect(loadArchives()).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/key-prog-archives',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('refreshArchivesFromServer overwrites the local cache with the server list', async () => {
    const serverArchives = [
      { id: 'kpa_remote_1', vin: 'V1', zipName: 'r1.zip', savedAt: '2026-04-23T12:00:00.000Z', bcmSec16: null },
      { id: 'kpa_remote_2', vin: 'V2', zipName: 'r2.zip', savedAt: '2026-04-23T11:00:00.000Z', bcmSec16: { source: 'flat', label: 'flat @0x40C9 (legacy)', blank: false } },
    ];
    // Seed something local-only so we can confirm the server list wins.
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      archives: [{ id: 'kpa_local_only', vin: 'L', zipName: 'l.zip', savedAt: '2026-04-22T00:00:00Z', bcmSec16: null }],
    }));
    // Mark migration done so the local-only entry is NOT pushed up — the
    // canonical server list should still take over the cache.
    globalThis.localStorage.setItem(MIGRATED_KEY, '1');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ archives: serverArchives }),
    });

    const list = await refreshArchivesFromServer();
    expect(list.map((a) => a.id)).toEqual(['kpa_remote_1', 'kpa_remote_2']);
    expect(loadArchives().map((a) => a.id)).toEqual(['kpa_remote_1', 'kpa_remote_2']);
  });

  it('migrates local-only entries to the server on first refresh', async () => {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      archives: [
        { id: 'kpa_local_a', vin: 'A', zipName: 'a.zip', savedAt: '2026-04-22T00:00:00Z', bcmSec16: null },
        { id: 'kpa_local_b', vin: 'B', zipName: 'b.zip', savedAt: '2026-04-22T01:00:00Z', bcmSec16: null },
      ],
    }));

    let serverRows = [];
    const fetchMock = vi.fn(async (url, opts) => {
      if (!opts || opts.method == null || opts.method === 'GET') {
        return { ok: true, json: async () => ({ archives: serverRows }) };
      }
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        serverRows.unshift({ ...body });
        return { ok: true, json: async () => ({ ok: true, id: body.id }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    globalThis.fetch = fetchMock;

    const list = await refreshArchivesFromServer();
    const ids = list.map((a) => a.id).sort();
    expect(ids).toEqual(['kpa_local_a', 'kpa_local_b']);
    // Migration marker is set after a clean run so we don't re-push every time.
    expect(globalThis.localStorage.getItem(MIGRATED_KEY)).toBeTruthy();
  });

  it('keeps unsynced local entries in cache and retries successfully on the next refresh after a POST fails', async () => {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      archives: [{ id: 'kpa_unstable', vin: 'A', zipName: 'a.zip', savedAt: '2026-04-22T00:00:00Z', bcmSec16: null }],
    }));

    let postOk = false;
    let serverRows = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      if (!opts || opts.method == null || opts.method === 'GET') {
        return { ok: true, json: async () => ({ archives: serverRows }) };
      }
      if (opts.method === 'POST') {
        if (!postOk) {
          // First attempt fails — migration marker must stay unset and
          // the unsynced entry must remain in the local cache so the
          // next refresh can retry it.
          return { ok: false, json: async () => ({ error: 'boom' }) };
        }
        const body = JSON.parse(opts.body);
        serverRows.unshift({ ...body });
        return { ok: true, json: async () => ({ ok: true, id: body.id }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    // First refresh: POST fails. Marker stays unset and the entry is
    // still in local cache so a future retry has something to push.
    const firstList = await refreshArchivesFromServer();
    expect(globalThis.localStorage.getItem(MIGRATED_KEY)).toBeNull();
    expect(firstList.some((a) => a.id === 'kpa_unstable')).toBe(true);
    expect(loadArchives().some((a) => a.id === 'kpa_unstable')).toBe(true);

    // Second refresh: POST succeeds. The retry pushes the entry, the
    // marker is set, and the canonical server list contains it.
    postOk = true;
    const secondList = await refreshArchivesFromServer();
    expect(secondList.some((a) => a.id === 'kpa_unstable')).toBe(true);
    expect(globalThis.localStorage.getItem(MIGRATED_KEY)).toBeTruthy();
    expect(serverRows.some((a) => a.id === 'kpa_unstable')).toBe(true);
  });

  it('exportArchives + importArchives round-trip preserves entries and skips duplicates', () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const a = recordArchive({ vin: 'A', zipName: 'a.zip' });
    const b = recordArchive({ vin: 'B', zipName: 'b.zip', bcmSec16: { source: 'split', label: 'split @0x81A0', blank: false } });

    const bundle = exportArchives();
    expect(bundle.archives).toHaveLength(2);
    expect(bundle.type).toBe('srtlab_keyprog_archive_v1');

    // Wipe local + re-import — both should come back; second import is a no-op.
    resetStorage();
    const r1 = importArchives(bundle);
    expect(r1.imported).toBe(2);
    expect(r1.skipped).toBe(0);
    expect(loadArchives().map((x) => x.id).sort()).toEqual([a.id, b.id].sort());

    const r2 = importArchives(bundle);
    expect(r2.imported).toBe(0);
    expect(r2.skipped).toBe(2);
  });

  it('importArchives accepts a backup-style bundle with embedded keyProgArchives field', () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const r = importArchives({
      type: 'srtlab_backup_archive',
      keyProgArchives: [
        { id: 'kpa_from_backup', vin: 'X', zipName: 'x.zip', savedAt: '2026-04-23T00:00:00Z', bcmSec16: null },
      ],
    });
    expect(r.imported).toBe(1);
    expect(loadArchives()[0].id).toBe('kpa_from_backup');
  });
});
