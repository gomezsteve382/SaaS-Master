/* ============================================================================
 * charger62BenchReport.js — pure logic for the 6.2 Charger bench-set
 * cross-check report (Task #769).
 *
 * Exports:
 *   CHARGER62_BENCH_FILES   — descriptor array (role, label, publicPath, origName)
 *   loadCharger62BenchSet() — fetch + wrap all 4 files; returns Promise<{bcmFile,rfhEeeFile,rfhPflashFile,pcmFile}>
 *   buildCharger62Report({ bcmInfo, rfhEeeInfo, rfhPflashInfo, pcmInfo })
 *     → { vinMatrix, securityMatrix, keyMaterial, blockingErrors, donorVin, targetVin, vinDivergent }
 *
 * All logic is pure (no React); the React panel imports this for rendering.
 * ============================================================================ */

const HEX = (arr) =>
  Array.from(arr || [])
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');

const HEX_COMPACT = (arr) =>
  Array.from(arr || [])
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');

const fO = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

/* ----------------------------------------------------------------------------
 * Bench-set file descriptors
 * ---------------------------------------------------------------------------- */
export const CHARGER62_BENCH_FILES = [
  {
    role: 'BCM',
    label: 'BCM D-Flash (64 KB)',
    publicPath: 'bench-sets/bcm_6.2charger.bin',
    origName: '196.2charger_BCMDFLASH_NEWVIN_1779734554788.bin',
    expectedSize: 65536,
  },
  {
    role: 'RFHUB_EEE',
    label: 'RFHUB External EEE (4 KB)',
    publicPath: 'bench-sets/rfhubeee_6.2charger.bin',
    origName: '19charger6,2_rfhubeee_1779733960311.bin',
    expectedSize: 4096,
  },
  {
    role: 'RFHUB_PFLASH',
    label: 'RFHUB Internal P-Flash (384 KB)',
    publicPath: 'bench-sets/rfhubpflash_6.2charger.bin',
    origName: '19charger6.2_rfhubP-flash_1779733960317.bin',
    expectedSize: 393216,
  },
  {
    role: 'PCM',
    label: 'PCM GPEC2A (4 KB)',
    publicPath: 'bench-sets/pcm_6.2charger.bin',
    origName: '6.2CHARGER_NEEDTOUSE_immoFix_1779733593578.bin',
    expectedSize: 4096,
  },
];

/* ----------------------------------------------------------------------------
 * loadCharger62BenchSet()
 *
 * Fetches each binary from the public/bench-sets directory. Returns an object
 * with {bcmFile, rfhEeeFile, rfhPflashFile, pcmFile} each shaped as
 * {name, data: Uint8Array, role, label}.
 * ---------------------------------------------------------------------------- */
export async function loadCharger62BenchSet() {
  const results = await Promise.all(
    CHARGER62_BENCH_FILES.map(async (desc) => {
      const resp = await fetch(desc.publicPath);
      if (!resp.ok) throw new Error(`Fetch failed for ${desc.publicPath}: ${resp.status}`);
      const buf = await resp.arrayBuffer();
      return { name: desc.origName, data: new Uint8Array(buf), role: desc.role, label: desc.label };
    }),
  );

  const [bcmFile, rfhEeeFile, rfhPflashFile, pcmFile] = results;
  return { bcmFile, rfhEeeFile, rfhPflashFile, pcmFile };
}

/* ----------------------------------------------------------------------------
 * Verdict helpers
 * ---------------------------------------------------------------------------- */
function vinVerdict(vin, expectedNonBcm, bcmVin, moduleRole) {
  if (!vin) return { verdict: 'BLANK', color: 'warn' };
  if (moduleRole === 'BCM') {
    if (!expectedNonBcm) return { verdict: 'PASS', color: 'ok' };
    if (vin === expectedNonBcm) return { verdict: 'PASS', color: 'ok' };
    if (vin === bcmVin) return { verdict: 'REVIN', color: 'info', note: `re-VIN\u2019d to ${bcmVin}` };
    return { verdict: 'MISMATCH', color: 'err' };
  }
  if (!bcmVin) return { verdict: 'PASS', color: 'ok' };
  if (vin === expectedNonBcm || vin === bcmVin) {
    return vin === bcmVin ? { verdict: 'PASS', color: 'ok' } : { verdict: 'DONOR', color: 'warn', note: 'donor VIN (pre-re-VIN\u2019d)' };
  }
  return { verdict: 'MISMATCH', color: 'err' };
}

