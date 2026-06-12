#!/usr/bin/env node
/* derive-gpec-patterns.mjs — recover the GPEC2A unlock patterns from a
 * locked/unlocked file pair, so the GPEC2A File-Unlock tab can be activated
 * without unpacking the WinLicense-protected GPEC_Unlocker.exe.
 *
 * WHY: gpec2aUnlocker.js has PATTERNS_AVAILABLE=false because three 4-byte
 * search patterns live in a protected section of the binary and were never
 * statically recoverable. But the unlock transform is known:
 *     byte[K]      -> 0xE8     (K = match offset of UNLOCK_TARGET_PATTERN)
 *     byte[0x2FFFC] -> 0x96    (only when file length > 0x2FFFC)
 * So one locked file + its unlocked output is enough to derive:
 *     UNLOCK_TARGET_PATTERN     = locked[K..K+4]      (the original 4 bytes)
 *     ALREADY_UNLOCKED_PATTERN  = unlocked[K+1..K+5]  (the 4 bytes after the E8)
 * GEN_DETECT_PATTERN is a firmware-generation marker, not part of the unlock,
 * and cannot be derived from a single pair — it stays null (gen labeling shows
 * as unknown, but the unlock itself works).
 *
 * USAGE:
 *   node derive-gpec-patterns.mjs <locked.bin> <unlocked.bin>
 *
 * The two LOCKED files already shipped in attached_assets/ are valid inputs;
 * you only need to produce ONE unlocked counterpart by running the unlocker
 * once on Windows, then diff the pair with this script.
 */
import { readFileSync } from 'node:fs';

const FLAG_OFF = 0x2FFFC;
const FLAG_VAL = 0x96;
const PATCH_VAL = 0xE8;
const hex = (b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0');
const arr = (bytes) => '[' + Array.from(bytes).map(hex).join(', ') + ']';

function main() {
  const [lockedPath, unlockedPath] = process.argv.slice(2);
  if (!lockedPath || !unlockedPath) {
    console.error('usage: node derive-gpec-patterns.mjs <locked.bin> <unlocked.bin>');
    process.exit(2);
  }
  const locked = readFileSync(lockedPath);
  const unlocked = readFileSync(unlockedPath);

  if (locked.length !== unlocked.length) {
    console.error(`REFUSE: length mismatch — locked ${locked.length} B vs unlocked ${unlocked.length} B. `
      + 'The unlocked file must be the same image patched in place; a different dump is not a valid pair.');
    process.exit(1);
  }

  // collect every differing offset
  const diffs = [];
  for (let i = 0; i < locked.length; i++) if (locked[i] !== unlocked[i]) diffs.push(i);

  console.log(`locked   : ${lockedPath} (${locked.length} B)`);
  console.log(`unlocked : ${unlockedPath} (${unlocked.length} B)`);
  console.log(`changed bytes: ${diffs.length}`);
  for (const o of diffs) {
    console.log(`  @0x${o.toString(16).toUpperCase()}  ${hex(locked[o])} -> ${hex(unlocked[o])}`);
  }
  console.log('');

  // 1. the flag byte
  const flagChanged = diffs.includes(FLAG_OFF);
  if (!flagChanged) {
    console.warn(`WARNING: expected the unlock flag at 0x2FFFC to change to ${hex(FLAG_VAL)}, `
      + `but it is unchanged (locked=${hex(locked[FLAG_OFF] ?? 0)}). `
      + 'Either the file is <= 0x2FFFC bytes, or this is not a clean unlock pair.');
  } else if (unlocked[FLAG_OFF] !== FLAG_VAL) {
    console.warn(`WARNING: flag @0x2FFFC changed to ${hex(unlocked[FLAG_OFF])}, not the expected ${hex(FLAG_VAL)}. `
      + 'Transform may differ from the documented one — inspect before trusting.');
  }

  // 2. the E8 patch byte(s): a changed offset (not the flag) where unlocked == 0xE8
  const e8sites = diffs.filter((o) => o !== FLAG_OFF && unlocked[o] === PATCH_VAL);
  const otherChanges = diffs.filter((o) => o !== FLAG_OFF && unlocked[o] !== PATCH_VAL);
  if (otherChanges.length) {
    console.warn(`WARNING: ${otherChanges.length} changed byte(s) are neither the flag nor an 0xE8 patch `
      + `(e.g. @0x${otherChanges[0].toString(16).toUpperCase()}). The documented unlock only writes 0xE8 + the flag — `
      + 'extra changes mean a different/newer unlock routine; do NOT blindly trust the derived patterns.');
  }
  if (e8sites.length !== 1) {
    console.error(`\nREFUSE: expected exactly one 0xE8 patch site, found ${e8sites.length}. Cannot derive a single `
      + 'UNLOCK_TARGET_PATTERN unambiguously. Provide a cleaner pair or inspect the diff above.');
    process.exit(1);
  }

  const K = e8sites[0];
  if (K + 5 > locked.length) {
    console.error('REFUSE: patch site is within 5 bytes of EOF; cannot read a 4-byte pattern with look-behind.');
    process.exit(1);
  }
  const unlockTarget = locked.slice(K, K + 4);          // original 4 bytes (pre-patch)
  const alreadyUnlocked = unlocked.slice(K + 1, K + 5); // 4 bytes after the 0xE8

  console.log('\n========== DERIVED PATTERNS ==========');
  console.log(`patch offset K            = 0x${K.toString(16).toUpperCase()}`);
  console.log(`UNLOCK_TARGET_PATTERN     = ${arr(unlockTarget)}   // locked[K..K+4], byte[K] -> 0xE8`);
  console.log(`ALREADY_UNLOCKED_PATTERN  = ${arr(alreadyUnlocked)}   // unlocked[K+1..K+5], scanned with 0xE8 look-behind`);
  console.log(`GEN_DETECT_PATTERN        = null   // not derivable from one pair; needs a 2015 vs 2018+ locked sample`);

  console.log('\n========== READY-TO-PASTE (gpec2aUnlocker.js) ==========');
  console.log(`export const PATTERNS_AVAILABLE = true;`);
  console.log(`export const GEN_DETECT_PATTERN       = null; // still unknown; gen labeling degrades, unlock still works`);
  console.log(`export const ALREADY_UNLOCKED_PATTERN = ${arr(alreadyUnlocked)};`);
  console.log(`export const UNLOCK_TARGET_PATTERN    = ${arr(unlockTarget)};`);
  console.log('\nNOTE: validate by re-running this script on a SECOND locked/unlocked pair — the two');
  console.log('patterns must come out identical. One pair is enough to derive; two pairs prove it.');
}

main();
