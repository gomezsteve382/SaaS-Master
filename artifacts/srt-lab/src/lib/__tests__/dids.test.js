import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getDidDescription,
  getDidDescriptions,
  loadDidDescriptions,
  getDidDescriptionCount,
  _resetDidDescriptionsForTests,
} from '../dids.js';
import { backupModule, CRITICAL_DIDS } from '../backups.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(__dirname, '..', '..', '..', 'public', 'unlock_catalog_extended.json');
const CATALOG_TEXT = readFileSync(CATALOG_PATH, 'utf8');

beforeEach(() => {
  _resetDidDescriptionsForTests();
  // Stub fetch with the on-disk extended catalog so the lookup loads
  // the same data the artifact ships in /public.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => JSON.parse(CATALOG_TEXT),
  });
});

describe('dids dictionary', () => {
  it('falls back to curated CRITICAL_DIDS before load completes', () => {
    expect(getDidDescription(0xF190)).toBe('VIN');
  });

  it('looks up labels from the asset-sweep extended catalog', async () => {
    const count = await loadDidDescriptions();
    expect(count).toBeGreaterThan(100);
    expect(getDidDescription(0x04C8)).toBe('Left/Right Hand Drive');
    expect(getDidDescription('0x04CA')).toBe('Shifter Type');
    expect(getDidDescription('04CC')).toBe('Headrest Present');
  });

  it('exposes every distinct description seen for a DID', async () => {
    await loadDidDescriptions();
    const variants = getDidDescriptions(0x04CC);
    expect(variants).toContain('Headrest Present');
    expect(variants).toContain('PTS Configuration');
    expect(variants).toContain('Rear View Camera');
  });

  it('returns "" for unknown DIDs and reports the loaded size', async () => {
    await loadDidDescriptions();
    expect(getDidDescription(0xDEAD)).toBe('');
    expect(getDidDescriptionCount()).toBe(getDidDescriptionCount());
    expect(getDidDescriptionCount()).toBeGreaterThan(0);
  });

  it('is idempotent across concurrent load calls', async () => {
    const [a, b] = await Promise.all([loadDidDescriptions(), loadDidDescriptions()]);
    expect(a).toBe(b);
  });

  it('seeds the VILLAIN-extracted Chrysler/FCA DIDs from CRITICAL_DIDS.VILLAIN_EXT', () => {
    // Curated baseline must label every VILLAIN DID before the catalog fetch
    // resolves. Source:
    //   /tmp/villain_gpec/villain_extraction/VILLAIN_COMPLETE_EXTRACTION.md
    expect(getDidDescription(0x7B90)).toBe('Current VIN');
    expect(getDidDescription(0x7B88)).toBe('Original VIN');
    expect(getDidDescription(0x6E2025)).toBe('Bus-Transmitted VIN');
    expect(getDidDescription(0x6E2027)).toBe('WCM Configured VIN');
    expect(getDidDescription(0x6E9EB0)).toBe('SKIM State');
    expect(getDidDescription(0x6EF190)).toBe('EPS VIN');
    expect(getDidDescription(0xF79EB045)).toBe('SKIM state flag (SCI-B)');
  });
});

