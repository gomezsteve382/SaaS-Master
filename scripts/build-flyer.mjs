#!/usr/bin/env node
import {writeFileSync, mkdirSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR  = resolve(__dirname, '..', 'attached_assets', 'flyers');
const SVG_PATH = resolve(OUT_DIR, 'srt_lab_flyer.svg');
const PNG_PATH = resolve(OUT_DIR, 'srt_lab_flyer.png');
const PDF_PATH = resolve(OUT_DIR, 'srt_lab_flyer.pdf');

mkdirSync(OUT_DIR, {recursive: true});

// 8.5 x 11 in at 300 dpi = 2550 x 3300
const W = 2550, H = 3300;

const C = {
  bg:   '#0A0A0A',
  ink:  '#0F0F0F',
  card: '#141414',
  edge: '#1F1F1F',
  red:  '#D32F2F',
  red2: '#FF1744',
  red3: '#7A0F0F',
  bone: '#F4F1EC',
  ash:  '#9E9E9E',
  dim:  '#5A5A5A',
  ok:   '#00C853',
  amber:'#FFB300',
  cyan: '#00BFA5',
  blue: '#2979FF',
  pur:  '#AA00FF',
  org:  '#FF6D00',
};

const display = `font-family="Righteous, sans-serif"`;
const body    = `font-family="Nunito, sans-serif"`;
const mono    = `font-family="JetBrains Mono, monospace"`;

// ── tile helper ────────────────────────────────────────────────────────────
function block({x, y, w, h, eyebrow, title, accent, hits, tag}) {
  const pad = 36;
  // hairline frame + eyebrow strip
  let s = '';
  s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${C.card}" stroke="${C.edge}" stroke-width="2"/>`;
  s += `<rect x="${x}" y="${y}" width="10" height="${h}" fill="${accent}"/>`;
  s += `<rect x="${x+pad}" y="${y+pad-4}" width="${w-pad*2}" height="2" fill="${C.edge}"/>`;
  s += `<text x="${x+pad}" y="${y+pad+34}" ${mono} font-size="22" letter-spacing="6" fill="${accent}" font-weight="700">${escapeXml(eyebrow)}</text>`;
  s += `<text x="${x+pad}" y="${y+pad+96}" ${display} font-size="58" fill="${C.bone}">${escapeXml(title)}</text>`;
  // bullets
  let by = y + pad + 156;
  for (const h of hits) {
    // dot
    s += `<rect x="${x+pad}" y="${by-22}" width="14" height="14" fill="${accent}"/>`;
    // bold lead + body
    const m = h.match(/^([^—]+?)\s+—\s+(.*)$/);
    if (m) {
      s += `<text x="${x+pad+30}" y="${by-8}" ${body} font-size="26" font-weight="900" fill="${C.bone}">${escapeXml(m[1].trim())}</text>`;
      s += `<text x="${x+pad+30}" y="${by+30}" ${body} font-size="24" font-weight="500" fill="${C.ash}">${escapeXml(m[2].trim())}</text>`;
      by += 72;
    } else {
      s += `<text x="${x+pad+30}" y="${by-8}" ${body} font-size="26" font-weight="700" fill="${C.bone}">${escapeXml(h)}</text>`;
      by += 50;
    }
  }
  // tag chip bottom-right
  if (tag) {
    const tw = tag.length * 14 + 36;
    s += `<rect x="${x+w-tw-pad}" y="${y+h-pad-44}" width="${tw}" height="36" fill="${C.ink}" stroke="${accent}" stroke-width="1.5"/>`;
    s += `<text x="${x+w-tw-pad+18}" y="${y+h-pad-18}" ${mono} font-size="18" letter-spacing="3" fill="${accent}" font-weight="700">${escapeXml(tag)}</text>`;
  }
  return s;
}

function escapeXml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ── grain / noise field for matte feel ─────────────────────────────────────
let grain = '';
{
  // sparse pseudo-random specks; deterministic so re-runs match
  let seed = 1337;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 1400; i++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H);
    const a = (0.02 + rnd()*0.05).toFixed(3);
    grain += `<rect x="${x}" y="${y}" width="2" height="2" fill="#FFFFFF" opacity="${a}"/>`;
  }
}

