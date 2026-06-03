// @vitest-environment jsdom
/* ============================================================================
 * charKeyAddVerification.test.js
 *
 * The before/after self-check records a clean single-add confirmation so the
 * Offline Key Adder can soften its "NOT BENCH-VERIFIED" caveat. These tests
 * cover the pure verdict gate + record builder, the localStorage round-trip
 * (survives refresh), best-effort server write-through, and the
 * refresh-from-server hydration + first-run migration of local-only rows.
 * ========================================================================== */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CHAR_MPC_8SLOT_LAYOUT,
  KEY_ADD_VERIFY_KEY,
  KEY_ADD_VERIFY_MIGRATED_PREFIX,
  KEY_ADD_VERIFY_EVENT,
  isVerifiableCleanAdd,
  buildVerification,
  saveVerification,
  loadVerifications,
  isLayoutVerified,
  clearVerifications,
  refreshVerificationsFromServer,
} from '../charKeyAddVerification.js';

function cleanDiff(over = {}) {
  return {
    ok: true,
    isSingleKeyAdd: true,
    addedSlotMatchesRule: true,
    masterChanged: false,
    expectedSlotIdx: 4,
    beforeKeyCount: 5,
    afterKeyCount: 6,
    companionRegions: [],
    addedKeys: [{ keyId: 'BCD2EB9B', slot: 5, slotIdx: 4 }],
    removedKeys: [],
    ...over,
  };
}

beforeEach(() => {
  globalThis.localStorage?.removeItem(KEY_ADD_VERIFY_KEY);
  globalThis.localStorage?.removeItem(`${KEY_ADD_VERIFY_MIGRATED_PREFIX}${CHAR_MPC_8SLOT_LAYOUT}`);
  vi.restoreAllMocks();
});

describe('isVerifiableCleanAdd', () => {
  it('accepts a clean single key-add', () => {
    expect(isVerifiableCleanAdd(cleanDiff())).toBe(true);
  });
  it('rejects a master-secret change', () => {
    expect(isVerifiableCleanAdd(cleanDiff({ masterChanged: true, isSingleKeyAdd: false }))).toBe(false);
  });
  it('rejects a companion-region change', () => {
    expect(isVerifiableCleanAdd(cleanDiff({ companionRegions: [{ start: 0x400, end: 0x401 }] }))).toBe(false);
  });
  it('rejects a slot-rule mismatch', () => {
    expect(isVerifiableCleanAdd(cleanDiff({ addedSlotMatchesRule: false }))).toBe(false);
  });
  it('rejects a non-ok diff and null', () => {
    expect(isVerifiableCleanAdd(cleanDiff({ ok: false }))).toBe(false);
    expect(isVerifiableCleanAdd(null)).toBe(false);
  });
});

describe('buildVerification', () => {
  it('captures the added key, slot, and counts from a clean diff', () => {
    const v = buildVerification(cleanDiff(), { beforeName: 'b.bin', afterName: 'a.bin' });
    expect(v).toMatchObject({
      layout: CHAR_MPC_8SLOT_LAYOUT,
      addedKeyId: 'BCD2EB9B',
      slot: 5,
      slotIdx: 4,
      expectedSlotIdx: 4,
      beforeKeyCount: 5,
      afterKeyCount: 6,
      beforeName: 'b.bin',
      afterName: 'a.bin',
    });
    expect(typeof v.confirmedAt).toBe('number');
    expect(v.id).toBeTruthy();
  });
  it('returns null for a non-clean diff', () => {
    expect(buildVerification(cleanDiff({ masterChanged: true, isSingleKeyAdd: false }))).toBeNull();
  });
});

describe('saveVerification + localStorage round-trip', () => {
  it('persists a clean confirmation and flips isLayoutVerified', () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    expect(isLayoutVerified()).toBe(false);

    const r = saveVerification(cleanDiff(), { beforeName: 'b.bin', afterName: 'a.bin' });
    expect(r.ok).toBe(true);
    expect(isLayoutVerified()).toBe(true);
    expect(loadVerifications()).toHaveLength(1);
    expect(loadVerifications()[0].addedKeyId).toBe('BCD2EB9B');
  });

  it('refuses to persist a non-clean pair', () => {
    const r = saveVerification(cleanDiff({ companionRegions: [{ start: 1, end: 2 }] }));
    expect(r.ok).toBe(false);
    expect(isLayoutVerified()).toBe(false);
  });

  it('POSTs to /api/key-add-verifications and fires the change event', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock;
    const onChanged = vi.fn();
    globalThis.addEventListener(KEY_ADD_VERIFY_EVENT, onChanged);

    const r = saveVerification(cleanDiff());
    expect(r.ok).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/key-add-verifications');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.layout).toBe(CHAR_MPC_8SLOT_LAYOUT);
    expect(body.addedKeyId).toBe('BCD2EB9B');
    expect(typeof body.confirmedAt).toBe('number');

    expect(onChanged).toHaveBeenCalledTimes(1);
    globalThis.removeEventListener(KEY_ADD_VERIFY_EVENT, onChanged);
  });

  it('keeps the confirmation across a simulated reload (reads the same store)', () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    saveVerification(cleanDiff());
    // A fresh read (as a reloaded page would do) still sees it in localStorage.
    expect(isLayoutVerified()).toBe(true);
  });
});

describe('clearVerifications', () => {
  it('drops the layer and DELETEs server-side', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock;
    saveVerification(cleanDiff());
    expect(isLayoutVerified()).toBe(true);

    const r = clearVerifications();
    expect(r.ok).toBe(true);
    expect(isLayoutVerified()).toBe(false);
    const deleteCall = fetchMock.mock.calls.find(([, o]) => o?.method === 'DELETE');
    expect(deleteCall[0]).toContain('/api/key-add-verifications?layout=');
  });
});

describe('refreshVerificationsFromServer', () => {
  it('hydrates the local cache from the server', async () => {
    const serverRow = {
      id: 'kav-server-1',
      layout: CHAR_MPC_8SLOT_LAYOUT,
      addedKeyId: 'AABBCCDD',
      slot: 6,
      slotIdx: 5,
      expectedSlotIdx: 5,
      beforeKeyCount: 3,
      afterKeyCount: 4,
      beforeName: '',
      afterName: '',
      confirmedAt: 1_700_000_000_000,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [serverRow] }),
    });

    const list = await refreshVerificationsFromServer();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('kav-server-1');
    expect(loadVerifications()[0].addedKeyId).toBe('AABBCCDD');
  });

  it('migrates a local-only confirmation up exactly once', async () => {
    // Seed a local-only row (server initially empty).
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    saveVerification(cleanDiff());
    const localId = loadVerifications()[0].id;

    const posts = [];
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === 'POST') {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      // GET returns whatever has been migrated so far.
      return Promise.resolve({ ok: true, json: async () => ({ entries: posts }) });
    });

    const list = await refreshVerificationsFromServer();
    expect(posts.some((p) => p.id === localId)).toBe(true);
    expect(list.some((e) => e.id === localId)).toBe(true);

    // Second refresh does not re-POST (migration marker set).
    const before = posts.length;
    await refreshVerificationsFromServer();
    expect(posts.length).toBe(before);
  });

  it('falls back to the local cache when the server is unreachable', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    saveVerification(cleanDiff());
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const list = await refreshVerificationsFromServer();
    expect(list).toHaveLength(1);
  });
});
