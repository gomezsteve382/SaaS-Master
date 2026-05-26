// AUTO-GENERATED data file. DO NOT EDIT BY HAND.
// Source: attached_assets/alfaobd-package-2026-05-25/security-intel-addendum.json
// Regenerate: node scripts/codegen-ecu-to-can.mjs
//
// Security-relevant intelligence extracted from AlfaOBD.exe IL.
//
// ⚠ INTERPRETATION CAVEATS:
// - The 5-byte hex strings (`4083618902`, `3E07860DAD`) are NOT confirmed to be
//   live cryptographic keys. They could be sample CodeCards baked in for testing,
//   expected-response patterns, or key-derivation inputs. Do not use as active
//   crypto material without bench-verification against a real ECU.
// - The registry-credential storage path is verified-by-IL-string but the
//   in-registry data is per-installation, not extracted from this binary.

/** Where AlfaOBD persists dealer credentials (CodeCard + PIN) on the user's
 *  Windows machine. Extracted from Method[2526] StartButton_Click1 IL. */
export const ALFAOBD_CREDENTIAL_STORAGE = {"registry_root":"HKCU\\SOFTWARE\\AlfaOBD\\CommonSettings","value_names":["CodeCard","PINcode"],"source":"AlfaOBD.exe Method[2526] StartButton_Click1 IL strings (salt=11)"};

/** The `SendCodeCardLogin` method (Method[1436] zz, salt=10) decrypted profile.
 *  Includes the candidate 5-byte hex CodeCard tokens paired with SA frames. */
export const SEND_CODE_CARD_LOGIN_METHOD = {"method":"Method[1436] zz","salt":10,"decrypted_method_identity":"SendCodeCardLogin","evidence_strings":[": SendCodeCardLogin - sent",": SendCodeCardLogin: Error: "],"associated_can_buses":["BCAN_7209","CCAN"],"uds_flow":["27 03 (SecurityAccess Request Seed level 3)","27 04 <key_bytes> (SecurityAccess Send Key level 4)","31 01 02 11 (RoutineControl Start, RID=0x0211 — vehicle config backup write)"],"candidate_codecard_keys_5byte":[{"hex":"4083618902","bytes":"40 83 61 89 02","appears_with_frame":"27 04","interpretation_caveat":"Either a sample CodeCard baked into the EXE for testing, OR an expected-response value, OR a key-derivation input. NOT independently verified."},{"hex":"3E07860DAD","bytes":"3E 07 86 0D AD","appears_with_frame":"27 04 00","interpretation_caveat":"Either a sample CodeCard, OR an expected-response value, OR a key-derivation input. NOT independently verified."}]};

/** Door modules using legacy KWP2000, not UDS. */
export const KWP2000_DOOR_MODULES = {"ecus":["DDM_KWP (Driver Door Module)","PDM_KWP (Passenger Door Module)"],"protocol":"KWP2000 (legacy, NOT UDS)","source":"Method[2528] StartButton_Click3 decrypted strings"};

/** CAN bus protocol names AlfaOBD recognizes. */
export const ALFAOBD_CAN_PROTOCOL_NAMES = ["BCAN_11BIT","BCAN_7209","BCAN_7274","CCAN","CCAN_11BIT"];

/** Legacy diagnostic protocols supported. */
export const LEGACY_PROTOCOLS_SUPPORTED = ["ISO9141","ISO9141_2","KWP2000_SLOW","KWP2000"];

/** OBD-II adapter chipsets AlfaOBD auto-detects. */
export const OBD_ADAPTER_DETECTION = ["STN1170","STN1110","OBDLinkMX"];
