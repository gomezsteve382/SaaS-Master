import { ALGOS } from './algos.js';

export const SEED_KEY_REF = {
  filename: 'SRT_Lab_SeedKey_Reference.pdf',
  title: 'SEED \u2192 KEY QUICK REFERENCE',
  subtitle: 'FCA / Mopar Security Access Algorithms',
  version: 'v1 \u00B7 14 algorithms',
  intro: [
    'Enter a 32-bit seed (hex) returned by 27 01 / 27 03 / 27 11. Pick the algorithm that matches the target',
    'module family. Reply with 27 02 / 27 04 / 27 12 + the calculated key. JTEC always returns 0x00000000.',
  ],
  sections: [
    {
      label: 'ALGORITHM CATALOG',
      type: 'rows',
      data: {
        headers: ['ALGO', 'HINT', 'TYPICAL TARGET'],
        rows: ALGOS.map(a => [a.n, a.h, algoTarget(a.id)]),
      },
    },
    {
      label: 'UDS SECURITY ACCESS FLOW',
      type: 'cmds',
      data: [
        ['27 01', 'Request seed (level 1, default session)'],
        ['27 03', 'Request seed (level 3, programming session)'],
        ['27 11', 'Request seed (level 11, mfg/extended)'],
        ['27 02 KK KK KK KK', 'Send key (matches level 1)'],
        ['27 04 KK KK KK KK', 'Send key (matches level 3)'],
        ['27 12 KK KK KK KK', 'Send key (matches level 11)'],
      ],
    },
    {
      label: 'TIPS',
      type: 'bullets',
      data: [
        'Seed = 0x00000000 means already unlocked or wrong session.',
        'NRC 0x35 = invalid key, 0x36 = exceeded attempts (cycle ignition), 0x37 = required time delay.',
        'CDA6 covers BCM/ABS/IPC on 2016+ FCA. TIPM uses 16-bit lookup tables (0x80/0x36/0x81/0x3C variants).',
      ],
    },
  ],
  footer: 'SRT Lab \u00B7 Seed/Key Reference \u00B7 For authorized service use only',
  footerRight: 'algos.js',
};

function algoTarget(id) {
  switch (id) {
    case 'gpec1': return 'Pre-2008 GPEC1 PCM';
    case 'gpec2': return 'Continental GPEC2 PCM';
    case 'gpec2_q2': return 'GPEC2 secondary (VILLAIN q2)';
    case 'gpec2f': return 'GPEC2 Flash boot';
    case 'gpec2f_q2': return 'GPEC2 Flash secondary (VILLAIN q2)';
    case 'gpec2e': return 'GPEC2 EPROM mode';
    case 'gpec2e_q2': return 'GPEC2 EPROM secondary (VILLAIN q2)';
    case 'gpec2e_q3': return 'GPEC2 EPROM tertiary (VILLAIN q3)';
    case 'gpec2e_q4': return 'GPEC2 EPROM quaternary (VILLAIN q4)';
    case 'gpec3': return '2018+ GPEC3 PCM';
    case 'gpec3_q2': return 'GPEC3 EPROM secondary (VILLAIN q2)';
    case 'gpec2a': return 'GPEC2A SRT/Hellcat';
    case 'gpec2a_q2': return 'GPEC2A EPROM secondary (VILLAIN q2)';
    case 'gpec15': return 'GPEC2 2015-18';
    case 'gpec15_q2': return 'GPEC2 2015 secondary (VILLAIN q2)';
    case 'ngc': return 'NGC PCM (Daimler era)';
    case 'jtec': return 'JTEC (key always 0x00000000)';
    case 'cda6': return 'BCM / ABS / IPC (2016+)';
    case 't80':   return 'TIPM 0x80 (t8001)';
    case 't36':   return 'TIPM 0x36 (t3605)';
    case 't81':   return 'TIPM 0x81 (t8101)';
    case 't3c':   return 'TIPM 0x3C (t3c)';
    case 't3608': return 'TIPM 0x08 (t3608, VILLAIN confirmed)';
    case 'tc605': return 'TIPM 0xC6 (tc605, VILLAIN confirmed)';
    default: return '';
  }
}

