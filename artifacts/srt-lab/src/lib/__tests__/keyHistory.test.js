// @vitest-environment jsdom
/* ============================================================================
 * keyHistory.test.js — Task #986
 *
 * Per-vehicle key history persistence for the Key Dump card:
 *   - normalizeVin rejects partial/garbage VINs
 *   - upsertEntry / removeEntryById pure reducers (insert, de-dupe, cap, sort)
 *   - loadKeyHistory / saveKeyToHistory / removeKeyFromHistory / clearKeyHistory
 *     round-trip through localStorage, scoped per VIN
 * ========================================================================== */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeVin,
  makeHistoryEntry,
  upsertEntry,
  removeEntryById,
  loadKeyHistory,
  saveKeyToHistory,
  removeKeyFromHistory,
  clearKeyHistory,
  buildKeyHistoryExport,
  parseKeyHistoryImport,
  readKeyHistoryImportVin,
  importKeyHistory,
  KEY_HISTORY_KEY,
  KEY_HISTORY_LIMIT_PER_VIN,
  KEY_HISTORY_EXPORT_TYPE,
} from '../keyWriter/keyHistory.js';

const VIN_A = '2C3CDXL95KH123456';
const VIN_B = '2C3CDXL95KH654321';

const baseRecord = {
  chipId: 'id46',
  uidHex: '00 77 A2 9B',
  skHex: '4F 4E 4D 49 4B 52',
  flags: { locked: false, coding: 'manchester', encryption: true, cloneable: true },
  label: 'spare fob #2',
  slotIdx: 1,
};

beforeEach(() => {
  globalThis.localStorage?.removeItem(KEY_HISTORY_KEY);
});

describe('normalizeVin', () => {
  it('uppercases and strips whitespace from a valid VIN', () => {
    expect(normalizeVin(' 2c3cdxl95kh123456 ')).toBe(VIN_A);
  });
  it('rejects a short / non-17-char VIN', () => {
    expect(normalizeVin('2C3CD')).toBe('');
    expect(normalizeVin('')).toBe('');
    expect(normalizeVin(null)).toBe('');
  });
  it('rejects VINs with disallowed letters (I, O, Q)', () => {
    expect(normalizeVin('IOQ3CDXL95KH123456')).toBe('');
  });
});

