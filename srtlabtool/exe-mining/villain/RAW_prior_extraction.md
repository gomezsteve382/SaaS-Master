# ECU-VILLAIN — COMPLETE REVERSE ENGINEERING EXTRACTION
# From memory dump: VILLAIN_protected_patched.DMP (173MB)
# Date: 2026-04-12

## KEY CONSTANTS EXTRACTED

### GPEC1 Seed Calculator
- KEY_CONSTANT: 670269
- Function: _gpec_1_seed_calculator
- Variables: key, seed (uses genexpr with wiwlwkwywzwal pattern)

### GPEC2 Seed Calculator  
- Function: _gpec_calculator
- Security access levels: 0x05/0x10 (request/response)
- Sub-functions: gpec2_flash, gpec2_eprom, gpec3_eprom, gpec2_2015_eprom, gpec2a_eprom

### NGC (Next Generation Controller) Seed Calculator
- Function: ngc_unlock, ngc_unlock_level5, ngc_trans_unlock_level5
- Variables: TABLE, KEY_CONSTANT, seedInt, tempSeedInt, TL1-TL5, keyInt
- Sub-function: shift_format (with v8, v10 parameters)
- Uses lookup tables with seed_a, seed_b, num0-num11

### Cummins Seed Calculator
- Function: seed_key_calculator_cummins
- Entry via security access 0x0C

### JTEC Unlock
- Function: jtec_unlock
- Entry: security access 0x34
- Key value: "0000"
- Sub-functions: send_jtec_calculated_key

### EPS (Electric Power Steering) Unlock
- Function: eps_unlock, _eps_calculator
- Diagnostic session: 0x67
- Seed request DID: 0x6706
- Variables: calc_one, calc_two, seed, temp_seed, shifted_seed, key
- Security access level: 0x60

### Security Access Level Map (from EcuUnlocks):
Level Group 1: 0x05 request / 0x10 response
Level Group 2: 0x02 request / 0x82 response  
Level Group 3: 0x08 request / 0x88 response
Level Group 4: 0x22,0x23,0x24,0x25,0x26,0x42,0x45,0x44,0x60,0x61,0x62,0x66,0x67,0x6B,0x6C,0x6D

### Security Access Dispatch:
- gpec2: uses _gpec_calculator
- ngc_unlock: level 0x08
- cummins: seed_key_calculator_cummins
- gpec1: _gpec_1_seed_calculator  
- ngc levels 0x80,0x01,0x81: ngc_unlock_level5
- gpec2_flash: specific q-constants
- gpec2_eprom: specific q-constants
- gpec3_eprom: specific q-constants
- gpec2_2015_eprom: specific q-constants
- gpec2a_eprom: specific q-constants
- jtec_unlock: level 0x34, key "0000"
- Additional level: 0x42,0x44,0x36 → gpec2

## TIPM Unlock Tables
- t8001: lookup table (security access 0x80)
- t3605: lookup table (access 0x05, paired with 0x36)
- t3608: lookup table (access 0x08)
- t0807: lookup table
- t8101: lookup table (access 0x81), has get_table_idx sub-function
- t3c: lookup table (access 0x3C)
- tc605: lookup table (C6 prefix)
- TIPM types: TIPM6, TIPM7, TIPM7S, TIPM8, BCM-KJ, BCM-CS, FCM

## VIN DIDs (Data Identifiers)
- 0x7B90: Current VIN (read/write)
- 0x7B88: Original VIN (read/write)
- 0x6E2025: Bus Transmitted VIN
- 0x6E2027: WCM Configured VIN
- 0x6E9EB0: SKIM State
- 0x6EF190: EPS VIN
- 0xF79EB045: SKIM state flag (SCI-B)

## ECU Protocol Support
- CAN 11-bit: CHRYSLER ECU CAN 11-BIT
- CAN 29-bit: CHRYSLER ECU CAN 29-BIT
- SCI-A ENGINE: CHRYSLER ECU SCI A ENGINE
- SCI-B ENGINE: CHRYSLER ECU SCI B ENGINE
- CHRYSLER TIPM
- EPS (Electric Power Steering)

## ECU Operations
### VIN:
- get_current_vin, write_current_vin
- get_original_vin, write_original_vin
- get_bus_transmitted_vin, write_bus_transmitted_vin
- get_wcm_configured_vin, write_win_configured_vin

### SKIM/Immobilizer:
- get_skim_state (DID 0x6E9EB0): returns 0x80=Enabled, 0x00=Disabled
- enable_skim, disable_skim
- get_skim_keys, write_skim_keys (6 keys)
- get_immo_keys, write_immo_keys (6 immobilizer keys)

### Mileage/SRI:
- get_sri_mileage (with calculate_sri function)
- write_sri_mileage
- Uses E2 prefix for SRI write

### EPROM:
- can_read_eprom, can_write_eprom
- eprom_data_collection
- save_eprom_to_file

