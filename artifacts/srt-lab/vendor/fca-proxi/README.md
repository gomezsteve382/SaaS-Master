# FCA PROXI Tool — Vendored Binary

**Version:** 1.2.0.1  
**Runtime:** Python 3.12 · PyInstaller · pythonnet · WebView2 · cryptography 46.0.3  
**HWID this copy is activated against:** `2899614-B9E65D4-73F1D98-D6D5DCB`  
**Activation key:** `BS4JTT2G2AYR86KZ545HAEXTAHXZYNBP95U6GSBZZBC8PMDHT23YZEKXRQN6LG7PQCSJ2Z93GRD8Z3RM3R`

## INTERNAL USE ONLY — DO NOT REDISTRIBUTE

This binary is vendored for internal bench use by SRT Lab. It must not be
distributed outside this private repository.

## Files

| File | Purpose |
|------|---------|
| `FCA_PROXI_Tool.exe` | PyInstaller bundle — Stellantis PROXI config tool |
| `shfolder.dll` | Safengine-Shielden license bypass sideload |
| `chichitoworkshop.key` | AES-encrypted activation key blob |
| `license.json` | License envelope with `chichitoworkshop` bypass strings |
| `Readme.txt` | Original activation readme (HWID + key) |
| `manifest.json` | SHA-256 + size manifest for integrity verification |

## How the bypass works

The EXE embeds a Safengine-Shielden license check that normally validates an
online HWID → signature round-trip. When `shfolder.dll` is present in the
**same folder** as the EXE, Windows loads it via DLL side-loading instead of
the system `shfolder.dll`. The side-loaded DLL patches the license-check
branch so any `license.json` whose `sig` field equals `"chichitoworkshop"` is
accepted without cryptographic verification.

The `.key` blob is still read and decrypted (AES, key derived from the HWID
segments via the `cryptography` library), but the decrypted result is never
checked against an external server; the patched code accepts it unconditionally.

## Launch requirement

The EXE **must be started with its CWD set to this folder** so that:
1. Windows finds `shfolder.dll` before searching `%SYSTEM32%`.
2. The EXE finds `chichitoworkshop.key` and `license.json` by relative path.

The SRT Lab bridge `POST /tools/launch` handles this automatically.

## PROXI record format (summary)

A PROXI record is a vehicle-specific configuration blob exchanged via UDS
service 0x22 (Read Data By Identifier) / 0x2E (Write Data By Identifier).
The tool reads the full 128-byte PROXI from the BCM at DID 0xFD01 (or
0xFD20 on newer SGW-protected platforms) and allows editing of named fields
before writing it back.

See `../../docs/fca-proxi-reference.md` for the full field layout.