/* ----------------------------------------------------------------------------
 * buildCharger62Report({ bcmInfo, rfhEeeInfo, rfhPflashInfo, pcmInfo })
 * ---------------------------------------------------------------------------- */
export function buildCharger62Report({ bcmInfo, rfhEeeInfo, rfhPflashInfo, pcmInfo }) {
  /* ---- 1. Determine dominant VINs ---- */
  const rfhEeeVins = (rfhEeeInfo.vins || []).map((v) => v.vin).filter(Boolean);
  const pcmVins = (pcmInfo.vins || []).map((v) => v.vin).filter(Boolean);
  const bcmVins = (bcmInfo.vins || []).map((v) => v.vin).filter(Boolean);

  const xc2268VinSlots = rfhPflashInfo.xc2268?.vinSlots || [];
  const pflashVins = xc2268VinSlots.map((s) => s.vin).filter(Boolean);

  const nonBcmVinCounts = {};
  [...rfhEeeVins, ...pcmVins, ...pflashVins].forEach((v) => {
    nonBcmVinCounts[v] = (nonBcmVinCounts[v] || 0) + 1;
  });
  const donorVin = Object.entries(nonBcmVinCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const bcmVinCounts = {};
  bcmVins.forEach((v) => { bcmVinCounts[v] = (bcmVinCounts[v] || 0) + 1; });
  const targetVin = Object.entries(bcmVinCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const vinDivergent = !!(donorVin && targetVin && donorVin !== targetVin);

  /* ---- 2. VIN matrix ---- */
  const vinMatrix = [];

  for (const v of (pcmInfo.vins || [])) {
    const vd = vinVerdict(v.vin, donorVin, targetVin, 'PCM');
    vinMatrix.push({
      module: 'PCM (GPEC2A)',
      role: 'PCM',
      offset: v.offset,
      offsetHex: fO(v.offset),
      vin: v.vin,
      crcOk: v.crcOk,
      ...vd,
    });
  }

  for (const v of (bcmInfo.vins || [])) {
    const vd = vinVerdict(v.vin, donorVin, targetVin, 'BCM');
    vinMatrix.push({
      module: 'BCM D-Flash',
      role: 'BCM',
      offset: v.offset,
      offsetHex: fO(v.offset),
      vin: v.vin,
      crcOk: v.crcOk,
      ...vd,
    });
  }

  for (const v of (rfhEeeInfo.vins || [])) {
    const vd = vinVerdict(v.vin, donorVin, targetVin, 'RFHUB_EEE');
    vinMatrix.push({
      module: 'RFHUB EEE',
      role: 'RFHUB_EEE',
      offset: v.offset,
      offsetHex: fO(v.offset),
      vin: v.vin,
      crcOk: v.crcOk,
      magic: v.magic,
      magicKnown: v.magicKnown,
      ...vd,
    });
  }

  for (const s of xc2268VinSlots) {
    if (!s.present) continue;
    const vd = vinVerdict(s.vin || null, donorVin, targetVin, 'RFHUB_PFLASH');
    vinMatrix.push({
      module: 'RFHUB P-Flash (XC2268)',
      role: 'RFHUB_PFLASH',
      offset: s.offset,
      offsetHex: fO(s.offset),
      vin: s.vin || null,
      crcOk: s.csOk,
      ...vd,
    });
  }

  /* ---- 3. Security matrix ---- */
  const rfhSlot1 = rfhEeeInfo.sec16s?.[0] || null;
  const rfhSlot2 = rfhEeeInfo.sec16s?.[1] || null;
  const bcmSec16 = bcmInfo.bcmSec16 || null;
  const pcmSec6 = pcmInfo.pcmSec6 || null;

  const rfhSec16Raw = rfhSlot1 && !rfhSlot1.blank ? Array.from(rfhSlot1.raw) : null;
  const rfhSec16Hex = rfhSec16Raw ? HEX(rfhSec16Raw) : null;

  const bcmSec16Bytes = bcmSec16?.bytes && !bcmSec16.blank ? Array.from(bcmSec16.bytes) : null;
  const bcmSec16Hex = bcmSec16Bytes ? HEX(bcmSec16Bytes) : null;

  let bcmRfhMatchVerdict = null;
  let bcmRfhMatch = null;
  if (rfhSec16Raw && bcmSec16Bytes) {
    const rfhReversed = [...rfhSec16Raw].reverse();
    bcmRfhMatch = rfhReversed.every((b, i) => b === bcmSec16Bytes[i]);
    bcmRfhMatchVerdict = bcmRfhMatch ? 'PASS' : 'MISMATCH';
  } else if (!rfhSec16Raw) {
    bcmRfhMatchVerdict = 'RFHUB SEC16 BLANK';
  } else {
    bcmRfhMatchVerdict = 'BCM SEC16 BLANK';
  }

  const slot2MatchVerdict = (() => {
    if (!rfhSlot1 || !rfhSlot2) return 'MISSING';
    if (rfhSlot1.blank && rfhSlot2.blank) return 'BOTH BLANK';
    if (rfhSlot1.blank || rfhSlot2.blank) return 'ONE BLANK';
    const s1 = Array.from(rfhSlot1.raw);
    const s2 = Array.from(rfhSlot2.raw);
    return s1.every((b, i) => b === s2[i]) ? 'PASS' : 'MISMATCH';
  })();

  const sec6Raw = rfhSec16Raw ? rfhSec16Raw.slice(0, 6) : null;
  const sec6Hex = sec6Raw ? HEX(sec6Raw) : null;

  let sec6VsPcmVerdict = null;
  if (sec6Raw && pcmSec6?.raw) {
    const pcmS6 = Array.from(pcmSec6.raw instanceof Uint8Array ? pcmSec6.raw : new Uint8Array(pcmSec6.raw));
    const match = sec6Raw.every((b, i) => b === pcmS6[i]);
    sec6VsPcmVerdict = match ? 'PASS' : 'MISMATCH';
  } else if (!sec6Raw) {
    sec6VsPcmVerdict = 'RFHUB SEC16 BLANK';
  } else {
    sec6VsPcmVerdict = 'PCM SEC6 MISSING/BLANK';
  }

  const securityMatrix = [
    {
      label: 'RFHUB EEE SEC16 — Slot 1',
      source: 'RFHUB EEE',
      offset: rfhSlot1 ? fO(rfhSlot1.offset) : null,
      value: rfhSec16Hex || '(blank/missing)',
      csOk: rfhSlot1?.csOk,
      verdict: rfhSlot1?.blank ? 'BLANK' : rfhSlot1?.csOk ? 'PASS' : 'CS ERR',
      note: rfhSlot1?.blank ? 'virgin RFHUB' : null,
    },
    {
      label: 'RFHUB EEE SEC16 — Slot 2',
      source: 'RFHUB EEE',
      offset: rfhSlot2 ? fO(rfhSlot2.offset) : null,
      value: rfhSlot2 ? (rfhSlot2.blank ? '(blank)' : HEX(Array.from(rfhSlot2.raw))) : '(missing)',
      csOk: rfhSlot2?.csOk,
      verdict: slot2MatchVerdict,
      note: 'slots must match for a paired RFHUB',
    },
    {
      label: 'BCM SEC16 (big-endian)',
      source: `BCM D-Flash (${bcmSec16?.source || 'unknown'})`,
      offset: bcmSec16 ? fO(bcmSec16.offset || 0) : null,
      value: bcmSec16Hex || '(blank/missing)',
      verdict: bcmSec16?.blank ? 'BLANK' : 'READ',
      note: bcmSec16?.source ? `source: ${bcmSec16.source}` : null,
    },
    {
      label: 'BCM \u2194 RFHUB SEC16 reverse check',
      source: 'BCM vs RFHUB EEE',
      offset: null,
      value: bcmSec16Bytes && rfhSec16Raw
        ? `BCM=${HEX_COMPACT(bcmSec16Bytes).slice(0, 8)}\u2026 RFH-rev=${HEX_COMPACT([...rfhSec16Raw].reverse()).slice(0, 8)}\u2026`
        : '(insufficient data)',
      verdict: bcmRfhMatchVerdict,
      note: 'BCM SEC16 must equal reverse(RFHUB SEC16)',
    },
    {
      label: 'SEC6 (first 6 bytes of RFHUB SEC16)',
      source: 'RFHUB EEE',
      offset: rfhSlot1 ? fO(rfhSlot1.offset) : null,
      value: sec6Hex || '(blank/missing)',
      verdict: sec6Raw ? 'DERIVED' : 'BLOCKED',
      note: 'used as PCM pairing secret',
    },
    {
      label: 'PCM SEC6 @ 0x03C8 (vs RFHUB SEC16[0:6])',
      source: 'PCM (GPEC2A)',
      offset: pcmSec6 ? fO(pcmSec6.offset) : null,
      value: pcmSec6 ? (pcmSec6.blank ? '(blank/virgin)' : pcmSec6.hex) : '(missing)',
      verdict: sec6VsPcmVerdict,
      note: pcmSec6?.markerOk === false ? 'FF FF FF AA marker MISSING — PCM reports IMMO_DAMAGED to tools' : null,
    },
    {
      label: 'RFHUB P-Flash (XC2268) — SEC16',
      source: 'RFHUB P-Flash',
      offset: null,
      value: 'LIVE_ONLY',
      verdict: 'LIVE_ONLY',
      note: 'SEC16 not stored in XC2268 internal flash; read over OBD only',
    },
  ];

  /* ---- 4. Key material ---- */
  let pin = null;
  if (rfhSec16Raw && rfhSec16Raw.length >= 16) {
    pin = ((rfhSec16Raw[14] << 8) | rfhSec16Raw[15]).toString().padStart(5, '0');
  }

  const fobikSlotsBcm = typeof bcmInfo.fobikCount === 'number' ? bcmInfo.fobikCount : null;
  const fobikSlotsRfh = typeof rfhEeeInfo.fobikSlots === 'number' ? rfhEeeInfo.fobikSlots : null;

  const keyMaterial = {
    skimSecret: rfhSec16Hex,
    skimSecretSource: rfhSlot1 ? `RFHUB EEE @ ${fO(rfhSlot1.offset)}` : 'not found',
    sec6Hex,
    sec6Source: rfhSlot1 ? `RFHUB EEE @ ${fO(rfhSlot1.offset)} [0:6]` : 'not found',
    pin,
    pinSource: rfhSlot1 ? `RFHUB EEE @ ${fO(rfhSlot1.offset)} bytes [14:16], big-endian` : 'not found',
    fobikSlotsBcm,
    fobikSlotsBcmSource: `BCM D-Flash @ 0x5862`,
    fobikSlotsRfh,
    fobikSlotsRfhSource: `RFHUB EEE @ 0x0880 (AA 50 markers)`,
  };

  /* ---- 5. Blocking errors ---- */
  const blockingErrors = [];

  if (!bcmInfo.vins?.length) {
    blockingErrors.push('BCM: no VIN slots found — parse may have failed or file is not a BCM dump');
  }
  if (!rfhEeeInfo.vins?.length && !rfhSlot1) {
    blockingErrors.push('RFHUB EEE: no VIN or SEC16 found — file may not be a Gen2 RFHUB EEPROM');
  }
  if (bcmRfhMatch === false) {
    blockingErrors.push(
      `BCM \u2194 RFHUB SEC16 reverse check FAILED — BCM=${HEX_COMPACT(bcmSec16Bytes || []).slice(0, 8)}\u2026 != rev(RFH)=${HEX_COMPACT([...(rfhSec16Raw || [])].reverse()).slice(0, 8)}\u2026 — this set is NOT safe as a virgin-key basis`,
    );
  }
  if (pflashVins.length > 0 && rfhEeeVins.length > 0) {
    const rfhEeeSet = new Set(rfhEeeVins);
    const pflashVinSet = new Set(pflashVins);
    const agree = [...pflashVinSet].some((v) => rfhEeeSet.has(v));
    if (!agree) {
      blockingErrors.push(
        `XC2268 P-Flash VIN (${[...pflashVinSet][0]}) disagrees with RFHUB EEE VIN (${[...rfhEeeSet][0]}) — flash/EEPROM out of sync`,
      );
    }
  }

  return {
    vinMatrix,
    securityMatrix,
    keyMaterial,
    blockingErrors,
    donorVin,
    targetVin,
    vinDivergent,
    rfhSec16Valid: !!(rfhEeeInfo.sec16valid),
    bcmRfhMatch,
    sec6VsPcmVerdict,
    rfhPflashType: rfhPflashInfo.type,
    rfhPflashXc2268Ok: !!(rfhPflashInfo.xc2268?.ok),
    rfhPflashSize: rfhPflashInfo.size,
  };
}
