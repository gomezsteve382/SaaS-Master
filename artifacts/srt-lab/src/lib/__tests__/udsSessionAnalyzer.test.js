import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseTrace } from '../udsSessionAnalyzer/parser.js';
import { analyzeSession } from '../udsSessionAnalyzer/analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(
  resolve(__dirname, '../udsSessionAnalyzer/fixtures/example_session.log'),
  'utf-8'
);

// ─── Helper ──────────────────────────────────────────────────────────────────

function trace(lines) {
  return parseTrace(lines.join('\n'));
}

function analyze(lines) {
  const { lines: parsed } = trace(lines);
  return analyzeSession(parsed);
}

// ─── parseTrace — format auto-detection ──────────────────────────────────────

describe('parseTrace — format detection', () => {
  it('detects candump format', () => {
    const { formatDetected, lines } = parseTrace(
      '(0.000123) can0 7E0#0322F190CC\n(0.015) can0 7E8#0562F190414243\n'
    );
    expect(formatDetected).toBe('candump');
    expect(lines).toHaveLength(2);
    expect(lines[0].shape).toBe('candump');
    expect(lines[0].canId).toBe(0x7E0);
  });

  it('strips ISO-TP SF PCI in candump lines', () => {
    const { lines } = parseTrace('(0.001) can0 7E0#0322F190CCCCCCCC\n');
    expect(lines[0].bytes).toEqual([0x22, 0xF1, 0x90]);
  });

  it('detects TX/RX format', () => {
    const { formatDetected, lines } = parseTrace(
      '[0.050] TX 7E0 22 F1 90\n[0.065] RX 7E8 62 F1 90 41 42 43\n'
    );
    expect(formatDetected).toBe('txrx');
    expect(lines[0].dir).toBe('req');
    expect(lines[1].dir).toBe('resp');
  });

  it('strips ISO-TP SF PCI in TX/RX lines', () => {
    const { lines } = parseTrace('[0.001] TX 7E0 03 22 F1 90\n');
    expect(lines[0].bytes).toEqual([0x22, 0xF1, 0x90]);
  });

  it('detects Req/Resp format', () => {
    const { formatDetected, lines } = parseTrace(
      '[Req] 10 03\n[Resp] 50 03 00 19 01 F4\n'
    );
    expect(formatDetected).toBe('reqresp');
    expect(lines[0].dir).toBe('req');
    expect(lines[1].dir).toBe('resp');
  });

  it('preserves bytes in Req/Resp format without PCI stripping', () => {
    const { lines } = parseTrace('[Req] 22 F1 90\n');
    expect(lines[0].bytes).toEqual([0x22, 0xF1, 0x90]);
  });

  it('detects bare hex format and infers direction from SID', () => {
    const { formatDetected, lines } = parseTrace(
      '10 03\n50 03 00 19 01 F4\n7F 27 35\n'
    );
    expect(formatDetected).toBe('bare');
    expect(lines[0].dir).toBe('req');
    expect(lines[1].dir).toBe('resp');
    expect(lines[2].dir).toBe('resp');
  });

  it('recognizes 7F as a response in bare hex', () => {
    const { lines } = parseTrace('7F 27 35\n');
    expect(lines[0].dir).toBe('resp');
    expect(lines[0].bytes).toEqual([0x7F, 0x27, 0x35]);
  });

  it('skips comment lines', () => {
    const { lines } = parseTrace('# comment\n; also comment\n// also\n10 03\n');
    expect(lines).toHaveLength(1);
  });

  it('skips blank lines', () => {
    const { lines } = parseTrace('\n\n10 03\n\n');
    expect(lines).toHaveLength(1);
  });

  it('reports messageCount correctly', () => {
    const { messageCount } = parseTrace('[Req] 10 03\n[Resp] 50 03\n');
    expect(messageCount).toBe(2);
  });

  it('returns empty result for empty input', () => {
    const r = parseTrace('');
    expect(r.lines).toHaveLength(0);
    expect(r.formatDetected).toBe('none');
  });

  it('includes optional timestamp in reqresp shape', () => {
    const { lines } = parseTrace('[0.123] [Req] 10 03\n');
    expect(lines[0].ts).toBeCloseTo(0.123);
  });

  it('flags FirstFrame (hi nibble 0x1) as isFF in candump', () => {
    const { lines } = parseTrace('(0.001) can0 7E0#1020222E F190414243CC\n');
    expect(lines[0].isFF).toBe(true);
  });
});

// ─── ISO-TP multi-frame reassembly ───────────────────────────────────────────

