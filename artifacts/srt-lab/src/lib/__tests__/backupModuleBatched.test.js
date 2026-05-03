import { describe, it, expect, vi, beforeEach } from 'vitest';
import { backupModule, CRITICAL_DIDS } from '../audit.js';

/**
 * Integration test: backupModule (audit.js) end-to-end with the new
 * multi-DID 0x22 batching. The reviewer specifically asked for proof
 * that batched reads preserve EXACT bytes for the critical DID set
 * even when payloads contain DID-marker-like byte pairs. We exercise
 * that here against the real BCM profile (CRITICAL_DIDS.BCM) with an
 * adversarial payload on F190.
 */

beforeEach(() => {
  // Stub localStorage and fetch so backupModule's persistence path
  // doesn't blow up under the node test environment.
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    key: i => Array.from(store.keys())[i] ?? null,
    get length(){ return store.size; },
  };
  globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
  globalThis.window = globalThis.window || { dispatchEvent: () => {} };
});

function asciiBytes(s){
  return Array.from(s).map(c => c.charCodeAt(0));
}

describe('backupModule with multi-DID batching (corruption guard end-to-end)', () => {
  it('preserves exact bytes for the BCM critical DID set when one DID payload contains a marker for another', async () => {
    const profile = CRITICAL_DIDS.BCM;
    expect(profile.length).toBeGreaterThan(0);

    // Truth table — what the module REALLY holds for each critical DID.
    // F1A0 (BCM Config) is the adversarial one: its real payload contains
    // 0xF1 0x87 (the marker bytes for F187) which would silently corrupt
    // the greedy splitter without the corruption-guard re-read.
    const truth = new Map();
    for (const d of profile){
      // Default: 4 boring bytes per DID.
      truth.set(d.did, [0x01, 0x02, 0x03, 0x04]);
    }
    truth.set(0xF190, asciiBytes('1C4HJXEN5MW123456'));            // VIN
    truth.set(0xF187, [0x55, 0x66, 0x77, 0x88]);                   // Part Number
    truth.set(0xF1A0, [0xAA, 0xF1, 0x87, 0xBB, 0xCC, 0xF1, 0xA1]); // ADVERSARIAL — contains F187 + F1A1 markers

    // Build a multi-DID 0x62 response that the module would send for
    // every DID in the profile, in order.
    const multiBody = [0x62];
    for (const d of profile){
      multiBody.push((d.did >> 8) & 0xFF, d.did & 0xFF, ...truth.get(d.did));
    }
    const multiResp = new Uint8Array(multiBody);

    // Engine: respond to the multi-DID request with the crafted body,
    // and to any single-DID re-read with the truth bytes for that DID.
    const calls = [];
    const eng = vi.fn(async (_tx, _rx, data) => {
      calls.push(Array.from(data));
      const sid = data[0];
      if (sid === 0x10) return { ok: true, d: new Uint8Array([0x50, 0x03]) }; // session
      if (sid === 0x22 && data.length === 3){
        const did = (data[1] << 8) | data[2];
        const bytes = truth.get(did);
        if (!bytes) return { ok: true, d: new Uint8Array([0x7F, 0x22, 0x31]) };
        return { ok: true, d: new Uint8Array([0x62, data[1], data[2], ...bytes]) };
      }
      if (sid === 0x22) return { ok: true, d: multiResp }; // multi-DID
      throw new Error('unexpected request: ' + Array.from(data).map(b => b.toString(16)).join(' '));
    });

    const backup = await backupModule(eng, 0x750, 0x758, 'BCM', () => {}, 'pre-write', null);
    expect(backup).toBeTruthy();

    // Every critical DID's persisted bytes must equal the truth bytes —
    // proving the corruption guard kicked in for F1A0 and re-read it.
    for (const d of profile){
      const got = backup.dids[d.did];
      expect(got, 'missing DID 0x' + d.did.toString(16)).toBeTruthy();
      expect(got.bytes, 'wrong bytes for DID 0x' + d.did.toString(16)).toEqual(truth.get(d.did));
    }
  });
});