### Flash/Tuner:
- tuner_flash_tab
- tuner_unlock_boot_button (bootloader unlock)
- tuner_write_ecu_button, tuner_read_ecu_button
- tuner_write_eprom_button, tuner_read_eprom_button

## Supplier Database
Major suppliers found: Continental, Bosch, Denso, Delphi, TRW, ZF, Becker, 
Blaupunkt, Hughes, Gigatronik, Hella, Lucas, Motorola, Valeo, Magna, etc.

## Microcontroller Database  
Found references to: HC08, HC12, ST9, SH7055SF, V850E, UPD780814GC, 
78K0816, MB90549, MB90598, M30810MCT, H8S/2646, MH8303, STAR 12

## Vehicle Database
- DCA, DCS, DCX, MMC (MMC / Smart)
- Vehicle lines with 2-letter codes (CS, CT, DR, HB, JC, JK, KL, LC, etc.)
- Body codes mapped to vehicle types
- Country codes (USA, Europe, Canada, England, Japan, Germany, etc.)

## J2534 PassThru Communication
- Registry path: Software\PassThruSupport.04.04\ and Wow6432Node variant
- Protocol support: CAN, ISO14230, ISO15765, SCI_A_ENGINE, SCI_B_ENGINE
- Baud rates: CAN_125k, CAN_250k, CAN_500k, SCI rates
- Filter types: PASS, BLOCK, FLOW_CONTROL
- Full PassThru API: Open, Close, Connect, Disconnect, ReadMsgs, WriteMsgs, 
  StartMsgFilter, StopMsgFilter, SetProgrammingVoltage, ReadVersion, GetLastError,
  Ioctl

## Cryptodome Usage
- AES encryption (Cryptodome.Cipher.AES)
- Padding (Cryptodome.Util.Padding.unpad)
- Used for license validation

## Anti-Debug
- detect_debugger, detect_debugger2
- IsDebuggerPresent (kernel32)
- TerminateProcess / GetCurrentProcess
- PYDEVD_LOAD_VALUES_ASYNC check (PyCharm debugger detection)
- ctypes.windll.kernel32 calls

## GUI Structure (VILLAIN.py)
- Framework: PyQt5 with qdarktheme
- Main class: VillainGui (QMainWindow)
- Website: ecuunlock.com
- Tabs: HOME, CONNECT, APNT, VILLAIN, TIPM, EPS, TUNER
- Logo: ECU_VILLAIN_LOGO_6.jpg

## EXTRACTED SEED-KEY CONSTANTS (from bytecode)

### GPEC1:
- KEY_CONSTANT: 670269

### GPEC2 (base _gpec_calculator):
- Constant pair: q1=0xE72E3799, q2=0x1B64DB03
- Security access: 0x42, 0x44, 0x36

### GPEC2 Flash:
- Constant pair: q1=0x966AEEB1, q2=0x440BCE28

### GPEC2 EPROM:
- Constants: q1=0x3F711F5A, q2=0xC3573AE9, q3=0x725EF016, q4=0x58329671

### GPEC3 EPROM:
- Constant pair: q1=0x129D657F, q2=0xD0726B89

### GPEC2 2015 EPROM:
- Constant pair: q1=0x47EC21F8, q2=0xCFB81A2E

### GPEC2A EPROM:
- Constant pair: q1=0xCE853A6F, q2=0x3BA8FDC7

### NGC Lookup Tables (from shift_format area):
- NGC shift_format table (8 entries): 
  0x9D9F, 0xCE48, 0xB0F3, 0xD99B, 0xA720, 0xFDD6, 0x836D, 0x6F8E

### NGC trans_unlock_level5 Constants:
- table (13 entries from bytecode):
  0x44, 0x41, 0x49, 0x4D, 0x4C, 0x45, 0x52, 0x43, 0x48, 0x52, 0x59, 0x53, 0x4C, 0x45, 0x52
  (ASCII: "DAIMCHRYSLER" + padding!)

### EPS Unlock:
- Diagnostic session: 0x67
- Seed DID: 0x6706
- Security level: 0x60
- _eps_calculator constants from bytecode area

### Main ECU Unlock Dispatch Table (NGC pre-constants):
q=0x2796144E, q=0xC55A3FD5, q=0x4D5C406D, q=0xB08EF250,
q=0x91FF47E1, q=0x2481F456, q=0xC393FC49, q=0x3A4EFF33,
q=0x1EADCC75, q=0xD9BDD2F5, q=0x679705B4, q=0x42CF5086,
q=0x415D9886, q=0x19111199

### TIPM Lookup Tables:
- t8001: Seed table for SA level 0x80 (8 entries at 0x83CB80-0x83CBA0)
  Values: 0x72{r}, 0xB301, 0x08EB, 0xB0BA, 0xECA7, 0x0ECC, 0xD69A, 0xE47E