describe('parseTrace — ISO-TP multi-frame reassembly', () => {
  it('reassembles a single FF + 2 CF response into one line with the full payload', () => {
    // Positive response to RDBI 0xF188: 0x62 0xF1 0x88 + 13 data bytes = 16 bytes total.
    // FF: 10 10 62 F1 88 31 32 33                      (PCI 0x1010, len=16, 6 payload bytes)
    // CF1: 21 34 35 36 37 38 39 30                     (SN=1, 7 bytes)
    // CF2: 22 41 42 43 CC CC CC CC                     (SN=2, 3 bytes, then padding)
    const { lines } = parseTrace([
      '(0.000) can0 7E0#0322F188CCCCCCCC',
      '(0.010) can0 7E8#101062F188313233',
      '(0.020) can0 7E8#2134353637383930',
      '(0.030) can0 7E8#22414243CCCCCCCC',
    ].join('\n'));

    expect(lines).toHaveLength(2);
    expect(lines[0].bytes).toEqual([0x22, 0xF1, 0x88]);
    expect(lines[1].bytes).toEqual([
      0x62, 0xF1, 0x88,
      0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x30,
      0x41, 0x42, 0x43,
    ]);
    expect(lines[1].dir).toBe('resp');
    expect(lines[1].isFF).toBe(false);
    expect(lines[1].isCF).toBe(false);
    expect(lines[1].canId).toBe(0x7E8);
  });

  it('drops ISO-TP flow-control (PCI 0x3x) frames silently', () => {
    const { lines } = parseTrace([
      '(0.005) can0 7E0#3000000000000000',
    ].join('\n'));
    expect(lines).toHaveLength(0);
  });

  it('surfaces the existing multi-frame warning when a CF sequence is incomplete', () => {
    // FF claims 16 bytes (6 in FF), only one CF arrives (7 more) — short by 3.
    const { lines } = parseTrace([
      '(0.010) can0 7E8#101062F188313233',
      '(0.020) can0 7E8#2134353637383930',
    ].join('\n'));

    expect(lines).toHaveLength(1);
    expect(lines[0].isFF).toBe(true);
    expect(lines[0].canId).toBe(0x7E8);

    const { exchanges } = analyzeSession(lines);
    const mf = exchanges.find(e => e.type === 'multiframe');
    expect(mf).toBeDefined();
    expect(mf.severity).toBe('WARN');
    expect(mf.verdict).toMatch(/First Frame|multi-frame/i);
  });

  it('emits an isCF warning for an orphan Consecutive Frame (no preceding FF)', () => {
    const { lines } = parseTrace([
      '(0.020) can0 7E8#2134353637383930',
    ].join('\n'));
    expect(lines).toHaveLength(1);
    expect(lines[0].isCF).toBe(true);
  });

  it('handles SF and multi-frame interleaved in the same candump session', () => {
    // Two complete exchanges:
    //   1. SF req 10 03 → SF resp 50 03 00 19
    //   2. SF req 22 F1 88 → FF + 2 CF reassembled into 16-byte positive response
    const { lines } = parseTrace([
      '(0.000) can0 7E0#02100300CCCCCCCC',
      '(0.005) can0 7E8#0450030019CCCCCC',
      '(0.010) can0 7E0#0322F188CCCCCCCC',
      '(0.020) can0 7E8#101062F188313233',
      '(0.030) can0 7E8#2134353637383930',
      '(0.040) can0 7E8#22414243CCCCCCCC',
    ].join('\n'));

    expect(lines).toHaveLength(4);
    expect(lines[3].bytes).toHaveLength(16);
    expect(lines[3].dir).toBe('resp');

    const { exchanges } = analyzeSession(lines);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].severity).toBe('OK');
    expect(exchanges[0].service).toBe('DiagnosticSessionControl');
    expect(exchanges[1].severity).toBe('OK');
    expect(exchanges[1].service).toBe('ReadDataByIdentifier');
    // Reassembled payload is surfaced verbatim in the response bytes.
    expect(exchanges[1].responseBytes).toMatch(/41 42 43$/);
  });

  it('runs DID name + decoded-value labelling on reassembled 0x22 responses', () => {
    // RDBI 0xF190 (VIN) — 17-byte ASCII payload "1C3CDZAG5KR123456".
    // Response: 62 F1 90 + 17 bytes = 20 bytes → must arrive as FF + 2 CF.
    //   FF : 10 14 62 F1 90 31 43 33                  (PCI 0x1014, len=20, 6 data bytes)
    //   CF1: 21 43 44 5A 41 47 35 4B                  (SN=1, 7 bytes)
    //   CF2: 22 52 31 32 33 34 35 36                  (SN=2, 7 bytes)
    const { exchanges } = analyze([
      '(0.000) can0 7E0#0322F190CCCCCCCC',
      '(0.010) can0 7E8#101462F190314333',
      '(0.020) can0 7E8#2143445A4147354B',
      '(0.030) can0 7E8#2252313233343536',
    ]);

    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.service).toBe('ReadDataByIdentifier');
    expect(ex.did).toBeDefined();
    expect(ex.did.did).toBe(0xF190);
    expect(ex.did.name).toMatch(/VIN/i);
    expect(ex.did.decoded).toBe('1C3CDZAG5KR123456');
    expect(ex.verdict).toMatch(/1C3CDZAG5KR123456/);
  });

  it('emits a clear WARN row when an FF is never completed by enough CFs', () => {
    const { exchanges } = analyze([
      '(0.010) can0 7E8#101062F188313233',
      '(0.020) can0 7E8#2134353637383930',
    ]);
    const mf = exchanges.find(e => e.type === 'multiframe');
    expect(mf).toBeDefined();
    expect(mf.severity).toBe('WARN');
    expect(mf.service).toBe('Multi-Frame (incomplete)');
    expect(mf.verdict).toMatch(/First Frame/);
    expect(mf.verdict).not.toMatch(/out of scope/i);
  });

  it('emits a clear WARN row for an orphan Consecutive Frame', () => {
    const { exchanges } = analyze([
      '(0.020) can0 7E8#2134353637383930',
    ]);
    const mf = exchanges.find(e => e.type === 'multiframe');
    expect(mf).toBeDefined();
    expect(mf.verdict).toMatch(/Orphan Consecutive Frame/);
  });

  it('reassembles multi-frame responses in TX/RX shape too', () => {
    const { lines } = parseTrace([
      '[0.010] RX 7E8 10 10 62 F1 88 31 32 33',
      '[0.020] RX 7E8 21 34 35 36 37 38 39 30',
      '[0.030] RX 7E8 22 41 42 43 CC CC CC CC',
    ].join('\n'));

    expect(lines).toHaveLength(1);
    expect(lines[0].dir).toBe('resp');
    expect(lines[0].bytes).toHaveLength(16);
    expect(lines[0].isFF).toBe(false);
  });
});

// ─── analyzeSession — NRC diagnosis branches ─────────────────────────────────