// ── HERO ───────────────────────────────────────────────────────────────────
const hero = `
  <!-- diagonal red gash -->
  <defs>
    <linearGradient id="redgash" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${C.red3}" stop-opacity="0"/>
      <stop offset="0.45" stop-color="${C.red}" stop-opacity="1"/>
      <stop offset="0.55" stop-color="${C.red2}" stop-opacity="1"/>
      <stop offset="1" stop-color="${C.red3}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bgwash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0E0E0E"/>
      <stop offset="0.5" stop-color="#0A0A0A"/>
      <stop offset="1" stop-color="#050505"/>
    </linearGradient>
  </defs>

  <!-- left rail registration marks -->
  <g fill="${C.red}">
    <rect x="60" y="120" width="6" height="60"/>
    <rect x="60" y="200" width="6" height="20"/>
    <rect x="60" y="240" width="6" height="180"/>
    <rect x="60" y="440" width="6" height="40"/>
  </g>

  <!-- header micro-strip -->
  <text x="120" y="160" ${mono} font-size="22" letter-spacing="8" fill="${C.ash}">// FCA / STELLANTIS  ·  2009 → 2026  ·  WORKBENCH BUILD</text>
  <text x="${W-120}" y="160" ${mono} font-size="22" letter-spacing="8" fill="${C.ash}" text-anchor="end">REV  v1.0  ·  18 TABS  ·  CLIENT-SIDE</text>

  <!-- the wordmark -->
  <text x="120" y="430" ${display} font-size="240" fill="${C.bone}" letter-spacing="-2">SRT LAB</text>
  <text x="120" y="560" ${display} font-size="118" fill="${C.red2}" letter-spacing="-1">JAILBREAK EDITION</text>

  <!-- crash bar -->
  <rect x="0" y="610" width="${W}" height="30" fill="url(#redgash)"/>
  <rect x="120" y="608" width="430" height="34" fill="${C.bone}"/>
  <text x="335" y="636" ${mono} font-size="22" letter-spacing="6" fill="${C.ink}" text-anchor="middle" font-weight="700">FCA / STELLANTIS</text>

  <!-- subhead -->
  <text x="120" y="760" ${body} font-size="40" font-weight="900" fill="${C.bone}">An ECU module workbench you can actually run from a browser tab.</text>
  <text x="120" y="820" ${body} font-size="32" font-weight="500" fill="${C.ash}">Read VINs. Patch bins. Talk UDS. Crack the secure gateway. No cloud, no telemetry, no subscription.</text>

  <!-- callout chips -->
  <g>
    <rect x="120" y="880" width="540" height="80" fill="${C.ink}" stroke="${C.red}" stroke-width="2"/>
    <text x="148" y="918" ${mono} font-size="22" letter-spacing="4" fill="${C.red2}" font-weight="700">XTEA  ·  SGW UNLOCK</text>
    <text x="148" y="948" ${body} font-size="22" font-weight="700" fill="${C.bone}">2018+ Secure Gateway · key from CDA.swf</text>

    <rect x="688" y="880" width="540" height="80" fill="${C.ink}" stroke="${C.cyan}" stroke-width="2"/>
    <text x="716" y="918" ${mono} font-size="22" letter-spacing="4" fill="${C.cyan}" font-weight="700">14  ·  SEED → KEY ALGOS</text>
    <text x="716" y="948" ${body} font-size="22" font-weight="700" fill="${C.bone}">CDA6 · GPEC1/2/2A/3 · NGC · JTEC · TIPM · SBEC</text>

    <rect x="1256" y="880" width="540" height="80" fill="${C.ink}" stroke="${C.org}" stroke-width="2"/>
    <text x="1284" y="918" ${mono} font-size="22" letter-spacing="4" fill="${C.org}" font-weight="700">AUTEL J2534  ·  HTTP BRIDGE</text>
    <text x="1284" y="948" ${body} font-size="22" font-weight="700" fill="${C.bone}">MaxiFlash VCI · raw PassThru when serial isn't enough</text>

    <rect x="1824" y="880" width="606" height="80" fill="${C.ink}" stroke="${C.amber}" stroke-width="2"/>
    <text x="1852" y="918" ${mono} font-size="22" letter-spacing="4" fill="${C.amber}" font-weight="700">ON-BENCH  ·  BIN PATCHER</text>
    <text x="1852" y="948" ${body} font-size="22" font-weight="700" fill="${C.bone}">GPEC2A · RFHUB · BCM · 95640 — auto-detect &amp; CRC</text>
  </g>
`;

