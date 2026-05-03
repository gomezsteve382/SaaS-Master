import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CDA_FLASH_CATALOG, CDA_VIN_CATALOG, CDA_RESET_CATALOG, getOfflineFlashSequence } from '../cdaCatalog.js';

// ─────────────────────────────────────────────────────────────────────────
// Bench trace #2 — offline flash / VIN-write / module-reset sequences.
//
// Sister test to cdaSwfSgwBenchTrace.test.js. Where THAT test pins the
// SGW VIN-storage absence proof, THIS test pins the live JSON catalogs
// emitted by tools/cda-extractor against a fresh re-extraction of the
// SWF. If the catalogs drift from the SWF, this test fails before any
// downstream code (flasherStateMachine, Cda6SessionTab, vinProgrammer)
// gets a chance to consume stale data.
//
// Skip behavior: when attached_assets/CDA_1776448059516.swf is missing
// (fresh checkout), the SWF re-extraction half is skipped and the test
// only validates the structural shape of the committed JSON catalogs.
// ─────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SWF_PATH = path.join(REPO_ROOT, 'attached_assets', 'CDA_1776448059516.swf');
const EXTRACTOR_DIR = path.join(REPO_ROOT, 'tools', 'cda-extractor');
const EXPECTED_INFLATED_SHA = 'd8b08bd85cf1a7f83ac560dab1fdbfc50ada701e767e290229e66d9cc5c6560f';
const CANONICAL_INFLATED_LENGTH = 8716982;

const swfExists = fs.existsSync(SWF_PATH);
const describeIfSwf = swfExists ? describe : describe.skip;

describe('CDA offline flash / VIN-write / module-reset catalogs', () => {
  it('cdaFlashSequences catalog has every flash phase for ECM, BCM, RFHUB, SGW', () => {
    expect(CDA_FLASH_CATALOG).toBeDefined();
    expect(CDA_FLASH_CATALOG.modules).toBeDefined();
    for (const code of ['ECM', 'BCM', 'RFHUB', 'SGW']) {
      const m = CDA_FLASH_CATALOG.modules[code];
      expect(m, `expected module ${code} in flash catalog`).toBeDefined();
      const phases = m.sequence.map(s => s.phase);
      // The 8 critical UDS phases that every offline flash MUST emit.
      for (const required of ['session_extended', 'session_program', 'seed', 'key', 'erase', 'request_download', 'transfer', 'transfer_exit', 'checksum', 'reset']) {
        expect(phases, `${code} sequence missing required phase ${required}`).toContain(required);
      }
    }
  });

  it('SGW module routes through xtea_sgw, ECM/TCM/ADCM through gpec2, BCM/RFHUB/IPC through cda6', () => {
    expect(CDA_FLASH_CATALOG.modules.SGW.unlockAlgo).toBe('xtea_sgw');
    expect(CDA_FLASH_CATALOG.modules.ECM.unlockAlgo).toBe('gpec2');
    expect(CDA_FLASH_CATALOG.modules.TCM.unlockAlgo).toBe('gpec2');
    expect(CDA_FLASH_CATALOG.modules.ADCM.unlockAlgo).toBe('gpec2');
    expect(CDA_FLASH_CATALOG.modules.BCM.unlockAlgo).toBe('cda6');
    expect(CDA_FLASH_CATALOG.modules.RFHUB.unlockAlgo).toBe('cda6');
    expect(CDA_FLASH_CATALOG.modules.IPC.unlockAlgo).toBe('cda6');
  });

  it('VIN catalog records BCM 0x6E2025 and RFHUB 0x6E2027 mirrors', () => {
    expect(CDA_VIN_CATALOG.didsByModule.BCM).toContain('0x6E2025');
    expect(CDA_VIN_CATALOG.didsByModule.RFHUB).toContain('0x6E2027');
    expect(CDA_VIN_CATALOG.didsByModule.default).toEqual(['0xF190', '0x7B90', '0x7B88']);
    expect(CDA_VIN_CATALOG.didsByModule.EPS).toEqual(['0xF190', '0x6EF190']);
  });

  it('Reset catalog records hardReset (11 01) and softReset (11 03) per ISO 14229', () => {
    expect(CDA_RESET_CATALOG.variants.hardReset.sid).toBe(0x11);
    expect(CDA_RESET_CATALOG.variants.hardReset.sub).toBe(0x01);
    expect(CDA_RESET_CATALOG.variants.softReset.sid).toBe(0x11);
    expect(CDA_RESET_CATALOG.variants.softReset.sub).toBe(0x03);
  });

  it('getOfflineFlashSequence(code) resolves to module sequence with provenance', () => {
    const seq = getOfflineFlashSequence('ECM');
    expect(Array.isArray(seq)).toBe(true);
    expect(seq.length).toBeGreaterThanOrEqual(10);
    expect(seq[0].swfClass).toMatch(/EnterDiagnosticSession/);
    // Unknown module returns null instead of throwing.
    expect(getOfflineFlashSequence('NOPE')).toBeNull();
  });

  it('committed catalog _meta pins canonical inflated SHA-256 (d8b08bd8…)', () => {
    expect(CDA_FLASH_CATALOG._meta.sha256).toBe(EXPECTED_INFLATED_SHA);
    expect(CDA_FLASH_CATALOG._meta.inflatedBytes).toBe(CANONICAL_INFLATED_LENGTH);
    expect(CDA_VIN_CATALOG._meta.sha256).toBe(EXPECTED_INFLATED_SHA);
    expect(CDA_RESET_CATALOG._meta.sha256).toBe(EXPECTED_INFLATED_SHA);
  });
});

describeIfSwf('CDA SWF — offline flash catalog matches fresh re-extraction', () => {
  it('extractor --check passes against the committed JSON catalogs', () => {
    // If the SWF or extractor logic changes and the on-disk JSONs become
    // stale, --check exits non-zero and execSync throws.
    let out;
    try {
      out = execSync('node ./src/extract.mjs --check', { cwd: EXTRACTOR_DIR, encoding: 'utf8' });
    } catch (e) {
      throw new Error(`cda-extractor --check failed:\n${e.stdout || ''}\n${e.stderr || ''}`);
    }
    expect(out).toMatch(/OK|catalogs match/);
  });

  it('SWF inflates to canonical length and SHA matches the catalog _meta', () => {
    const raw = fs.readFileSync(SWF_PATH);
    const body = zlib.inflateSync(raw.slice(8));
    expect(body.length).toBe(CANONICAL_INFLATED_LENGTH);
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    expect(sha).toBe(EXPECTED_INFLATED_SHA);
  });
});