describe('analyzeSession — NRC 0x33 SecurityAccess denied', () => {
  it('produces SAD diagnosis finding', () => {
    const { diagnosis } = analyze([
      '[Req] 2E F1 90 41 41',
      '[Resp] 7F 2E 33',
    ]);
    const sad = diagnosis.find(d => d.code === 'SAD');
    expect(sad).toBeDefined();
    expect(sad.severity).toBe('FAIL');
    expect(sad.recommendation).toMatch(/security/i);
  });

  it('marks the exchange as FAIL', () => {
    const { exchanges } = analyze(['[Req] 2E F1 90 41', '[Resp] 7F 2E 33']);
    expect(exchanges[0].severity).toBe('FAIL');
    expect(exchanges[0].nrcCode).toBe(0x33);
  });
});

describe('analyzeSession — NRC 0x35 Invalid key', () => {
  it('produces IK diagnosis finding', () => {
    const { diagnosis, summary } = analyze([
      '[Req] 27 01',
      '[Resp] 67 01 AA BB CC DD',
      '[Req] 27 02 DE AD BE EF',
      '[Resp] 7F 27 35',
    ]);
    const ik = diagnosis.find(d => d.code === 'IK');
    expect(ik).toBeDefined();
    expect(summary.wrongKeyCount).toBe(1);
  });
});

describe('analyzeSession — NRC 0x36 Exceeded number of attempts', () => {
  it('produces ENOA diagnosis and sets lockoutActive', () => {
    const { diagnosis, summary } = analyze([
      '[Req] 27 02 FF FF FF FF',
      '[Resp] 7F 27 36',
    ]);
    const enoa = diagnosis.find(d => d.code === 'ENOA');
    expect(enoa).toBeDefined();
    expect(enoa.severity).toBe('FAIL');
    expect(summary.lockoutActive).toBe(true);
  });
});

describe('analyzeSession — NRC 0x37 Required time delay', () => {
  it('produces RTDNE finding as WARN', () => {
    const { diagnosis } = analyze([
      '[Req] 27 01',
      '[Resp] 7F 27 37',
    ]);
    const rtdne = diagnosis.find(d => d.code === 'RTDNE');
    expect(rtdne).toBeDefined();
    expect(rtdne.severity).toBe('WARN');
    expect(rtdne.recommendation).toMatch(/wait/i);
  });

  it('marks the exchange as WARN (pending/retry)', () => {
    const { exchanges } = analyze(['[Req] 27 01', '[Resp] 7F 27 37']);
    expect(exchanges[0].severity).toBe('WARN');
    expect(exchanges[0].nrcCode).toBe(0x37);
  });
});

describe('analyzeSession — NRC 0x22 Conditions not correct', () => {
  it('produces CNC diagnosis finding', () => {
    const { diagnosis } = analyze([
      '[Req] 2E F1 90 41 42 43',
      '[Resp] 7F 2E 22',
    ]);
    const cnc = diagnosis.find(d => d.code === 'CNC');
    expect(cnc).toBeDefined();
    expect(cnc.severity).toBe('FAIL');
  });
});

describe('analyzeSession — NRC 0x24 Request sequence error', () => {
  it('produces RSE diagnosis finding', () => {
    const { diagnosis } = analyze([
      '[Req] 36 01 AA BB CC',
      '[Resp] 7F 36 24',
    ]);
    const rse = diagnosis.find(d => d.code === 'RSE');
    expect(rse).toBeDefined();
  });
});

describe('analyzeSession — NRC 0x31 Request out of range', () => {
  it('produces ROOR diagnosis finding', () => {
    const { diagnosis } = analyze([
      '[Req] 22 AB CD',
      '[Resp] 7F 22 31',
    ]);
    const roor = diagnosis.find(d => d.code === 'ROOR');
    expect(roor).toBeDefined();
  });
});

describe('analyzeSession — NRC 0x72 General programming failure', () => {
  it('produces GPF diagnosis finding', () => {
    const { diagnosis } = analyze([
      '[Req] 31 01 FF 00',
      '[Resp] 7F 31 72',
    ]);
    const gpf = diagnosis.find(d => d.code === 'GPF');
    expect(gpf).toBeDefined();
    expect(gpf.severity).toBe('FAIL');
    expect(gpf.recommendation).toMatch(/voltage/i);
  });
});

// ─── 0x78 ResponsePending → silence timeout pattern ──────────────────────────

describe('0x78 ResponsePending → silence timeout', () => {
  it('detects timeout when 0x78 present but no final response', () => {
    const { exchanges, summary, diagnosis } = analyze([
      '[Req] 31 01 FF 00',
      '[Resp] 7F 31 78',
    ]);
    expect(summary.pendingTimeouts).toBe(1);
    const timeout = diagnosis.find(d => d.code === 'RCRRP_TIMEOUT');
    expect(timeout).toBeDefined();
    expect(timeout.severity).toBe('FAIL');
    const ex = exchanges.find(e => e.type === 'pending_timeout');
    expect(ex).toBeDefined();
    expect(ex.severity).toBe('FAIL');
  });

  it('does NOT flag timeout when 0x78 is followed by a positive response', () => {
    const { summary, exchanges } = analyze([
      '[Req] 31 01 FF 00',
      '[Resp] 7F 31 78',
      '[Resp] 71 01 FF 00',
    ]);
    expect(summary.pendingTimeouts).toBe(0);
    expect(exchanges[0].severity).toBe('OK');
    expect(exchanges[0].verdict).toMatch(/ResponsePending/);
  });

  it('counts multiple 0x78 hops correctly', () => {
    const { exchanges } = analyze([
      '[Req] 31 01 FF 00',
      '[Resp] 7F 31 78',
      '[Resp] 7F 31 78',
      '[Resp] 71 01 FF 00',
    ]);
    expect(exchanges[0].severity).toBe('OK');
    expect(exchanges[0].verdict).toMatch(/2 ResponsePending/);
  });
});

// ─── No-response / link–addressing pattern ───────────────────────────────────

