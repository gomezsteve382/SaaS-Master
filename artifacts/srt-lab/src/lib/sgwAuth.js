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

// Module-level state. A simple Set of subscriber callbacks lets the React
// hook re-render any tab that cares without pulling in a heavier context.
let _state = { vin: null, authenticatedAt: null, expiresAt: null };
const _subs = new Set();

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
     - we have a non-expired authentication, AND
     - if `vin` is provided, it matches the VIN that was authenticated.
   Use this from non-React contexts (engine code, button handlers) where
   pulling the hook isn't appropriate. */
export function isSgwAuthenticated(vin){
  if (!_state.expiresAt || Date.now() >= _state.expiresAt) return false;
  if (typeof vin === 'string' && vin.length === 17) {
    if (_state.vin !== vin.toUpperCase()) return false;
  }
  return true;
}

/* Read-only snapshot for non-React callers (e.g. a CLI or a test). */
export function getSgwAuthState(){
  return { ..._state };
}

/* Test-only reset hook. Production code should never call this — clear
   via clearSgwAuth() so subscribers are notified. */
export function _resetSgwAuthForTests(){
  _state = { vin: null, authenticatedAt: null, expiresAt: null };
  _subs.clear();
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
  const authenticated = !!(_state.expiresAt && now < _state.expiresAt);
  return {
    authenticated,
    vin: authenticated ? _state.vin : null,
    expiresAt: authenticated ? _state.expiresAt : null,
    remainingMs: authenticated ? Math.max(0, _state.expiresAt - now) : 0,
  };
}
