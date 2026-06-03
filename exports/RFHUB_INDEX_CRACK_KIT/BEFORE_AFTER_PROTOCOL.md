# BEFORE / AFTER CAPTURE PROTOCOL  (highest-value deliverable)

  Goal: capture the exact INDEX a known-good tool assigns to a known keyId, so we get
  ground-truth F(keyId,master)->INDEX samples with zero guessing and zero PIN risk.

  Steps (bench, RFHUB on the table or via your tool's read/write):
  1. Read full RFHUB EEPROM. Save EXACTLY as: before.bin   (4096 bytes for MPC modules)
  2. Using your software, ADD ONE key. Record its 4-byte keyId (8 hex chars).
     - One key per capture. Multiple keys at once is fine but list every keyId added.
  3. Read the EEPROM again. Save as: after.bin
  4. Run:  node diff_dumps.mjs before.bin after.bin
     Output = newly appeared key records with their keyId + INDEX + flag + offset,
     plus whether the master secret changed.
  5. Send back: before.bin, after.bin, and the keyId(s) you added.

  Repeat on 2-3 different vehicles if possible (different master secrets). That set
  either reveals F directly or proves INDEX is an allocation counter we then replicate.

  Notes:
  - EEPROM read/write does NOT consume PIN attempts (no 0x0401 OBD learn involved).
  - Do not virginize between before/after — we need the delta of a single add.
  