describe('no-response / link and addressing pattern', () => {
  it('flags no-response as WARN and produces diagnosis', () => {
    const { exchanges, summary, diagnosis } = analyze([
      '[Req] 10 03',
    ]);
    expect(exchanges[0].type).toBe('no_response');
    expect(exchanges[0].severity).toBe('WARN');
    expect(summary.noResponseCount).toBe(1);
    const nr = diagnosis.find(d => d.code === 'NO_RESPONSE');
    expect(nr).toBeDefined();
    expect(nr.severity).toBe('FAIL');
    expect(nr.recommendation).toMatch(/CAN ID/i);
  });

  it('counts multiple no-response requests correctly', () => {
    const { summary } = analyze([
      '[Req] 10 03',
      '[Req] 27 01',
    ]);
    expect(summary.noResponseCount).toBe(2);
  });
});

// ─── SecurityAccess state tracking ───────────────────────────────────────────

describe('SecurityAccess state tracking', () => {
  it('tracks seen = false when no SA exchange', () => {
    const { summary } = analyze(['[Req] 10 03', '[Resp] 50 03 00 19 01 F4']);
    expect(summary.securityAccessSeen).toBe(false);
    expect(summary.securityAccessUnlocked).toBe(false);
  });

  it('sets seen = true after seed request', () => {
    const { summary } = analyze([
      '[Req] 27 01',
      '[Resp] 67 01 AA BB CC DD',
    ]);
    expect(summary.securityAccessSeen).toBe(true);
    expect(summary.securityAccessLevel).toBe(1);
  });

  it('sets unlocked = true on successful key send', () => {
    const { summary } = analyze([
      '[Req] 27 01',
      '[Resp] 67 01 AA BB CC DD',
      '[Req] 27 02 12 34 56 78',
      '[Resp] 67 02',
    ]);
    expect(summary.securityAccessUnlocked).toBe(true);
    expect(summary.wrongKeyCount).toBe(0);
  });

  it('does not set unlocked on wrong key', () => {
    const { summary } = analyze([
      '[Req] 27 01',
      '[Resp] 67 01 AA BB',
      '[Req] 27 02 00 00',
      '[Resp] 7F 27 35',
    ]);
    expect(summary.securityAccessUnlocked).toBe(false);
    expect(summary.wrongKeyCount).toBe(1);
  });

  it('decodes level from odd sub-function', () => {
    const { summary } = analyze([
      '[Req] 27 03',
      '[Resp] 67 03 DE AD',
    ]);
    expect(summary.securityAccessLevel).toBe(2);
  });
});

// ─── Clean session ────────────────────────────────────────────────────────────

describe('clean session', () => {
  it('reports CLEAN when all exchanges succeed', () => {
    const { diagnosis } = analyze([
      '[Req] 10 03',
      '[Resp] 50 03 00 19 01 F4',
      '[Req] 3E 00',
      '[Resp] 7E 00',
    ]);
    const clean = diagnosis.find(d => d.code === 'CLEAN');
    expect(clean).toBeDefined();
    expect(clean.severity).toBe('OK');
  });
});

// ─── Suppress TesterPresent ───────────────────────────────────────────────────

describe('TesterPresent suppress bit', () => {
  it('marks suppressed TP as OK without needing a response', () => {
    const { exchanges } = analyze(['[Req] 3E 80']);
    expect(exchanges[0].type).toBe('suppress');
    expect(exchanges[0].severity).toBe('OK');
  });
});

// ─── Multi-DID 0x22 batch reads ──────────────────────────────────────────────

