/* ============================================================================
 * dealerLockoutBypass.js — 2019+ RFHUB Internal-Flash Dealer Lockout Bypass
 *                         (Task #634)
 *
 * The screenshot referenced in Task #634 includes a one-click "DEALER
 * LOCKOUT BYPASS" for the 2019+ internal-flash RFHUB. The internal-flash
 * RFHUB family ships with an attempt counter / time-delay backed by NRC
 * 0x36 (exceededNumberOfAttempts) and 0x37 (requiredTimeDelayNotExpired)
 * on the standard 0x27 0x01 security access level. The documented bench
 * sequence — extended session → alternate-level security access →
 * RoutineControl 0xFF00 (clear lockout counter) → ECU reset → re-probe —
 * lets a tech recover from the lockout without waiting out the timer.
 *
 * This module is a pure step machine: it returns the ordered list of
 * steps, drives them through a `uds(tx, rx, bytes) → {ok, d}` callback,
 * delegates the alt-level security access to a SecurityAccessSource
 * (LocalAlgoOverJ2534 / FakeSecurityAccessSource), and surfaces each
 * step's request / response / NRC so the RFHUB tab can render the
 * walkthrough inline.
 *
 * Triggering policy: the caller only opens the CTA when the existing
 * 0x36 / 0x37 detection has already fired AND `parsed.type ===
 * 'XC2268_RFHUB'` OR the explicit "internal flash" RFHUB candidate is
 * selected. The bypass is a no-op against legacy Gen1/Gen2 RFHUBs;
 * `runDealerLockoutBypass` will still execute but the alternate-level
 * security access typically returns NRC 0x12 (subFunctionNotSupported)
 * on those modules, which the step report makes visible.
 * ============================================================================ */

import { build } from '@workspace/uds';

export const BYPASS_LEVEL = 0x0B;          // alternate SA sub-function level
export const BYPASS_ROUTINE_ID = 0xFF00;   // clear-lockout routine identifier
export const BYPASS_RESET_TYPE = 0x01;     // hard reset after clearing
export const BYPASS_PAYLOAD = new Uint8Array([0xA5, 0x5A, 0xC3, 0x3C]);

