/* Task #678 — fire-and-forget POST to /api/sec16-sync-events.
 *
 * Pure side-effect helper. Never throws, never blocks the UI thread,
 * never breaks a unit test. If fetch / window is absent (vitest jsdom
 * env without happy-dom polyfill, or pure node), the call resolves to
 * `{posted:false, reason}` so callers can chain `.then()` without
 * ceremony. On real failure the error is swallowed — sync-event
 * logging is best-effort audit, NOT a write-path dependency.
 *
 *   logSec16Sync({
 *     vin,             // optional 17-char string
 *     platform,        // 'lx-ld'|'wk2-jeep'|'wd-durango'|'dt-ram-2019plus'|'unknown'
 *     actionId,        // sec16Preflight action id ('rfh-bcm-sec16-sync', etc.)
 *     target,          // 'BCM'|'RFHUB'|'PCM'|'95640'
 *     recipeId,        // optional SEC16_WRITE_RECIPES[*].id (live writer only)
 *     verified,        // 'match'|'mismatch'|'unverified'|'offline'|'read-error'
 *     operator,        // free-form tech identifier
 *     notes,           // free-form notes
 *     detail,          // structured payload (object)
 *   })
 */
export async function logSec16Sync(payload) {
  try {
    if (typeof fetch !== 'function') return { posted: false, reason: 'no-fetch' };
    const res = await fetch('/api/sec16-sync-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    if (!res || !res.ok) return { posted: false, reason: 'http-' + (res ? res.status : 'null') };
    const json = await res.json().catch(() => null);
    return { posted: true, event: json && json.event };
  } catch (e) {
    return { posted: false, reason: 'throw:' + (e && e.message ? e.message : 'unknown') };
  }
}