- t3605: Seed table for SA level 0x36/0x05 (8 entries at 0x83CBF0-0x83CC10)
  Values: 0x7A44, 0x0201, 0xF123, 0x146E, 0xCBC2, 0x553F, 0xD398, 0x4EDC
- t3608: Combined with t0807
- t8101: Seed table for SA level 0x81 (8 entries at 0x83CC90-0x83CCB0)
  Values: 0x22B5, 0x5767, 0x4C5A, 0xE443, 0xC606, 0x7544, 0x0DFB, 0x36D6
- t3c: SA level 0x3C
- tc605: SA level C6/05 combo

### JTEC:
- Security level: 0x34
- Key: "0000" (fixed!)

## NGC TABLE — "DAIMLERCHRYSLER" (confirmed from memory)
The NGC seed-key algorithm uses the ASCII string "DAIMLERCHRYSLER1" as a lookup table:
```
TABLE = [0x44, 0x41, 0x49, 0x4D, 0x4C, 0x45, 0x52, 0x43, 0x48, 0x52, 0x59, 0x53, 0x4C, 0x45, 0x52, 0x31]
       = "DAIMLERCHRYSLER1"
```

## NGC shift_format Table (8 entries):
```python
shift_table = [0x9D9F, 0xCE48, 0xB0F3, 0xD99B, 0xA720, 0xFDD6, 0x836D, 0x6F8E]
```

## NGC Pre-Computation Table (14 x 32-bit constants):
```python
ngc_table = [
    0x2796144E, 0xC55A3FD5, 0x4D5C406D, 0xB08EF250,
    0x91FF47E1, 0x2481F456, 0xC393FC49, 0x3A4EFF33,
    0x1EADCC75, 0xD9BDD2F5, 0x679705B4, 0x42CF5086,
    0x415D9886, 0x19111199
]
```

## TIPM Lookup Tables (complete from memory):

### t8001 (SA 0x80, 8 entries):
```python
t8001 = [0x727B, 0xB301, 0x08EB, 0xB0BA, 0xECA7, 0x0ECC, 0xD69A, 0xE47E]
```

### t3605 (SA 0x36/0x05, 8 entries):
```python
t3605 = [0x7A44, 0x0201, 0xF123, 0x146E, 0xCBC2, 0x553F, 0xD398, 0x4EDC]
```

### t3608/t0807 (SA 0x36/0x08, 8 entries):
```python
t3608 = [0x9110, 0x4E8A, 0xEA2C, 0xE235, 0xB73F, 0xE6E5, 0x5916, 0x16CC]
```

### t8101 (SA 0x81, 8 entries):
```python
t8101 = [0x22B5, 0x5767, 0x4C5A, 0xE443, 0xC606, 0x7544, 0x0DFB, 0x36D6]
```

### t3c (SA 0x3C, 8 entries):
```python
t3c = [0x632A, 0x193B, 0x914F, 0x0F88, 0x5E51, 0x8DCD, 0xDD6C, 0x00DD]
```

### tc605 (SA 0xC6/0x05, 8 entries):
```python
tc605 = [0x53CE, 0xE73D, 0x2255, 0xB1BA, 0xDA02, 0x70BE, 0xBB65, 0x81A4]
```

### TIPM Bit Masks (for table index calculation):
```python
masks = [0xBAEE, 0xE000, 0x1C00, 0x0380, 0x0070, 0x0007]
```

## wiTECH Analysis

wiTECH is Chrysler/Stellantis official diagnostic tool built in Erlang (OTP).
Key finding: **The official tool calls Stellantis manufacturing servers for seed-key authentication.**

Functions: `request_sgw_signed_challenge_from_manufacturing_server`, `request_sgw_cert_from_manufacturing_server`

This means Stellantis uses a **server-side seed-key challenge system** for SGW (Security Gateway) bypass — the tool cannot compute unlock codes locally. VILLAIN reimplements these algorithms locally.

### wiTECH ECU Modules:
- `device_unlock_ecu` — ECU unlock module  
- `whs_ecu_unlock` — Workshop ECU unlock
- `veh_unlock` — Vehicle unlock
- `flash_sup`, `jcanflash`, `rmflash`, `vrflash` — Flash utilities
- `veh_sgw` — Security Gateway module
- `whs_ecu_memory` — ECU memory read/write
- `whs_flash` — Flash programming
- `whs_ecu_raw` — Raw ECU communication
- Protocol support: `protocol_kline`, `protocol_services`

### wiTECH UDS Functions:
- `read_seed`, `send_key`, `pre_unlock_init`
- `read_memory`, `write_memory`
- `enter_diagnostic_session`
- `disable_normal_messages`, `enable_normal_messages`
- `enable_fault_setting`, `disable_fault_setting`
- `send_tester_present`
- `read_partnumber`, `read_vin`, `read_flash_partnumber`
- `read_software_number`, `read_hardware_number`
