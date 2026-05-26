// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/vin-programming-guide.json
// Re-extract: node scripts/codegen-alfaobd-package.mjs
//
// VIN storage locations and programming procedures for FCA modules.
// Companion to vinOffsetDatabase.generated.js (per-module byte offsets).

export const VIN_PROGRAMMING_GUIDE = {
  "description": "VIN storage locations and programming procedures for Chrysler/FCA/Stellantis modules",
  "source": "Reverse-engineered from AlphaOBD and industry tools",
  "modules": {
    "RFHUB": {
      "module_name": "Radio Frequency Hub",
      "can_tx": "0x740",
      "can_rx": "0x4C0",
      "vin_storage_locations": [
        {
          "offset": "0x000EA5",
          "offset_dec": 60069,
          "description": "Primary VIN storage location 1",
          "access_method": "UDS 0x2E (WriteDataByIdentifier) with DID 0xF190"
        },
        {
          "offset": "0x000EB9",
          "offset_dec": 60089,
          "description": "Primary VIN storage location 2",
          "access_method": "UDS 0x2E (WriteDataByIdentifier) with DID 0xF190"
        },
        {
          "offset": "0x000ECD",
          "offset_dec": 60109,
          "description": "Primary VIN storage location 3",
          "access_method": "UDS 0x2E (WriteDataByIdentifier) with DID 0xF190"
        },
        {
          "offset": "0x000EE1",
          "offset_dec": 60129,
          "description": "Primary VIN storage location 4",
          "access_method": "UDS 0x2E (WriteDataByIdentifier) with DID 0xF190"
        }
      ],
      "programming_sequence": [
        "1. Enter diagnostic session (0x10 0x02 or 0x10 0x03)",
        "2. Perform security access (0x27 0x01 to request seed)",
        "3. Calculate key using Atlantis Level 5 algorithm",
        "4. Send key (0x27 0x02 + 4-byte key)",
        "5. Write VIN using 0x2E 0xF1 0x90 + 17-byte VIN",
        "6. Verify VIN using 0x22 0xF1 0x90",
        "7. Reset ECU (0x11 0x01)"
      ],
      "security_algorithm": "Atlantis Level 5 (CRC32-based seed/key)",
      "notes": "RFHUB stores VIN in 4 locations for redundancy. All must match or module will fault."
    },
    "PCM": {
      "module_name": "Powertrain Control Module",
      "can_tx": "0x7E0",
      "can_rx": "0x7E8",
      "vin_storage_locations": [
        {
          "offset": "Variable",
          "description": "VIN stored in EEPROM, location varies by calibration",
          "access_method": "UDS 0x2E (WriteDataByIdentifier) with DID 0xF190"
        }
      ],
      "programming_sequence": [
        "1. Enter programming session (0x10 0x02)",
        "2. Perform security access (0x27 0x01/0x02)",
        "3. Write VIN using 0x2E 0xF1 0x90 + 17-byte VIN",
        "4. Verify VIN using 0x22 0xF1 0x90"
      ],
      "security_algorithm": "Varies by year/model (Seed/Key algorithm)",
      "notes": "PCM VIN programming typically requires dealer-level security access"
    },
    "TCM": {
      "module_name": "Transmission Control Module",
      "can_tx": "0x7E1",
      "can_rx": "0x7E9",
      "vin_storage_locations": [
        {
          "offset": "Variable",
          "description": "VIN stored in EEPROM",
          "access_method": "UDS 0x2E (WriteDataByIdentifier) with DID 0xF190"
        }
      ],
      "programming_sequence": [
        "1. Enter programming session (0x10 0x02)",
        "2. Perform security access (0x27 0x01/0x02)",
        "3. Write VIN using 0x2E 0xF1 0x90 + 17-byte VIN",
        "4. Verify VIN using 0x22 0xF1 0x90"
      ],
      "security_algorithm": "Varies by year/model",
      "notes": "TCM VIN must match PCM VIN or transmission will not shift properly"
    },
    "BCM": {
      "module_name": "Body Control Module",
      "can_tx": "0x620",
      "can_rx": "0x504",
      "vin_storage_locations": [
        {
          "offset": "Variable",
          "description": "VIN stored in EEPROM",
          "access_method": "UDS 0x2E (WriteDataByIdentifier) with DID 0xF190"
        }
      ],
      "programming_sequence": [
        "1. Enter extended diagnostic session (0x10 0x03)",
        "2. Perform security access (0x27 0x01/0x02)",
        "3. Write VIN using 0x2E 0xF1 0x90 + 17-byte VIN",
        "4. Verify VIN using 0x22 0xF1 0x90"
      ],
      "security_algorithm": "Varies by year/model",
      "notes": "BCM controls many body functions and stores VIN for anti-theft"
    },
    "IPC": {
      "module_name": "Instrument Panel Cluster",
      "can_tx": "0x742",
      "can_rx": "0x4C2",
      "vin_storage_locations": [
        {
          "offset": "Variable",
          "description": "VIN displayed on startup screen",
          "access_method": "UDS 0x2E (WriteDataByIdentifier) with DID 0xF190"
        }
      ],
      "programming_sequence": [
        "1. Enter extended diagnostic session (0x10 0x03)",
        "2. Write VIN using 0x2E 0xF1 0x90 + 17-byte VIN",
        "3. Verify VIN using 0x22 0xF1 0x90"
      ],
      "security_algorithm": "Usually no security required for VIN write",
      "notes": "IPC displays VIN on startup and in settings menu"
    },
    "ABS": {
      "module_name": "Anti-lock Braking System",
      "can_tx": "0x747",
      "can_rx": "0x4C7",
      "vin_storage_locations": [
        {
          "offset": "Variable",
          "description": "VIN stored for module identification",
          "access_method": "UDS 0x2E (WriteDataByIdentifier) with DID 0xF190"
        }
      ],
      "programming_sequence": [
        "1. Enter programming session (0x10 0x02)",
        "2. Perform security access (0x27 0x01/0x02)",
        "3. Write VIN using 0x2E 0xF1 0x90 + 17-byte VIN",
        "4. Verify VIN using 0x22 0xF1 0x90"
      ],
      "security_algorithm": "Varies by manufacturer (Bosch/Continental/TRW)",
      "notes": "ABS module VIN programming may require specific tool authorization"
    }
  },
  "common_uds_commands": {
    "read_vin": {
      "command": "0x22 0xF1 0x90",
      "description": "ReadDataByIdentifier - VIN",
      "response": "0x62 0xF1 0x90 + 17 bytes VIN"
    },
    "write_vin": {
      "command": "0x2E 0xF1 0x90 + 17 bytes VIN",
      "description": "WriteDataByIdentifier - VIN",
      "response": "0x6E 0xF1 0x90 (success)"
    },
    "security_seed": {
      "command": "0x27 0x01",
      "description": "SecurityAccess - RequestSeed",
      "response": "0x67 0x01 + 4 bytes seed"
    },
    "security_key": {
      "command": "0x27 0x02 + 4 bytes key",
      "description": "SecurityAccess - SendKey",
      "response": "0x67 0x02 (success)"
    },
    "enter_programming": {
      "command": "0x10 0x02",
      "description": "DiagnosticSessionControl - Programming Session",
      "response": "0x50 0x02"
    },
    "enter_extended": {
      "command": "0x10 0x03",
      "description": "DiagnosticSessionControl - Extended Diagnostic Session",
      "response": "0x50 0x03"
    },
    "ecu_reset": {
      "command": "0x11 0x01",
      "description": "ECUReset - Hard Reset",
      "response": "0x51 0x01"
    }
  },
  "warnings": [
    "⚠️ Writing incorrect VIN can cause module faults and anti-theft lockout",
    "⚠️ Always backup original VIN before programming",
    "⚠️ VIN must be valid 17-character format (no I, O, Q)",
    "⚠️ All modules in vehicle should have matching VIN",
    "⚠️ Some modules require dealer-level security access",
    "⚠️ Failed VIN programming may require module replacement"
  ]
};

export const VIN_PROGRAMMING_GUIDE_META = {
  "source": "AlfaOBD reverse engineering + Chrysler service documentation"
};
