# ECU-VILLAIN — intel status (HONEST grounding)

**Source tool:** `VILLAIN_protected.exe` (~13 MB, Windows PE32, PyInstaller +
PyQt5/qdarktheme, site: ecuunlock.com). Heavily packed/protected.

**What we have in-repo:** a *strings-only scrape* taken from a 173 MB runtime
memory dump (`VILLAIN_protected_patched.DMP`). **The exe and the dump are NOT in
this environment** — only the scrape (`VILLAIN_GPEC_COMPLETE_EXTRACTION.zip`).

> ⚠️ GROUNDING: Everything below is **inventory recovered from string literals**,
> not from decompiled code. Function bodies (the actual seed→key math) were
> **NOT** recovered. Treat every algorithm as **constants-only / math
> unverified** until the exe or dump is decompiled. Do not ship any of these as
> working seed-key routines.

## Correction to the old report
- `X86_SEED_KEY_NATIVE.asm` is **mislabeled**. It is the **CPython runtime**
  (`compile` / `dont_inherit` / `optimize` / "object is not callable" =
  `Py_CompileStringFlags` + `PyObject_Call`), not a seed-key routine. No value.

## Recovered inventory (names + constants only)

### Seed-key calculators present (math NOT recovered)
- `_gpec_1_seed_calculator` — KEY_CONSTANT `670269`
- `_gpec_calculator` (GPEC2) — sec access `0x42/0x44/0x36`; q1=`0xE72E3799` q2=`0x1B64DB03`
- GPEC2 flash q1=`0x966AEEB1` q2=`0x440BCE28`
- GPEC2 eprom q1=`0x3F711F5A` q2=`0xC3573AE9` q3=`0x725EF016` q4=`0x58329671`
- GPEC3 eprom q1=`0x129D657F` q2=`0xD0726B89`
- GPEC2 2015 eprom q1=`0x47EC21F8` q2=`0xCFB81A2E`
- GPEC2A eprom q1=`0xCE853A6F` q2=`0x3BA8FDC7`
- `ngc_unlock` / `ngc_unlock_level5` / `ngc_trans_unlock_level5` — sec level `0x08`
- `seed_key_calculator_cummins` — sec access `0x0C`
- `jtec_unlock` — sec level `0x34`, fixed key `"0000"`
- `eps_unlock` / `_eps_calculator` — session `0x67`, seed DID `0x6706`, level `0x60`

### NGC tables (raw constants)
```python
TABLE       = b"DAIMLERCHRYSLER1"  # [0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31]
shift_table = [0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E]
ngc_table   = [0x2796144E,0xC55A3FD5,0x4D5C406D,0xB08EF250,
               0x91FF47E1,0x2481F456,0xC393FC49,0x3A4EFF33,
               0x1EADCC75,0xD9BDD2F5,0x679705B4,0x42CF5086,
               0x415D9886,0x19111199]
```

### TIPM seed tables + masks (raw constants)
```python
t8001 = [0x727B,0xB301,0x08EB,0xB0BA,0xECA7,0x0ECC,0xD69A,0xE47E]  # SA 0x80
t3605 = [0x7A44,0x0201,0xF123,0x146E,0xCBC2,0x553F,0xD398,0x4EDC]  # SA 0x36/0x05
t3608 = [0x9110,0x4E8A,0xEA2C,0xE235,0xB73F,0xE6E5,0x5916,0x16CC]  # SA 0x36/0x08
t8101 = [0x22B5,0x5767,0x4C5A,0xE443,0xC606,0x7544,0x0DFB,0x36D6]  # SA 0x81
t3c   = [0x632A,0x193B,0x914F,0x0F88,0x5E51,0x8DCD,0xDD6C,0x00DD]  # SA 0x3C
tc605 = [0x53CE,0xE73D,0x2255,0xB1BA,0xDA02,0x70BE,0xBB65,0x81A4]  # SA 0xC6/0x05
masks = [0xBAEE,0xE000,0x1C00,0x0380,0x0070,0x0007]               # table-index calc
# TIPM types: TIPM6/7/7S/8, BCM-KJ, BCM-CS, FCM
```

### VIN / immo DIDs
- `0x7B90` current VIN (r/w), `0x7B88` original VIN (r/w)
- `0x6E2025` bus-transmitted VIN, `0x6E2027` WCM-configured VIN
- `0x6E9EB0` SKIM state (`0x80`=enabled / `0x00`=disabled), `0x6EF190` EPS VIN
- `0xF79EB045` SKIM state flag (SCI-B)

### SKIM/immo ops (names)
get/enable/disable_skim, get/write_skim_keys (6), get/write_immo_keys (6),
get/write current/original/bus/wcm VIN, get/write_sri_mileage (E2 prefix).

### wiTECH note (separate, Erlang/OTP tool)
Official tool calls **Stellantis manufacturing servers** for SGW seed-key
(`request_sgw_signed_challenge_from_manufacturing_server`) — i.e. SGW unlock is
**server-side challenge**, not locally computable. Villain reimplements the ECU
algorithms locally (which is why recovering its actual math matters).

## To FINISH villain
Re-upload **`VILLAIN_protected.exe`** (or the 173 MB dump). Then:
`pyinstxtractor-ng → main/*.pyc → pycdc` (same pipeline that fully recovered the
FCA PROXI tool in `exe-mining/proxi/`). That yields the real function bodies so
each calculator can be **bench-verified** before it's trusted.