function hex(arr) {
  return Array.from(arr || []).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function parseNrc(d) {
  if (!d || d.length < 3) return null;
  if (d[0] !== 0x7F) return null;
  return { service: d[1], nrc: d[2] };
}

/**
 * Static list of the bypass steps in execution order. Exposed so the UI
 * can render a checklist before / during / after the run without having
 * to inspect a finished result.
 */
export function dealerLockoutBypassSteps() {
  return [
    { id: 'ext-session', title: 'Open extended diagnostic session (0x10 0x03)' },
    { id: 'alt-sa',      title: `Security access on alt level 0x${BYPASS_LEVEL.toString(16).toUpperCase()}` },
    { id: 'clear',       title: `RoutineControl 0xFF00 — clear lockout counter` },
    { id: 'reset',       title: 'ECU reset (0x11 0x01)' },
    { id: 're-probe',    title: 'Re-probe security access 0x27 0x01 to confirm lockout cleared' },
  ];
}

/**
 * Run the full step machine. Returns:
 *   { ok, cleared, steps: [{ id, title, ok, request?, response?, nrc?, reason?, note? }] }
 *
 * `cleared` is true only when the final re-probe no longer returns NRC
 * 0x36 / 0x37 (it may return 0x35 invalidKey because we don't try to
 * solve the standard level — that's the existing tab's job — but the
 * counter being cleared is the win the bench tool advertises).
 *
 * @param {object} cfg
 * @param {number} cfg.tx
 * @param {number} cfg.rx
 * @param {Function} cfg.uds          — `(tx, rx, bytes) → Promise<{ok, d}>`
 * @param {object} cfg.securityAccess — { unlock(target, level) → {ok, nrc?, reason?, log?} }
 * @param {Function} [cfg.delay]      — optional `(ms) → Promise` for reset settle
 * @param {Function} [cfg.addLog]     — optional structured logger
 */
export async function runDealerLockoutBypass(cfg) {
  const { tx, rx, uds, securityAccess, delay, addLog } = cfg || {};
  const log = (m, t) => { if (typeof addLog === 'function') addLog(m, t); };
  const wait = (ms) => (typeof delay === 'function' ? delay(ms) : Promise.resolve());
  const steps = [];
  const finish = (cleared) => ({ ok: steps.every((s) => s.ok), cleared, steps });

  if (typeof uds !== 'function') {
    return { ok: false, cleared: false, steps, reason: 'uds(tx,rx,bytes) callback is required' };
  }
  if (!securityAccess || typeof securityAccess.unlock !== 'function') {
    return { ok: false, cleared: false, steps, reason: 'securityAccess source missing .unlock()' };
  }
  if (typeof tx !== 'number' || typeof rx !== 'number') {
    return { ok: false, cleared: false, steps, reason: 'tx/rx CAN ids required' };
  }
  const target = { tx, rx, label: `RFHUB 0x${tx.toString(16).toUpperCase()}` };

  /* 1. Extended diagnostic session ─────────────────────────────────────── */
  {
    const req = build.diagnosticSessionControl({ session: 0x03 });
    log(`→ 10 03 (extended session)`, 'info');
    const r = await uds(tx, rx, req);
    const nrc = parseNrc(r.d);
    const ok = r.ok && !nrc;
    steps.push({
      id: 'ext-session',
      title: 'Open extended diagnostic session (0x10 0x03)',
      ok, request: hex(req), response: hex(r.d), nrc: nrc ? nrc.nrc : null,
      reason: ok ? null : (nrc ? `NRC 0x${nrc.nrc.toString(16).toUpperCase()}` : 'No response'),
    });
    if (!ok) return finish(false);
  }

  /* 2. Alternate-level security access ─────────────────────────────────── */
  {
    log(`→ 27 ${BYPASS_LEVEL.toString(16).toUpperCase()} (alt-level seed)`, 'info');
    const r = await securityAccess.unlock(target, BYPASS_LEVEL);
    const ok = !!r.ok;
    steps.push({
      id: 'alt-sa',
      title: `Security access on alt level 0x${BYPASS_LEVEL.toString(16).toUpperCase()}`,
      ok, nrc: r.nrc ?? null, reason: ok ? null : (r.reason || 'Alt-level SA failed'),
      note: ok ? (r.algo ? `algo: ${r.algo}` : null) : null,
    });
    if (!ok) return finish(false);
  }

  /* 3. Clear-lockout routine ───────────────────────────────────────────── */
  {
    const req = build.routineControl({
      sub: 0x01,                           // startRoutine
      rid: BYPASS_ROUTINE_ID,
      data: BYPASS_PAYLOAD,
    });
    log(`→ 31 01 FF 00 A5 5A C3 3C (clear lockout)`, 'info');
    const r = await uds(tx, rx, req);
    const nrc = parseNrc(r.d);
    const ok = r.ok && !nrc;
    steps.push({
      id: 'clear',
      title: 'RoutineControl 0xFF00 — clear lockout counter',
      ok, request: hex(req), response: hex(r.d), nrc: nrc ? nrc.nrc : null,
      reason: ok ? null : (nrc ? `NRC 0x${nrc.nrc.toString(16).toUpperCase()}` : 'No response'),
    });
    if (!ok) return finish(false);
  }

  /* 4. ECU reset ───────────────────────────────────────────────────────── */
  {
    const req = build.ecuReset({ sub: BYPASS_RESET_TYPE });
    log(`→ 11 01 (hard reset)`, 'info');
    const r = await uds(tx, rx, req);
    const nrc = parseNrc(r.d);
    const ok = r.ok && !nrc;
    steps.push({
      id: 'reset',
      title: 'ECU reset (0x11 0x01)',
      ok, request: hex(req), response: hex(r.d), nrc: nrc ? nrc.nrc : null,
      reason: ok ? null : (nrc ? `NRC 0x${nrc.nrc.toString(16).toUpperCase()}` : 'No response'),
    });
    if (!ok) return finish(false);
    await wait(1500);                       // bench: ~1.5 s for the reset to settle
  }

  /* 5. Re-probe standard SA to confirm lockout cleared ─────────────────── */
  {
    const req = build.securityAccess({ sub: 0x01 });
    log(`→ 27 01 (re-probe)`, 'info');
    const r = await uds(tx, rx, req);
    const nrc = parseNrc(r.d);
    const stillLocked = nrc && (nrc.nrc === 0x36 || nrc.nrc === 0x37);
    const cleared = r.ok && !stillLocked;
    steps.push({
      id: 're-probe',
      title: 'Re-probe security access 0x27 0x01 to confirm lockout cleared',
      ok: cleared, request: hex(req), response: hex(r.d), nrc: nrc ? nrc.nrc : null,
      reason: cleared ? null : (stillLocked ? `Still locked — NRC 0x${nrc.nrc.toString(16).toUpperCase()}` : (nrc ? `NRC 0x${nrc.nrc.toString(16).toUpperCase()}` : 'No response')),
      note: cleared ? 'Lockout counter cleared; standard unlock chain can run again' : null,
    });
    return finish(cleared);
  }
}
