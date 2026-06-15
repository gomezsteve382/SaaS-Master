/* aklPlanner — All-Keys-Lost job planner. PURE logic, no bus access: given the
   job inputs (dump available? live bridge? slot state?) it returns the branch,
   an ordered step plan, and any hard blocks. The wizard UI executes the plan
   against liveImmo.js primitives.

   Both branches end in the SAME live first-key learn (enterKeyLearn +
   confirmKeyLearned) — there is no separate "program first key" call. They differ
   only in the PIN source: an offline dump SEC16 (pinFromSec16) vs a live readPin.
   The PIN gates write-level security (0x27 0x03/0x04); it is not passed to the
   learn routine. A live bridge is therefore REQUIRED to program, even with a dump. */

export const AKL_STEP = Object.freeze({
  CONNECT: 'connect',
  PIN_OFFLINE: 'pin-offline',
  PIN_LIVE: 'pin-live',
  CHECK_SLOTS: 'check-slots',
  ERASE: 'erase-all',
  ENTER_LEARN: 'enter-learn',
  INSERT_KEY: 'insert-key',
  CONFIRM: 'confirm-learned',
  EXIT: 'exit-learn',
});

/* inputs: { hasDump, dumpSec16:(number[]|null), hasBridge, slots:({occupiedCount,total}|null), eraseConfirmed }
   returns: { branch:'dump'|'live', ok, blocks:[...], steps:[{id,label,kind}] }
     kind: 'auto' (runs automatically) | 'operator' (waits for the tech) |
           'confirm' (irreversible — explicit confirm) | 'always' (runs on success AND abort) */
export function planAkl({ hasDump = false, dumpSec16 = null, hasBridge = false, slots = null, eraseConfirmed = false } = {}) {
  const blocks = [];
  if (!hasBridge) {
    blocks.push('A live bridge connection is required to PROGRAM a key — the first-key learn is a live operation (a dump alone can only supply the PIN).');
  }
  const dumpUsable = hasDump && Array.isArray(dumpSec16) && dumpSec16.length >= 16;
  const branch = dumpUsable ? 'dump' : 'live';

  const slotsFull = !!(slots && typeof slots.occupiedCount === 'number' && slots.occupiedCount >= (slots.total || 8));
  if (slotsFull && !eraseConfirmed) {
    blocks.push('All key slots are full — an erase-all (IRREVERSIBLE) is required before a first-key learn. Confirm the erase to proceed.');
  }

  const steps = [];
  steps.push({ id: AKL_STEP.CONNECT, label: 'Connect + identify immobilizer module', kind: 'auto' });
  steps.push(branch === 'dump'
    ? { id: AKL_STEP.PIN_OFFLINE, label: 'Extract PIN from dump SEC16 (offline)', kind: 'auto' }
    : { id: AKL_STEP.PIN_LIVE, label: 'Read PIN live (27 01/02 → SEC16 → PIN)', kind: 'auto' });
  steps.push({ id: AKL_STEP.CHECK_SLOTS, label: 'Read key slots (need ≥ 1 empty)', kind: 'auto' });
  if (slotsFull) steps.push({ id: AKL_STEP.ERASE, label: 'Erase all keys — IRREVERSIBLE', kind: 'confirm' });
  steps.push({ id: AKL_STEP.ENTER_LEARN, label: 'Enter key-learn (routine 0x0203)', kind: 'auto' });
  steps.push({ id: AKL_STEP.INSERT_KEY, label: 'Insert new key + cycle ignition', kind: 'operator' });
  steps.push({ id: AKL_STEP.CONFIRM, label: 'Confirm key learned (poll 31 03 02 03)', kind: 'auto' });
  steps.push({ id: AKL_STEP.EXIT, label: 'Exit key-learn (runs on success and abort)', kind: 'always' });

  return { branch, ok: blocks.length === 0, blocks, steps };
}

export function pinSourceLabel(branch) {
  return branch === 'dump' ? 'offline dump SEC16' : 'live read (27 01/02)';
}
