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