// ── BLOCKS ────────────────────────────────────────────────────────────────
const COLS = 2;
const COL_W = 1155;
const COL_H = 700;
const GAP = 30;
const X0 = 120, Y0 = 1020;

const blocks = [
  {
    eyebrow:'01  ·  LIVE OBD & UDS',
    title:'Talk to the car.',
    accent: C.blue,
    tag:'WEB SERIAL',
    hits:[
      'ELM327 / STN — auto-init (ATZ 3000 ms · STN PP2C/PP2D), one-click reconnect',
      'Multi-module scan — BCM · RFHUB · ECM · TCM · ADCM · IPC · ABS · TIPM · SGW',
      'Raw UDS console — type 22 F1 90, get bytes back, NRC names decoded inline',
      'Unlock chain — preferred algo first, then walks the fallback list on NRC 0x35',
      'Response-pending aware — handles 0x78 polling without dropping the session',
    ],
  },
  {
    eyebrow:'02  ·  VIN SURGERY',
    title:'Write the VIN. Verify it stuck.',
    accent: C.red2,
    tag:'PER-DID READ-BACK',
    hits:[
      'Six DIDs covered — F190 · 7B90 · 7B88 · 6E2025 · 6E2027 · 6EF190',
      '24-bit DID encoding — 0x6E_____ space encoded as 3 bytes, no silent truncation',
      'Per-module DID list — BCM gets 6E2025, RFHUB gets 6E2027, EPS gets 6EF190',
      'Tail-8 comparator — accepts either full 17 or trailing-8 on mirror DIDs',
      'Write-gating — refuses 2E if unlock failed, no half-flashed modules',
    ],
  },
  {
    eyebrow:'03  ·  MODULE BIN WORKBENCH',
    title:'Drag in a dump. Get the truth.',
    accent: C.cyan,
    tag:'CLIENT-SIDE PARSE',
    hits:[
      'Auto-detect — GPEC2A · RFHUB Gen1/Gen2 · BCM D-FLASH · 95640 EEPROM',
      'CRC primitives — CCITT-FALSE 0x1021 · 95640 0x42 · RFHUB 0xA0 reflected',
      'VIN patch with CRC — patches every slot, recomputes every checksum',
      'Virginizer · SKIM toggle · ZZZZ tamper check · transponder & secret keys',
      'IMMO backup sync — mirrors 0x40C0 → 0x2000 (192 B), 24-byte SKIM records',
    ],
  },
  {
    eyebrow:'04  ·  SECURITY & SEED→KEY',
    title:'Fourteen algos. One XTEA.',
    accent: C.pur,
    tag:'NRC-AWARE CHAIN',
    hits:[
      'XTEA SGW — 128-bit key from CDA.swf, 32 rounds, 4-byte and 8-byte seeds',
      'Per-module pref — ECM/TCM/DAMP/ADCM → GPEC2; body bus → CDA6; SGW → XTEA',
      'ADCM Routine 0x0312 — primary unlock with SBEC fallback on rejection',
      'RFH ↔ PCM pairing — vehicle secret cross-check, byte-reversed endian',
      'Cross-vehicle key matcher — sync VINs + keys from a chosen source module',
    ],
  },
  {
    eyebrow:'05  ·  HARDWARE & WORKFLOWS',
    title:'Cable in. Coffee on. Go.',
    accent: C.org,
    tag:'BENCH OR IN-CAR',
    hits:[
      'Autel MaxiFlash J2534 — local HTTP bridge daemon for SGW-routed writes',
      'Program-All — guided BCM → RFHUB → ECM → ADCM with cross-verify gates',
      'On-bench mode — full UDS over a bench harness, no car required',
      'Backups (50) + Sessions (500) — per-write paper trail with PDF export',
      'Jailbreak presets — SRT · Demon · Hellcat · Redeye feature unlocks',
    ],
  },
  {
    eyebrow:'06  ·  18 TABS  ·  ONE TAB IN YOUR BROWSER',
    title:'Everything, in plain sight.',
    accent: C.amber,
    tag:'NO INSTALL',
    hits:[
      'PROGRAM ALL · BCM · RFHUB · ECM · ADCM — the daily driver flow',
      'UDS PROGRAMMER · BACKUPS · SESSIONS · JAILBREAK — power-user surface',
      'DUMPS · BENCH · SEED→KEY · GPEC · GPEC2A — bench & bin work',
      'FCA ANALYZER · LIVE OBD · SWARM · J2534 — diagnostic & hardware',
      'Inline styles · React 18 + Vite · pnpm monorepo · Node 24',
    ],
  },
];

