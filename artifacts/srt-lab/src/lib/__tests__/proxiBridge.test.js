/**
 * proxiBridge.test.js — exercise the read/unlock/write helpers against a
 * fake UDS engine so the full sequence (10 03 → 22 FD01 → 27 01/02 →
 * 2E FD01 → 11 01) is covered without a live BCM.
 */
import { describe, it, expect } from 'vitest';
import {
  readProxiFromBcm,
  unlockBcmForProxi,
  writeProxiToBcm,
  PROXI_DID_NONSGW,
  BCM_TX_DEFAULT,
  BCM_RX_DEFAULT,
} from '../proxiBridge.js';
import { buildProxi, parseProxi, serializeProxi } from '../fcaProxi.js';
import { cfBCM, cfCall16 } from '../canflashAlgos.js';

const SECTIONS = [
  { id: 0x01, payload: new Uint8Array([0x11, 0x22, 0x33]) },
  { id: 0x02, payload: new Uint8Array([0xAA, 0xBB]) },
  { id: 0x07, payload: new Uint8Array([0x01]) },
];

const FIXTURE = buildProxi(SECTIONS, 1);

/** A scriptable fake engine: `responses` is an array of {match, reply}.
 *  Each call pulls the first matching scripted reply and removes it. */
function makeEngine(script) {
  const sent = [];
  const queue = [...script];
  return {
    sent,
    queue,
    uds: async (tx, rx, frame) => {
      sent.push({ tx, rx, frame: Array.from(frame) });
      const idx = queue.findIndex((s) => s.match(frame));
      if (idx < 0) return { ok: false, raw: 'no scripted reply for ' + Array.from(frame).map(b=>b.toString(16)).join(' ') };
      const [s] = queue.splice(idx, 1);
      const reply = typeof s.reply === 'function' ? s.reply(frame) : s.reply;
      return { ok: true, d: new Uint8Array(reply), raw: reply.map(b=>b.toString(16)).join('') };
    },
  };
}

describe('readProxiFromBcm', () => {
  it('drives 10 03 → 22 FD01 and parses the PROXI payload', async () => {
    const eng = makeEngine([
      { match: f => f[0] === 0x10 && f[1] === 0x03, reply: [0x50, 0x03, 0x00, 0x32, 0x01, 0xF4] },
      { match: f => f[0] === 0x22 && f[1] === 0xFD && f[2] === 0x01, reply: [0x62, 0xFD, 0x01, ...FIXTURE] },
    ]);
    const r = await readProxiFromBcm({ engine: eng, addLog: () => {} });
    expect(r.ok).toBe(true);
    expect(r.parsed.sectionCount).toBe(3);
    expect(r.parsed.crcValid).toBe(true);
    expect(Array.from(r.raw)).toEqual(Array.from(FIXTURE));
    // Bridge addresses default to FCA BCM.
    expect(eng.sent[0].tx).toBe(BCM_TX_DEFAULT);
    expect(eng.sent[0].rx).toBe(BCM_RX_DEFAULT);
    expect(eng.sent[1].frame).toEqual([0x22, 0xFD, 0x01]);
  });

  it('surfaces a 10 03 NRC without attempting the read', async () => {
    const eng = makeEngine([
      { match: f => f[0] === 0x10, reply: [0x7F, 0x10, 0x12] },
    ]);
    const r = await readProxiFromBcm({ engine: eng, addLog: () => {} });
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x12);
    expect(r.error).toMatch(/10 03 NRC/);
    expect(eng.sent.length).toBe(1);
  });

  it('surfaces a 22 FD01 NRC and returns the engine for retry', async () => {
    const eng = makeEngine([
      { match: f => f[0] === 0x10, reply: [0x50, 0x03, 0, 0x32, 0x01, 0xF4] },
      { match: f => f[0] === 0x22, reply: [0x7F, 0x22, 0x31] },
    ]);
    const r = await readProxiFromBcm({ engine: eng, addLog: () => {} });
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x31);
    expect(r.engine).toBe(eng);
  });

  it('honors a custom DID (0xFD20 SGW)', async () => {
    const eng = makeEngine([
      { match: f => f[0] === 0x10, reply: [0x50, 0x03, 0, 0, 0, 0] },
      { match: f => f[0] === 0x22 && f[1] === 0xFD && f[2] === 0x20, reply: [0x62, 0xFD, 0x20, ...FIXTURE] },
    ]);
    const r = await readProxiFromBcm({ engine: eng, addLog: () => {}, did: 0xFD20 });
    expect(r.ok).toBe(true);
    expect(r.did).toBe(0xFD20);
  });
});

describe('unlockBcmForProxi', () => {
  it('runs cfBCM on the seed and sends the matching key', async () => {
    const SEED = [0x12, 0x34];
    const expectedKey = cfCall16(cfBCM, SEED);
    const eng = makeEngine([
      { match: f => f[0] === 0x27 && f[1] === 0x01, reply: [0x67, 0x01, ...SEED] },
      { match: f => f[0] === 0x27 && f[1] === 0x02, reply: [0x67, 0x02] },
    ]);
    const r = await unlockBcmForProxi(eng, { addLog: () => {} });
    expect(r.ok).toBe(true);
    // Second sent frame is the key — confirm cfBCM was used end-to-end.
    expect(eng.sent[1].frame).toEqual([0x27, 0x02, ...expectedKey]);
  });

  it('treats a zero seed as already-unlocked and skips 27 02', async () => {
    const eng = makeEngine([
      { match: f => f[0] === 0x27 && f[1] === 0x01, reply: [0x67, 0x01, 0x00, 0x00] },
    ]);
    const r = await unlockBcmForProxi(eng, { addLog: () => {} });
    expect(r.ok).toBe(true);
    expect(r.alreadyUnlocked).toBe(true);
    expect(eng.sent.length).toBe(1);
  });

  it('surfaces a 27 02 NRC 0x35 invalid-key', async () => {
    const eng = makeEngine([
      { match: f => f[0] === 0x27 && f[1] === 0x01, reply: [0x67, 0x01, 0x12, 0x34] },
      { match: f => f[0] === 0x27 && f[1] === 0x02, reply: [0x7F, 0x27, 0x35] },
    ]);
    const r = await unlockBcmForProxi(eng, { addLog: () => {} });
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x35);
  });
});

