// Canonical bench-quick-reference data.
// Mirrors public/srt_lab.py (BCM_CANDIDATES, BCM_ALGORITHMS, CLI commands).
// Keep this file in sync with srt_lab.py if either changes.

export const QR_CMDS = [
  ['python srt_lab.py devices',          'List connected J2534 vendor adapters'],
  ['python srt_lab.py scan',             'Probe all CAN modules, log responders'],
  ['python srt_lab.py unlock-test BCM',  'Try all 17 algorithms against BCM seed'],
  ['python srt_lab.py bcm-write --vin <VIN17>', 'One-shot VIN write to BCM (CDA6 + 2E F190)'],
];

// Mirrors BCM_CANDIDATES in srt_lab.py
export const QR_BCM_CANDIDATES = [
  [0x750, 0x758, 'BCM (CDA6 primary)'],
  [0x742, 0x762, 'BCM (CLAUDE.md/DarkVIN)'],
  [0x7E0, 0x7E8, 'BCM (legacy, pre-2016)'],
  [0x6B0, 0x6B8, 'BCM (DarkVIN alt)'],
  [0x7B0, 0x7B8, 'BCM (swarm scanner)'],
  [0x620, 0x628, 'BCM (PowerNet)'],
];

// Mirrors BCM_ALGORITHMS in srt_lab.py (17 entries)
export const QR_ALGOS = [
  ['CDA6',         'Modern Chrysler BCM/ABS/IPC'],
  ['BCM Standard', 'BCM 2007-2015'],
  ['BCM FCA',      'BCM 2016+'],
  ['GPEC2',        'Continental GPEC2'],
  ['GPEC2 Flash',  'GPEC2 Flash mode'],
  ['GPEC2 EPROM',  'GPEC2 EPROM mode'],
  ['GPEC3',        'GPEC3 2018+'],
  ['GPEC2A',       'GPEC2A variant'],
  ['GPEC2 2015',   'GPEC2 2015-18'],
  ['GPEC1',        'GPEC1 KEY=670269'],
  ['NGC',          'NGC DAIMLERCHRYSLER'],
  ['JTEC',         'JTEC fixed 0000'],
  ['TIPM t8001',   'TIPM 0x80'],
  ['TIPM t3605',   'TIPM 0x36'],
  ['TIPM t8101',   'TIPM 0x81'],
  ['TIPM t3c',     'TIPM 0x3C'],
  ['SBEC',         'Legacy SBEC2/3'],
];

export const QR_BLURB = [
  'Pocket-sized cheat sheet for bench techs running srt_lab.py against Mopar BCMs and powertrain modules.',
  'Cable: J2534 (Autel MaxiFlash / MaxiPro / DrewTech) on Windows 10/11 + Python 3.8+. No pip packages.',
  'Flow: devices -> scan -> unlock-test BCM -> bcm-write --vin <VIN17>. Always confirm BCM CAN ID before writing.',
];
