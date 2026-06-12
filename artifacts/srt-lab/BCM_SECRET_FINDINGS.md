# BCM SEC16 secret — evidence-grounded findings

Companion to `RFHUB_GEN2_LAYOUT.md`. Every claim traced to a byte-level diff or
multi-sample read across the real dump corpus. Unknowns are marked as unknown.

## 1. The marry algebra is PROVEN (and was never the problem)
On the SCAT 530589 **married** set (BCM + RFHUB + PCM, same VIN):

```
BCM split-secret (0x81A0/C0/E0) = 6B 56 F3 63 8A 5C B8 84 33 02 E1 B4 84 00 38 3B
RFHUB[0x050E]                    = 3B 38 00 84 B4 E1 02 33 84 B8 5C 8A 63 F3 56 6B  = reverse16(BCM)   ✓
PCM[0x3C8] SEC6                  = 3B 38 00 84 B4 E1                                = reverse(BCM)[0:6] ✓
PCM[0x3C4] marker               = FF FF FF AA  (GPEC2A)                                               ✓
```

This is exactly `immoSecret.deriveAllFromBcm`. The marry math is correct; what
was wrong was **which BCM bytes get used as the secret** (below).

## 2. Two BCM states — NOT two year-generations
The discriminator is **programmed vs un-programmed**, not model year. Secret
location is the **split records `0x81A0/C0/E0`** across 18–22 (no generational
move).

| BCM | split records | `0x40C9` | resolver source |
|---|---|---|---|
| 19 SCAT / 19 charger / 21 Jailbreak / 22 Redeye | **populated (per-car secret)** | blank / real | `split` |
| 18 ZO / 21 592745 | blank | the constant | `mirror1` |
| 18 SRT | **no split structure** | the constant | `mirror1` |

Caveat (single sample): the **18 SRT** BCM has no split-record structure at all
— possibly a genuine different part, but one dump can't confirm a variant.

## 3. The `00…31 3E 00 10 00 18 00 0A 00` constant
- **Byte-identical across 527958 / 592745 / 539430** (three unrelated cars) — so
  it is **not a per-vehicle secret.**
- Appears **only** on BCMs whose split records are blank (un-programmed/donor);
  never on programmed BCMs. Strong signal it's a **virgin/default placeholder.**
- **NOT proven fake, either.** Every constant-BCM I have is from an un-synced /
  donor set (matched RFHUB/PCM blank), so "the RFHUB doesn't carry its reverse16"
  is equally explained by "un-synced." The codebase claims FCA-SINCRO confirmed
  it as a real "6.2 Charger / 1C4RJFDJ-family bench SEC16" (`bcmSec16Absent`,
  `charger62bench.realfiles` tests).
- **Resolution requires one thing I don't have:** a *married* set whose BCM
  carries the constant. If its RFHUB carries `reverse16(constant)` → real secret;
  if not → placeholder.

## 4. What shipped (honest, non-destructive)
`resolveBcmSec16` now sets `bcmSec16.sharedConstant=true` when the resolved value
is that constant (and source≠split). **Bytes are unchanged** (SINCRO-claim
behavior + all 704 BCM tests preserved). `crossValidate` emits a warning so the
marry/key flows never present it as a confident per-car secret — honest
provenance instead of guessing in either direction.

## 5. Un-synced detection (grounded)
The 19charger set: BCM has a real split secret (`55 5A AA F0…`) but `reverse16`
of it appears **nowhere** in the RFHUB (`0x050E` = `FF 01 FF…`). That's a true
**OG set needing marry** — write `reverse16(split)` → RFHUB `0x050E`,
`reverse(split)[0:6]` → PCM `0x3C8`.