let blocksSvg = '';
blocks.forEach((b, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = X0 + col * (COL_W + GAP);
  const y = Y0 + row * (COL_H + GAP);
  blocksSvg += block({x, y, w: COL_W, h: COL_H, ...b});
});

// ── FOOTER ────────────────────────────────────────────────────────────────
const footY = Y0 + 3 * (COL_H + GAP) + 10;
const footer = `
  <!-- top divider -->
  <rect x="120" y="${footY}" width="${W-240}" height="2" fill="${C.edge}"/>

  <!-- big mono tagline -->
  <text x="120" y="${footY+90}" ${mono} font-size="42" letter-spacing="6" fill="${C.bone}" font-weight="700">
    100% CLIENT-SIDE  ·  NO TELEMETRY  ·  WEB SERIAL + J2534
  </text>
  <text x="120" y="${footY+150}" ${body} font-size="26" font-weight="500" fill="${C.ash}">
    Open the page. Plug in the cable. The car talks. Your data never leaves the laptop.
  </text>

  <!-- bottom strip -->
  <rect x="0" y="${H-90}" width="${W}" height="90" fill="${C.red}"/>
  <text x="120" y="${H-30}" ${display} font-size="44" fill="${C.bone}">SRT LAB</text>
  <text x="${W/2}" y="${H-32}" ${mono} font-size="22" letter-spacing="8" fill="${C.bone}" text-anchor="middle" font-weight="700">// JAILBREAK EDITION  ·  FCA / STELLANTIS  ·  v1.0</text>
  <text x="${W-120}" y="${H-30}" ${mono} font-size="22" letter-spacing="6" fill="${C.bone}" text-anchor="end" font-weight="700">srt-lab // workbench</text>
`;

// ── compose ───────────────────────────────────────────────────────────────
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="url(#bgwash)"/>
  ${grain}
  ${hero}
  ${blocksSvg}
  ${footer}
</svg>`;

writeFileSync(SVG_PATH, svg);
console.log('wrote', SVG_PATH, svg.length, 'bytes');

// Render PNG and PDF via librsvg (proper SVG renderer with full font support).
// Resolve rsvg-convert from the IM delegate registry so we don't hard-code a
// nix store hash that may rotate between rebuilds.
function resolveRsvg() {
  try {
    const out = execSync('magick -list delegate', {encoding: 'utf8'});
    const m = out.match(/svg\s*=>\s*"([^"\s]*rsvg-convert)/);
    if (m) return m[1];
  } catch {}
  // last-ditch: hope it's on PATH
  return 'rsvg-convert';
}
const RSVG = resolveRsvg();
console.log('using', RSVG);

execSync(`${RSVG} -f png -b "${C.bg}" -o "${PNG_PATH}" "${SVG_PATH}"`, {stdio: 'inherit'});
console.log('wrote', PNG_PATH);

execSync(`${RSVG} -f pdf -b "${C.bg}" -o "${PDF_PATH}" "${SVG_PATH}"`, {stdio: 'inherit'});
console.log('wrote', PDF_PATH);
