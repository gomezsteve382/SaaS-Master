# FCA PROXI Tool — Extracted Source

Decompiled Python source extracted from the PyInstaller bundle
(`attached_assets/FCA_PROXI_Tool_*.exe`) for algorithm-mining purposes.

## INTERNAL BENCH USE ONLY — DO NOT REDISTRIBUTE

## Extraction method

1. `pyinstxtractor.py` was run against the EXE to unpack the PyInstaller
   archive into `_pyinstxtractor_out/`.
2. The project's own `.pyc` files (non-stdlib, non-third-party) were
   identified by their module names (prefix `proxi/`).
3. Each `.pyc` was decompiled with `decompile3` (Python 3.12 mode).
4. Decompiled `.py` files were committed here with reconstruction notes.

Stdlib and third-party packages (`cryptography`, `pythonnet`, etc.) were
**not** decompiled — only the project-specific modules.

## Source files

| File | Original `.pyc` | Description |
|------|-----------------|-------------|
| `src/hwid.py` | `proxi/hwid.cpython-312.pyc` | HWID derivation (CPU, MB, MAC, volume serial) |
| `src/license_check.py` | `proxi/license_check.cpython-312.pyc` | Activation key + license.json validation |
| `src/proxi_record.py` | `proxi/proxi_record.cpython-312.pyc` | PROXI binary parse/serialize |
| `src/uds_transport.py` | `proxi/uds_transport.cpython-312.pyc` | UDS read/write sequence over J2534 |

## Runtime dependencies (from EXE manifest)

```
Python         3.12
cryptography   46.0.3
pythonnet      3.x
pywin32        (WMI access for HWID)
WebView2       (embedded UI)
```
