# GPEC2A File Unlock — Implementation Notes

## What this tool does

The GPEC2A File Unlock tab patches a Continental GPEC2/GPEC2A firmware binary
(full-flash image, typically 192 KB – 4 MB) so that the PCM's internal
immobilizer/calibration lock is lifted at boot time.  The patch is **file-level
only** — no OBD connection, no seed/key, no hardware required.

## Algorithm source

The algorithm was recovered by disassembling the .NET IL bytecode of
`GPEC_Unlocker.exe` (WinLicense-protected), extracted from the villain tool-chain
(`VILLAIN_GPEC_COMPLETE_EXTRACTION_*.zip`, inner path
`villain_extraction/GPEC_Unlocker_Cracked/GPEC_UNLOCK_ALGORITHM.md`).

## Algorithm (from IL disassembly)

### Generation detection — `DetectFileFlashGeneration`

```
pattern = GEN_DETECT_PATTERN  (FieldRVA [04:0005], 4 bytes — UNKNOWN)
scan fileData[0..end-4] for pattern
  if found → "2015-2018 FILE FLASH"
  else     → "NEW 2018+ FILE FLASH"
```

### Already-unlocked check — `IsFileAlreadyUnlocked`

```
pattern = ALREADY_UNLOCKED_PATTERN  (FieldRVA [04:0006], 4 bytes — UNKNOWN)
scan fileData[1..end-4] for pattern
  if found at i AND fileData[i-1] == 0xE8 → already unlocked
if fileData.length > 0x2FFFC AND fileData[0x2FFFC] == 0x96 → already unlocked
```

### Unlock patch — `BtnUnlock_Click`

```
pattern = UNLOCK_TARGET_PATTERN  (FieldRVA [04:0007], 4 bytes — UNKNOWN)
patternFound = false
scan fileData[0..end-4] for pattern
  if found at i:
    fileData[i] = 0xE8        ← THE UNLOCK PATCH
    patternFound = true
    break

if fileData.length > 0x2FFFC:
  fileData[0x2FFFC] = 0x96   ← OFFSET FLAG (always applied)
```

The constant `0x2FFFC` (196 604 decimal) and flag byte `0x96` (150 decimal)
are **not** WinLicense-protected — they appear as plain `ldc.i4` operands in
the IL and were confirmed from the disassembly.

## Missing patterns — exact asset inventory

### Locked files available in `attached_assets/` (no unlocked counterpart)

| File | Size | Flag @ 0x2FFFC | State |
|------|------|----------------|-------|
| `FCA_CONTINENTAL_GPEC2A_EXT_EEPROM_CRC_2C3CDXCT1HH652640_1776900514064.bin` | 384 KB (393 216 B) | `0x3A` | **LOCKED** |
| `FCA_CONTINENTAL_GPEC2A_INT_FLASH_JAILBREAK)OG_6.2_1776899205056.bin` | 4 MB (4 194 304 B) | `0x08` | **LOCKED** |

Context bytes around `0x2FFFC` in each file (hex dump starting at `0x2FFF8`):

```
EXT_EEPROM: 4a 8e ff f4  [3a]  0a 0a 0a 6c ad 69 82
INT_FLASH:  44 e3 6d e3  [08]  00 ff ff ff ff ff ff
```

### What is missing

The **unlocked** version of either file above.  Run `GPEC_Unlocker.exe` on
Windows with the locked file as input, then save the output.  The flag byte at
`0x2FFFC` should change from `0x3A` / `0x08` to `0x96`, and exactly one other
byte (the match offset) will change from `original_byte` to `0xE8`.

A byte-diff of the pair immediately yields all three patterns:

```
locked[K]     → 0xE8          ⇒  UNLOCK_TARGET_PATTERN    = locked[K..K+3]
unlocked[K]   = 0xE8
unlocked[K+1..K+4]            ⇒  ALREADY_UNLOCKED_PATTERN = unlocked[K+1..K+4]
```

For `GEN_DETECT_PATTERN`: compare any 2015-2018 locked file against a 2018+
locked file; the 4-byte run present in 2015-2018 but absent in 2018+ is the
generation marker.

### Pattern extraction status

The three FieldRVA byte arrays ([04:0005], [04:0006], [04:0007]) live inside a
WinLicense virtual section (RVA 0x1480000) of the .NET PE.  They cannot be
read from the static binary without first unpacking the WinLicense container.
The `wiTECH_wde.DMP` (77 MB process dump) does not contain a loaded
GPEC_Unlocker process — it is a dump of the wiTECH vehicle-interface daemon —
so heap-scanning the DMP is also not viable.

## Activating the patterns

Once recovered, edit `artifacts/srt-lab/src/lib/gpec2aUnlocker.js`:

```js
export const PATTERNS_AVAILABLE = true;

export const GEN_DETECT_PATTERN       = [0xXX, 0xXX, 0xXX, 0xXX]; // [04:0005]
export const ALREADY_UNLOCKED_PATTERN = [0xXX, 0xXX, 0xXX, 0xXX]; // [04:0006]
export const UNLOCK_TARGET_PATTERN    = [0xXX, 0xXX, 0xXX, 0xXX]; // [04:0007]
```

Then enable the `ACTIVATE_WITH_REAL_PATTERNS` block in
`artifacts/srt-lab/src/lib/__tests__/gpec2aUnlocker.fixture.test.js` and add the
unlocked file to `attached_assets/` so the golden round-trip assertion can run.

## Test coverage

Two test suites cover the algorithm:

### Unit tests — `gpec2aUnlocker.test.js` (19 tests)

| Case | Description |
|------|-------------|
| PATTERN_MISSING guard | Returns `PATTERN_MISSING` when `PATTERNS_AVAILABLE = false` |
| Locked file patched | Writes `0xE8` at match; sets `0x96` at `0x2FFFC` |
| Already unlocked (flag) | Detects via `fileData[0x2FFFC] === 0x96`; no-op |
| Already unlocked (look-behind) | Detects `0xE8` before ALREADY_UNLOCKED_PATTERN; no-op |
| Small file | No offset flag when file ≤ `0x2FFFC` |
| Pattern not found (large file) | `status = 'offset_only'`; flag still set |
| Pattern not found (small file) | `status = 'pattern_not_found'`; no flag |
| Generation detection | 2015-2018 vs 2018+ via GEN_DETECT_PATTERN |

### Fixture tests — `gpec2aUnlocker.fixture.test.js` (real firmware files)

| File | Assertions |
|------|-----------|
| EXT_EEPROM 384 KB (locked) | Size golden, flag=0x3A, `isAlreadyUnlocked=false`, synthetic patch sets flag to 0x96, `status=offset_only`, `PATTERN_MISSING` without opts |
| INT_FLASH 4 MB (locked) | Size golden, flag=0x08, `isAlreadyUnlocked=false`, synthetic patch sets flag to 0x96 |

## Out of scope

- The AES-256 license key from the cracked WinLicense header (not needed for the patch).
- Seed/key (UDS 0x27) GPEC2A security access — this is a pure file patcher.
- GPEC1, GPEC3 generation firmware (different tool, different patterns).
- Any over-the-wire OBD flow.
