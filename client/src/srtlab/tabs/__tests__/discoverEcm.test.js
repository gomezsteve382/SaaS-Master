// discoverEcm — ECM CAN address discovery (Task #939).
//
// Verifies the targeted TesterPresent (3E 00) probe loop:
//   1. the standard 0x7E0 default wins with zero extra probing,
//   2. a non-standard ECM at a later candidate is found,
//   3. no responder → null (so the UI can surface a clear error),
//   4. only a positive (0x7E) response counts — NRC / silence is skipped.

import { describe, it, expect, vi } from 'vitest';
import { discoverEcm, ECM_PROBE_CANDIDATES } from '../EcmTab.jsx';

const tp = () => ({ ok: true, d: new Uint8Array([0x7E, 0x00]) });
const silent = () => ({ ok: false });

describe('discoverEcm', () => {
  it('returns the first candidate (0x7E0) when the standard PCM answers', async () => {
    const uds = vi.fn(async () => tp());
    const found = await discoverEcm({ uds });
    expect(found.tx).toBe(0x7E0);
    expect(found.rx).toBe(0x7E8);
    // First candidate wins → only one probe sent.
    expect(uds).toHaveBeenCalledTimes(1);
  });

  it('finds a non-standard ECM that only answers on a later candidate', async () => {
    const target = ECM_PROBE_CANDIDATES[2]; // 0x7A0
    const uds = vi.fn(async (tx) => (tx === target.tx ? tp() : silent()));
    const found = await discoverEcm({ uds });
    expect(found.tx).toBe(target.tx);
    expect(found.rx).toBe(target.rx);
  });

  it('returns null when no candidate responds', async () => {
    const uds = vi.fn(async () => silent());
    const found = await discoverEcm({ uds });
    expect(found).toBeNull();
    expect(uds).toHaveBeenCalledTimes(ECM_PROBE_CANDIDATES.length);
  });

  it('ignores a negative response (NRC) and keeps probing', async () => {
    const nrc = { ok: true, d: new Uint8Array([0x7F, 0x3E, 0x11]) };
    const target = ECM_PROBE_CANDIDATES[1]; // 0x740
    const uds = vi.fn(async (tx) => {
      if (tx === ECM_PROBE_CANDIDATES[0].tx) return nrc;
      if (tx === target.tx) return tp();
      return silent();
    });
    const found = await discoverEcm({ uds });
    expect(found.tx).toBe(target.tx);
  });

  it('returns null for a missing engine', async () => {
    expect(await discoverEcm(null)).toBeNull();
  });

  it('sends a TesterPresent (3E 00) frame on each probe', async () => {
    const uds = vi.fn(async () => silent());
    await discoverEcm({ uds });
    for (const call of uds.mock.calls) {
      const frame = call[2];
      expect(frame[0]).toBe(0x3E);
      expect(frame[1]).toBe(0x00);
    }
  });

  it('keeps 0x7E0 as the first probe so standard vehicles are unchanged', () => {
    expect(ECM_PROBE_CANDIDATES[0].tx).toBe(0x7E0);
    const txs = ECM_PROBE_CANDIDATES.map((c) => c.tx);
    expect(txs).toEqual(expect.arrayContaining([0x7E0, 0x740, 0x7A0, 0x6F0]));
  });
});
