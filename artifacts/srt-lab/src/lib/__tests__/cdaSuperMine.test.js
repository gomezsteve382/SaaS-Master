import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CDA_SID_INDEX,
  CDA_DID_INDEX,
  CDA_ROUTINE_INDEX,
  CDA_BINARY_DATA,
  CDA_COMMANDS_CATALOG,
  CDA_EVENTS_CATALOG,
  CDA_ENDPOINTS_CATALOG,
  CDA_LOCALIZATION_KEYS,
} from '../cdaCatalog.js';

// ─────────────────────────────────────────────────────────────────────────
// Bench trace #3 — SUPER-MINE catalogs.
//
// Pins the structural shape and key counts of the deep AS3 ABC mine
// performed by tools/cda-extractor/src/extract.mjs. If the extractor
// regresses (e.g. drops the hot-class scoping, breaks the call-graph
// approximation, or stops merging across DoABC tags) this test is the
// first thing to fail.
//
// All catalogs MUST share the same SWF sha256 — proves they came from
// a single deterministic re-extraction of the canonical SWF body.
// ─────────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SWF_PATH   = path.join(REPO_ROOT, 'attached_assets', 'CDA_1776448059516.swf');

const EXPECTED_SHA = 'd8b08bd85cf1a7f83ac560dab1fdbfc50ada701e767e290229e66d9cc5c6560f';

const swfExists = fs.existsSync(SWF_PATH);
const describeIfSwf = swfExists ? describe : describe.skip;

describe('CDA super-mine catalogs — provenance', () => {
  it('every super-mine catalog is keyed to the same canonical SWF sha256', () => {
    for (const cat of [
      CDA_SID_INDEX, CDA_DID_INDEX, CDA_ROUTINE_INDEX,
      CDA_BINARY_DATA, CDA_COMMANDS_CATALOG, CDA_EVENTS_CATALOG,
      CDA_ENDPOINTS_CATALOG, CDA_LOCALIZATION_KEYS,
    ]) {
      expect(cat?._meta?.sha256).toBe(EXPECTED_SHA);
    }
  });
});