describe('villain_operations.json', () => {
  const OPS_PATH = resolve(
    __dirname, '..', '..', '..', 'public', 'villain_operations.json'
  );
  const ops = JSON.parse(readFileSync(OPS_PATH, 'utf8'));

  it('declares every VILLAIN-documented protocol scope', () => {
    const expected = [
      'CHRYSLER_ECU_CAN_11_BIT',
      'CHRYSLER_ECU_CAN_29_BIT',
      'CHRYSLER_ECU_SCI_A_ENGINE',
      'CHRYSLER_ECU_SCI_B_ENGINE',
      'CHRYSLER_TIPM',
      'EPS',
      'TUNER',
    ];
    for (const k of expected) expect(ops.protocols).toHaveProperty(k);
  });

  it('cross-indexes every documented VILLAIN DID with the right protocol scope', () => {
    expect(ops.did_index['0x7B90'].scopes).toContain('CHRYSLER_ECU_CAN_11_BIT');
    expect(ops.did_index['0x6E9EB0'].scopes).toContain('CHRYSLER_TIPM');
    expect(ops.did_index['0x6E9EB0'].values['0x80']).toBe('Enabled');
    expect(ops.did_index['0x6EF190'].scopes).toContain('EPS');
    expect(ops.did_index['0xF79EB045'].scopes).toContain('CHRYSLER_ECU_SCI_B_ENGINE');
  });

  it('lists the SKIM enable/disable/state-read TIPM operations', () => {
    const ids = ops.protocols.CHRYSLER_TIPM.operations.map((o) => o.id);
    for (const id of ['tipm_get_skim_state', 'tipm_enable_skim', 'tipm_disable_skim']) {
      expect(ids).toContain(id);
    }
  });

  it('flags the SRI write E2-prefix quirk', () => {
    const sriWrite = ops.protocols.CHRYSLER_TIPM.operations.find(
      (o) => o.id === 'tipm_write_sri_mileage'
    );
    expect(sriWrite).toBeDefined();
    expect(sriWrite.notes || '').toMatch(/E2/i);
  });

  it('groups the four bench VIN reads/writes under CAN 11-bit', () => {
    const ids = ops.protocols.CHRYSLER_ECU_CAN_11_BIT.operations.map((o) => o.id);
    for (const id of [
      'get_current_vin', 'write_current_vin',
      'get_original_vin', 'write_original_vin',
      'get_bus_transmitted_vin', 'write_bus_transmitted_vin',
      'get_wcm_configured_vin', 'write_wcm_configured_vin',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('did_index keys are all referenced by at least one operation in the listed scope', () => {
    // Architect-recommended generic structural check: every DID we publish
    // in did_index must appear under at least one of its listed protocol
    // scopes' operations[].did, and the operation's `name` must mention
    // a recognizable token from the did_index entry's name. This guards
    // against typos / orphaned entries when the file is hand-edited.
    for (const [didKey, meta] of Object.entries(ops.did_index)) {
      let foundInAtLeastOneScope = false;
      for (const scope of meta.scopes) {
        const scopeOps = ops.protocols[scope]?.operations || [];
        if (scopeOps.some((op) => op.did === didKey)) {
          foundInAtLeastOneScope = true;
          break;
        }
      }
      expect(
        foundInAtLeastOneScope,
        `DID ${didKey} (${meta.name}) is in did_index but not referenced by any operation in scopes ${meta.scopes.join(', ')}`
      ).toBe(true);
    }
  });
});

describe('backupModule wide-DID guard (defensive: VILLAIN_EXT carries 24/32-bit DIDs)', () => {
  beforeEach(() => {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      key: (i) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    };
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    globalThis.window = globalThis.window || { dispatchEvent: () => {} };
  });

  it('skips every >0xFFFF DID in CRITICAL_DIDS.VILLAIN_EXT and never sends a truncated 0x22 frame', async () => {
    // Sanity: the fixture under test must actually contain wide DIDs,
    // otherwise this guard test would silently pass for the wrong reason.
    const wide = CRITICAL_DIDS.VILLAIN_EXT.filter((d) => d.did > 0xFFFF);
    expect(wide.length).toBeGreaterThan(0);

    const sent = [];
    const engUds = async (_tx, _rx, bytes) => {
      sent.push(bytes);
      return { ok: true, d: [0x62, bytes[1], bytes[2], 0x00] };
    };
    const logs = [];
    const addLog = (msg, level) => logs.push({ msg, level });
    const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');

    await backupModule(engUds, 0x7E0, 0x7E8, 'VILLAIN_EXT', addLog, hx);

    // Every UDS frame issued must be exactly 3 bytes (0x10 0x03 session
    // is the only 2-byte frame, all DID reads are 0x22 hi lo). No frame
    // should be a truncated wide-DID read where the upper bytes were lost.
    const didReads = sent.filter((f) => f[0] === 0x22);
    for (const f of didReads) {
      expect(f.length).toBe(3);
    }

    // Each wide DID must have produced a "Skipping wide DID" warn log.
    for (const d of wide) {
      const hexLabel = '0x' + d.did.toString(16).toUpperCase();
      const skipped = logs.some(
        (l) => l.level === 'warn' && l.msg.includes('Skipping wide DID') && l.msg.includes(hexLabel)
      );
      expect(skipped, `expected a skip-warn log for wide DID ${hexLabel}`).toBe(true);
    }

    // The number of 0x22 frames sent must equal the number of NARROW DIDs
    // — i.e. the 16-bit ones — confirming wide DIDs never made it to engUds.
    const narrow = CRITICAL_DIDS.VILLAIN_EXT.filter((d) => d.did <= 0xFFFF);
    expect(didReads.length).toBe(narrow.length);
  });
});
