// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/uds-protocols.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// Generic UDS service reference + SBEC2/SBEC3 legacy (SCI-bus) seed-key
// algorithm + 7-step VIN programming sequence template. Module addresses
// here are FCA conventions — cross-check against quickRefData.generated.js
// for SRT Lab's verified addressing per platform.

export const SBEC23_SECURITY = {
  "name": "EEPROM Security Seed (SBEC2/SBEC3)",
  "protocol": "SCI-bus (Chrysler CCD)",
  "commands": {
    "request_seed": {
      "command": "0x2B",
      "tx": "2B",
      "rx_format": "2B XX YY CS",
      "description": "Request security seed from PCM",
      "notes": "XX YY = 16-bit seed, CS = checksum"
    },
    "send_solution": {
      "command": "0x2C",
      "algorithm": "Solution = (Seed * 4) + 0x9018",
      "tx_format": "2C SolutionHB SolutionLB CS",
      "checksum": "CS = 0x2C + SolutionHB + SolutionLB",
      "description": "Send calculated solution to unlock EEPROM write",
      "notes": "Use lower 16 bits only (mask with 0xFFFF)"
    },
    "write_eeprom": {
      "command": "0x27",
      "description": "Write EEPROM (requires security clearance)",
      "prerequisite": "Must send valid solution via 0x2C first"
    }
  },
  "example": {
    "seed": "0x2E2A",
    "calculation": "0x2E2A * 4 + 0x9018 = 0x148C0",
    "solution": "0x48C0",
    "tx_bytes": "2C 48 C0 [checksum]"
  },
  "source": "chryslerccdsci.wordpress.com (extracted from wiTECH files)"
};

export const UDS_SERVICES_GENERIC = {
  "0x10": {
    "name": "DiagnosticSessionControl",
    "description": "Switch to programming session",
    "request": "10 02",
    "response": "50 02",
    "notes": "Required before VIN writing"
  },
  "0x27": {
    "name": "SecurityAccess",
    "description": "Unlock security for programming",
    "request_seed": "27 01",
    "send_key": "27 02 [calculated_key]",
    "response": "67 01 [seed]",
    "notes": "Seed-key algorithm varies by module"
  },
  "0x2E": {
    "name": "WriteDataByIdentifier",
    "description": "Write VIN to module",
    "request": "2E F1 90 [17-byte VIN]",
    "response": "6E F1 90",
    "data_identifier": "F190 = VIN",
    "notes": "Primary method for VIN programming"
  },
  "0x31": {
    "name": "RoutineControl",
    "description": "Execute checksum calculation routine",
    "request": "31 01 [routine_id]",
    "response": "71 01 [routine_id]",
    "notes": "May be required after VIN write"
  },
  "0x3E": {
    "name": "TesterPresent",
    "description": "Keep session alive",
    "request": "3E 00",
    "response": "7E 00",
    "notes": "Send every 2 seconds during programming"
  },
  "0x11": {
    "name": "ECUReset",
    "description": "Reset module after programming",
    "request": "11 01",
    "response": "51 01",
    "notes": "Apply changes and restart"
  }
};

export const UDS_MODULE_ADDRESSES = {
  "BCM": {
    "tx_id": "0x7E0",
    "rx_id": "0x7E8",
    "description": "Body Control Module",
    "vin_did": "F190"
  },
  "ECM": {
    "tx_id": "0x7E0",
    "rx_id": "0x7E8",
    "description": "Engine Control Module",
    "vin_did": "F190"
  },
  "RFHUB": {
    "tx_id": "0x742",
    "rx_id": "0x762",
    "description": "RF Hub / SKIM",
    "vin_did": "F190"
  },
  "TCM": {
    "tx_id": "0x7E1",
    "rx_id": "0x7E9",
    "description": "Transmission Control Module",
    "vin_did": "F190"
  },
  "ABS": {
    "tx_id": "0x760",
    "rx_id": "0x768",
    "description": "ABS/ESP Module",
    "vin_did": "F190"
  }
};

export const VIN_PROGRAMMING_SEQUENCE = {
  "name": "Live VIN Programming via OBD2",
  "protocol": "UDS over CAN (ISO 14229)",
  "steps": [
    {
      "step": 1,
      "command": "DiagnosticSessionControl",
      "tx": "10 02",
      "rx_expected": "50 02",
      "description": "Enter programming session"
    },
    {
      "step": 2,
      "command": "TesterPresent (background)",
      "tx": "3E 00",
      "interval": "2 seconds",
      "description": "Keep session alive"
    },
    {
      "step": 3,
      "command": "SecurityAccess - Request Seed",
      "tx": "27 01",
      "rx_expected": "67 01 [seed_bytes]",
      "description": "Get security seed"
    },
    {
      "step": 4,
      "command": "SecurityAccess - Send Key",
      "tx": "27 02 [calculated_key]",
      "rx_expected": "67 02",
      "description": "Unlock with calculated key",
      "notes": "Key calculation algorithm varies by module"
    },
    {
      "step": 5,
      "command": "WriteDataByIdentifier - VIN",
      "tx": "2E F1 90 [17-byte VIN in ASCII]",
      "rx_expected": "6E F1 90",
      "description": "Write new VIN",
      "example": "2E F1 90 32 42 33 43 4A 35 44 54 32 42 48 35 39 30 37 39 34"
    },
    {
      "step": 6,
      "command": "RoutineControl - Calculate Checksum",
      "tx": "31 01 [routine_id]",
      "rx_expected": "71 01 [routine_id]",
      "description": "Update checksums (if required)",
      "notes": "Some modules auto-calculate"
    },
    {
      "step": 7,
      "command": "ECUReset",
      "tx": "11 01",
      "rx_expected": "51 01",
      "description": "Reset module to apply changes"
    }
  ],
  "notes": [
    "Must use correct CAN IDs for target module",
    "Security key algorithm must be known for the module",
    "Some modules require dealer authentication",
    "Always backup original module before programming"
  ]
};

export const UDS_PROTOCOLS_META = {
  "source": "AlfaOBD RE + community knowledge",
  "caveat": "Module addresses may conflict with quickRefData.generated.js verified values."
};