export const IMMO_VIN_REF = {
  filename: 'SRT_Lab_ImmoVIN_Reference.pdf',
  title: 'IMMO / VIN BINARY QUICK REFERENCE',
  subtitle: 'RFHUB EEE (24C32) \u00B7 GPEC2A 95320 SPI',
  version: 'v1 \u00B7 EEPROM offsets',
  intro: [
    'Two-phase workflow: INSPECT a 4KB dump, then APPLY a new VIN / key. RFHUB stores VIN byte-reversed',
    'with CRC8RF; GPEC2A stores VIN as plain ASCII with no CRC. Always verify SKIM byte before write.',
  ],
  sections: [
    {
      label: 'RFHUB EEE (24C32, 4096 B) \u2014 Gen2',
      type: 'rows',
      data: {
        headers: ['REGION', 'OFFSET', 'SIZE', 'NOTE'],
        rows: [
          ['VIN slot 1', '0x0EA5', '17 + 1', 'Reversed ASCII + CRC8RF'],
          ['VIN slot 2', '0x0EB9', '17 + 1', 'Reversed ASCII + CRC8RF'],
          ['VIN slot 3', '0x0ECD', '17 + 1', 'Reversed ASCII + CRC8RF'],
          ['VIN slot 4', '0x0EE1', '17 + 1', 'Reversed ASCII + CRC8RF'],
          ['SEC16 slot 1', '0x00AE', '16 + 2', 'Pairing (XOR LSB)'],
          ['SEC16 slot 2', '0x00C0', '16 + 2', 'Mirror of slot 1'],
          ['Secret key', '0x0040', '16 B', 'Vehicle secret'],
        ],
      },
    },
    {
      label: 'GPEC2A 95320 SPI (4096 B)',
      type: 'rows',
      data: {
        headers: ['REGION', 'OFFSET', 'SIZE', 'NOTE'],
        rows: [
          ['VIN slot 1', '0x0000', '17', 'Plain ASCII (no CRC)'],
          ['VIN slot 2', '0x01F0', '17', 'Plain ASCII (no CRC)'],
          ['VIN slot 3', '0x0224', '17', 'Plain ASCII (no CRC)'],
          ['VIN slot 4', '0x0CE0', '17', 'Plain ASCII (no CRC) — present in both 4 KB and 8 KB GPEC2A images'],
          ['SKIM byte', '0x0011', '1', '0x80 = ENABLED, 0x00 = DISABLED'],
          ['GPEC vehicle/skim key', '0x0203', '8', 'GPEC-INTERNAL — NOT the BCM-pairing field. Mirror @0x0361'],
          ['PCM SEC6 (BCM pairing)', '0x03C8', '6', '= reverse(BCM SEC16)[0:6]. All 0xFF = IMMO_DAMAGED'],
        ],
      },
    },
    {
      label: 'BCM SEC16 \u2014 RESOLVER PRIORITY (Task #380)',
      type: 'rows',
      data: {
        headers: ['SOURCE', 'OFFSET', 'LAYOUT', 'NOTE'],
        rows: [
          ['Split rec 1', '0x81A0', 'hdr FF FF 00..00, idx@+8 (01/02), prefix7@+9, sep 04 04 00 14 @+16, suffix9@+20, trailer 7F/8F @+29', 'SEC16 = prefix7 || suffix9'],
          ['Split rec 2', '0x81C0', 'same layout', 'Mirror of rec 1'],
          ['Split rec 3', '0x81E0', 'same layout', 'Mirror of rec 1'],
          ['Mirror1 record', 'inactive bank', 'hdr 00 00 00 18 00 46 EB 00, idx@+8, SEC16@+9..+25', 'Slot 0xEB / size 0x18'],
          ['Mirror2 record', 'inactive bank', 'hdr 00 00 00 28 00 46 CA 00, idx@+8, SEC16@+9..+25', 'Slot 0xCA / size 0x28'],
          ['Flat (legacy)', '0x40C9', '16 B little-endian', 'Pre-Redeye fallback only \u2014 garbage on synced dumps'],
          ['FEE bank0 seq', '0x0002', '2 B BE', 'Higher seq = ACTIVE bank'],
          ['FEE bank1 seq', '0x4002', '2 B BE', 'Lower seq = INACTIVE bank (mirrors live here)'],
        ],
      },
    },
    {
      label: 'CRC RECIPE (RFHUB)',
      type: 'cmds',
      data: [
        ['poly = 0xA0  init = 0x54  refin/refout', 'CRC8RF over 17 stored (reversed) VIN bytes'],
        ['SKIM 0x80 = enabled / 0x00 bypass / 0x02 alt', 'GPEC2A immobilizer state byte'],
      ],
    },
  ],
  footer: 'SRT Lab \u00B7 ImmoVIN Reference \u00B7 For authorized service use only',
  footerRight: 'ImmoVINTab.jsx',
};

