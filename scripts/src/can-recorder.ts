#!/usr/bin/env tsx
/**
 * can-recorder — sibling CLI to the J2534 desktop bridge.
 *
 * Polls the bridge's existing read endpoint over HTTP and writes every
 * frame it sees to a candump-format `.log` on disk. **Does not modify**
 * `tools/python-bridge/` — talks to its existing API only.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run can-recorder \
 *     --out capture.log --bridge http://127.0.0.1:8765 --iface can0 \
 *     --duration 30
 *
 * The bridge is expected to expose `POST /readmsg` (the canonical lowercase
 * path the existing repo bridge uses; `--poll` overrides it for forks) that
 * returns `{ frames: [{ canId, ext, data }] }` — the same envelope the
 * existing bench bridge uses. Frames lacking a timestamp are stamped at
 * receive time so the resulting log is monotonically ordered.
 */

import { writeFileSync, appendFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { writeCandumpLine, type CandumpFrame } from '@workspace/uds';

interface Args {
  out: string;
  bridge: string;
  iface: string;
  durationSec: number;
  pollPath: string;
  pollMs: number;
  channel: number;
}

function parseArgs(a: string[]): Args {
  const out: Args = {
    out: 'capture.log',
    bridge: 'http://127.0.0.1:8765',
    iface: 'can0',
    durationSec: 0,
    pollPath: '/readmsg',
    pollMs: 5,
    channel: 0,
  };
  for (let i = 2; i < a.length; i++) {
    const k = a[i];
    const v = a[i + 1];
    if (k === '--out')      { out.out = v;            i++; }
    else if (k === '--bridge')   { out.bridge = v.replace(/\/+$/, ''); i++; }
    else if (k === '--iface')    { out.iface = v;     i++; }
    else if (k === '--duration') { out.durationSec = Number(v); i++; }
    else if (k === '--poll')     { out.pollPath = v;  i++; }
    else if (k === '--poll-ms')  { out.pollMs = Number(v); i++; }
    else if (k === '--channel')  { out.channel = Number(v); i++; }
    else if (k === '--help' || k === '-h') {
      console.log('can-recorder --out FILE [--bridge URL] [--iface NAME] [--duration SEC] [--poll PATH] [--poll-ms MS] [--channel N]');
      exit(0);
    }
  }
  return out;
}

interface BridgeFrame {
  canId?: number;
  id?: number;
  ext?: boolean;
  extended?: boolean;
  data?: number[] | string;
  ts?: number;
  timestamp?: number;
}

function normaliseFrame(raw: BridgeFrame, fallbackTs: number, iface: string): CandumpFrame | null {
  const id = raw.canId ?? raw.id;
  if (typeof id !== 'number') return null;
  const ext = !!(raw.ext ?? raw.extended ?? id > 0x7FF);
  let data: Uint8Array;
  if (raw.data instanceof Uint8Array) data = raw.data;
  else if (Array.isArray(raw.data)) data = new Uint8Array(raw.data);
  else if (typeof raw.data === 'string') {
    const clean = raw.data.replace(/[^0-9a-fA-F]/g, '');
    data = new Uint8Array(clean.length / 2);
    for (let i = 0; i < data.length; i++) data[i] = parseInt(clean.substr(i * 2, 2), 16);
  } else data = new Uint8Array(0);
  return {
    ts: raw.ts ?? raw.timestamp ?? fallbackTs,
    iface, id, ext, fd: false, rtr: false, data, fdFlags: null,
  };
}

async function poll(url: string, channel: number): Promise<BridgeFrame[]> {
  // The existing bridge accepts either GET or POST {channel} on /readmsg.
  // Try POST first, fall back to GET. Treat HTTP errors as no-data.
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel }),
    });
    if (!r.ok) return [];
    const j = await r.json() as { frames?: BridgeFrame[]; messages?: BridgeFrame[] };
    return j.frames ?? j.messages ?? [];
  } catch {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (!r.ok) return [];
      const j = await r.json() as { frames?: BridgeFrame[] };
      return j.frames ?? [];
    } catch { return []; }
  }
}

async function main() {
  const args = parseArgs(argv);
  writeFileSync(args.out, '');
  const start = Date.now() / 1000;
  const stopAt = args.durationSec > 0 ? start + args.durationSec : Infinity;
  let frameCount = 0;
  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  stdout.write(`can-recorder: writing ${args.out} (bridge=${args.bridge}, iface=${args.iface})\n`);

  const url = `${args.bridge}${args.pollPath}`;
  while (!stop && Date.now() / 1000 < stopAt) {
    const raws = await poll(url, args.channel);
    if (raws.length) {
      const now = Date.now() / 1000 - start;
      const lines: string[] = [];
      for (const r of raws) {
        const f = normaliseFrame(r, now, args.iface);
        if (f) { lines.push(writeCandumpLine(f)); frameCount++; }
      }
      if (lines.length) appendFileSync(args.out, lines.join('\n') + '\n');
    }
    await new Promise(r => setTimeout(r, args.pollMs));
  }
  stdout.write(`can-recorder: stopped after ${frameCount} frames\n`);
}

main().catch(e => { console.error(e); exit(1); });
