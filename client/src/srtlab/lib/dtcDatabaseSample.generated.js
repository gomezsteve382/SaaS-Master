// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/dtc-database-sample.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// SAMPLE DTC reference — 10 commonly-seen Chrysler/FCA codes. These are
// generic FCA repair-doc descriptions, NOT extracted from the AlfaOBD
// .db Faults table. Use as UI seed/example only.
//
// RETRACTION: the previous "real catalog size 20,043" claim came from a
// naive /[A-Z][0-9]{4}/ regex run on a 66 MB XOR-decrypted .db with
// 5-10% byte residual — that regex matches random byte triples; the
// sequential B0000..B0050 listing in extraction-report.md is the tell.
// User-verified search for P/B/C/U-format ASCII DTCs in the recovered
// .db returns ZERO hits. The real Faults table row shape
// (per analysis_notes.txt) is (hexcode TEXT, device_id TEXT, code_en,
// code_de, code_cz, code_es, code_fr, code_hu, code_it, code_po, code_ru)
// and identifying its rows in lost_and_found is pending.

export const DTC_SAMPLE = [
  {
    "code": "P0300",
    "codeType": "P",
    "moduleCode": "ECM",
    "description": "Random/Multiple Cylinder Misfire Detected",
    "causes": [
      "Faulty spark plugs or ignition coils",
      "Vacuum leak",
      "Low fuel pressure",
      "Faulty fuel injectors",
      "Worn or damaged engine components"
    ],
    "symptoms": [
      "Check Engine Light illuminated",
      "Engine runs rough or hesitates",
      "Loss of power",
      "Poor fuel economy"
    ],
    "repairProcedures": [
      "Scan for additional codes",
      "Inspect spark plugs and replace if worn",
      "Check ignition coils with multimeter",
      "Test fuel pressure (should be 58 PSI for Pentastar)",
      "Inspect for vacuum leaks",
      "Check compression on all cylinders"
    ],
    "severity": "high"
  },
  {
    "code": "P0171",
    "codeType": "P",
    "moduleCode": "ECM",
    "description": "System Too Lean (Bank 1)",
    "causes": [
      "Vacuum leak",
      "Faulty MAF sensor",
      "Weak fuel pump",
      "Clogged fuel filter",
      "Faulty oxygen sensor"
    ],
    "symptoms": [
      "Check Engine Light on",
      "Rough idle",
      "Hesitation on acceleration",
      "Poor fuel economy"
    ],
    "repairProcedures": [
      "Inspect for vacuum leaks using smoke machine",
      "Clean MAF sensor with MAF cleaner",
      "Test fuel pressure",
      "Check oxygen sensor readings with scan tool",
      "Inspect PCV valve and hoses"
    ],
    "severity": "medium"
  },
  {
    "code": "B1602",
    "codeType": "B",
    "moduleCode": "BCM",
    "description": "VIN Configuration Error",
    "causes": [
      "VIN not programmed in BCM",
      "VIN mismatch between modules",
      "Corrupted BCM memory",
      "Failed VIN programming attempt"
    ],
    "symptoms": [
      "Multiple warning lights",
      "Some features may not work",
      "Security system issues"
    ],
    "repairProcedures": [
      "Verify VIN matches vehicle registration",
      "Use dealer scan tool to reprogram VIN",
      "Ensure VIN matches across ECM, BCM, TCM",
      "Clear codes after successful programming",
      "Perform BCM configuration if needed"
    ],
    "severity": "high"
  },
  {
    "code": "U0100",
    "codeType": "U",
    "moduleCode": "BCM",
    "description": "Lost Communication with ECM/PCM",
    "causes": [
      "Faulty CAN bus wiring",
      "Loose or corroded connectors",
      "Failed ECM",
      "Failed BCM",
      "Short circuit in CAN network"
    ],
    "symptoms": [
      "Check Engine Light on",
      "Multiple warning lights",
      "Vehicle may not start",
      "Loss of features"
    ],
    "repairProcedures": [
      "Check CAN bus termination resistance (should be 60 ohms)",
      "Inspect CAN wiring for damage",
      "Check ECM and BCM connectors",
      "Scan all modules for communication",
      "Isolate faulty module by disconnecting one at a time"
    ],
    "severity": "critical"
  },
  {
    "code": "P0562",
    "codeType": "P",
    "moduleCode": "ECM",
    "description": "System Voltage Low",
    "causes": [
      "Weak battery",
      "Faulty alternator",
      "Loose or corroded battery terminals",
      "Excessive electrical load",
      "Faulty voltage regulator"
    ],
    "symptoms": [
      "Check Engine Light on",
      "Dim headlights",
      "Slow cranking",
      "Electrical accessories not working properly"
    ],
    "repairProcedures": [
      "Test battery voltage (should be 12.6V)",
      "Load test battery",
      "Test alternator output (should be 13.5-14.5V)",
      "Check battery terminals for corrosion",
      "Inspect alternator belt tension"
    ],
    "severity": "medium"
  },
  {
    "code": "C121C",
    "codeType": "C",
    "moduleCode": "ABS",
    "description": "ABS Pump Motor Circuit Malfunction",
    "causes": [
      "Faulty ABS pump motor",
      "Wiring issue to ABS module",
      "Failed ABS module",
      "Low system voltage"
    ],
    "symptoms": [
      "ABS warning light on",
      "ABS not functioning",
      "Traction control disabled"
    ],
    "repairProcedures": [
      "Check ABS fuse",
      "Test ABS pump motor operation",
      "Inspect wiring harness for damage",
      "Check ground connections",
      "Replace ABS module if internal fault"
    ],
    "severity": "high"
  },
  {
    "code": "P0128",
    "codeType": "P",
    "moduleCode": "ECM",
    "description": "Coolant Thermostat (Coolant Temperature Below Thermostat Regulating Temperature)",
    "causes": [
      "Stuck open thermostat",
      "Faulty coolant temperature sensor",
      "Low coolant level",
      "Air in cooling system"
    ],
    "symptoms": [
      "Check Engine Light on",
      "Poor heater performance",
      "Longer warm-up time",
      "Poor fuel economy"
    ],
    "repairProcedures": [
      "Check coolant level",
      "Test thermostat operation (opens at 195°F for Pentastar)",
      "Verify coolant temperature sensor readings",
      "Bleed cooling system if air present",
      "Replace thermostat if stuck open"
    ],
    "severity": "low"
  },
  {
    "code": "B2AAA",
    "codeType": "B",
    "moduleCode": "RFHUB",
    "description": "RFHUB Internal Fault",
    "causes": [
      "Corrupted RFHUB memory",
      "Failed RFHUB module",
      "VIN programming error",
      "Security byte mismatch"
    ],
    "symptoms": [
      "Remote start not working",
      "Key fob not recognized",
      "Security light flashing",
      "No-start condition"
    ],
    "repairProcedures": [
      "Verify VIN programming in RFHUB",
      "Check security bytes match SKIM/BCM",
      "Reprogram RFHUB with dealer tool",
      "Perform SKIM pairing procedure",
      "Replace RFHUB if internal failure"
    ],
    "severity": "high"
  },
  {
    "code": "P0420",
    "codeType": "P",
    "moduleCode": "ECM",
    "description": "Catalyst System Efficiency Below Threshold (Bank 1)",
    "causes": [
      "Failed catalytic converter",
      "Faulty oxygen sensors",
      "Engine misfire",
      "Exhaust leak",
      "Rich or lean fuel condition"
    ],
    "symptoms": [
      "Check Engine Light on",
      "Reduced fuel economy",
      "Possible rotten egg smell",
      "Loss of power"
    ],
    "repairProcedures": [
      "Check for exhaust leaks",
      "Verify oxygen sensor operation",
      "Check for misfires (P030X codes)",
      "Test catalytic converter efficiency",
      "Replace catalytic converter if failed"
    ],
    "severity": "medium"
  },
  {
    "code": "P0700",
    "codeType": "P",
    "moduleCode": "TCM",
    "description": "Transmission Control System Malfunction",
    "causes": [
      "Failed TCM",
      "Transmission internal fault",
      "Wiring issue",
      "Low transmission fluid",
      "Faulty shift solenoid"
    ],
    "symptoms": [
      "Check Engine Light on",
      "Transmission warning light on",
      "Harsh shifting",
      "No shifting",
      "Limp mode"
    ],
    "repairProcedures": [
      "Scan TCM for additional codes",
      "Check transmission fluid level and condition",
      "Test shift solenoids",
      "Inspect wiring harness",
      "Perform TCM relearn if replaced"
    ],
    "severity": "high"
  }
];

export const DTC_SAMPLE_META = {
  "totalSamples": 10,
  "realCatalogSize": null,
  "realCatalogSizeRetractedNote": "Earlier 20,043 figure was a regex artifact, not real count. See header.",
  "source": "Generic FCA Chrysler community repair docs (NOT extracted from AlfaOBD .db)",
  "useFor": "UI seed/example data only — load the full Faults table once lost_and_found rows are matched to its shape."
};