export const SWARM_REF = {
  filename: 'SRT_Lab_Swarm_Reference.pdf',
  title: 'SWARM CAN NEGOTIATOR QUICK REFERENCE',
  subtitle: 'Agentic CAN scan via OBDLink EX / STN \u00B7 ELM327 fallback',
  version: 'v2.0 \u00B7 9 strategies',
  intro: [
    'SWARM probes every known FCA module address with escalating strategies until each module either',
    'CONFIRMS or EXHAUSTS. Run SCOUT (passive ATMA), then HUNTER (7DF broadcast), then SWEEPER (per-mod).',
  ],
  sections: [
    {
      label: 'STRATEGIES (escalating per module)',
      type: 'rows',
      data: {
        headers: ['#', 'NAME', 'ACTION'],
        rows: [
          ['S0', 'EXT_VIN', '10 03 ExtSession then 22 F1 90'],
          ['S1', 'DEF_VIN', '10 01 DefSession then 22 F1 90'],
          ['S2', 'RAW_VIN', '22 F1 90 with no session change'],
          ['S3', 'TESTER_PRESENT', '3E 00 (any positive reply)'],
          ['S4', 'SLOW_TIMING', 'ATST32 + 22 F1 90'],
          ['S5', 'SP5_250K', 'Switch to 250 kbps + 22 F1 90'],
          ['S6', 'SP7_33K', 'Switch to 33.3 kbps + 22 F1 90'],
          ['S7', 'FUNC_BCAST', '7DF broadcast 22 F1 90, log responders'],
          ['S8', 'SOFT_RESET', 'ATZ + re-init + 22 F1 90'],
        ],
      },
    },
    {
      label: 'CORE ELM/STN INIT',
      type: 'cmds',
      data: [
        ['ATZ ; ATE0 ; ATL0 ; ATS1 ; ATH1', 'Reset, echo off, headers on'],
        ['ATSP6 ; ATCAF1 ; ATAT2 ; ATST96', 'ISO15765 11-bit, auto formatting'],
        ['ATFCSH7E0 ; ATFCSD300000 ; ATFCSM1', 'STN flow control for multi-frame'],
        ['ATPP2CSV81 ; ATPP2CON ; ATZ', 'STN: enable MFG extended mode (PP2C=81)'],
        ['ATPP2COFF ; ATPP2DOFF ; ATPPSOFF ; ATD ; ATZ', 'Reset PP back to factory defaults'],
      ],
    },
    {
      label: 'AGENT COLOR LEGEND',
      type: 'grid',
      data: [
        ['SCOUT', 'Passive ATMA bus monitor'],
        ['HUNTER', '7DF functional broadcast'],
        ['SWEEPER', 'Per-module agentic loop'],
        ['SHIFTER', 'Bus speed/protocol shifts'],
        ['BRUTE', 'Exhausted modules'],
        ['FOUND', 'Confirmed responder'],
      ],
    },
  ],
  footer: 'SRT Lab \u00B7 SWARM Reference \u00B7 For authorized service use only',
  footerRight: 'OBDSwarmDiagnostic.jsx',
};

export const J2534_REF = {
  filename: 'SRT_Lab_J2534_Reference.pdf',
  title: 'J2534 RAW CAN SCANNER QUICK REFERENCE',
  subtitle: 'Bypasses ELM327 \u00B7 talks to j2534_bridge.py over WebSocket',
  version: 'v1 \u00B7 PassThru API',
  intro: [
    'Local Python bridge exposes the J2534 PassThru DLL (Autel/DrewTech/OBDLink) to the browser via',
    'ws://localhost:8765. Use this when ELM327 AT command quirks are blocking module discovery.',
  ],
  sections: [
    {
      label: 'BENCH SETUP',
      type: 'cmds',
      data: [
        ['pip install websockets', 'One-time dependency (no other packages required)'],
        ['python j2534_bridge.py', 'Starts WebSocket server on ws://localhost:8765'],
        ['Plug J2534 adapter via USB', 'Autel MaxiFlash / MaxiPro / DrewTech / OBDLink EX'],
        ['Click "Connect Bridge" in tab', 'Then "Open J2534 Device" then "SCAN ALL MODULES"'],
      ],
    },
    {
      label: 'BRIDGE WEBSOCKET COMMANDS',
      type: 'rows',
      data: {
        headers: ['COMMAND', 'PAYLOAD', 'RESPONSE'],
        rows: [
          ['ListDevices', '{}', '{ devices: [{ name }] }'],
          ['Open', '{}', '{ success, deviceName }'],
          ['Connect', '{ baudRate:500000 }', '{ success } (ISO15765 500k)'],
          ['Scan', '{}', '{ success, found:[{name,tx,rx,vin}], total }'],
          ['UDS', '{ txId, rxId, data:[..], timeout }', '{ success, canId, data:[..] }'],
        ],
      },
    },
    {
      label: 'COMMON UDS REQUESTS',
      type: 'cmds',
      data: [
        ['22 F1 90', 'Read VIN (DID F190)'],
        ['22 F1 87', 'Read part number (DID F187)'],
        ['10 03', 'Diagnostic session control - extended'],
        ['27 01', 'Security access - request seed level 1'],
        ['3E 00', 'Tester present (keep session alive)'],
        ['11 01', 'ECU reset - hard reset'],
      ],
    },
    {
      label: 'COMMON QUICK ADDRESSES',
      type: 'grid',
      data: [
        ['ECM', 'TX 0x7E0 / RX 0x7E8'],
        ['BCM (CDA6)', 'TX 0x750 / RX 0x758'],
        ['BCM (alt)', 'TX 0x742 / RX 0x762'],
        ['RFHUB', 'TX 0x75F / RX 0x767'],
        ['ABS', 'TX 0x760 / RX 0x768'],
        ['IPC', 'TX 0x746 / RX 0x766'],  // RE-verified UDS addr
      ],
    },
  ],
  footer: 'SRT Lab \u00B7 J2534 Reference \u00B7 For authorized service use only',
  footerRight: 'J2534Scanner.jsx',
};
