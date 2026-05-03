#!/usr/bin/env ts-node
/**
 * scan-witech-dump.ts
 * -------------------
 * Mine the Stellantis wiTECH Erlang/OTP memory dump for:
 *   - SGW challenge/cert flow symbols
 *   - UDS helper function names
 *   - Nearby byte context around each hit (±256 bytes)
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec ts-node src/scan-witech-dump.ts \
 *       --dump /tmp/villain_gpec/wiTECH_wde.DMP \
 *       --out  /tmp/witech_scan_results.json
 *
 * If --out is omitted, results are written to stdout.
 * If the dump file is absent the script exits with a clear message
 * rather than silently producing an empty report.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
const DUMP_PATH  = flag('dump')  ?? '/tmp/villain_gpec/wiTECH_wde.DMP';
const OUT_PATH   = flag('out');
const WINDOW     = parseInt(flag('window') ?? '256', 10);

// ── Symbols to locate ─────────────────────────────────────────────────────────
//
// SGW challenge / cert flow — the manufacturing-server calls that the OEM tool
// uses to authenticate the SGW without a pre-shared key baked locally.
const SGW_FLOW_SYMBOLS: string[] = [
  'request_sgw_signed_challenge_from_manufacturing_server',
  'request_sgw_cert_from_manufacturing_server',
  'SecurityGatewayCommand',
  'unlockSecurityGateway',
  'dongleUnlockSecurityGateway',
  'flashUnlockSecurityGateway',
  'SGWJsonHTTPAction',
  'sgwTimeoutHTTPActionContext',
];

// Erlang module-level entry points
const ERLANG_MODULE_SYMBOLS: string[] = [
  'device_unlock_ecu',
  'whs_ecu_unlock',
  'veh_unlock',
  'veh_sgw',
  'whs_ecu_memory',
  'whs_flash',
  'whs_ecu_raw',
  'flash_sup',
  'jcanflash',
  'rmflash',
  'vrflash',
  'protocol_kline',
  'protocol_services',
];

// UDS helper functions — these drive the actual on-wire service frames
const UDS_FUNCTION_SYMBOLS: string[] = [
  'read_seed',
  'send_key',
  'pre_unlock_init',
  'read_memory',
  'write_memory',
  'enter_diagnostic_session',
  'disable_normal_messages',
  'enable_normal_messages',
  'enable_fault_setting',
  'disable_fault_setting',
  'send_tester_present',
  'read_partnumber',
  'read_vin',
  'read_flash_partnumber',
  'read_software_number',
  'read_hardware_number',
];

const ALL_SYMBOLS = [
  ...SGW_FLOW_SYMBOLS,
  ...ERLANG_MODULE_SYMBOLS,
  ...UDS_FUNCTION_SYMBOLS,
];

// ── Types ─────────────────────────────────────────────────────────────────────
interface Hit {
  symbol: string;
  category: 'sgw_flow' | 'erlang_module' | 'uds_function';
  offset: number;
  offsetHex: string;
  contextBefore: string; // hex dump
  contextAfter:  string;
  printableContext: string; // ASCII printable chars in ±WINDOW
}

interface ScanReport {
  dumpPath:   string;
  dumpSizeMB: number;
  scanDate:   string;
  windowBytes: number;
  hits:       Hit[];
  symbolsSeen:    string[];
  symbolsMissing: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function categoryOf(sym: string): Hit['category'] {
  if (SGW_FLOW_SYMBOLS.includes(sym))     return 'sgw_flow';
  if (ERLANG_MODULE_SYMBOLS.includes(sym)) return 'erlang_module';
  return 'uds_function';
}

function hexDump(buf: Buffer, start: number, len: number): string {
  const end = Math.min(start + len, buf.length);
  const slice = buf.subarray(start, end);
  const parts: string[] = [];
  for (let i = 0; i < slice.length; i += 16) {
    const row = slice.subarray(i, i + 16);
    const hex = Array.from(row).map(b => b.toString(16).padStart(2, '0')).join(' ');
    parts.push(hex);
  }
  return parts.join('\n');
}

function printable(buf: Buffer, start: number, len: number): string {
  const end = Math.min(start + len, buf.length);
  let out = '';
  for (let i = start; i < end; i++) {
    const b = buf[i];
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  return out;
}

/** Find all byte offsets of `needle` (as UTF-8) inside `haystack`. */
function findAll(haystack: Buffer, needle: string): number[] {
  const pat = Buffer.from(needle, 'utf8');
  const offsets: number[] = [];
  let pos = 0;
  while (pos <= haystack.length - pat.length) {
    const idx = haystack.indexOf(pat, pos);
    if (idx < 0) break;
    offsets.push(idx);
    pos = idx + 1;
  }
  return offsets;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  if (!fs.existsSync(DUMP_PATH)) {
    process.stderr.write(
      `ERROR: Dump file not found: ${DUMP_PATH}\n` +
      `       Place the wiTECH_wde.DMP file at that path and re-run.\n` +
      `       Expected size: ~77 MB (Erlang/OTP BEAM memory dump)\n`,
    );
    process.exit(1);
  }

  const stat = fs.statSync(DUMP_PATH);
  const dumpSizeMB = +(stat.size / 1024 / 1024).toFixed(2);
  process.stderr.write(`Loading ${DUMP_PATH} (${dumpSizeMB} MB)…\n`);

  const buf = fs.readFileSync(DUMP_PATH);
  process.stderr.write(`Loaded. Scanning for ${ALL_SYMBOLS.length} symbols (±${WINDOW} byte window)…\n`);

  const hits: Hit[] = [];
  const symbolsSeen = new Set<string>();

  for (const sym of ALL_SYMBOLS) {
    const offsets = findAll(buf, sym);
    if (offsets.length === 0) continue;
    symbolsSeen.add(sym);

    for (const offset of offsets) {
      const before = Math.max(0, offset - WINDOW);
      const after  = Math.min(buf.length, offset + sym.length + WINDOW);
      hits.push({
        symbol:  sym,
        category: categoryOf(sym),
        offset,
        offsetHex: '0x' + offset.toString(16).toUpperCase().padStart(8, '0'),
        contextBefore:  hexDump(buf, before, offset - before),
        contextAfter:   hexDump(buf, offset + sym.length, after - offset - sym.length),
        printableContext: printable(buf, before, after - before),
      });
    }

    process.stderr.write(`  ${sym}: ${offsets.length} hit(s) @ ${offsets.map(o => '0x' + o.toString(16).toUpperCase()).join(', ')}\n`);
  }

  const symbolsMissing = ALL_SYMBOLS.filter(s => !symbolsSeen.has(s));
  if (symbolsMissing.length > 0) {
    process.stderr.write(`\nMISSING (0 hits): ${symbolsMissing.join(', ')}\n`);
  }

  const report: ScanReport = {
    dumpPath: path.resolve(DUMP_PATH),
    dumpSizeMB,
    scanDate: new Date().toISOString(),
    windowBytes: WINDOW,
    hits,
    symbolsSeen: [...symbolsSeen],
    symbolsMissing,
  };

  const json = JSON.stringify(report, null, 2);
  if (OUT_PATH) {
    fs.writeFileSync(OUT_PATH, json, 'utf8');
    process.stderr.write(`\nReport written to ${OUT_PATH}\n`);
    process.stderr.write(`  Total hits : ${hits.length}\n`);
    process.stderr.write(`  Symbols found  : ${symbolsSeen.size}/${ALL_SYMBOLS.length}\n`);
    process.stderr.write(`  Symbols missing: ${symbolsMissing.length}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
}

main();
