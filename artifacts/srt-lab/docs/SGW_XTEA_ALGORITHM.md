# SGW XTEA — Extracted Key & Algorithm

> **Private reference.** The XTEA key below was lifted from a cracked OEM
> diagnostic SWF (`attached_assets/CDA_1776448059516.swf`). Do not commit
> this file to a public repo without explicit go‑ahead.

## Source

- File: `attached_assets/CDA_1776448059516.swf`
- Header: `CWS` (zlib‑compressed SWF v11). Decompress by rewriting bytes
  0..2 to `FWS` and `zlib.inflateSync` everything from offset 8 onward.
  The flat body is 8,716,990 bytes.
- Anchor: AS3 constant‑pool offset **`0x24664A`** in the inflated body.

## Where the key lives

The constant pool in the AS3 ABC block at `0x24664A` reads:

```
... 11 "LOG_TARGET_PHRASE" 08 "?G@H?;H:" 03 "KEY"
    10 "BC474048A33B483A" 10 "6368727973313372" 08 "IS_CHINA" ...
```

`KEY` is a `static const` whose *value* is the concatenation of the two
following 16‑char ASCII‑hex string constants. Hex‑decoding gives the
**128‑bit XTEA key**:

```
KEY = BC 47 40 48 A3 3B 48 3A 63 68 72 79 73 31 33 72
    = (0xBC474048, 0xA33B483A, 0x63687279, 0x73313372)   // four big-endian u32s
```

Note the second 8 bytes are themselves printable ASCII — `chrys13r` —
which makes the constant easy to confirm by eye.

## AS3 call graph

The XTEA implementation lives in the bundled `as3crypto` (hurlant)
library at `com.hurlant.crypto.symmetric` (string pool entry seen at
`0x172d72`):

- `XTeaKey` class declared at constant‑pool offset `0x22ca32`, with the
  `NUM_ROUNDS` static constant (== 32, the standard XTEA round count).
- Block size: 8 bytes (64‑bit), key size: 16 bytes (128‑bit), delta:
  `0x9E3779B9` (golden‑ratio constant — confirmed unmodified by the
  presence of the standard hurlant `XTeaKey` symbol).
- Higher‑level wrappers visible in the same pool: `CBCMode`, `IVMode`,
  `PKCS5`, `NullPad`, `ICipher` — XTEA is wired into the same
  CBC/PKCS5 pipeline as the other block ciphers in the SWF.

The key is consumed by the dccTools settings layer
(`ServiceSettings._key` / `_iv` / `_useSecretKey` /
`_secretKeyService` — strings at `0x185780..0x18579e`) which configures
the `SecurityGatewayCommand` (`0x16cf14`) HTTP/diagnostic flows:

- `SecurityGatewayCommand.unlockSecurityGateway`
- `SecurityGatewayCommand.dongleUnlockSecurityGateway`
- `SecurityGatewayCommand.flashUnlockSecurityGateway`

These call paths hit the SGW at CAN ID **`0x74F` request / `0x76F`
response** with a UDS `27 01` / `27 02` security‑access exchange.

## Mode / IV / padding

- Mode: **ECB single block** for the seed→key transform used here.
  CBC + PKCS5 are present in the SWF but are used by the higher‑level
  HTTP envelope to the unlock server, not by the on‑wire UDS exchange.
- IV: not applicable for the single‑block transform. `_iv` in
  `ServiceSettings` is configured per HTTP context, not per UDS request.
- Endianness: big‑endian for both seed/key and the four key words above.
- Rounds: 32 (standard).

## Seed → key transform (v1)

For the UDS `27 01` / `27 02` exchange used by SRT Lab the SGW returns
a 4‑byte seed. The transform implemented in `algos.js` /
`srt_lab.py` is:

1. Take the 4‑byte seed as a big‑endian `u32` → `v0`.
2. Set `v1 = ~v0` (bitwise complement) so a zero seed never collapses
   the block to all zeros.
3. Run one XTEA(32) encrypt block with the SGW key above.
4. Return the high 32 bits (`v0` of the ciphertext) as the 4‑byte key.

The full 8 bytes of the encrypted block are exposed via
`xtea_sgw_full(seed)` for SGWs that ask for an 8‑byte response.

## Worked example

```
seed       = 0x12345678
v0, v1     = 0x12345678, 0xEDCBA987         # v1 = ~seed
key (u128) = BC474048 A33B483A 63687279 73313372
XTEA(32)
   ciphertext c0, c1 = 0xFCB85437, 0xB3E3C96A   # full 8 bytes
   xtea_sgw(0x12345678) = 0xFCB85437            # high u32 → 4-byte UDS key
   UDS 27 02 payload    = FC B8 54 37
```

### Pinned parity vectors

These exact values are asserted from three places — keep them
byte‑for‑byte in sync:

| seed | high‑word `c0` (== `xtea_sgw(seed)`) | low‑word `c1` |
| --- | --- | --- |
| `0x00000000` | `0x9D76B2A1` | `0x34A91DEE` |
| `0x12345678` | `0xFCB85437` | `0xB3E3C96A` |
| `0xA1B2C3D4` | `0x3E98C5CE` | `0xF921AB09` |
| `0xDEADBEEF` | `0x85135F8C` | `0xDD4A5FF3` |
| `0xFFFFFFFF` | `0x8DC3151B` | `0x23A6E04A` |

- `artifacts/srt-lab/src/__tests__/algos.xtea.test.mjs` → `SGW_VECTORS`
  (asserted against `xtea_sgw` and `xteaEncryptBlock`).
- `artifacts/srt-lab/public/srt_lab.py` → `SGW_XTEA_VECTORS` plus an
  `_selftest_xtea_sgw()` that runs at import time.
- This doc (above table).

The values were produced by a from‑spec reference XTEA running with the
key in this doc and double‑checked by the test
`"XTEA encipher matches a known-good reference implementation"` in
`algos.xtea.test.mjs`.

> **Caveat.** These vectors prove the JS and Python ports agree on a
> well‑defined, deterministic XTEA(32) transform with the SWF‑extracted
> key. They do *not* yet prove that the chosen 4‑byte‑seed → high‑u32
> framing is what a real 2018+ FCA Secure Gateway accepts on the wire.
> Validate against an actual vehicle and capture real seed/key pairs
> before relying on this in production.

## Wiring inside SRT Lab

- JS: `xtea_sgw(seed)` and `unlockKey('xtea_sgw', seed)` in
  `src/lib/algos.js`. Picked up automatically by the Seed→Key tab
  (`SGW (XTEA)`).
- `MODULE_TARGETS` in `src/lib/jailbreakFeatures.js` ships an
  `sgw-xtea` entry (`tx 0x74F`, `rx 0x76F`, `unlock: "xtea_sgw"`).
- Jailbreak / OBD / Bench unlock dispatchers route by either the
  `MODULE_TARGETS.unlock` field or the helper `unlockIdForTx(tx)` so
  any flow that lands on `0x74F` runs XTEA instead of CDA6.
- Python mirror: `algo_xtea_sgw` + `BCM_ALGORITHMS['SGW XTEA']` in
  `public/srt_lab.py`.
