import { describe, it, expect, beforeEach } from 'vitest';
import {
  STORAGE_KEY, loadPresets, savePreset, deletePreset, hydratePreset,
  bytesToB64, b64ToBytes,
} from '../keyProgPresets.js';

function memStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  globalThis.window = { localStorage: memStorage() };
});

const trio = () => ({
  BCM: { name: 'bcm.bin', data: new Uint8Array([1, 2, 3, 4, 5]) },
  RFH: { name: 'rfh.bin', data: new Uint8Array([9, 8, 7]) },
  PCM: { name: 'pcm.bin', data: new Uint8Array([0xff, 0x00, 0xab]) },
});
const VIN = '1C3CDZAG7JH123456';

describe('keyProgPresets', () => {
  it('round-trips bytes through base64', () => {
    const src = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
    const back = b64ToBytes(bytesToB64(src));
    expect(Array.from(back)).toEqual(Array.from(src));
  });

  it('loadPresets returns [] when storage is empty', () => {
    expect(loadPresets()).toEqual([]);
  });

  it('savePreset persists, loadPresets reads back, hydratePreset restores bytes', () => {
    const files = trio();
    const saved = savePreset({ name: 'My Preset', vin: VIN, files });
    expect(saved.id).toMatch(/^kp_/);

    const all = loadPresets();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('My Preset');
    expect(all[0].vin).toBe(VIN);

    const h = hydratePreset(all[0]);
    expect(h.vin).toBe(VIN);
    expect(h.files.BCM.name).toBe('bcm.bin');
    expect(Array.from(h.files.BCM.data)).toEqual(Array.from(files.BCM.data));
    expect(Array.from(h.files.PCM.data)).toEqual(Array.from(files.PCM.data));
  });

  it('savePreset rejects bad inputs', () => {
    expect(() => savePreset({ name: '', vin: VIN, files: trio() })).toThrow();
    expect(() => savePreset({ name: 'x', vin: 'TOO-SHORT', files: trio() })).toThrow();
    const f = trio(); f.RFH = null;
    expect(() => savePreset({ name: 'x', vin: VIN, files: f })).toThrow();
  });

  it('deletePreset removes by id', () => {
    const a = savePreset({ name: 'A', vin: VIN, files: trio() });
    savePreset({ name: 'B', vin: VIN, files: trio() });
    const after = deletePreset(a.id);
    expect(after.length).toBe(1);
    expect(after.find((p) => p.id === a.id)).toBeUndefined();
  });

  it('stores a checks snapshot when provided', () => {
    const checks = [
      { label: 'A', pass: true },
      { label: 'B', pass: true, detail: 'ok' },
      { label: 'C', pass: false, detail: 'mismatch' },
    ];
    const saved = savePreset({ name: 'with-checks', vin: VIN, files: trio(), checks });
    expect(saved.checksTotal).toBe(3);
    expect(saved.checksPassed).toBe(2);
    expect(saved.checksAllGreen).toBe(false);
    expect(saved.checks).toHaveLength(3);
    expect(saved.checks[2]).toEqual({ label: 'C', pass: false, detail: 'mismatch' });

    const allGreen = savePreset({
      name: 'green', vin: VIN, files: trio(),
      checks: [{ label: 'X', pass: true }, { label: 'Y', pass: true }],
    });
    expect(allGreen.checksAllGreen).toBe(true);
    expect(allGreen.checksPassed).toBe(2);
  });

  it('omits checks fields when no snapshot is provided', () => {
    const saved = savePreset({ name: 'no-checks', vin: VIN, files: trio() });
    expect(saved.checks).toBeUndefined();
    expect(saved.checksTotal).toBeUndefined();
    expect(saved.checksAllGreen).toBeUndefined();
  });

  it('survives a corrupt storage payload', () => {
    globalThis.window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadPresets()).toEqual([]);
  });
});
