---
name: EFD → BIN conversion
description: How Mopar PowerCal .efd/.webm containers convert to a flashable .bin, and what is myth vs real.
---

# EFD → BIN conversion

Converting a Mopar PowerCal `.efd` / `.webm` container to a `.bin` = **carve the raw
UP payload bytes out of the EBML container**. Nothing more.

- The container is EBML (magic `1A 45 DF A3`). The payload lives in the `UP`
  element, EBML id **`0x205550`**, located by a proper EBML walk
  (`extractEfdPayload` in `efdParser.js`, which reuses `parseEFD`).
- The carved bytes are **byte-for-byte identical to what the desktop
  `EFD_Reader.exe` writes**. The real tool also does NOT decrypt — it just
  extracts the payload. The payload stays encrypted (entropy ~7.999); the ECM
  bootloader decrypts it in-place during the UDS `0x36 TransferData` flash.

**Why this matters:** an earlier handoff/LLM transcript claimed EFD_Reader.exe
"fully decrypts" and named an AES key / element id `0x42F5` / C2 URL / ransomware.
All of that is fabricated. A naive `0x42F5` two-byte id scan would carve garbage.
Do not chase a decryption step — there isn't one client-side.

**Reference fixture:** `attached_assets/05036070ab_1780363989010.efd` (3.8 MB,
mopar_powercal). UP payload: offset **625**, size **3,985,329**, entropy 7.999.

`parseEFD` clamps payload `size` to bytes actually present; `declaredSize` is the
raw EBML-claimed size. They differ only on a truncated/partial container — that
gap is the only honest "truncated download" signal.
