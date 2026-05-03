# GPEC Unlocker — Vendored Binary

**Version:** 1.0  
**Runtime:** .NET Framework 4.8.1  
**Protection:** WinLicense 2.4.6.30 (anti-debug Advanced, API-wrapping Level 2, memory guard)

## INTERNAL USE ONLY — DO NOT REDISTRIBUTE

This binary is vendored for internal bench use by SRT Lab. It must not be
distributed outside this private repository.

## What it does

GPEC Unlocker automates the Continental GPEC2A EEPROM security-byte unlock
workflow — the same sequence that SRT Lab's native GPEC2A tab implements
natively. The vendored binary is kept here so the bench can fall back to the
original tool for comparison or for ECUs where the native path is untested.

## Files

| File | Purpose |
|------|---------|
| `GPEC_Unlocker.exe` | WinLicense-protected .NET binary |
| `manifest.json` | SHA-256 + size manifest for integrity verification |

## Protection notes (from WinLicense log)

- Anti-debugger: Advanced — will refuse to run under any common debugger  
- Anti-dump: ENABLED — memory dump extraction will fail  
- Entry Point Obfuscation: ENABLED  
- Resource Encryption: ENABLED  
- API-Wrapping Level 2 — most Win32 calls are wrapped through a trampoline  
- Memory Guard: ENABLED  

Unlike FCA PROXI Tool, GPEC Unlocker does **not** appear to use a sideloaded
DLL for license bypass; the protection is structural (WinLicense keygen or
serial-based). No `.key` or `license.json` files are required — the binary
runs as-is on any machine without a license check (WinLicense trial/cracked
build).

## Launch requirement

No special CWD requirement. The SRT Lab bridge `POST /tools/launch` starts it
from this folder for consistency.
