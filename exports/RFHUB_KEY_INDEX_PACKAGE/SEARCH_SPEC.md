# SEARCH SPECIFICATION — RFHUB Key Index Byte

## Objective
Find the function **F** that maps a transponder Key ID to its 1-byte RFHUB table index.

    F(keyId) -> index            (or keyed: F(keyId, master) -> index)

Once F is known, ANY new key can be added to the RFHUB table offline.

## Inputs
- **keyId**: 4-byte transponder serial, big-endian as the Autel prints it.
  In EEPROM it is stored byte-reversed (revUID).
- **master**: 16-byte per-vehicle secret @ 0x0226:
  `59 02 2F 55 42 BE 76 44 EC 20 28 C5 3A D4 D6 54`

## Output
- **index**: single byte, 0x00–0xFF.

## Test vectors — F must reproduce ALL SIX exactly
| keyId (BE) | revUID (LE) | index |
|------------|-------------|-------|
| 0077A29B   | 9BA27700    | 0x48  |
| CC62209F   | 9F2062CC    | 0x0F  |
| 09A6629F   | 9F62A609    | 0x4C  |
| 91654F9E   | 9E4F6591    | 0x19  |
| 197E6C9E   | 9E6C7E19    | 0x5B  |
| C47D6C9E   | 9E6C7DC4    | 0xB0  |

## Already ruled out — DO NOT re-test
- CRC8 (all 256 polys x inits 00/FF/55/AA) of keyId, revUID, keyId+master, master+keyId, keyId^master.
- Byte-wise xor/add/sub of any single keyId byte with a constant.
- keyId byte XOR / ADD any single master byte (all 4x16 combos).
- sum / xor folds of keyId or revUID.

## Candidate families to search — priority order
1. **Keyed cipher truncation under the master secret**
   - DES / 3DES with master[0:8] or master[8:16] as key, input = keyId (padded); take each output byte position.
   - AES-128 with master as key, input = keyId (padded); test every output byte position.
   - Magneti-Marelli / FCA seed-key tables.
2. **Hitag2 cipher output**
   - SK = `4F4E4D494B52` (universal MIKRON), UID = keyId; compute Hitag2 keystream / authenticator.
   - index may be byte N of the Hitag2 auth response.
3. **FCA/Stellantis immobilizer seed-to-key (SecurityAccess 0x27)**
   - Treat keyId as the seed, master as the key constant; index = 1 byte of the key response.
4. **CRC16 / sum16 truncated to 1 byte** of (keyId || master) or (master || keyId), all common CRC16 variants (CCITT, MODBUS, XMODEM, etc.), then high or low byte.
5. **Not offline-derivable** — if 1–4 all fail, the index is assigned by the RFHUB during the
   RoutineControl 0x0401 key-learn and cannot be precomputed. In that case the working path is
   chip-burn + OBD learn, not table editing.

## Validation
- A candidate F must reproduce all 6 indexes above.
- Then confirm on a held-out 7th key: burn a chip, write the table record with index = F(newKeyId),
  bench-flash the RFHUB EEPROM, verify the car cranks.
- Direct EEPROM bench-flash consumes **no** PIN/learn attempts, so it is safe to retry.

## Secondary data to correlate
Past slot 7 (0xCDC+) the EEPROM uses a different mirrored record layout (separated by FF FF):
    0xCDC: 00 6C 26 6C
    0xCE6: 00 00 00 00 09 10 0C FD DA 01
    0xCFE: 00 00 00 04 06 98 DA 89 F6 01
    0xD16: 00 00 3C FE 14 32 00 41 3B 01
These may be rolling counters or a second (keyless-go) key list. Check whether any field here
equals, indexes, or seeds the index byte for each KeyID.
