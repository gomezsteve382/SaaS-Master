// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/did-database.json
// Re-extract: node scripts/extract-did-database.mjs
//
// UDS Data Identifier (DID) catalog. The F1xx-range entries are ISO 14229
// standard DIDs — high confidence. The module-specific entries (F1B0+
// per-module ranges) are educated guesses based on common FCA conventions;
// each is flagged with `confidence: "unverified_module_specific"` and
// should be validated against a real vehicle before use.

/** ISO 14229 standard DIDs (F186-F1A5 range). High confidence. */
export const UDS_STANDARD_DIDS = {
  "F186": {
    "name": "Active Diagnostic Session",
    "description": "Current diagnostic session type",
    "access": "read",
    "length": 1,
    "format": "hex",
    "confidence": "iso14229_standard"
  },
  "F187": {
    "name": "Vehicle Configuration",
    "description": "Build options and installed modules",
    "access": "read-write",
    "length": "variable",
    "format": "hex",
    "critical": true,
    "confidence": "iso14229_standard"
  },
  "F18A": {
    "name": "System Supplier Identifier",
    "description": "Manufacturer code",
    "access": "read",
    "length": 1,
    "format": "hex",
    "confidence": "iso14229_standard"
  },
  "F18B": {
    "name": "ECU Manufacturing Date",
    "description": "Production date (YYMMDD)",
    "access": "read",
    "length": 3,
    "format": "bcd",
    "confidence": "iso14229_standard"
  },
  "F18C": {
    "name": "ECU Serial Number",
    "description": "Calibration serial number",
    "access": "read-write",
    "length": "variable",
    "format": "ascii",
    "critical": true,
    "confidence": "iso14229_standard"
  },
  "F190": {
    "name": "VIN",
    "description": "Vehicle Identification Number",
    "access": "read-write",
    "length": 17,
    "format": "ascii",
    "critical": true,
    "confidence": "iso14229_standard"
  },
  "F191": {
    "name": "ECU Hardware Number",
    "description": "Hardware part number",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F192": {
    "name": "System Supplier Specific",
    "description": "Supplier-specific data",
    "access": "read",
    "length": "variable",
    "format": "hex",
    "confidence": "iso14229_standard"
  },
  "F193": {
    "name": "ECU Hardware Version",
    "description": "Hardware revision",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F194": {
    "name": "ECU Software Number",
    "description": "Software part number",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F195": {
    "name": "ECU Software Version",
    "description": "Software version",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F197": {
    "name": "System Name or Engine Type",
    "description": "Engine designation",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F198": {
    "name": "Repair Shop Code",
    "description": "Last service location",
    "access": "read-write",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F199": {
    "name": "Programming Date",
    "description": "Last programming timestamp",
    "access": "read-write",
    "length": "variable",
    "format": "bcd",
    "confidence": "iso14229_standard"
  },
  "F19D": {
    "name": "ECU Installation Date",
    "description": "Module installation date",
    "access": "read-write",
    "length": 3,
    "format": "bcd",
    "confidence": "iso14229_standard"
  },
  "F19E": {
    "name": "Vehicle Manufacturer Spare Part Number",
    "description": "OEM part number",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F1A0": {
    "name": "Boot Software Number",
    "description": "Bootloader part number",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F1A1": {
    "name": "Boot Software Version",
    "description": "Bootloader version",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F1A2": {
    "name": "Application Software Number",
    "description": "Application part number",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F1A3": {
    "name": "Application Software Version",
    "description": "Application version",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F1A4": {
    "name": "Calibration Software Number",
    "description": "Calibration part number",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  },
  "F1A5": {
    "name": "Calibration Software Version",
    "description": "Calibration version",
    "access": "read",
    "length": "variable",
    "format": "ascii",
    "confidence": "iso14229_standard"
  }
};