describe('analyzeSession — 0x22 multi-DID batch reads', () => {
  it('splits a single-frame multi-DID response into one row per DID', () => {
    // Request:  22 F19F F1A6 F1A9            (three fixed-length DIDs, all 1 byte)
    // F19F = Number of Valid Calibration Files (uint), F1A6/F1A9 = hex.
    // Response: 62 F19F 03 F1A6 02 F1A9 00
    const { exchanges } = analyze([
      '[Req] 22 F1 9F F1 A6 F1 A9',
      '[Resp] 62 F1 9F 03 F1 A6 02 F1 A9 00',
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.service).toBe('ReadDataByIdentifier');
    expect(ex.dids).toHaveLength(3);
    expect(ex.dids[0].did).toBe(0xF19F);
    expect(ex.dids[0].decoded).toBe('3');
    expect(ex.dids[1].did).toBe(0xF1A6);
    expect(ex.dids[1].decoded).toMatch(/^02$/i);
    expect(ex.dids[2].did).toBe(0xF1A9);
    expect(ex.dids[2].decoded).toMatch(/^00$/i);
    expect(ex.verdict).toMatch(/Multi-DID read \(3 DIDs\)/);
    expect(ex.verdict).toMatch(/0xF19F/);
    expect(ex.verdict).toMatch(/0xF1A6/);
    expect(ex.verdict).toMatch(/0xF1A9/);
  });

  it('handles a mix of fixed-length and variable-length DIDs by scanning for the next DID id', () => {
    // Request:  22 F190 F186 F1A6
    //   F190 = VIN (17 bytes ASCII fixed)
    //   F186 = Active Diagnostic Session (1 byte fixed)
    //   F1A6 = Active Security Level (1 byte fixed)
    // VIN bytes: "1C3CDZAG5KR123456" → 31 43 33 43 44 5A 41 47 35 4B 52 31 32 33 34 35 36
    // Response total length: 1 (62) + 2+17 + 2+1 + 2+1 = 26 bytes → FF + 3 CFs.
    //   FF : 10 1A 62 F1 90 31 43 33                  (PCI 0x101A, len=26, 6 data bytes)
    //   CF1: 21 43 44 5A 41 47 35 4B                  (SN=1, 7 bytes)
    //   CF2: 22 52 31 32 33 34 35 36                  (SN=2, 7 bytes)
    //   CF3: 23 F1 86 03 F1 A6 02 CC                  (SN=3, 6 bytes + 1 padding)
    const { exchanges } = analyze([
      '(0.000) can0 7E0#0722F190F186F1A6',
      '(0.010) can0 7E8#101A62F190314333',
      '(0.020) can0 7E8#2143445A4147354B',
      '(0.030) can0 7E8#2252313233343536',
      '(0.040) can0 7E8#23F18603F1A602CC',
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.dids).toHaveLength(3);
    expect(ex.dids[0].did).toBe(0xF190);
    expect(ex.dids[0].decoded).toBe('1C3CDZAG5KR123456');
    expect(ex.dids[1].did).toBe(0xF186);
    expect(ex.dids[2].did).toBe(0xF1A6);
    expect(ex.verdict).toMatch(/1C3CDZAG5KR123456/);
  });

  it('falls back to raw hex labels per DID when alignment fails (no decoded values)', () => {
    // Request three DIDs but respond with only two — splitter must reject and
    // fall back to a labeled-but-undecoded list rather than misalign.
    const { exchanges } = analyze([
      '[Req] 22 F1 86 F1 A6 F1 A9',
      '[Resp] 62 F1 86 03 F1 A6 02',
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.dids).toHaveLength(3);
    expect(ex.dids.every(r => r.decoded === null)).toBe(true);
    expect(ex.verdict).toMatch(/could not be split/i);
  });

  it('labels unknown DIDs by hex and decodes them as raw hex bytes', () => {
    // Request:  22 F1 90 AB CD            (second DID is not in the catalog)
    // Response: 62 F1 90 <17 VIN bytes> AB CD DE AD BE EF
    // total 1 + 2+17 + 2+4 = 26 bytes → FF + CFs.
    //   FF : 10 1A 62 F1 90 31 43 33
    //   CF1: 21 43 44 5A 41 47 35 4B
    //   CF2: 22 52 31 32 33 34 35 36
    //   CF3: 23 AB CD DE AD BE EF CC
    const { exchanges } = analyze([
      '(0.000) can0 7E0#0522F190ABCDCCCC',
      '(0.010) can0 7E8#101A62F190314333',
      '(0.020) can0 7E8#2143445A4147354B',
      '(0.030) can0 7E8#2252313233343536',
      '(0.040) can0 7E8#23ABCDDEADBEEFCC',
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.dids).toHaveLength(2);
    expect(ex.dids[0].did).toBe(0xF190);
    expect(ex.dids[0].name).toMatch(/VIN/i);
    expect(ex.dids[0].decoded).toBe('1C3CDZAG5KR123456');
    expect(ex.dids[1].did).toBe(0xABCD);
    expect(ex.dids[1].name).toBeNull();
    expect(ex.dids[1].decoded).toMatch(/DE AD BE EF/);
  });

  it('keeps single-DID 0x22 reads working with one-element dids array', () => {
    const { exchanges } = analyze([
      '[Req] 22 F1 9F',
      '[Resp] 62 F1 9F 03',
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.dids).toHaveLength(1);
    expect(ex.dids[0].did).toBe(0xF19F);
    expect(ex.did.did).toBe(0xF19F);
    expect(ex.did.decoded).toBe('3');
    expect(ex.verdict).not.toMatch(/Multi-DID/);
  });

  it('surfaces requested DID labels even when the multi-DID request gets an NRC', () => {
    const { exchanges } = analyze([
      '[Req] 22 F1 90 F1 86 F1 A6',
      '[Resp] 7F 22 31',
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.severity).toBe('FAIL');
    expect(ex.nrcCode).toBe(0x31);
    expect(ex.dids).toHaveLength(3);
    expect(ex.dids.map(r => r.did)).toEqual([0xF190, 0xF186, 0xF1A6]);
  });
});

// ─── example_session.log fixture ─────────────────────────────────────────────

describe('example_session.log fixture', () => {
  it('parses without errors', () => {
    const { lines, messageCount } = parseTrace(FIXTURE);
    expect(lines.length).toBeGreaterThan(0);
    expect(messageCount).toBe(lines.length);
  });

  it('detects reqresp format', () => {
    const { formatDetected } = parseTrace(FIXTURE);
    expect(formatDetected).toBe('reqresp');
  });

  it('produces the expected exchange sequence', () => {
    const { exchanges } = analyzeSession(parseTrace(FIXTURE).lines);
    const services = exchanges.map(e => e.service);
    expect(services).toContain('DiagnosticSessionControl');
    expect(services).toContain('SecurityAccess');
    expect(services).toContain('ReadDataByIdentifier');
    expect(services).toContain('WriteDataByIdentifier');
    expect(services).toContain('RoutineControl');
    expect(services).toContain('ECUReset');
  });

  it('detects wrong key and time delay from fixture', () => {
    const { summary } = analyzeSession(parseTrace(FIXTURE).lines);
    expect(summary.wrongKeyCount).toBe(1);
    expect(summary.securityAccessUnlocked).toBe(true);
  });

  it('produces IK and RTDNE diagnosis items', () => {
    const { diagnosis } = analyzeSession(parseTrace(FIXTURE).lines);
    expect(diagnosis.find(d => d.code === 'IK')).toBeDefined();
    expect(diagnosis.find(d => d.code === 'RTDNE')).toBeDefined();
  });

  it('produces GPF diagnosis item for the RoutineControl failure', () => {
    const { diagnosis } = analyzeSession(parseTrace(FIXTURE).lines);
    expect(diagnosis.find(d => d.code === 'GPF')).toBeDefined();
  });

  it('has no pending timeouts in the fixture', () => {
    const { summary } = analyzeSession(parseTrace(FIXTURE).lines);
    expect(summary.pendingTimeouts).toBe(0);
  });
});

// ─── DID decoding via RDBI 0x22 ──────────────────────────────────────────────

describe('RDBI 0x22 DID decoding', () => {
  it('decodes a 0xF190 positive response to the VIN ASCII string', () => {
    // "1C4HJXFG5KW501234" → 17 ASCII bytes after the 62 F1 90 header.
    const { exchanges } = analyze([
      '[Req] 22 F1 90',
      '[Resp] 62 F1 90 31 43 34 48 4A 58 46 47 35 4B 57 35 30 31 32 33 34',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.did).toBeDefined();
    expect(ex.did.did).toBe(0xF190);
    expect(ex.did.decoded).toBe('1C4HJXFG5KW501234');
    expect(ex.verdict).toMatch(/1C4HJXFG5KW501234/);
  });

  it('falls back to hex when the DID is not in the catalog', () => {
    // 0xABCD is not a known DID — decoder should surface the raw payload as hex.
    const { exchanges } = analyze([
      '[Req] 22 AB CD',
      '[Resp] 62 AB CD DE AD BE EF',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.did.did).toBe(0xABCD);
    expect(ex.did.decoded).toMatch(/DE AD BE EF/i);
    expect(ex.did.name).toBeNull();
  });
});

// ─── Multi-DID 0x2E batched writes ───────────────────────────────────────────

describe('analyzeSession — 0x2E multi-DID batch writes', () => {
  it('splits a batched 0x2E write into one sub-row per DID', () => {
    // Request:  2E F19F 03 F1A6 02 F1A9 00       (three 1-byte DIDs)
    // Response: 6E F19F F1A6 F1A9                (echo IDs of each written DID)
    const { exchanges } = analyze([
      '[Req] 2E F1 9F 03 F1 A6 02 F1 A9 00',
      '[Resp] 6E F1 9F F1 A6 F1 A9',
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.service).toBe('WriteDataByIdentifier');
    expect(ex.dids).toHaveLength(3);
    expect(ex.dids[0].did).toBe(0xF19F);
    expect(ex.dids[0].decoded).toBe('written successfully');
    expect(ex.dids[1].did).toBe(0xF1A6);
    expect(ex.dids[2].did).toBe(0xF1A9);
    expect(ex.verdict).toMatch(/Multi-DID write \(3 DIDs\)/);
    expect(ex.verdict).toMatch(/0xF19F/);
    expect(ex.verdict).toMatch(/0xF1A9/);
  });

  it('falls back to labeled sub-rows when the 0x6E echoes do not line up', () => {
    // Request three writes, response echoes only two — splitter must reject
    // and surface a labeled-but-undecoded fallback.
    const { exchanges } = analyze([
      '[Req] 2E F1 9F 03 F1 A6 02 F1 A9 00',
      '[Resp] 6E F1 9F F1 A6',
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.dids).toHaveLength(3);
    expect(ex.dids.every(r => r.decoded === null)).toBe(true);
    expect(ex.verdict).toMatch(/could not be split/i);
  });

  it('attaches per-DID NRC sub-rows when a batched write fails with NRC', () => {
    const { exchanges } = analyze([
      '[Req] 2E F1 9F 03 F1 A6 02 F1 A9 00',
      '[Resp] 7F 2E 33',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('FAIL');
    expect(ex.nrcCode).toBe(0x33);
    expect(ex.dids).toHaveLength(3);
    expect(ex.dids[0].decoded).toMatch(/NRC 0x33/);
    expect(ex.dids[2].decoded).toMatch(/NRC 0x33/);
  });

  it('still surfaces a single-DID 0x2E exchange the way it did before', () => {
    const { exchanges } = analyze([
      '[Req] 2E F1 9F 03',
      '[Resp] 6E F1 9F',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.dids).toBeNull();
    expect(ex.verdict).toMatch(/written successfully/);
    expect(ex.verdict).toMatch(/0xF19F/);
  });

  it('does not try to split when one of the written DIDs has no catalog length', () => {
    // 0xABCD is not in the catalog → getWrittenDids returns null and the
    // exchange falls back to the original single-DID rendering.
    const { exchanges } = analyze([
      '[Req] 2E F1 9F 03 AB CD 11 22',
      '[Resp] 6E F1 9F AB CD',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.dids).toBeNull();
  });
});

// ─── Multi-routine 0x31 batched RoutineControl results ───────────────────────

describe('analyzeSession — 0x31 multi-routine batch results', () => {
  it('splits a batched RoutineControl response into one sub-row per routine', () => {
    // Request:  31 01 FF 00 FF 01 FF 02            (three RIDs, start type)
    // Response: 71 01 FF 00 AA FF 01 BB FF 02 CC   (1-byte status per RID)
    const { exchanges } = analyze([
      '[Req] 31 01 FF 00 FF 01 FF 02',
      '[Resp] 71 01 FF 00 AA FF 01 BB FF 02 CC',
    ]);
    expect(exchanges).toHaveLength(1);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.service).toBe('RoutineControl');
    expect(ex.routines).toHaveLength(3);
    expect(ex.routines[0].routineId).toBe(0xFF00);
    expect(ex.routines[0].status).toMatch(/AA/);
    expect(ex.routines[1].routineId).toBe(0xFF01);
    expect(ex.routines[1].status).toMatch(/BB/);
    expect(ex.routines[2].routineId).toBe(0xFF02);
    expect(ex.routines[2].status).toMatch(/CC/);
    expect(ex.verdict).toMatch(/Multi-routine \(3 routines/);
    expect(ex.verdict).toMatch(/0xFF00/);
  });

  it('handles batched routines with empty status records (pure RID echoes)', () => {
    // Request:  31 01 DE AD BE EF AB CD           (three RIDs)
    // Response: 71 01 DE AD BE EF AB CD           (echo only, no status)
    const { exchanges } = analyze([
      '[Req] 31 01 DE AD BE EF AB CD',
      '[Resp] 71 01 DE AD BE EF AB CD',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.routines).toHaveLength(3);
    expect(ex.routines.every(r => r.status === 'completed')).toBe(true);
  });

  it('falls through to single-routine rendering when echoes do not line up', () => {
    // Request three routines, response echoes only two — splitter rejects
    // and we fall through to the legacy single-routine verdict rather
    // than emitting a misleading multi-routine error.
    const { exchanges } = analyze([
      '[Req] 31 01 FF 00 FF 01 FF 02',
      '[Resp] 71 01 FF 00 AA FF 01 BB',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.routines).toBeNull();
    expect(ex.verdict).toMatch(/Routine 0xFF00 type 0x01/);
    expect(ex.verdict).not.toMatch(/could not be split/i);
  });

  it('does not attach per-routine NRC sub-rows for batched RC (request alone is ambiguous)', () => {
    const { exchanges } = analyze([
      '[Req] 31 01 FF 00 FF 01 FF 02',
      '[Resp] 7F 31 33',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('FAIL');
    expect(ex.nrcCode).toBe(0x33);
    expect(ex.routines).toBeNull();
  });

  it('still surfaces a single-routine 0x31 exchange the way it did before', () => {
    const { exchanges } = analyze([
      '[Req] 31 01 FF 00',
      '[Resp] 71 01 FF 00',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.routines).toBeNull();
    expect(ex.verdict).toMatch(/Routine 0xFF00 type 0x01/);
  });

  it('does not misclassify a single-routine request with an option record as a 2-RID batch', () => {
    // Request:  31 01 FF 00 12 34         (single RID 0xFF00 + 2-byte option)
    // Response: 71 01 FF 00 99             (normal single-routine response)
    // Regression guard: previous logic treated 2 candidate RIDs as a batch
    // and emitted "could not be split"; new logic preserves legacy rendering.
    const { exchanges } = analyze([
      '[Req] 31 01 FF 00 12 34',
      '[Resp] 71 01 FF 00 99',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.routines).toBeNull();
    expect(ex.verdict).toMatch(/Routine 0xFF00 type 0x01/);
    expect(ex.verdict).not.toMatch(/Multi-routine/i);
    expect(ex.verdict).not.toMatch(/could not be split/i);
  });

  it('handles single-routine request with option record + NRC response without inventing sub-rows', () => {
    const { exchanges } = analyze([
      '[Req] 31 01 FF 00 12 34',
      '[Resp] 7F 31 33',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('FAIL');
    expect(ex.nrcCode).toBe(0x33);
    expect(ex.routines).toBeNull();
  });

  it('handles single-routine request with a longer option record that mimics multiple RIDs', () => {
    // Request:  31 01 FF 00 11 22 33 44      (single RID + 4-byte option)
    // Response: 71 01 FF 00 55                (normal single-routine response)
    // Even with 3 candidate RIDs from the request, the response can't be
    // split, so we fall through to single-routine rendering safely.
    const { exchanges } = analyze([
      '[Req] 31 01 FF 00 11 22 33 44',
      '[Resp] 71 01 FF 00 55',
    ]);
    const ex = exchanges[0];
    expect(ex.severity).toBe('OK');
    expect(ex.routines).toBeNull();
    expect(ex.verdict).toMatch(/Routine 0xFF00 type 0x01/);
  });
});

// ─── Backfill 1: canraw "id-first" trace shape ───────────────────────────────

describe('parseTrace — canraw (id-first) shape', () => {
  it('parses id-first lines without TX/RX keyword and infers direction from SID', () => {
    const { lines, formatDetected, formatCounts } = parseTrace(
      [
        '18DA40F1 03 22 F1 90 CC CC CC CC',   // request — SID 0x22 (RDBI)
        '18DAF140 06 62 F1 90 41 42 43 44',   // response — SID 0x62 (pos RDBI)
      ].join('\n'),
    );
    expect(formatDetected).toBe('canraw');
    expect(formatCounts.canraw).toBe(2);
    expect(lines).toHaveLength(2);
    expect(lines[0].dir).toBe('req');
    expect(lines[0].shape).toBe('canraw');
    expect(lines[0].canId).toBe(0x18DA40F1);
    expect(lines[0].bytes).toEqual([0x22, 0xF1, 0x90]); // SF PCI stripped
    expect(lines[1].dir).toBe('resp');
    expect(lines[1].bytes).toEqual([0x62, 0xF1, 0x90, 0x41, 0x42, 0x43]);
  });

  it('accepts a leading timestamp on a canraw line', () => {
    const { lines, formatDetected } = parseTrace('12.345 18DA40F1 03 22 F1 90');
    expect(formatDetected).toBe('canraw');
    expect(lines).toHaveLength(1);
    expect(lines[0].ts).toBeCloseTo(12.345);
    expect(lines[0].bytes).toEqual([0x22, 0xF1, 0x90]);
  });

  it('accepts an 11-bit CAN id like 7E0 / 7E8', () => {
    const { lines } = parseTrace('7E0 02 10 03\n7E8 06 50 03 00 19 01 F4');
    expect(lines).toHaveLength(2);
    expect(lines[0].canId).toBe(0x7E0);
    expect(lines[0].bytes).toEqual([0x10, 0x03]);
    expect(lines[1].canId).toBe(0x7E8);
    expect(lines[1].bytes).toEqual([0x50, 0x03, 0x00, 0x19, 0x01, 0xF4]);
  });

  it('does NOT misclassify true bare-hex lines as canraw (token-length discriminator)', () => {
    // Each token is 2 chars → bare, not canraw.
    const { formatDetected, lines } = parseTrace('22 F1 90');
    expect(formatDetected).toBe('bare');
    expect(lines[0].shape).toBe('bare');
  });

  it('still produces an exchange the analyzer can pair from a canraw trace', () => {
    const { lines } = parseTrace(
      [
        '18DA40F1 02 27 01',                 // SecAccess seed request
        '18DAF140 06 67 01 AA BB CC DD',     // seed response
      ].join('\n'),
    );
    const { exchanges, summary } = analyzeSession(lines);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].severity).toBe('OK');
    expect(exchanges[0].service).toMatch(/SecurityAccess/i);
    expect(summary.securityAccessSeen).toBe(true);
  });

  it('canraw lines go into formatCounts.canraw bucket', () => {
    const { formatCounts } = parseTrace('18DA40F1 03 22 F1 90\n');
    expect(formatCounts.canraw).toBe(1);
    expect(formatCounts.bare).toBe(0);
  });
});

// ─── Backfill 2: NRC 0x21 and 0x73 plain-cause strings ───────────────────────

describe('analyzeSession — NRC 0x21 busyRepeatRequest plain cause', () => {
  it('surfaces the busy-repeat-request cause for NRC 0x21', () => {
    const { exchanges } = analyze(['[Req] 22 F1 90', '[Resp] 7F 22 21']);
    const ex = exchanges[0];
    expect(ex.nrcCode).toBe(0x21);
    // 0x21 is flagged isPending in the ISO 14229 NRC table (transient retry),
    // so the analyzer correctly classifies it as WARN, not FAIL.
    expect(ex.severity).toBe('WARN');
    expect(ex.verdict).toMatch(/busy/i);
    expect(ex.verdict).toMatch(/retry/i);
  });
});

describe('analyzeSession — NRC 0x73 wrongBlockSequenceCounter plain cause', () => {
  it('surfaces the block-sequence-counter cause for NRC 0x73', () => {
    const { exchanges } = analyze(['[Req] 36 02 AA BB CC', '[Resp] 7F 36 73']);
    const ex = exchanges[0];
    expect(ex.nrcCode).toBe(0x73);
    expect(ex.severity).toBe('FAIL');
    expect(ex.verdict).toMatch(/sequence counter/i);
    expect(ex.verdict).toMatch(/RequestDownload/i);
  });
});

// ─── Backfill 3: SECURED_WITHOUT_UNLOCK diagnosis item ───────────────────────

describe('analyzeSession — SECURED_WITHOUT_UNLOCK diagnosis', () => {
  it('emits SECURED_WITHOUT_UNLOCK (SA never requested) when 0x31 attempted with no SA at all', () => {
    const { diagnosis } = analyze([
      '[Req] 10 03',
      '[Resp] 50 03 00 19 01 F4',
      '[Req] 31 01 FF 00',
      '[Resp] 7F 31 22',
    ]);
    const item = diagnosis.find(d => d.code === 'SECURED_WITHOUT_UNLOCK');
    expect(item).toBeDefined();
    expect(item.severity).toBe('FAIL');
    expect(item.recommendation).toMatch(/No SecurityAccess.*was issued at all/i);
  });

  it('emits SECURED_WITHOUT_UNLOCK (SA requested but not completed) when SA seed was seen but key exchange never succeeded', () => {
    const { diagnosis } = analyze([
      '[Req] 10 03',
      '[Resp] 50 03 00 19 01 F4',
      '[Req] 27 01',
      '[Resp] 67 01 AA BB CC DD',
      // Key send fails — never gets a positive 0x67 response
      '[Req] 27 02 DE AD BE EF',
      '[Resp] 7F 27 35',
      // Then attempts a secured routine before completing unlock
      '[Req] 31 01 FF 00',
      '[Resp] 7F 31 22',
    ]);
    const item = diagnosis.find(d => d.code === 'SECURED_WITHOUT_UNLOCK');
    expect(item).toBeDefined();
    expect(item.severity).toBe('FAIL');
    expect(item.recommendation).toMatch(/SecurityAccess was requested.*no successful unlock/i);
  });

  it('downgrades to WARN when the secured request returned a positive response (trace likely started after unlock)', () => {
    const { diagnosis } = analyze([
      '[Req] 10 03',
      '[Resp] 50 03 00 19 01 F4',
      // No 0x27 in trace at all, but the 0x31 worked — unlock likely
      // happened before logging started. Worth flagging, not a failure.
      '[Req] 31 01 FF 00',
      '[Resp] 71 01 FF 00 00',
    ]);
    const item = diagnosis.find(d => d.code === 'SECURED_WITHOUT_UNLOCK');
    expect(item).toBeDefined();
    expect(item.severity).toBe('WARN');
  });

  it('does NOT emit SECURED_WITHOUT_UNLOCK when unlock was completed before the secured service', () => {
    const { diagnosis } = analyze([
      '[Req] 10 03',
      '[Resp] 50 03 00 19 01 F4',
      '[Req] 27 01',
      '[Resp] 67 01 AA BB CC DD',
      '[Req] 27 02 DE AD BE EF',
      '[Resp] 67 02',           // key accepted — unlocked
      '[Req] 31 01 FF 00',
      '[Resp] 71 01 FF 00 00',
    ]);
    const item = diagnosis.find(d => d.code === 'SECURED_WITHOUT_UNLOCK');
    expect(item).toBeUndefined();
  });

  it('detects SECURED_WITHOUT_UNLOCK for 0x34 RequestDownload attempted without unlock', () => {
    const { diagnosis } = analyze([
      '[Req] 34 00 44 00 10 00 00 00 FF 00',
      '[Resp] 7F 34 33',
    ]);
    const item = diagnosis.find(d => d.code === 'SECURED_WITHOUT_UNLOCK');
    expect(item).toBeDefined();
    expect(item.message).toMatch(/RequestDownload/);
  });

  it('does NOT flag non-secured services (RDBI etc.) even when locked', () => {
    const { diagnosis } = analyze([
      '[Req] 22 F1 90',
      '[Resp] 62 F1 90 31 41 42 43 44',  // VIN read works in extended without unlock
    ]);
    const item = diagnosis.find(d => d.code === 'SECURED_WITHOUT_UNLOCK');
    expect(item).toBeUndefined();
  });
});
