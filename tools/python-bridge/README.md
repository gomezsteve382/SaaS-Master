# SRT Lab Python J2534 Bridge

Reference Python implementation of the local J2534 daemon that the SRT Lab
web app talks to over HTTP, plus a suite of operational helper scripts that
exercise the same J2534 stack from the command line.

> **Heads up — this lives outside the pnpm workspace.**
> Nothing in this directory is part of the web build, the pnpm install graph,
> or CI. It is reference / field-tech code that ships as a runnable starting
> point for users who want to drive a real J2534 adapter against an FCA
> module. The TypeScript app under `artifacts/srt-lab/` is the source of
> truth for the wire protocol; if the two ever disagree, the web app wins.

## Layout

```
tools/python-bridge/
├── bridge/
│   └── j2534_bridge.py        ← localhost HTTP daemon (the bridge proper)
├── tools/
│   ├── srtlab_*.py            ← per-feature operational scripts
│   ├── canflash_*.py          ← lower-level seed/key + UDS helpers
│   ├── serve_ui.py            ← optional static-file server for offline UI use
│   └── canflash_unlocks/      ← 100 vendor unlock DLLs (Windows/PE32, ~4 MB)
├── requirements.txt
└── README.md                  ← you are here
```

## Prerequisites

- **Operating system** — Windows is the only fully supported target. The
  J2534 spec is a Windows DLL ABI; the bridge loads the vendor `.dll` via
  `ctypes`. The bridge will start on Linux/macOS for protocol testing, but
  no PassThru calls will succeed without a real DLL.
- **Python** — 3.8 or newer (uses only `http.server` from stdlib for the
  daemon; no Flask/uvicorn dependency).
- **A J2534-2 adapter + its vendor DLL.** Tested with:
  - Autel MaxiFlash VCI / Elite / IM608 → `MaxiFlashJ2534.dll`
  - Any other J2534-2 device → its own vendor DLL
  The bridge does **not** perform Secure-Gateway bypass; the MaxiFlash
  family handles SGW authentication in firmware using Autel's own
  credentials.
- **Python deps** — `pip install -r requirements.txt` (only `pefile` and
  `unicorn` are third-party; everything else is stdlib).

## Running the bridge

```powershell
# Default port 8765, auto-discovers a J2534 DLL from the registry:
python bridge\j2534_bridge.py

# Or point at a specific DLL and bind a different port:
python bridge\j2534_bridge.py ^
    --dll "C:\Program Files\Autel\MaxiFlashJ2534.dll" ^
    --port 8765 --verbose
```

The web app reads `localStorage["srtlab_autel"].url` (default
`http://localhost:8765`) and polls `/status` every few seconds — see
`artifacts/srt-lab/src/lib/bridgeClient.js`.

## HTTP protocol the web app expects

All endpoints respond with JSON. Binary payloads are uppercase hex strings.
Every response contains `{ok: true|false, ...}`; on failure the response
includes `error: "<message>"`.

| Method | Path          | Body                                      | Returns                                                                 |
|--------|---------------|-------------------------------------------|-------------------------------------------------------------------------|
| GET    | `/status`     | —                                         | `{ok, opened, connected, vendor, dllPath, versions:{firmware,...}}`     |
| POST   | `/open`       | `{}`                                      | `{ok}` — calls `PassThruOpen`                                           |
| POST   | `/close`      | `{}`                                      | `{ok}` — calls `PassThruClose`                                          |
| POST   | `/connect`    | `{protocol, flags, baudrate}`             | `{ok}` — `PassThruConnect`; default ISO15765 (6) @ 500 kbit/s           |
| POST   | `/disconnect` | `{}`                                      | `{ok}` — `PassThruDisconnect`                                           |
| POST   | `/setfilter`  | `{txId, rxId}`                            | `{ok}` — `PassThruStartMsgFilter`, FLOW_CONTROL_FILTER                  |
| POST   | `/sendmsg`    | `{txId, data, flags, timeoutMs}`          | `{ok}` — `PassThruWriteMsgs`; `data` is hex; `flags` defaults to `0x40` |
| POST   | `/readmsg`    | `{timeoutMs}`                             | `{ok, msg:{canId, data, ts}}` — `PassThruReadMsgs`; `data` is hex       |

A 0x7F NRC `0x78` (response pending) is **not** stripped by the bridge —
the JS `bridgeEngine.js` keeps polling `/readmsg` until the real reply
arrives or the deadline elapses.

## Operational helper scripts

All of these import the bridge primitives directly via `ctypes` (they do
**not** go through the HTTP daemon). Run them on the same Windows box that
has the J2534 DLL installed.

| Script                            | One-line purpose                                                                  |
|-----------------------------------|-----------------------------------------------------------------------------------|
| `srtlab_unlock_catalog.py`        | Universal unlock dispatcher — 81 FCA modules, 14 native Python + 67 DLL emulation |
| `srtlab_canflash_algos.py`        | 14 hand-reverse-engineered seed/key algorithms with 112 pinned test vectors       |
| `srtlab_module_scan.py`           | Read-only UDS scanner: supplier ID, DID probing, unlock verification              |
| `srtlab_ecm_vin_write.py`         | Single-module VIN writer (session → seed → key → write F190 → reset → verify)     |
| `srtlab_seedkey_capture.py`       | Capture seed/key pairs over the wire to identify unknown algorithms               |
| `srtlab_orc_clear.py`             | Clears stored crash/deployment data on airbag ORC/OCM modules pre-VIN-write      |
| `srtlab_did_decode.py`            | DID lookup — translates raw 22-service bytes via the AlfaOBD definitions         |
| `srtlab_uds_errors.py`            | UDS NRC decoder + context-aware human diagnosis                                  |
| `srtlab_algos.py`                 | 18 algorithms ported from the Replit web app (XTEA SGW, module unlocks)          |
| `srtlab_crc.py`                   | 7 verified CRC primitives (CCITT-FALSE, RFHUB 0xA0 reflected, 95640 0x42, …)     |
| `srtlab_parsemodule.py`           | Field-map parser for BCM / RFHUB / GPEC2A / 95640 EEPROM dumps                   |
| `srtlab_patch_vin.py`             | Offline binary VIN patcher with CRC enforcement                                  |
| `srtlab_crossvalidate.py`         | Cross-module sync rule validator (mirrors `crossValidate.js`)                    |
| `canflash_seedkey.py`             | Lower-level seed/key dispatcher consumed by `srtlab_unlock_catalog.py`           |
| `canflash_uds.py`                 | UDS service primitives (write, routine, transfer-data) used by the writers       |
| `serve_ui.py`                     | Optional `http.server` wrapper for serving an offline copy of the web UI         |

## Windows launchers

The original drop included a set of `.bat` launchers (`SRTLAB_*.bat`) that
just chained `python tools\<script>.py` with the right flags. They were not
present in the consolidated archive used to populate this directory, so
none are committed. Until they are restored, run the scripts directly with
`python tools\<name>.py --help` to see flags.

## NOT done by this directory

- No CI hook lints, typechecks, or tests this code.
- No Replit workflow auto-starts the bridge — the daemon needs Windows and
  a real adapter on the OBD-II port.
- The Python is committed **as-is** from the field drop. No refactors,
  modernization, or de-duplication beyond picking the newest copy of each
  file.
