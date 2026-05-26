// Canonical bench-quick-reference data.
//
// QR_BCM_CANDIDATES, QR_ALGOS, and QR_MODULES are auto-generated from
// public/srt_lab.py by scripts/generate-quickref-data.mjs. Adding a BCM
// CAN ID or a new security algorithm in the Python script automatically
// flows into the printed cheat sheet on next build.
//
// QR_CMDS and QR_BLURB stay hand-maintained: they describe how to
// invoke the script, not data inside it.
export { QR_BCM_CANDIDATES, QR_ALGOS, QR_MODULES } from './quickRefData.generated.js';

export const QR_CMDS = [
  ['python srt_lab.py devices',          'List connected J2534 vendor adapters'],
  ['python srt_lab.py scan',             'Probe all CAN modules, log responders'],
  ['python srt_lab.py unlock-test BCM',  'Try all 17 algorithms against BCM seed'],
  ['python srt_lab.py bcm-write --vin <VIN17>', 'One-shot VIN write to BCM (CDA6 + 2E F190)'],
];

export const QR_BLURB = [
  'Pocket-sized cheat sheet for bench techs running srt_lab.py against Mopar BCMs and powertrain modules.',
  'Cable: J2534 (Autel MaxiFlash / MaxiPro / DrewTech) on Windows 10/11 + Python 3.8+. No pip packages.',
  'Flow: devices -> scan -> unlock-test BCM -> bcm-write --vin <VIN17>. Always confirm BCM CAN ID before writing.',
];
