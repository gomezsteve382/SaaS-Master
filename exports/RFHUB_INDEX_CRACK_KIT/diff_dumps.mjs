#!/usr/bin/env node
/*
 * diff_dumps.mjs  before.bin  after.bin
 * Prints key records that appear in after.bin but not before.bin (the keys your tool added),
 * with their assigned INDEX byte. Also flags master-secret changes.
 *
 * For 4 KB MPC Charger/Challenger images it additionally answers the two
 * questions the bench verification needs (mirrors the in-app diffCharKeyTables
 * harness in artifacts/srt-lab/src/lib/charRfhubKeyTable.js):
 *   1. Did the added key land in the HIGHEST free slot of before.bin?
 *   2. Did anything change OUTSIDE the 8-slot key table (a candidate companion
 *      table an offline add would also have to touch)?
 */
import fs from 'fs';
const [, , beforeP, afterP] = process.argv;
if (!beforeP || !afterP) { console.error('usage: node diff_dumps.mjs before.bin after.bin'); process.exit(1); }
const hx = a => Buffer.from(a).toString('hex').toUpperCase();

// 4 KB MPC Charger key table: 8 slots @0xC5E stride 16 (6-byte record + FF FF + mirror).
const KT_BASE = 0x0C5E;
const KT_SLOTS = 8;
const KT_STRIDE = 16;
const KT_END = KT_BASE + KT_SLOTS * KT_STRIDE; // exclusive
const MASTER_OFF = 0x0226;
const MASTER_LEN = 16;

function recs(b) {
  const out = new Map();
  for (let i = 0; i + 14 <= b.length; i++) {
    if (b[i + 6] === 0xFF && b[i + 7] === 0xFF) {
      const a = b.subarray(i, i + 6), c = b.subarray(i + 8, i + 14);
      if (Buffer.compare(a, c) === 0) {
        const flag = a[5], uid = hx(a.subarray(0, 4));
        if ((flag === 0x01 || flag === 0x03) && !['5A5A5A5A', 'FFFFFFFF', '00000000'].includes(uid)) {
          const keyId = hx([a[3], a[2], a[1], a[0]]);
          out.set(keyId + ':' + a[4] + ':' + flag, { keyId, index: a[4], flag, off: i });
          i += 13;
        }
      }
    }
  }
  return out;
}

// Slot-level view of a 4 KB image: which of the 8 key-table slots hold a key,
// and which are empty (template 5A5A5A5A / all-FF / all-00). Highest empty slot
// is the one addCharKey fills by default.
function slotView(b) {
  const slots = [];
  for (let s = 0; s < KT_SLOTS; s++) {
    const off = KT_BASE + s * KT_STRIDE;
    const rec = b.subarray(off, off + 6);
    const mir = b.subarray(off + 8, off + 14);
    const mirrorOk = Buffer.compare(rec, mir) === 0;
    const flag = rec[5];
    const uid = hx(rec.subarray(0, 4));
    const isKey = mirrorOk && (flag === 0x01 || flag === 0x03) && !['5A5A5A5A', 'FFFFFFFF', '00000000'].includes(uid);
    const isEmpty = uid === '5A5A5A5A' || uid === 'FFFFFFFF' || uid === '00000000';
    slots.push({ slot: s + 1, slotIdx: s, off, isKey, isEmpty, keyId: isKey ? hx([rec[3], rec[2], rec[1], rec[0]]) : null });
  }
  return slots;
}
function highestFreeSlot(slots) {
  for (let i = slots.length - 1; i >= 0; i--) if (slots[i].isEmpty && !slots[i].isKey) return i;
  return -1;
}
function coalesce(a, b, gap = 8) {
  const len = Math.min(a.length, b.length);
  const runs = [];
  let cur = null;
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) { if (cur && i - cur.end <= gap) cur.end = i; else { cur = { start: i, end: i }; runs.push(cur); } }
  }
  return runs;
}
const inKeyTable = r => r.start < KT_END && r.end >= KT_BASE;
const inMaster = r => r.start < MASTER_OFF + MASTER_LEN && r.end >= MASTER_OFF;

