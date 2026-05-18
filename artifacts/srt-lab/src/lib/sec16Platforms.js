/* ============================================================================
 * sec16Platforms.js — Task #678
 *
 * Pure VIN+module classifier that names the platform under test and lists
 * which SEC16 sync rules MUST hold for that platform before key programming
 * is safe. The pre-flight evaluator (sec16Preflight.js) consumes the
 * `requiredRules` list to decide GO / SYNC_REQUIRED / NO_GO; the GO/NO-GO
 * panel in RfhubTab.jsx renders the human-readable `label` + `notes`.
 *
 * Inputs
 *   vin      string|null   — 17-char VIN of the vehicle (may be null)
 *   modules  array         — parseModule() results (each has `.type`)
 *
 * Output
 *   {
 *     platform:   'lx-ld' | 'wk2-jeep' | 'wd-durango' | 'dt-ram-2019plus' | 'unknown',
 *     label:      string,    // human-readable
 *     liveOnly:   boolean,   // true → offline SEC16 not available, OBD only
 *     requiredRules: string[],
 *     optionalRules: string[],
 *     notes:      string[],  // surfaced verbatim under the platform badge
 *     vinSeen:    string|null,
 *   }
 *
 * Rule ids match the crossValidate output message prefixes used by
 * sec16Preflight.js so the mapping is grep-able in both directions.
 *
 * IMPORTANT: this is a pure helper — no DOM, no fetch, no localStorage,
 * no console. UI lives in the consumers.
 * ========================================================================== */

const WMI_TABLE = [
  /* DT/DS Ram 2019+ — VIN WMI 1C6, 3C6, 1D7, 3D7, 1D6, 3D6 plus the
   * legacy 2C6 Promaster (kept under the same XC2268 platform because
   * it ships the same RFHUB). Live-only because the 2019+ RFHUB stores
   * its vehicle-pairing block in internal flash (XC2268N) and does
   * NOT expose it as a flat SEC16 in any field-readable EEPROM image. */
  { re: /^(1C6|3C6|1D7|3D7|1D6|3D6|2C6)/, platform: 'dt-ram-2019plus' },
  /* WK2 Jeep Grand Cherokee (incl Trackhawk SRT) — WMI 1C4RJF / 1C4RJE
   * / 1J4 / 1J8. */
  { re: /^(1C4RJ[EF]|1J[48])/, platform: 'wk2-jeep' },
  /* WD Durango (incl SRT) — WMI 1C4SDH / 1C4PDH / 1C4SDJ / 1C4PDJ. */
  { re: /^(1C4[SP]D[HJ])/, platform: 'wd-durango' },
  /* LX / LD Charger / Challenger / 300 — WMI 2C3, 2B3, 2D3, 2G3, 2C4,
   * plus the Canadian 2D4. */
  { re: /^(2[CBDG]3|2C4|2D4)/, platform: 'lx-ld' },
];

const PLATFORM_META = {
  'lx-ld': {
    label: 'Charger / Challenger / 300 (LX/LD)',
    liveOnly: false,
    requiredRules: [
      'rfhub-bcm-sec16',
      'rfhub-sec16-self',
      'bcm-pcm-sec6',
      'rfhub-pcm-sec6',
    ],
    optionalRules: ['bcm-flat-staleness'],
    notes: [
      'BCM SEC16 must equal reverse(RFHUB SEC16) before key programming.',
      'PCM SEC6 @ 0x3C8 must equal RFHUB SEC16[0:6] (= reverse(BCM SEC16)[0:6]).',
    ],
  },
  'wk2-jeep': {
    label: 'Grand Cherokee / Trackhawk (WK2)',
    liveOnly: false,
    requiredRules: [
      'rfhub-bcm-sec16',
      'rfhub-sec16-self',
      'bcm-pcm-sec6',
      'rfhub-pcm-sec6',
      'rfhub-95640-skey',
      'rfhub-95640-bcm-sec16',
    ],
    optionalRules: ['bcm-flat-staleness'],
    notes: [
      'WK2 dumps include an external 95640 EEPROM that mirrors the BCM SEC16 (reversed @ 0x838).',
      'Trackhawk RFHUB on later MYs has no in-flash SEC16 — read live over OBD if your dump shows blank slots.',
    ],
  },
  'wd-durango': {
    label: 'Durango (WD, incl. SRT)',
    liveOnly: false,
    requiredRules: [
      'rfhub-bcm-sec16',
      'rfhub-sec16-self',
      'bcm-pcm-sec6',
      'rfhub-pcm-sec6',
      'rfhub-95640-skey',
      'rfhub-95640-bcm-sec16',
    ],
    optionalRules: ['bcm-flat-staleness'],
    notes: [
      'Durango shares the WK2 95640 layout — the EEPROM SEC16 @ 0x838 must agree with the RFHUB.',
    ],
  },
  'dt-ram-2019plus': {
    label: 'Ram 1500 / HD 2019+ (DT/DS, XC2268N RFHUB)',
    liveOnly: true,
    requiredRules: [],
    optionalRules: [],
    notes: [
      'XC2268N RFHUB stores its vehicle-pairing block in internal flash — there is no offline SEC16 to validate.',
      'Read and write SEC16 live via OBD (extended session 0x10 0x03 → security 0x27 0x03/0x04 → RoutineControl 0x31 0x01 0x02 0x10).',
    ],
  },
  unknown: {
    label: 'Unknown platform',
    liveOnly: false,
    requiredRules: [
      'rfhub-bcm-sec16',
      'rfhub-sec16-self',
      'bcm-pcm-sec6',
    ],
    optionalRules: ['rfhub-pcm-sec6', 'bcm-flat-staleness'],
    notes: [
      'VIN WMI did not match a known SRT platform — running the conservative baseline rule set.',
    ],
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORM_META);

/**
 * Classify the platform under test. The XC2268 RFHUB override wins over
 * VIN WMI because a tech may load a 2019+ Ram dump without typing the
 * VIN in first, and the RFHUB image itself is the more authoritative
 * signal in that case.
 */
export function classifyPlatform({ vin = null, modules = [] } = {}) {
  const xcRfhub = (modules || []).find((m) => m && m.type === 'XC2268_RFHUB');
  const vinSeen = typeof vin === 'string' && vin.length === 17 ? vin.toUpperCase() : null;

  let platform = null;
  if (xcRfhub) {
    platform = 'dt-ram-2019plus';
  } else if (vinSeen) {
    for (const row of WMI_TABLE) {
      if (row.re.test(vinSeen)) { platform = row.platform; break; }
    }
  }
  if (!platform) platform = 'unknown';

  const meta = PLATFORM_META[platform];
  return {
    platform,
    label: meta.label,
    liveOnly: meta.liveOnly,
    requiredRules: [...meta.requiredRules],
    optionalRules: [...meta.optionalRules],
    notes: [...meta.notes],
    vinSeen,
    xc2268Detected: !!xcRfhub,
  };
}

export function platformMeta(platform) {
  return PLATFORM_META[platform] || PLATFORM_META.unknown;
}