describeIfSwf('CDA super-mine catalogs — content (requires SWF)', () => {
  it('SID index is scoped to HOT classes and surfaces the expected UDS services', () => {
    const byHex = Object.fromEntries(CDA_SID_INDEX.services.map(s => [s.hex, s]));
    // Every UDS SID we know about must appear as an entry (even if 0 refs).
    for (const hex of ['0x10','0x11','0x14','0x19','0x22','0x27','0x2E','0x31','0x34','0x36','0x37','0x3E']) {
      expect(byHex[hex], `missing SID entry ${hex}`).toBeDefined();
    }
    // Diagnostic Session Control should fire from many places (it is THE
    // most-pushed UDS byte in the diagnostic tree). Pin a floor of 20
    // refs to catch the "scoping accidentally dropped" regression.
    expect(byHex['0x10'].refCount).toBeGreaterThanOrEqual(20);
    // SecurityAccess should show up in at least one HOT class — proves
    // the SecurityGatewayCommand / EcuDiagnostics tree got mined.
    expect(byHex['0x27'].refCount).toBeGreaterThanOrEqual(1);
    // 0x83/0x85/0x86/0x87 must be present (architectural fact: SWF UI
    // never authors them as raw bytes — they live in native MVCI). We
    // pin them at exactly 0 refs so a future regression that starts
    // pulling in non-diagnostic classes immediately fails this test.
    for (const hex of ['0x83','0x85','0x86','0x87']) {
      expect(byHex[hex].refCount).toBe(0);
    }
  });

  it('Commands catalog covers every Command/Message/Event class', () => {
    expect(CDA_COMMANDS_CATALOG.count).toBeGreaterThan(300);
    const bySimple = Object.fromEntries(
      CDA_COMMANDS_CATALOG.commands.map(c => [c.simpleName, c])
    );
    // A handful of commands the flasher state machine actually drives:
    for (const required of [
      'EnterDiagnosticSessionCommand',
      'StartFlashCommand',
      'SecurityGatewayCommand',
      'ResetECUCommand',
    ]) {
      expect(bySimple[required], `missing command class ${required}`).toBeDefined();
    }
    // Kind classification must always be one of three buckets.
    for (const c of CDA_COMMANDS_CATALOG.commands) {
      expect(['command','message','event']).toContain(c.kind);
    }
  });

  it('Events catalog is built from the HOT call graph and includes flash callbacks', () => {
    expect(CDA_EVENTS_CATALOG.count).toBeGreaterThan(10);
    const eventNames = new Set(CDA_EVENTS_CATALOG.events.map(e => e.event));
    // At least one onBoardRoutines / onAuth / onFlash style callback
    // must be in the catalog. Pin a known-good one observed in the live
    // extraction; if naming drifts, the test points at the right place
    // to update the assertion.
    const hasFlashCallback = [...eventNames].some(n => /^on(?:Board|Authenticate|Start|Fetch)/.test(n));
    expect(hasFlashCallback, `events catalog has no flash/auth callback: ${[...eventNames].slice(0,20).join(', ')}`).toBe(true);
  });

  it('Endpoints catalog at minimum includes the offline-flash REST path', () => {
    const paths = CDA_ENDPOINTS_CATALOG.endpoints.map(e => e.path);
    expect(paths).toContain('vehicle/flash/start/');
  });

  it('Localization keys catalog has the broadcast-message + auth-popup buckets', () => {
    expect(CDA_LOCALIZATION_KEYS.count).toBeGreaterThan(100);
    const keys = new Set(CDA_LOCALIZATION_KEYS.keys.map(k => k.key));
    const hasBroadcast = [...keys].some(k => k.startsWith('broadcastmessages.'));
    const hasAuth      = [...keys].some(k => k.startsWith('authenticatedDiagnosticsLoginPopup.'));
    expect(hasBroadcast, 'expected at least one broadcastmessages.* key').toBe(true);
    expect(hasAuth, 'expected at least one authenticatedDiagnosticsLoginPopup.* key').toBe(true);
  });

  it('Binary data inventory is small and contains no diagnostic payloads', () => {
    // The SWF has 9 DefineBinaryData tags totalling ~12 KB. They are
    // all blend-mode shader / text-layout helpers. If a future SWF
    // version starts shipping flash payloads inline this test fails
    // and we re-evaluate.
    expect(CDA_BINARY_DATA.count).toBeLessThan(20);
    for (const b of CDA_BINARY_DATA.binaryData) {
      expect(b.length).toBeLessThan(64 * 1024);
    }
  });

  it('SID index does NOT leak framework classes into the diagnostic-tree refs', () => {
    // HOT scoping must reject mx.*, adobe.*, flash.*, spark.* and other
    // framework namespaces. If a future regression broadens HOT_CLASS_RE
    // (e.g. accidentally matching "Download" mid-name in
    // mx.preloaders::SparkDownloadProgressBar) this test fails loudly.
    const FRAMEWORK_NS_RE = /^(?:mx|adobe|flash|fl|spark|com\.adobe|flashx|org\.osmf|com\.greensock|com\.bit101|com\.hurlant)\b/i;
    for (const svc of CDA_SID_INDEX.services) {
      for (const r of svc.refs) {
        expect(
          FRAMEWORK_NS_RE.test(r.class),
          `${svc.hex} ${svc.name} refs leaked framework class ${r.class}`
        ).toBe(false);
      }
    }
  });

  it('every HOT class lives in a cda.* namespace (no framework leakage at the source)', () => {
    // Defense in depth: check the raw udsByClass catalog so the regression
    // is caught at the producer, not just the SID-index consumer.
    const fp = path.join(REPO_ROOT, 'tools', 'cda-extractor', 'out', 'cdaUdsByClass.generated.json');
    if (!fs.existsSync(fp)) return; // skip if the heavy JSON isn't present
    const all = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const [className, v] of Object.entries(all.classes)) {
      if (!v.hot) continue;
      expect(
        /(?:^|\.)cda\./.test(className),
        `non-cda class flagged hot: ${className}`
      ).toBe(true);
    }
  });

  it('Routine + DID catalogs document the "lives in native layer" finding', () => {
    // After scoping to HOT classes, both catalogs are nearly empty —
    // confirming that DIDs and routine IDs are composed in the native
    // MVCI/J2534 layer rather than authored as AS3 constants. Pin
    // small ceilings so that if a future regression accidentally
    // re-includes cold framework classes (which would push the counts
    // back into the hundreds with junk) the test fails loudly.
    expect(CDA_DID_INDEX.didCount).toBeLessThan(50);
    expect(CDA_ROUTINE_INDEX.routineCount).toBeLessThan(50);
  });
});