describe('upsertEntry / removeEntryById — pure reducers', () => {
  it('inserts a new entry', () => {
    const e = makeHistoryEntry(baseRecord);
    const list = upsertEntry([], e);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(e.id);
  });

  it('updates the same chip+UID in place rather than duplicating', () => {
    const first = makeHistoryEntry({ ...baseRecord, label: 'orig', capturedAt: 1000 });
    let list = upsertEntry([], first);
    const dup = makeHistoryEntry({ ...baseRecord, uidHex: '0077a29b', label: 'renamed', capturedAt: 2000 });
    list = upsertEntry(list, dup);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('renamed');
    expect(list[0].id).toBe(first.id); // id preserved across update
  });

  it('keeps distinct chips/UIDs as separate rows, newest first', () => {
    let list = upsertEntry([], makeHistoryEntry({ ...baseRecord, capturedAt: 1000 }));
    list = upsertEntry(list, makeHistoryEntry({ ...baseRecord, uidHex: 'AA BB CC DD', capturedAt: 2000 }));
    expect(list).toHaveLength(2);
    expect(list[0].capturedAt).toBe(2000);
    expect(list[1].capturedAt).toBe(1000);
  });

  it('caps the list at KEY_HISTORY_LIMIT_PER_VIN', () => {
    let list = [];
    for (let i = 0; i < KEY_HISTORY_LIMIT_PER_VIN + 10; i++) {
      const uid = `${i.toString(16).padStart(8, '0')}`;
      list = upsertEntry(list, makeHistoryEntry({ ...baseRecord, uidHex: uid, capturedAt: i }));
    }
    expect(list).toHaveLength(KEY_HISTORY_LIMIT_PER_VIN);
    // newest kept (highest capturedAt), oldest dropped
    expect(list[0].capturedAt).toBe(KEY_HISTORY_LIMIT_PER_VIN + 9);
  });

  it('removeEntryById drops only the matching id', () => {
    const a = makeHistoryEntry({ ...baseRecord, uidHex: '11 11 11 11' });
    const b = makeHistoryEntry({ ...baseRecord, uidHex: '22 22 22 22' });
    const list = removeEntryById([a, b], a.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(b.id);
  });
});

describe('localStorage round-trip, scoped per VIN', () => {
  it('refuses to save without a valid VIN', () => {
    const res = saveKeyToHistory('bad', baseRecord);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/VIN/i);
  });

  it('re-saving the same chip+UID returns the stored row id (not a fresh one)', () => {
    const first = saveKeyToHistory(VIN_A, { ...baseRecord, label: 'orig' });
    expect(first.ok).toBe(true);
    const again = saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '0077a29b', label: 'renamed' });
    expect(again.ok).toBe(true);
    // upsert kept one row, and the returned entry carries the original id.
    expect(again.list).toHaveLength(1);
    expect(again.entry.id).toBe(first.entry.id);
    expect(again.entry.label).toBe('renamed');
  });

  it('saves and re-loads a key under its VIN', () => {
    const res = saveKeyToHistory(VIN_A, baseRecord);
    expect(res.ok).toBe(true);
    expect(res.entry.chipId).toBe('id46');
    expect(res.entry.slotIdx).toBe(1);

    const loaded = loadKeyHistory(VIN_A);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].uidHex).toBe('00 77 A2 9B');
    expect(loaded[0].skHex).toBe('4F 4E 4D 49 4B 52');
  });

  it('keeps each VIN history separate', () => {
    saveKeyToHistory(VIN_A, { ...baseRecord, label: 'A key' });
    saveKeyToHistory(VIN_B, { ...baseRecord, uidHex: 'AA BB CC DD', label: 'B key' });
    expect(loadKeyHistory(VIN_A)).toHaveLength(1);
    expect(loadKeyHistory(VIN_B)).toHaveLength(1);
    expect(loadKeyHistory(VIN_A)[0].label).toBe('A key');
    expect(loadKeyHistory(VIN_B)[0].label).toBe('B key');
  });

  it('removes a single saved key', () => {
    const r1 = saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '11 11 11 11' });
    saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '22 22 22 22' });
    expect(loadKeyHistory(VIN_A)).toHaveLength(2);
    const rem = removeKeyFromHistory(VIN_A, r1.entry.id);
    expect(rem.ok).toBe(true);
    expect(loadKeyHistory(VIN_A)).toHaveLength(1);
  });

  it('clears all keys for a VIN without touching another VIN', () => {
    saveKeyToHistory(VIN_A, baseRecord);
    saveKeyToHistory(VIN_B, { ...baseRecord, uidHex: 'AA BB CC DD' });
    clearKeyHistory(VIN_A);
    expect(loadKeyHistory(VIN_A)).toHaveLength(0);
    expect(loadKeyHistory(VIN_B)).toHaveLength(1);
  });

  it('returns [] for an unknown VIN', () => {
    expect(loadKeyHistory('2C3CDXL95KH000000')).toEqual([]);
  });
});

