# SEARCH SPEC — RFHUB per-key INDEX byte

  ## The one unknown
  Every key record in an FCA/Stellantis RFHUB (MPC, 4KB 95xxx EEPROM) is:

      [ keyId : 4 bytes LE in file ]  [ INDEX : 1 byte ]  [ FLAG : 1 byte (01 or 03) ]   (mirrored, FFFF separated)

  keyId, flag, mirroring, table layout = SOLVED. The ONLY value we cannot reproduce
  offline is the 1-byte **INDEX**. Without the correct INDEX a written key is rejected
  exactly like a blank-index (0x95) attempt.

  We need the function:

      INDEX = F( keyId , master_secret )      # 1 byte out

  - keyId           : 4-byte transponder ID (big-endian form used below)
  - master_secret   : 16 bytes at file offset 0x0226 (mirror at 0x0238), unique per vehicle
  - INDEX           : 1 byte

  It MAY be F(keyId) alone (master-independent). The sentinel record keyId=FFFFFF02
  maps to INDEX=0xFB on TWO different master secrets (V2 and V3), which hints at
  master-independence — but FFFFFF02 is almost certainly a hardcoded factory sentinel,
  so do not over-trust it. Treat master as an input until proven otherwise.

  ## Ground-truth dataset (real bench dumps, 4 distinct vehicles)
  See pairs_all.csv and vehicles.txt. 21 real keyId->INDEX pairs across 4 master secrets.
  Use them as the validation oracle: a candidate F is correct ONLY if it reproduces
  ALL non-sentinel pairs for every vehicle.

  ## Already RULED OUT (do not waste cycles)
  - CRC8: every polynomial 0x00-0xFF x inits {00,FF,55,AA,1D,3D} x {refin,refout} x {xorout 00,FF}, on keyId BE and LE. No match.
  - Single-byte linear: keyId[p] XOR/ADD/SUB const, all p, all const. No match.
  - Folds: sum, xor, sum+1 over keyId bytes. No match.
  - (All of the above tested against the full multi-vehicle set in solve_index.mjs --builtins.)

  ## Candidate families to test next (in priority order)
  1. **CRC16 truncation** — CCITT/IBM/MODBUS/etc, take high byte OR low byte OR (hi^lo),
     over keyId, over keyId||master, over master||keyId. (harness has a CRC16 sweep stub)
  2. **Keyed truncation of a block cipher** — DES / 3DES / AES-128 with master_secret
     (or a transform of it) as the key, keyId as (zero-padded) plaintext, INDEX = one
     output byte. Try first/last byte, and byte = output[k] for all k.
  3. **Hitag2 / FCA transponder auth** — INDEX may be a byte of the crypto-handshake
     authenticator computed from the universal MIKRON SK + keyId.
  4. **FCA seed-to-key style** — run keyId (and/or master) through the known FCA
     seed->key transforms; INDEX = one byte of the response.
  5. **Table/PRNG index** — INDEX could be an allocation counter, NOT derived. If so,
     pairs will show INDEX correlating with slot order, not keyId. The before/after
     capture (below) settles this immediately.

  ## THE FASTEST PATH — before/after capture (do this first)
  If your software can ADD ONE KEY to an RFHUB, you do not need to solve any math:
  1. Dump the RFHUB EEPROM -> save as before.bin
  2. Add ONE key whose keyId you record (write it down).
  3. Dump again -> after.bin
  4. Run:  node diff_dumps.mjs before.bin after.bin
     It prints the exact INDEX your working tool assigned to that known keyId.
  Send back before.bin + after.bin + the keyId. Two or three of these and F is solved
  (or proven to be a non-derivable counter, in which case we replicate the counter).

  ## What to send back
  - EITHER: a working F (any language) + which pairs it reproduces, OR
  - before.bin / after.bin / keyId triples from a successful add, OR
  - predicted INDEX for new keyIds your tool computes (we bench-verify on EEPROM, no PIN risk).
  