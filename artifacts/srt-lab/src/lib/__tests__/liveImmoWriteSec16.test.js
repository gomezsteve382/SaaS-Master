import { describe, it, expect } from 'vitest';
import { writeSec16, SEC16_WRITE_RECIPES } from '../liveImmo.js';

/* Stub bridge engine that scripts UDS request → response by leading
 * service byte. Mirrors the pattern used by dealerLockoutBypass.test.js. */
function makeEngine(handler) {
  const calls = [];
  return {
    calls,
    async uds(tx, rx, bytes /*, timeout */) {
      const arr = Array.from(bytes);
      calls.push({ tx, rx, bytes: arr });
      const r = handler(arr, calls.length - 1);
      return r || { ok: false, d: new Uint8Array() };
    },
  };
}

function posResp(svc, ...rest) {
  return { ok: true, d: new Uint8Array([(svc + 0x40) & 0xFF, ...rest]) };
}
function nrcResp(svc, nrc) {
  return { ok: true, d: new Uint8Array([0x7F, svc, nrc]) };
}

const SEC16_TARGET = new Uint8Array([
  0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88,
  0x99,0xAA,0xBB,0xCC,0xDD,0xEE,0xF0,0x01,
]);
const SEC16_OLD = new Uint8Array(16).fill(0x5A);

describe('writeSec16 — guardrails', () => {
  it('refuses a non-16-byte sec16', async () => {
    const eng = makeEngine(() => posResp(0x10));
    const r = await writeSec16(eng, { tx: 0x742, rx: 0x762 }, {
      sec16: new Uint8Array(8), recipe: 'RFHUB_GEN2_DID_F102',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/16-byte/);
  });
  it('refuses an unknown recipe', async () => {
    const eng = makeEngine(() => posResp(0x10));
    const r = await writeSec16(eng, { tx: 0x742, rx: 0x762 }, {
      sec16: SEC16_TARGET, recipe: 'NOT_A_RECIPE',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown SEC16 write recipe/);
  });
});

describe('writeSec16 — RFHUB Gen2 DID 0xF102 happy path', () => {
  it('walks session → SA → pre-read → write → post-read and confirms match', async () => {
    const eng = makeEngine((bytes) => {
      if (bytes[0] === 0x10) return posResp(0x10, 0x03);
      if (bytes[0] === 0x27 && bytes[1] === 0x03) return posResp(0x27, 0x03, 0x00, 0x00, 0x00, 0x01);
      if (bytes[0] === 0x27 && bytes[1] === 0x04) return posResp(0x27, 0x04);
      if (bytes[0] === 0x22 && bytes[1] === 0xF1 && bytes[2] === 0x02) {
        return posResp(0x22, 0xF1, 0x02, ...(eng.calls.length > 5 ? SEC16_TARGET : SEC16_OLD));
      }
      if (bytes[0] === 0x2E && bytes[1] === 0xF1 && bytes[2] === 0x02) {
        return posResp(0x2E, 0xF1, 0x02);
      }
      return { ok: false, d: new Uint8Array() };
    });
    const r = await writeSec16(eng, { tx: 0x742, rx: 0x762 }, {
      sec16: SEC16_TARGET, recipe: 'RFHUB_GEN2_DID_F102',
    });
    expect(r.ok).toBe(true);
    expect(r.recipeId).toBe('RFHUB_GEN2_DID_F102');
    expect(r.verified).toBe('match');
    expect(Array.from(r.before)).toEqual(Array.from(SEC16_OLD));
    expect(Array.from(r.after)).toEqual(Array.from(SEC16_TARGET));
    expect(Array.from(r.txFrame)).toEqual([0x2E, 0xF1, 0x02, ...SEC16_TARGET]);
  });
});

describe('writeSec16 — NRC surfaces with no read-back attempted', () => {
  it('returns ok:false + nrc on 0x33 from the write frame', async () => {
    const eng = makeEngine((bytes) => {
      if (bytes[0] === 0x10) return posResp(0x10, 0x03);
      if (bytes[0] === 0x27 && bytes[1] === 0x03) return posResp(0x27, 0x03, 0x00, 0x00, 0x00, 0x01);
      if (bytes[0] === 0x27 && bytes[1] === 0x04) return posResp(0x27, 0x04);
      if (bytes[0] === 0x22) return posResp(0x22, 0xF1, 0x02, ...SEC16_OLD);
      if (bytes[0] === 0x2E) return nrcResp(0x2E, 0x33);
      return { ok: false, d: new Uint8Array() };
    });
    const r = await writeSec16(eng, { tx: 0x742, rx: 0x762 }, {
      sec16: SEC16_TARGET, recipe: 'RFHUB_GEN2_DID_F102',
    });
    expect(r.ok).toBe(false);
    expect(r.nrc).toBe(0x33);
    expect(r.error).toMatch(/Security access denied/);
    expect(r.after).toBeNull();
  });
});

describe('writeSec16 — XC2268 routine has no verify and reports unverified', () => {
  it('runs the routine but leaves verified=unverified', async () => {
    const eng = makeEngine((bytes) => {
      if (bytes[0] === 0x10) return posResp(0x10, 0x03);
      if (bytes[0] === 0x27 && bytes[1] === 0x03) return posResp(0x27, 0x03, 0x00, 0x00, 0x00, 0x01);
      if (bytes[0] === 0x27 && bytes[1] === 0x04) return posResp(0x27, 0x04);
      if (bytes[0] === 0x31) return posResp(0x31, 0x01, 0x02, 0x10);
      return { ok: false, d: new Uint8Array() };
    });
    const r = await writeSec16(eng, { tx: 0x742, rx: 0x762 }, {
      sec16: SEC16_TARGET, recipe: 'RFHUB_XC2268_ROUTINE',
    });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe('unverified');
    expect(r.before).toBeNull();
    expect(r.after).toBeNull();
    expect(Array.from(r.txFrame)).toEqual([0x31, 0x01, 0x02, 0x10, ...SEC16_TARGET]);
  });
});

describe('writeSec16 — BCM recipe applies byte-reverse on the wire', () => {
  it('writes reverse(sec16) to DID 0x5320 and reads back BCM-form, comparing to RFH-form', async () => {
    const bcmForm = new Uint8Array([...SEC16_TARGET].reverse());
    const eng = makeEngine((bytes) => {
      if (bytes[0] === 0x10) return posResp(0x10, 0x03);
      if (bytes[0] === 0x27 && bytes[1] === 0x03) return posResp(0x27, 0x03, 0x00, 0x00, 0x00, 0x01);
      if (bytes[0] === 0x27 && bytes[1] === 0x04) return posResp(0x27, 0x04);
      if (bytes[0] === 0x22 && bytes[1] === 0x53 && bytes[2] === 0x20) {
        return posResp(0x22, 0x53, 0x20, ...bcmForm);
      }
      if (bytes[0] === 0x2E && bytes[1] === 0x53 && bytes[2] === 0x20) {
        return posResp(0x2E, 0x53, 0x20);
      }
      return { ok: false, d: new Uint8Array() };
    });
    const r = await writeSec16(eng, { tx: 0x762, rx: 0x76A }, {
      sec16: SEC16_TARGET, recipe: SEC16_WRITE_RECIPES.BCM_DID_5320,
    });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe('match');
    /* tx is BCM-form on the wire. */
    expect(Array.from(r.txFrame.slice(3))).toEqual(Array.from(bcmForm));
    /* after is RFH-form (reversed back) so it compares equal to the target. */
    expect(Array.from(r.after)).toEqual(Array.from(SEC16_TARGET));
  });
});
