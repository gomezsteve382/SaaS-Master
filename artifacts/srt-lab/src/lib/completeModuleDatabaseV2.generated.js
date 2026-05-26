// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/complete-module-database-v2.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// Complete module catalog v2 — 22 modules with EXPLICIT verified flags.
// 8 verified against wiTECH; 14 are pattern matches NOT verified on a vehicle.

export const COMPLETE_MODULES_V2 = [
  {
    "code": "BCM",
    "name": "Body Control Module",
    "tx": "0x7E0",
    "rx": "0x7E8",
    "verified": true,
    "source": "wiTECH",
    "description": "Central body electronics control - lighting, locks, windows, security"
  },
  {
    "code": "ECM",
    "name": "Engine Control Module",
    "tx": "0x7E0",
    "rx": "0x7E8",
    "verified": true,
    "source": "wiTECH",
    "description": "Engine management - fuel injection, ignition, emissions"
  },
  {
    "code": "TCM",
    "name": "Transmission Control Module",
    "tx": "0x7E1",
    "rx": "0x7E9",
    "verified": true,
    "source": "wiTECH",
    "description": "Transmission control - shift points, torque converter"
  },
  {
    "code": "RFHUB",
    "name": "RF Hub / SKIM",
    "tx": "0x742",
    "rx": "0x762",
    "verified": true,
    "source": "wiTECH",
    "description": "Key fob receiver and immobilizer - wireless entry, remote start"
  },
  {
    "code": "ABS",
    "name": "Anti-lock Brake System",
    "tx": "0x760",
    "rx": "0x768",
    "verified": true,
    "source": "wiTECH",
    "description": "Brake control - ABS, traction control, stability control"
  },
  {
    "code": "CCM",
    "name": "Climate Control Module",
    "tx": "0x743",
    "rx": "0x763",
    "verified": true,
    "source": "wiTECH",
    "description": "HVAC control - air conditioning, heating, ventilation"
  },
  {
    "code": "ADM",
    "name": "Active Dampening Module",
    "tx": "0x744",
    "rx": "0x764",
    "verified": true,
    "source": "wiTECH",
    "description": "Active suspension control - adaptive dampening"
  },
  {
    "code": "SDM",
    "name": "Suspension Dampening Module",
    "tx": "0x745",
    "rx": "0x765",
    "verified": true,
    "source": "wiTECH",
    "description": "Suspension control - air suspension, ride height"
  },
  {
    "code": "IPCM",
    "name": "Instrument Panel Cluster Module",
    "tx": "0x746",
    "rx": "0x766",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Gauges and displays - speedometer, tachometer, warning lights"
  },
  {
    "code": "ORC",
    "name": "Occupant Restraint Controller",
    "tx": "0x747",
    "rx": "0x767",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Airbag system - deployment control, crash sensors"
  },
  {
    "code": "DDM",
    "name": "Driver Door Module",
    "tx": "0x748",
    "rx": "0x768",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Driver door functions - locks, windows, mirrors"
  },
  {
    "code": "PDM",
    "name": "Passenger Door Module",
    "tx": "0x749",
    "rx": "0x769",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Passenger door functions - locks, windows, mirrors"
  },
  {
    "code": "EPS",
    "name": "Electric Power Steering",
    "tx": "0x74A",
    "rx": "0x76A",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Power steering control - assist level, returnability"
  },
  {
    "code": "SCCM",
    "name": "Steering Column Control Module",
    "tx": "0x74B",
    "rx": "0x76B",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Steering column functions - tilt, telescope, lock"
  },
  {
    "code": "PAM",
    "name": "Park Assist Module",
    "tx": "0x74C",
    "rx": "0x76C",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Parking sensors - ultrasonic detection, alerts"
  },
  {
    "code": "TCCM",
    "name": "Transfer Case Control Module",
    "tx": "0x74D",
    "rx": "0x76D",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "4WD/AWD control - transfer case, differential locks"
  },
  {
    "code": "TPMS",
    "name": "Tire Pressure Monitoring System",
    "tx": "0x74E",
    "rx": "0x76E",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Tire pressure monitoring - sensors, alerts"
  },
  {
    "code": "SGW",
    "name": "Security Gateway Module",
    "tx": "0x74F",
    "rx": "0x76F",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "CAN gateway security - module authentication, firewall"
  },
  {
    "code": "ACC",
    "name": "Adaptive Cruise Control",
    "tx": "0x750",
    "rx": "0x770",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Cruise control - adaptive speed, distance keeping"
  },
  {
    "code": "ESM",
    "name": "Electronic Shifter Module",
    "tx": "0x751",
    "rx": "0x771",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Electronic shifter - gear selection, park lock"
  },
  {
    "code": "EPB",
    "name": "Electronic Parking Brake",
    "tx": "0x752",
    "rx": "0x772",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Electronic parking brake - apply, release, hill hold"
  },
  {
    "code": "RADIO",
    "name": "Radio / Infotainment",
    "tx": "0x753",
    "rx": "0x773",
    "verified": false,
    "source": "AlfaOBD + Standard CAN",
    "description": "Audio system - radio, navigation, connectivity"
  }
];

export const COMPLETE_V2_NOTES = {
  "verified_modules": "8 modules verified from wiTECH/CDA6 data",
  "alfaobd_modules": "14 additional modules from AlfaOBD screenshots",
  "can_addresses": "Unverified addresses follow standard automotive CAN patterns (0x740-0x77F range)",
  "testing_required": "All unverified modules need real vehicle testing to confirm CAN addresses",
  "address_conflicts": "Some modules may share TX addresses (BCM/ECM both use 0x7E0) - this is normal for different diagnostic sessions"
};

export const COMPLETE_MODULE_DB_V2_META = {
  "version": "2.0",
  "source": "AlfaOBD 2.5.6.0 + wiTECH/CDA6 + Standard Automotive CAN",
  "date": "2025-10-28",
  "totalModules": 22,
  "verifiedCount": 8,
  "unverifiedCount": 14
};
