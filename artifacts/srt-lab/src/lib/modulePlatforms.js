/* modulePlatforms — canonical, PLATFORM-AWARE module CAN addresses.

   The audit caught that module addresses DISAGREE across the codebase:
     - liveImmo.js      RFHUB = 0x742 / 0x762
     - TopologyTab.jsx  RFHUB = 0x740 / 0x4C0   (bench-verified)
     - moduleRegistry   RFHUB = 0x75F / 0x767
   These are NOT one bug to "fix" — they are THREE REAL FCA platforms. Collapsing
   them would send an unlock + 0x2E to the WRONG rx-id and brick the module. So
   addresses live here keyed by platform; a consumer asks for (code, platform)
   and gets the right pair. When the platform is unknown, addressVariants(code)
   lists every known pair so the operator (or the identity preflight, which reads
   the part-number DID) can confirm which one actually answers.

   FCA NOTE: on the LD-2019 bench, RX is a LOW id (rx < tx). NEVER derive rx from
   tx (the common tx+8 assumption is wrong here). Treat each (tx, rx) as opaque.

   Provenance: ld-2019 = the bench-verified map from TopologyTab.jsx (sincro
   ecu_addressing.json, 2019 LD); cusw = moduleRegistry.js (CDA6 / tx+8);
   powernet = moduleRegistry PowerNet rows. */

export const DEFAULT_PLATFORM = 'ld-2019';

export const PLATFORMS = {
  'ld-2019':  { label: 'LD 2019+ (Charger / 300 / Challenger)', note: 'bench-verified; RX = LOW id' },
  'cusw':     { label: 'CUSW / CDA6 (tx+8 RX)',                 note: 'moduleRegistry default convention' },
  'powernet': { label: 'PowerNet (legacy)',                     note: 'older body-bus addressing' },
};

// ADDRS[platform][code] = { tx, rx }. Codes are canonical (BCM, RFHUB, IPC, …).
const ADDRS = {
  'ld-2019': {
    BCM:  { tx: 0x620, rx: 0x504 }, PCM:  { tx: 0x7E0, rx: 0x7E8 }, TCM:  { tx: 0x7E1, rx: 0x7E9 },
    ABS:  { tx: 0x747, rx: 0x4C7 }, ORC:  { tx: 0x744, rx: 0x4C4 }, RFHUB:{ tx: 0x740, rx: 0x4C0 },
    ESM:  { tx: 0x749, rx: 0x4C9 }, ACC:  { tx: 0x753, rx: 0x4D3 }, ADCM: { tx: 0x757, rx: 0x4D7 },
    DTCM: { tx: 0x74B, rx: 0x4CB }, TPM:  { tx: 0x743, rx: 0x4C3 }, IPC:  { tx: 0x742, rx: 0x4C2 },
    EPS:  { tx: 0x75A, rx: 0x4DA }, SCCM: { tx: 0x763, rx: 0x4E3 }, PTS:  { tx: 0x762, rx: 0x4E2 },
    HVAC: { tx: 0x783, rx: 0x503 }, AMP:  { tx: 0x7BE, rx: 0x53E }, DDM:  { tx: 0x784, rx: 0x504 },
    PDM:  { tx: 0x785, rx: 0x505 }, CMCM: { tx: 0x7BF, rx: 0x53F },
  },
  'cusw': {
    BCM:  { tx: 0x750, rx: 0x758 }, RFHUB:{ tx: 0x75F, rx: 0x767 }, IPC:  { tx: 0x740, rx: 0x748 },
    ECM:  { tx: 0x7E0, rx: 0x7E8 }, PCM:  { tx: 0x7E0, rx: 0x7E8 }, TCM:  { tx: 0x7E1, rx: 0x7E9 },
    ABS:  { tx: 0x760, rx: 0x768 }, ORC:  { tx: 0x758, rx: 0x760 }, ADCM: { tx: 0x7A8, rx: 0x7B0 },
    EPS:  { tx: 0x761, rx: 0x769 }, HVAC: { tx: 0x751, rx: 0x759 }, SCCM: { tx: 0x74D, rx: 0x76D },
    TIPM: { tx: 0x74C, rx: 0x76C }, SKREEM:{ tx: 0x75A, rx: 0x77A }, RADIO:{ tx: 0x772, rx: 0x77A },
  },
  'powernet': {
    BCM:  { tx: 0x620, rx: 0x628 }, SKIM: { tx: 0x741, rx: 0x749 }, RADIO:{ tx: 0x7C8, rx: 0x7D0 },
    HVAC: { tx: 0x688, rx: 0x690 },
  },
};

/* The single (tx, rx) for a code on a given platform, or null. */
export function getAddr(code, platform = DEFAULT_PLATFORM) {
  const p = ADDRS[platform];
  return (p && p[code]) ? { ...p[code] } : null;
}

/* Every known (platform, tx, rx) pair for a code across all platforms — for an
   operator to choose from, or for the identity preflight to probe in turn, when
   the platform isn't known yet. */
export function addressVariants(code) {
  const out = [];
  for (const [platform, map] of Object.entries(ADDRS)) {
    if (map[code]) out.push({ platform, ...map[code] });
  }
  return out;
}

/* Reverse lookup: which (platform, code) owns a given (tx, rx) pair. */
export function platformForAddr(tx, rx) {
  for (const [platform, map] of Object.entries(ADDRS)) {
    for (const [code, a] of Object.entries(map)) {
      if (a.tx === tx && a.rx === rx) return { platform, code };
    }
  }
  return null;
}

/* All codes known for a platform. */
export function codesForPlatform(platform = DEFAULT_PLATFORM) {
  return Object.keys(ADDRS[platform] || {});
}