describe('whole-key-set wrapper export / import — Task #992', () => {
  it('exports a typed/versioned wrapper that drops per-row ids', () => {
    saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '11 11 11 11', label: 'one' });
    saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '22 22 22 22', label: 'two' });
    const list = loadKeyHistory(VIN_A);
    const wrapper = buildKeyHistoryExport(VIN_A, list);

    expect(wrapper.type).toBe(KEY_HISTORY_EXPORT_TYPE);
    expect(wrapper.version).toBe(1);
    expect(wrapper.vin).toBe(VIN_A);
    expect(wrapper.keys).toHaveLength(2);
    for (const k of wrapper.keys) {
      expect('id' in k).toBe(false); // ids never leak into the bundle
      expect(k.chipId).toBe('id46');
    }
  });

  it('round-trips every saved key through build → parse', () => {
    saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '11 11 11 11', label: 'one', slotIdx: 0 });
    saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '22 22 22 22', label: 'two', slotIdx: 3 });
    const list = loadKeyHistory(VIN_A);
    const json = JSON.stringify(buildKeyHistoryExport(VIN_A, list));
    const parsed = parseKeyHistoryImport(json);

    expect(parsed).toHaveLength(2);
    const byUid = Object.fromEntries(parsed.map((p) => [p.uidHex, p]));
    expect(byUid['11 11 11 11'].label).toBe('one');
    expect(byUid['11 11 11 11'].slotIdx).toBe(0);
    expect(byUid['22 22 22 22'].label).toBe('two');
    expect(byUid['22 22 22 22'].slotIdx).toBe(3);
  });

  it('imports the wrapper into an empty history, minting fresh ids', () => {
    saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '11 11 11 11', label: 'one' });
    saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '22 22 22 22', label: 'two' });
    const json = JSON.stringify(buildKeyHistoryExport(VIN_A, loadKeyHistory(VIN_A)));

    // Import the bundle into a *different*, empty VIN history.
    const res = importKeyHistory(VIN_B, json);
    expect(res.ok).toBe(true);
    expect(res.imported).toBe(2);

    const loaded = loadKeyHistory(VIN_B);
    expect(loaded).toHaveLength(2);
    const ids = loaded.map((e) => e.id);
    expect(new Set(ids).size).toBe(2); // unique, freshly minted
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('imports into a populated history without id collisions', () => {
    // Seed VIN_B with one existing distinct key.
    saveKeyToHistory(VIN_B, { ...baseRecord, uidHex: 'AA BB CC DD', label: 'existing' });
    const existingId = loadKeyHistory(VIN_B)[0].id;

    // Build a wrapper of two other keys and import it on top.
    saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '11 11 11 11', label: 'one' });
    saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '22 22 22 22', label: 'two' });
    const json = JSON.stringify(buildKeyHistoryExport(VIN_A, loadKeyHistory(VIN_A)));

    const res = importKeyHistory(VIN_B, json);
    expect(res.ok).toBe(true);

    const loaded = loadKeyHistory(VIN_B);
    expect(loaded).toHaveLength(3); // existing + 2 imported
    const ids = loaded.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids).toContain(existingId); // existing row untouched
  });

  it('re-importing the same wrapper de-dupes by chip+UID (no duplicate rows)', () => {
    saveKeyToHistory(VIN_A, { ...baseRecord, uidHex: '11 11 11 11', label: 'one' });
    const json = JSON.stringify(buildKeyHistoryExport(VIN_A, loadKeyHistory(VIN_A)));

    importKeyHistory(VIN_B, json);
    importKeyHistory(VIN_B, json); // import twice
    expect(loadKeyHistory(VIN_B)).toHaveLength(1);
  });

  it('refuses to import without a valid VIN', () => {
    const json = JSON.stringify(buildKeyHistoryExport(VIN_A, []));
    const res = importKeyHistory('bad', json);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/VIN/i);
  });

  it('rejects malformed JSON and unrelated wrapper types', () => {
    expect(() => parseKeyHistoryImport('{not json')).toThrow(/JSON/i);
    const wrong = JSON.stringify({ type: 'some.other.export', version: 1, keys: [{ chipId: 'id46' }] });
    expect(() => parseKeyHistoryImport(wrong)).toThrow(/Unrecognized export type/);
  });

  it('throws when the wrapper has no usable keys', () => {
    const empty = JSON.stringify(buildKeyHistoryExport(VIN_A, []));
    expect(() => parseKeyHistoryImport(empty)).toThrow(/No keys/i);
  });
});

describe('readKeyHistoryImportVin — pre-import VIN warning helper', () => {
  it('returns the normalized VIN a wrapper was exported from', () => {
    const json = JSON.stringify(buildKeyHistoryExport(VIN_A, []));
    expect(readKeyHistoryImportVin(json)).toBe(VIN_A);
  });

  it('accepts the wrapper object directly and normalizes the VIN', () => {
    const wrapper = buildKeyHistoryExport('2c3cdxl95kh123456', []);
    expect(readKeyHistoryImportVin(wrapper)).toBe(VIN_A);
  });

  it('returns empty string for a bare array, missing VIN, or unparsable input', () => {
    expect(readKeyHistoryImportVin('[{"chipId":"id46"}]')).toBe('');
    expect(readKeyHistoryImportVin(JSON.stringify({ type: KEY_HISTORY_EXPORT_TYPE, keys: [] }))).toBe('');
    expect(readKeyHistoryImportVin('{not json')).toBe('');
    expect(readKeyHistoryImportVin(null)).toBe('');
  });
});