const A = fs.readFileSync(beforeP), B = fs.readFileSync(afterP);
for (const [p, b] of [[beforeP, A], [afterP, B]]) if (![4096, 8192, 65536].includes(b.length))
  console.log('!! WARN ' + p + ' is ' + b.length + ' B — not a typical RFHUB EEPROM size (4096/8192/65536); results may be unreliable.');
const ra = recs(A), rb = recs(B);
const ma = A.length >= 0x236 ? hx(A.subarray(MASTER_OFF, MASTER_OFF + MASTER_LEN)) : '?';
const mb = B.length >= 0x236 ? hx(B.subarray(MASTER_OFF, MASTER_OFF + MASTER_LEN)) : '?';
console.log('before:', beforeP, A.length, 'B  master', ma);
console.log('after :', afterP, B.length, 'B  master', mb);
const masterChanged = ma !== mb;
if (masterChanged) console.log('!! master secret CHANGED between dumps — this is a FULL RE-KEY / cross-vehicle pairing, NOT a single offline key-add.');

console.log('\nNEW key records (in after, not before):');
const added = [];
for (const [k, v] of rb) if (!ra.has(k)) { added.push(v); }
if (!added.length) console.log('  (none — no new keys detected)');
for (const v of added) {
  console.log('  keyId=' + v.keyId + '  INDEX=0x' + v.index.toString(16).padStart(2, '0').toUpperCase() +
    '  flag=0x0' + v.flag + '  @0x' + v.off.toString(16));
}
const removed = [];
for (const [k, v] of ra) if (!rb.has(k)) removed.push(v);
if (removed.length) {
  console.log('\nREMOVED key records (in before, not after):');
  for (const v of removed) console.log('  keyId=' + v.keyId + '  @0x' + v.off.toString(16));
}

// 4 KB MPC slot-rule + companion-table analysis.
if (A.length === 4096 && B.length === 4096) {
  console.log('\n── 4 KB MPC key-table analysis ──');
  const beforeSlots = slotView(A);
  const hf = highestFreeSlot(beforeSlots);
  console.log('  before slots: ' + beforeSlots.map(s => s.isKey ? `K${s.slot}` : (s.isEmpty ? `.${s.slot}` : `?${s.slot}`)).join(' '));
  console.log('  highest free slot in before: ' + (hf < 0 ? 'NONE (table full)' : `slot ${hf + 1} (idx ${hf}) @0x${(KT_BASE + hf * KT_STRIDE).toString(16)}`));

  if (added.length === 1 && removed.length === 0 && !masterChanged) {
    const v = added[0];
    const addedSlotIdx = (v.off - KT_BASE) % KT_STRIDE === 0 ? (v.off - KT_BASE) / KT_STRIDE : -1;
    if (addedSlotIdx >= 0 && addedSlotIdx < KT_SLOTS) {
      const rule = addedSlotIdx === hf;
      console.log(`  added key landed in slot ${addedSlotIdx + 1} (idx ${addedSlotIdx}) — highest-free-slot rule: ${rule ? 'MATCH ✓' : 'MISMATCH ✗ (expected idx ' + hf + ')'}`);
    } else {
      console.log(`  added key @0x${v.off.toString(16)} is not slot-aligned to the key table — unexpected layout.`);
    }
  } else {
    console.log('  (highest-free-slot rule only evaluated for a clean single key-add with unchanged master)');
  }

  const runs = coalesce(A, B);
  const companion = runs.filter(r => !inKeyTable(r) && !inMaster(r));
  if (!companion.length) {
    console.log('  companion-table candidates: NONE — every changed byte is inside the key table' + (masterChanged ? ' or the master secret.' : '.'));
  } else {
    console.log('  companion-table candidates (changed runs OUTSIDE key table & master — an offline add may also need these):');
    for (const r of companion) console.log(`    0x${r.start.toString(16)}–0x${r.end.toString(16)} (${r.end - r.start + 1} B)`);
  }
}

console.log('\n>>> Send back: before.bin, after.bin, and the keyId you added.');
