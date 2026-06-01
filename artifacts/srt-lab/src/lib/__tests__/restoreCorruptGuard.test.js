import { describe, it, expect, vi, beforeEach } from 'vitest';
import { backupCorruptFill, restoreModule, importBackups, backupModule } from '../audit.js';

/* The corrupt-read guard in backupModule (Task #968) runs before any
 * persistence, so we stub readDidsBatched to feed it a controlled read result
 * (a Map keyed by DID -> { ok, data }) without standing up the real batched
 * UDS plumbing. */
const mockReadDidsBatched = vi.fn();
vi.mock('../uds.js', () => ({
  readDidsBatched: (...args) => mockReadDidsBatched(...args),
}));

/**
 * Block restoring a corrupt backup onto a live module.
 *
 * Corrupt captures are refused at upload, but a backup created before that
 * fix — or imported from an older archive — could still hold a tool-error
 * capture. These tests prove:
 *   1. backupCorruptFill flags tool-error payloads and clears clean ones.
 *   2. restoreModule refuses to emit a single UDS 0x2E frame for a corrupt
 *      backup (last-line defense, fires even without the UI banner).
 *   3. importBackups treats corrupt archive entries as invalid so they are
 *      never listed as restorable.
 */

beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    key: i => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  globalThis.window = globalThis.window || { dispatchEvent: () => {} };
  if (!globalThis.window.dispatchEvent) globalThis.window.dispatchEvent = () => {};
});

/* A DID payload of 64 bytes all 0x55 — the OBDSTAR single-byte tool-error
 * pattern. 0xFF / 0x00 are deliberately excluded by detectCorruptFill (virgin
 * reads), so 0x55 is the canonical corrupt-fill marker. */
const corruptBytes = new Array(64).fill(0x55);

function corruptBackup() {
  return {
    module: 'BCM', tx: 0x7B0, rx: 0x7B8, timestamp: new Date().toISOString(),
    dids: {
      0xF1A0: { name: 'BCM Config', critical: true, hex: '', bytes: corruptBytes },
    },
  };
}

function cleanBackup() {
  const vin = Array.from('1C6SRFKT5MN500000').map(c => c.charCodeAt(0));
  return {
    module: 'BCM', tx: 0x7B0, rx: 0x7B8, timestamp: new Date().toISOString(),
    dids: {
      0xF190: { name: 'VIN', critical: true, hex: '', ascii: '1C6SRFKT5MN500000', bytes: vin },
    },
  };
}

describe('backupCorruptFill', () => {
  it('flags a single-byte tool-error fill', () => {
    const cf = backupCorruptFill(corruptBackup());
    expect(cf).toBeTruthy();
    expect(cf.corruptFill).toBe(true);
  });

  it('returns null for a clean backup', () => {
    expect(backupCorruptFill(cleanBackup())).toBeNull();
  });

  it('returns null for a missing / shapeless backup', () => {
    expect(backupCorruptFill(null)).toBeNull();
    expect(backupCorruptFill({})).toBeNull();
  });
});

describe('restoreModule corrupt guard', () => {
  it('refuses a corrupt backup and emits no UDS frames', async () => {
    const uds = vi.fn(async () => ({ ok: true, d: [0x6E] }));
    const logs = [];
    const ok = await restoreModule(uds, 0x7B0, 0x7B8, corruptBackup(), (m, t) => logs.push({ m, type: t }), true);
    expect(ok).toBe(false);
    expect(uds).not.toHaveBeenCalled();
    expect(logs.some(l => l.type === 'error' && /tool-error|refused/i.test(l.m))).toBe(true);
  });

  it('still restores a clean backup (guard does not over-fire)', async () => {
    const uds = vi.fn(async () => ({ ok: true, d: [0x6E] }));
    const ok = await restoreModule(uds, 0x7B0, 0x7B8, cleanBackup(), () => {}, true);
    expect(ok).toBe(true);
    expect(uds).toHaveBeenCalled();
  });
});

describe('backupModule corrupt-read guard', () => {
  const engUds = vi.fn(async () => ({ ok: true, d: [0x6E] }));

  beforeEach(() => {
    mockReadDidsBatched.mockReset();
    engUds.mockClear();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }));
  });

  it('discards a corrupt live read and never persists it to the vault', async () => {
    /* Every DID comes back as a 64-byte 0x55 fill — a tool-error capture. */
    mockReadDidsBatched.mockImplementation(async (_e, _tx, _rx, dids) => {
      const m = new Map();
      for (const did of dids) m.set(did, { ok: true, data: corruptBytes });
      return m;
    });
    const logs = [];
    const backup = await backupModule(engUds, 0x7B0, 0x7B8, 'BCM', (m, t) => logs.push({ m, type: t }));

    expect(backup.corrupt).toBeTruthy();
    expect(backup.corrupt.corruptFill).toBe(true);
    expect(logs.some(l => l.type === 'error' && /tool-error|NOT saved|corrupt/i.test(l.m))).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const idx = JSON.parse(localStorage.getItem('srtlab_backup_index') || '[]');
    expect(idx.length).toBe(0);
  });

  it('persists a clean live read as normal (guard does not over-fire)', async () => {
    const vin = Array.from('1C6SRFKT5MN500000').map(c => c.charCodeAt(0));
    mockReadDidsBatched.mockImplementation(async (_e, _tx, _rx, dids) => {
      const m = new Map();
      for (const did of dids) {
        m.set(did, did === 0xF190 ? { ok: true, data: vin } : { ok: false, data: null });
      }
      return m;
    });
    const backup = await backupModule(engUds, 0x7B0, 0x7B8, 'BCM', () => {});

    expect(backup.corrupt).toBeUndefined();
    expect(backup.checksum).toBeDefined();
    const idx = JSON.parse(localStorage.getItem('srtlab_backup_index') || '[]');
    expect(idx.length).toBe(1);
  });
});

describe('importBackups corrupt guard', () => {
  it('counts corrupt entries as invalid and does not list them as restorable', () => {
    const corruptKey = 'srtlab_backup_BCM_unknown_9999';
    const cleanKey = 'srtlab_backup_BCM_1C6SRFKT5MN500000_8888';
    const archive = {
      type: 'srtlab_backup_archive',
      version: 1,
      index: [],
      backups: {
        [corruptKey]: corruptBackup(),
        [cleanKey]: cleanBackup(),
      },
    };
    const result = importBackups(archive);
    expect(result.invalid).toBe(1);
    expect(result.imported).toBe(1);
    const idx = JSON.parse(localStorage.getItem('srtlab_backup_index') || '[]');
    expect(idx.some(e => e.key === corruptKey)).toBe(false);
    expect(idx.some(e => e.key === cleanKey)).toBe(true);
  });
});
