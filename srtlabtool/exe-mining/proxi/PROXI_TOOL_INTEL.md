# FCA PROXI Tool — extracted intel

Source: `FCA_PROXI_Tool.exe` (PyInstaller, Python 3.12, 21.7 MB).
Unpacked with pyinstxtractor-ng → `main.pyc` → decompiled with pycdc.
Full source: `proxi_main_decompiled.py` (1,638 lines).

This is the **real read/write PROXI protocol** the dealer-style tool uses over
OBD — exact CAN addressing, testers, UDS sequences. Directly grounds SRT Lab's
PROXI / BCM-config features.

## Transport
- Two backends: **J2534 PassThru** (`TXFLAG_CAN_29BIT_ID`) and **ELM327**
  (`ATSP7` = 29-bit ISO-TP; MS-CAN needs `STP 53`, STN/vLinker only).
- `_elm_extract_isotp_payload()` normalizes multi-frame ELM responses.

## 29-bit ISO-TP addressing (`_ids_29bit`)
```
TX = 0x18DA0000 | (target << 8) | tester
RX = 0x18DA0000 | (tester << 8) | target
```
(`416940032` == `0x18DA0000`.)

## Module targets (`write_proxi` target_map)
| Module | Target | Bus |
|---|---|---|
| BCM | 0x40 | HS CAN |
| IPC | 0x60 | HS CAN |
| ETM / RADIO / RADIO_STACK / CTM / AMP | 0x87 | **MS CAN** |

Testers: **0xF2 primary, 0xF1 fallback** (tried in that order).

## Read PROXI (`read_proxi_bcm`) — DID 0x2023
1. Session: `10 03` → expect `50` (positive). Else try next tester.
2. Read: `22 20 23` → 
   - `7F .. 78` (response-pending) → wait 1.5 s, re-send once.
   - `62 20 23 <data…>` → success; PROXI = bytes after the 3-byte echo.
3. On BCM, target = 0x40, bus = HS.

## Write PROXI (`write_proxi`) — DID 0x2023
1. Session `10 03` → expect `50`.
2. Write: `2E 20 23 <data…>` → expect `6E` (positive).
   - `7F .. 78` = pending (treated as in-progress).
   - else "Write failed/rejected".

## Write-access probe (`check_write_access`)
Sends `2E 20 23` with no data and classifies:
- `7F 2E …` → "gateway passes traffic" (write path reachable)
- `6E 20 23` → positive
- no response → blocked.

## VIN read (`read_vin`)
Target 0x40 (BCM), HS CAN, testers F2/F1. (Body decompiled incompletely but
matches the read_proxi session/read shape.)

## Licensing / hardening (bonus — not module-related)
The tool gates itself with: Windows **DPAPI** encrypt/decrypt of a device seed,
an RSA **vendor public key** `verify_license`, a `get_request_code` activation
flow, and `is_virtual_machine_hard()` anti-VM (PowerShell/tasklist probes).
Noted for completeness; not needed for the module protocol.

## Cross-check vs SRT Lab
SRT Lab's PROXI tab decodes DID 0x2023 from a *file*. This tool proves the
**live OBD** path: HS/MS bus split per module, F2→F1 tester fallback, the
`10 03 → 22/2E 20 23` sequence, and the 29-bit `0x18DAtt ss` addressing. Wire
these constants into the Live OBD / UDS console PROXI flows.
