/* sgwAuth — explicit "Secure Gateway is authenticated for VIN X" state.

   Why this exists
   ---------------
   The Autel J2534 bridge daemon has two distinct conditions:
     1. /status returns ok        → the cable is plugged in and the daemon
                                     is running. This is what useBridgeStatus
                                     reports today.
     2. SGW seed/key (27 01/02)    → the truck's Secure Gateway has actually
        succeeded for the loaded     accepted a key derived from this VIN's
        VIN                          XTEA seed. Only after this can the
                                     downstream BCM / RFHUB / ECM / ADCM
                                     writes pass through SGW.

   Until now the four bench tabs and ProgramAllTab were treating (1) as if
   it implied (2). On a 2018+ truck a tech could plug in the cable, see
   "BRIDGE CONNECTED", click "Write VIN", and the SGW would silently reject
   every downstream WriteByID. This module fixes that by exposing an
   explicit "authenticated for VIN X until T" flag that the AUTEL SGW tab
   sets after a successful 27 01/02 dance and that every write site reads
   before allowing traffic to leave the box.

   Lifetime / TTL
   --------------
   SGW auth on real trucks expires when the diagnostic session times out
   (typically a few minutes after the last 0x3E TesterPresent), so we cap
   our locally-tracked auth at SGW_AUTH_TTL_MS (10 min by default). Past
   that the gate fails closed and the tech is asked to re-authenticate.

   Persistence
   -----------
   Intentionally NONE. SGW auth is per-cable-session — surviving a browser
   refresh would just give the tech a stale "authenticated" green pill that
   no longer matches reality. */

import {useEffect, useState} from 'react';

export const SGW_AUTH_TTL_MS = 10 * 60 * 1000;
const BYPASS_KEY = 'srtlab_sgw_bypass';

// Module-level state. A simple Set of subscriber callbacks lets the React
// hook re-render any tab that cares without pulling in a heavier context.
let _state = { vin: null, authenticatedAt: null, expiresAt: null };
const _subs = new Set();

/* Bench bypass — when the SGW is physically out of the harness (bench
   work, jumpered out, or pre-2018 vehicle wired into a bench loom that
   originally had a gateway) the gate I added has nothing to gate against.
   This flag short-circuits isSgwAuthenticated() so writes go through.
   It is INTENTIONALLY persisted in localStorage so a tech who runs a
   bench all day doesn't have to re-tick it on every reload, and it is
   surfaced as a loud red banner in the AUTEL SGW tab so it cannot be
   forgotten when the next vehicle is plugged in. */
let _bypass = false;
try {
  if (typeof localStorage !== 'undefined') {
    _bypass = localStorage.getItem(BYPASS_KEY) === '1';
  }
} catch { /* SSR / tests / private mode — bypass stays off */ }

function _notify(){
  for (const cb of _subs) {
    try { cb(_state); } catch { /* swallow — one bad subscriber must not break the others */ }
  }
}

/* Mark the SGW as authenticated for the given 17-char VIN. ttlMs lets the
   caller shorten the window (e.g. when the SGW reports a smaller session
   timeout); defaults to SGW_AUTH_TTL_MS. */
export function setSgwAuthenticated(vin, ttlMs){
  if (typeof vin !== 'string' || vin.length !== 17) return false;
  const now = Date.now();
  const ttl = (typeof ttlMs === 'number' && ttlMs > 0) ? ttlMs : SGW_AUTH_TTL_MS;
  _state = { vin: vin.toUpperCase(), authenticatedAt: now, expiresAt: now + ttl };
  _notify();
  return true;
}

/* Clear the SGW auth — call this on disconnect, on any NRC during the
   seed/key dance, or when the tech changes VINs. */
export function clearSgwAuth(){
  if (_state.vin === null && _state.expiresAt === null) return;
  _state = { vin: null, authenticatedAt: null, expiresAt: null };
  _notify();
}

/* Synchronous gate. Returns true iff:
     - bench bypass is enabled (SGW physically out of the harness), OR
     - we have a non-expired authentication AND, if `vin` is provided, it
       matches the VIN that was authenticated.
   Use this from non-React contexts (engine code, button handlers) where
   pulling the hook isn't appropriate. */
export function isSgwAuthenticated(vin){
  if (_bypass) return true;
  if (!_state.expiresAt || Date.now() >= _state.expiresAt) return false;
  if (typeof vin === 'string' && vin.length === 17) {
    if (_state.vin !== vin.toUpperCase()) return false;
  }
  return true;
}

/* Bench bypass setter — persists to localStorage and notifies subscribers
   so the AUTEL SGW tab banner and every bench tab's gate UI re-render
   immediately. */
export function setSgwBypass(on){
  const next = !!on;
  if (next === _bypass) return;
  _bypass = next;
  try {
    if (typeof localStorage !== 'undefined') {
      if (next) localStorage.setItem(BYPASS_KEY, '1');
      else localStorage.removeItem(BYPASS_KEY);
    }
  } catch { /* private mode — in-memory only is fine */ }
  _notify();
}

export function isSgwBypassed(){ return _bypass; }

/* Read-only snapshot for non-React callers (e.g. a CLI or a test). */
export function getSgwAuthState(){
  return { ..._state };
}

/* Test-only reset hook. Production code should never call this — clear
   via clearSgwAuth() so subscribers are notified. */
export function _resetSgwAuthForTests(){
  _state = { vin: null, authenticatedAt: null, expiresAt: null };
  _bypass = false;
  _subs.clear();
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(BYPASS_KEY); } catch {}
}

/* React hook — re-renders the calling component whenever the auth state
   changes AND every second so the "expires in 4:32" countdown ticks
   without the component needing its own setInterval. Returns:
     {
       authenticated: boolean,           // honors expiry
       vin: string|null,
       expiresAt: number|null,           // epoch ms
       remainingMs: number,              // 0 when not authenticated
     }                                                                       */
export function useSgwAuth(){
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force(n => n + 1);
    _subs.add(cb);
    // Tick once a second so the countdown rerenders. Cheap — only sites
    // that actually mount the gate banner pay the cost.
    const t = setInterval(cb, 1000);
    return () => { _subs.delete(cb); clearInterval(t); };
  }, []);
  const now = Date.now();
  const realAuth = !!(_state.expiresAt && now < _state.expiresAt);
  // The gate the rest of the app reads honors bypass — surface that here
  // so banners say "writes unblocked" even when no seed/key has run.
  const authenticated = _bypass || realAuth;
  return {
    authenticated,
    bypassed: _bypass,
    vin: realAuth ? _state.vin : null,
    expiresAt: realAuth ? _state.expiresAt : null,
    remainingMs: realAuth ? Math.max(0, _state.expiresAt - now) : 0,
  };
}