/** Module-specific DID ranges (F1B0+). UNVERIFIED — needs bench validation. */
export const UDS_MODULE_SPECIFIC_DIDS = {
  "gateway": {
    "name": "Gateway (GPEC4)",
    "critical_dids": [
      "F190",
      "F187",
      "F18C",
      "F199"
    ],
    "additional_dids": {
      "F1B0": {
        "name": "SGW Authorization List",
        "description": "Authorized module list for security gateway",
        "access": "read-write",
        "length": "variable",
        "format": "hex",
        "critical": true,
        "confidence": "unverified_module_specific"
      },
      "F1B1": {
        "name": "SGW Mode",
        "description": "Security gateway enable/disable",
        "access": "read-write",
        "length": 1,
        "format": "hex",
        "critical": true,
        "confidence": "unverified_module_specific"
      }
    }
  },
  "ecm": {
    "name": "Engine Control Module",
    "critical_dids": [
      "F190",
      "F18C",
      "F194",
      "F195",
      "F1A4",
      "F1A5"
    ],
    "additional_dids": {
      "F1C0": {
        "name": "Engine Hours",
        "description": "Total engine runtime",
        "access": "read-write",
        "length": 4,
        "format": "hex",
        "confidence": "unverified_module_specific"
      },
      "F1C1": {
        "name": "Odometer",
        "description": "Vehicle mileage",
        "access": "read-write",
        "length": 4,
        "format": "hex",
        "confidence": "unverified_module_specific"
      }
    }
  },
  "bcm": {
    "name": "Body Control Module",
    "critical_dids": [
      "F190",
      "F18C",
      "F187"
    ],
    "additional_dids": {
      "F1D0": {
        "name": "Key FOB Data",
        "description": "Programmed key information",
        "access": "read-write",
        "length": "variable",
        "format": "hex",
        "critical": true,
        "confidence": "unverified_module_specific"
      },
      "F1D1": {
        "name": "SKIM Data",
        "description": "Security immobilizer data",
        "access": "read-write",
        "length": "variable",
        "format": "hex",
        "critical": true,
        "confidence": "unverified_module_specific"
      }
    }
  },
  "rfhub": {
    "name": "RF Hub (Tire Pressure Monitor)",
    "critical_dids": [
      "F190",
      "F18C"
    ],
    "additional_dids": {
      "F1E0": {
        "name": "Tire Sensor IDs",
        "description": "Programmed TPMS sensor IDs",
        "access": "read-write",
        "length": 16,
        "format": "hex",
        "critical": true,
        "confidence": "unverified_module_specific"
      }
    }
  },
  "tcm": {
    "name": "Transmission Control Module",
    "critical_dids": [
      "F190",
      "F18C",
      "F194",
      "F195"
    ],
    "additional_dids": {
      "F1F0": {
        "name": "Transmission Adaptation",
        "description": "Learned shift points",
        "access": "read-write",
        "length": "variable",
        "format": "hex",
        "confidence": "unverified_module_specific"
      }
    }
  },
  "abs": {
    "name": "ABS Module",
    "critical_dids": [
      "F190",
      "F18C"
    ],
    "additional_dids": {}
  }
};

/** Common module-clone workflows from the source. UNVERIFIED step ordering. */
export const UDS_CLONE_WORKFLOWS = {
  "gateway": {
    "steps": [
      "Read VIN (F190)",
      "Read Vehicle Configuration (F187)",
      "Read ECU Serial Number (F18C)",
      "Read SGW Authorization List (F1B0)",
      "Read SGW Mode (F1B1)",
      "Read all software versions",
      "Write to target gateway",
      "Verify all DIDs",
      "Test module communication"
    ],
    "security_level": 5,
    "risks": [
      "SGW lockout",
      "Module authorization mismatch"
    ]
  },
  "ecm": {
    "steps": [
      "Read VIN (F190)",
      "Read ECU Serial Number (F18C)",
      "Read Software Numbers (F194, F1A2, F1A4)",
      "Read Calibration Data",
      "Read Engine Hours (F1C0)",
      "Read Odometer (F1C1)",
      "Write to target ECM",
      "Verify all DIDs"
    ],
    "security_level": 1,
    "risks": [
      "Odometer fraud detection",
      "Immobilizer mismatch"
    ]
  },
  "bcm": {
    "steps": [
      "Read VIN (F190)",
      "Read ECU Serial Number (F18C)",
      "Read Vehicle Configuration (F187)",
      "Read Key FOB Data (F1D0)",
      "Read SKIM Data (F1D1)",
      "Write to target BCM",
      "Verify all DIDs",
      "Test key FOB operation"
    ],
    "security_level": 1,
    "risks": [
      "Key FOB loss",
      "SKIM lockout",
      "Feature mismatch"
    ]
  },
  "rfhub": {
    "steps": [
      "Read VIN (F190)",
      "Read ECU Serial Number (F18C)",
      "Read Tire Sensor IDs (F1E0)",
      "Write to target RFHUB",
      "Verify all DIDs",
      "Test TPMS sensors"
    ],
    "security_level": 1,
    "risks": [
      "Sensor ID mismatch"
    ]
  }
};

export const UDS_DIDS_META = {
  standardCount: 22,
  moduleSpecificCount: 8,
  source: "Combined ISO 14229 standard + FCA convention assumptions",
};