describe('writeProxiToBcm', () => {
  it('serializes (recomputes CRC) and sends 2E FD01 + 11 01', async () => {
    const parsed = parseProxi(FIXTURE);
    // Mutate one section to force a CRC change vs the read.
    parsed.sections[0].payload = new Uint8Array([0x99, 0x88, 0x77]);

    const eng = makeEngine([
      { match: f => f[0] === 0x2E && f[1] === 0xFD && f[2] === 0x01, reply: [0x6E, 0xFD, 0x01] },
      { match: f => f[0] === 0x11 && f[1] === 0x01, reply: [0x51, 0x01] },
    ]);
    const r = await writeProxiToBcm(eng, parsed, { addLog: () => {} });
    expect(r.ok).toBe(true);
    // Frame body equals serializeProxi(parsed) — round-trip through the
    // editor path is byte-lossless and CRC was recomputed.
    const expected = serializeProxi(parsed);
    expect(eng.sent[0].frame.slice(3)).toEqual(Array.from(expected));
    // ECU reset followed.
    expect(eng.sent[1].frame).toEqual([0x11, 0x01]);
  });

  it('skips the reset when reset:false', async () => {
    const parsed = parseProxi(FIXTURE);
    const eng = makeEngine([
      { match: f => f[0] === 0x2E, reply: [0x6E, 0xFD, 0x01] },
    ]);
    const r = await writeProxiToBcm(eng, parsed, { addLog: () => {}, reset: false });
    expect(r.ok).toBe(true);
    expect(eng.sent.length).toBe(1);
  });

  it('surfaces an 11 01 reset NRC and reports overall failure', async () => {
    const parsed = parseProxi(FIXTURE);
    const eng = makeEngine([
      { match: f => f[0] === 0x2E, reply: [0x6E, 0xFD, 0x01] },
      { match: f => f[0] === 0x11, reply: [0x7F, 0x11, 0x22] },
    ]);
    const r = await writeProxiToBcm(eng, parsed, { addLog: () => {} });
    expect(r.ok).toBe(false);
    expect(r.resetResult).toBeTruthy();
    expect(r.resetResult.ok).toBe(false);
    expect(r.resetResult.nrc).toBe(0x22);
    // Write bytes are still surfaced so the caller can show what landed.
    expect(r.written).toBeTruthy();
  });

  it('marks reset OK when 51 01 is returned', async () => {
    const parsed = parseProxi(FIXTURE);
    const eng = makeEngine([
      { match: f => f[0] === 0x2E, reply: [0x6E, 0xFD, 0x01] },
      { match: f => f[0] === 0x11, reply: [0x51, 0x01] },
    ]);
    const r = await writeProxiToBcm(eng, parsed, { addLog: () => {} });
    expect(r.ok).toBe(true);
    expect(r.resetResult).toEqual({ ok: true });
  });

  it('surfaces a 2E NRC 0x33 securityAccessDenied', async () => {
    const parsed = parseProxi(FIXTURE);
    const eng = makeEngine([
      { match: f => f[0] === 0x2E, reply: [0x7F, 0x2E, 0x33] },
    ]);
    const r = await writeProxiToBcm(eng, parsed, { addLog: () => {} });
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x33);
  });
});

describe('end-to-end round-trip', () => {
  it('read → edit → unlock → write writes byte-identical PROXI when no edits', async () => {
    const eng = makeEngine([
      { match: f => f[0] === 0x10, reply: [0x50, 0x03, 0, 0, 0, 0] },
      { match: f => f[0] === 0x22, reply: [0x62, 0xFD, 0x01, ...FIXTURE] },
      { match: f => f[0] === 0x27 && f[1] === 0x01, reply: [0x67, 0x01, 0x00, 0x00] },
      { match: f => f[0] === 0x2E, reply: [0x6E, 0xFD, 0x01] },
      { match: f => f[0] === 0x11, reply: [0x51, 0x01] },
    ]);
    const rd = await readProxiFromBcm({ engine: eng, addLog: () => {} });
    expect(rd.ok).toBe(true);
    const u = await unlockBcmForProxi(eng, { addLog: () => {} });
    expect(u.ok).toBe(true);
    const w = await writeProxiToBcm(eng, rd.parsed, { addLog: () => {} });
    expect(w.ok).toBe(true);
    // The exact bytes that hit the wire on 2E are byte-for-byte the
    // bytes the bench delivered on 22 FD01 — proves the edit path is
    // lossless when nothing was edited.
    const writeFrame = eng.sent.find(s => s.frame[0] === 0x2E).frame;
    expect(writeFrame.slice(3)).toEqual(Array.from(FIXTURE));
  });
});
