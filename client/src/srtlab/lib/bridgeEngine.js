/* bridgeEngine — wraps the local J2534 HTTP bridge daemon (j2534_bridge.py)
   into the same `{ok, d, raw}` UDS interface that initAdapter exposes.

   When a VIN's model year requires FCA Secure-Gateway (vinHasSGW), the BCM /
   RFHUB / ECM / ADCM tabs route their writes through this engine so the Autel
   MaxiFlash cable performs SGW authentication. If the bridge daemon is not
   reachable, createBridgeEngine() returns null with an error message logged
   via addLog and the caller MUST abort the write.

   Transport selector (Task #613)
   ──────────────────────────────
   Two transport backends are available and share the same JSON-RPC surface:

     J2534 Pass-Thru  — Autel MaxiFlash / any J2534 DLL, port 8765 (default)
     MicroPod II      — wiTECH MicroPod II USB bridge,    port 8766 (default)

   The choice is persisted per-session in localStorage under
   'srtlab_transport' and can be changed at any time from the External Tools
   tab transport selector. All existing callers (offline-flash, VIN-write,
   module-reset, SGW re-unlock) flow through whichever engine is active —
   no tab-level code changes are needed.

   // transport: micropod-ii  ← provenance comment for MicroPod II paths */

import {getStatus, open as openBridge, connect as bridgeConnect, setFilter, sendMsg, readMsg, getAutelState, getMicroPodUrl} from './bridgeClient.js';

const PROTOCOL_ISO15765 = 6;
const ISO15765_FRAME_PAD = 0x40;

function hexToBytes(hex){
  if(!hex)return [];
  const clean=String(hex).replace(/\s+/g,'');
  const out=[];
  for(let i=0;i+1<clean.length;i+=2){
    const b=parseInt(clean.substr(i,2),16);
    if(!isNaN(b))out.push(b);
  }
  return out;
}

function bytesToHex(arr){
  return Array.from(arr).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
}

// ─── Transport selector (Task #613) ──────────────────────────────────────────
// Persisted in localStorage so the operator's choice survives page refreshes
// and is shared between all tabs without prop-drilling.

const LS_TRANSPORT_KEY = 'srtlab_transport';

export const TRANSPORT_J2534    = 'j2534';
export const TRANSPORT_MICROPOD = 'micropod-ii';

export function getActiveTransport(){
  try {
    const v = localStorage.getItem(LS_TRANSPORT_KEY);
    if (v === TRANSPORT_MICROPOD) return TRANSPORT_MICROPOD;
    return TRANSPORT_J2534;
  } catch {
    return TRANSPORT_J2534;
  }
}

export function setActiveTransport(t){
  try {
    const val = t === TRANSPORT_MICROPOD ? TRANSPORT_MICROPOD : TRANSPORT_J2534;
    localStorage.setItem(LS_TRANSPORT_KEY, val);
    return val;
  } catch {
    return TRANSPORT_J2534;
  }
}

// Build a UDS engine from any bridge URL that speaks the standard surface
// (open / connect / setfilter / sendmsg / readmsg).
// Returns { ok:true, engine } or { ok:false, error }.
async function _buildUdsEngineFromUrl({ addLog, url, transportLabel, adapterLabel, isMicroPod }) {
  const log = (m, t='info') => { try { addLog && addLog(m, t); } catch {} };

  log(`${transportLabel} → routing UDS through ${adapterLabel} (${url})`, 'info');

  const st = await getStatus(url);
  if (!st || !st.ok) {
    return { ok: false, error: `${transportLabel} not reachable: ${st?.error || 'no response'}` };
  }

  // MicroPod II pre-flight checks.
  // pyusbAvailable is checked first: if pyusb is missing the pod will also
  // appear absent, so reporting "pyusb not installed" is the more actionable
  // diagnosis and avoids a misleading POD_NOT_FOUND when the real issue is
  // a missing Python dependency.
  if (isMicroPod && st.pyusbAvailable === false) {
    return {
      ok: false,
      error: 'pyusb not installed on bridge host — run: pip install pyusb',
    };
  }
  if (isMicroPod && st.podPresent === false) {
    return {
      ok: false,
      error: 'POD_NOT_FOUND: MicroPod II not detected on USB bus. Check cable and driver.',
    };
  }

  const isOpen      = st.opened || st.deviceOpen;
  const isConnected = st.connected || st.channelConnected;

  if (!isOpen) {
    log(`Opening ${adapterLabel} device…`, 'info');
    const o = await openBridge(url);
    if (!o.ok) {
      // Surface friendly MicroPod error codes
      const code = o.code || '';
      if (code === 'POD_NOT_FOUND')     return { ok: false, error: 'POD_NOT_FOUND: MicroPod II not detected — check USB cable and driver.' };
      if (code === 'PERMISSION_DENIED') return { ok: false, error: 'PERMISSION_DENIED: cannot claim MicroPod II — add udev rule or run bridge as root (see docs/MICROPOD_II_TRANSPORT.md).' };
      if (code === 'FIRMWARE_TOO_OLD') return { ok: false, error: 'FIRMWARE_TOO_OLD: update MicroPod II firmware via wiTECH 2.0 before using this bridge.' };
      return { ok: false, error: `${transportLabel} /open failed: ${o.error || 'unknown'}` };
    }
  }

  if (!isConnected) {
    log(`Connecting ISO15765 channel @ 500 kbit/s…`, 'info');
    const c = await bridgeConnect({ protocol: PROTOCOL_ISO15765, flags: 0, baudrate: 500000 }, url);
    if (!c.ok) return { ok: false, error: `${transportLabel} /connect failed: ${c.error || 'unknown'}` };
  }

  const fwStr = st.versions?.firmware ? ` fw ${st.versions.firmware}` : '';
  log(`✓ ${adapterLabel} ready${fwStr}`, 'rx');

  let lastTx = -1, lastRx = -1;
  let negotiatedTiming = null;
  const computeDefaultTimeout = (dataLen) => {
    if (negotiatedTiming) {
      const a = Number(negotiatedTiming.p2StarMs) || 0;
      const b = Number(negotiatedTiming.p2Ms) || 0;
      const v = Math.max(a, b);
      if (v > 0) return v;
    }
    return dataLen > 7 ? 8000 : 4000;
  };

  const uds = async (tx, rx, data, timeoutMs) => {
    const tm = timeoutMs || computeDefaultTimeout(data.length);
    if (tx !== lastTx || rx !== lastRx) {
      const f = await setFilter({ txId: tx, rxId: rx }, url);
      if (!f.ok) return { ok: false, raw: `${transportLabel} setFilter: ${f.error || 'failed'}` };
      lastTx = tx; lastRx = rx;
    }
    const dataHex = bytesToHex(data);
    const sm = await sendMsg({ txId: tx, data: dataHex, flags: ISO15765_FRAME_PAD, timeoutMs: 1000 }, url);
    if (!sm.ok) return { ok: false, raw: `${transportLabel} sendMsg: ${sm.error || 'failed'}` };
    const deadline = Date.now() + tm;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const slice = Math.min(1500, Math.max(150, remaining));
      const r = await readMsg({ timeoutMs: slice }, url);
      if (!r || !r.ok) return { ok: false, raw: `${transportLabel} readMsg: ${r?.error || 'failed'}` };
      const m = r.msg;
      if (!m || !m.data) continue;
      if (typeof m.canId === 'number' && rx && m.canId !== rx) continue;
      const bytes = hexToBytes(m.data);
      if (!bytes.length) continue;
      if (bytes.length >= 3 && bytes[0] === 0x7F && bytes[2] === 0x78) continue;
      return { ok: true, d: new Uint8Array(bytes), raw: m.data };
    }
    return { ok: false, raw: `${transportLabel}: timeout after ${tm}ms` };
  };

  const setNegotiatedTiming = (t) => {
    if (!t) { negotiatedTiming = null; return; }
    const p2  = Number(t.p2Ms)     || 0;
    const p2s = Number(t.p2StarMs) || 0;
    if (p2 <= 0 && p2s <= 0) { negotiatedTiming = null; return; }
    negotiatedTiming = { p2Ms: p2, p2StarMs: p2s };
  };
  const clearNegotiatedTiming = () => { negotiatedTiming = null; };
  const getNegotiatedTiming   = () => negotiatedTiming ? { ...negotiatedTiming } : null;

  return {
    ok: true,
    engine: {
      uds,
      adapter:  adapterLabel,
      transport: isMicroPod ? TRANSPORT_MICROPOD : TRANSPORT_J2534,
      readVoltage: async () => null,
      isBridge: true,
      setNegotiatedTiming,
      clearNegotiatedTiming,
      getNegotiatedTiming,
      vendor:   st.vendor   || null,
      firmware: st.versions?.firmware || null,
      versions: st.versions || null,
      deviceUrl: url,
    },
  };
}

// ─── J2534 Pass-Thru engine ───────────────────────────────────────────────────

/* Build a uds-compatible engine honoring the operator's transport selection.

   When `url` is provided explicitly (e.g. AutelSgwTab or proxiBridge pass a
   specific URL), the call always routes to the J2534 daemon at that address —
   the explicit URL overrides the transport selector.

   When no `url` is given (all bench-flash tabs — EcmTab, BcmTab, AdcmTab,
   ProgramAllTab, RfhubTab, EcmFlasherTab, Cda6SessionTab, GpecObdVinPanel,
   LiveKeyTab), the function reads getActiveTransport() and delegates to either
   createMicroPodEngine() or the J2534 daemon, so every existing caller
   automatically honours the transport the operator selected in External Tools
   without any tab-level code changes.  // transport: micropod-ii

   Returns { ok:true, engine } on success or { ok:false, error } on failure.
   The caller is expected to:
     - check sgwReq before calling
     - log the error and abort the write when ok===false */
export async function createBridgeEngine({ addLog, url } = {}) {
  // transport: micropod-ii
  // When no explicit URL is provided, honour the operator's transport choice.
  if (!url && getActiveTransport() === TRANSPORT_MICROPOD) {
    return createMicroPodEngine({ addLog });
  }
  const bridgeUrl = url || getAutelState().url;
  return _buildUdsEngineFromUrl({
    addLog,
    url: bridgeUrl,
    transportLabel: 'J2534 bridge',
    adapterLabel: 'Autel J2534',
    isMicroPod: false,
  });
}

// ─── MicroPod II engine (Task #613) ──────────────────────────────────────────
// // transport: micropod-ii
//
// createMicroPodEngine() returns the same {ok, d, raw} UDS engine contract
// that createBridgeEngine() exposes. Offline flash, VIN-write, module-reset
// and all SGW re-unlock paths work through this engine without code changes —
// they go through the same bridgeClient HTTP surface, but the URL points at
// micropod_bridge.py (default port 8766) instead of j2534_bridge.py (8765).
//
// Wiring: the MicroPod II bridge daemon (tools/python-bridge/bridge/micropod_bridge.py)
// must be running on the bench machine before this engine can be created.
// The daemon enumerates the pod via USB (pyusb), handles claim/release, framing
// and keepalive, and exposes the same RPC surface the J2534 daemon already does.
//
// Provenance: sourced from CDA SWF MicroPodII /
//   com.chrysler.cda.domain.discovery.device:MicroPodII class enumeration
//   (harvested into tools/cda-extractor/out/harvestedStrings.generated.json
//   #microPodSurface).

export async function createMicroPodEngine({ addLog, deviceUrl } = {}) {
  // transport: micropod-ii
  const url = deviceUrl || getMicroPodUrl();
  return _buildUdsEngineFromUrl({
    addLog,
    url,
    transportLabel: 'MicroPod II',
    adapterLabel: 'wiTECH MicroPod II',
    isMicroPod: true,
  });
}

// ─── Active-transport factory (Task #613) ─────────────────────────────────────
// createEngineForActiveTransport() reads the persisted transport choice and
// delegates to the appropriate factory. Use this as the single entry point for
// any tab that wants to use whatever transport the operator selected; the
// operator does not need to restart the app when switching between J2534 and
// MicroPod II.

export async function createEngineForActiveTransport({ addLog, url, deviceUrl } = {}) {
  // transport: micropod-ii
  const transport = getActiveTransport();
  if (transport === TRANSPORT_MICROPOD) {
    return createMicroPodEngine({ addLog, deviceUrl: deviceUrl || url });
  }
  return createBridgeEngine({ addLog, url });
}

import {
  detect0x29, shouldProbe0x29ForNrc,
  auth29RefusalMessage, auth29UnlockedMessage,
  attemptAuth29Unlock, getAuth29Strategy,
} from './auth29.js';
import { flagAuth29Detected, flagAuth29Unlocked } from './auth29State.js';

/* Re-issue the extended-session + seed/key unlock on a freshly-routed engine
   (typically the bridge engine returned by createBridgeEngine). The unlock the
   tech ran on the simulator/ELM channel does not carry over once SGW routing
   flips us to the Autel cable, so we must re-run it on the bridge channel
   before the first 2E write or the module will reject with an NRC.

   algoFn(seed:number) -> number  computes the key from the seed, using the
   same algorithm that succeeded on the sim channel.

   Returns {ok:true} on success or {ok:false, error, nrc?} on failure. */
export async function reUnlockSeedKey(engine,tx,rx,algoFn,{addLog,hx,auth29Strategy,auth29Options}={}){
  const log=(m,t='info')=>{try{addLog&&addLog(m,t);}catch{}};
  const _hx=hx||((n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0'));
  if(!engine||typeof engine.uds!=='function')return {ok:false,error:'no engine'};
  if(typeof algoFn!=='function')return {ok:false,error:'no unlock algorithm available — run sim-channel unlock first'};
  log('Re-running unlock on bridge channel (10 03)...','info');
  const ds=await engine.uds(tx,rx,[0x10,0x03]);
  if(!ds.ok)return {ok:false,error:'bridge 10 03 failed: '+(ds.raw||'no response')};
  if(ds.d&&ds.d[0]===0x7F){
    const nrc=ds.d.length>2?ds.d[2]:0;
    return {ok:false,nrc,error:'bridge 10 03 NRC 0x'+_hx(nrc)};
  }
  log('Requesting seed on bridge (27 01)...','info');
  const s=await engine.uds(tx,rx,[0x27,0x01]);
  if(!s||!s.ok||!s.d||s.d.length===0)return {ok:false,error:'bridge 27 01 failed: '+(s?.raw||'no response')};
  if(s.d[0]===0x7F){
    const nrc=s.d.length>2?s.d[2]:0;
    // Task #567: if the seed NRC is 0x33/0x34, probe for 0x29 before
    // giving up. A confirmed 0x29-required module gets a clear refusal
    // instead of leaving the operator to guess at why 0x27 keeps failing.
    if (shouldProbe0x29ForNrc(nrc)){
      log('Seed rejected with NRC 0x'+_hx(nrc)+' — probing for UDS 0x29 Authentication','warn');
      const probe=await detect0x29(engine,tx,rx);
      log('0x29 probe → '+probe.classification+(probe.nrc!=null?' (NRC 0x'+_hx(probe.nrc)+')':'')+(probe.error?' ['+probe.error+']':''),'info');
      if (probe.supports){
        // Task #572 — attempt the real challenge/response handshake when
        // a strategy is registered (or passed in). On success the bridge
        // is authenticated and the caller can proceed with writes; on
        // failure or no-strategy we fall back to the canonical refusal.
        const strategy = (typeof auth29Strategy === 'function') ? auth29Strategy : getAuth29Strategy(tx);
        if (strategy){
          log('Running 0x29 challenge/response handshake on bridge…','info');
          const hs = await attemptAuth29Unlock(engine, tx, rx, { strategy, deauth:false, ...(auth29Options||{}) });
          if (hs.authenticated){
            try { flagAuth29Unlocked({ tx, rx, label: 'reUnlockSeedKey', statusInfo: hs.statusInfo }); } catch {}
            log('✓ '+auth29UnlockedMessage()+' · statusInfo=0x'+_hx(hs.statusInfo|0),'rx');
            return { ok:true, auth29:true, statusInfo: hs.statusInfo };
          }
          try { flagAuth29Detected({ tx, rx, label: 'reUnlockSeedKey', nrc }); } catch {}
          log('0x29 handshake failed at '+hs.phase+': '+(hs.error||'unknown'),'error');
          return { ok:false, nrc, auth29:true, error: '0x29 handshake failed: '+(hs.error||'unknown') };
        }
        try { flagAuth29Detected({ tx, rx, label: 'reUnlockSeedKey', nrc }); } catch {}
        return { ok:false, nrc, auth29:true, error: auth29RefusalMessage() };
      }
    }
    return {ok:false,nrc,error:'bridge 27 01 NRC 0x'+_hx(nrc)};
  }
  if(s.d.length<4)return {ok:false,error:'bridge 27 01 short response: '+(s.raw||'')};
  const sb=Array.from(s.d).slice(-4);
  let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=sv>>>0;
  log('Bridge seed: 0x'+_hx(sv,8),'info');
  const k=(algoFn(sv)>>>0);
  log('Bridge key: 0x'+_hx(k,8),'info');
  const r=await engine.uds(tx,rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
  if(r.ok&&r.d&&r.d[0]===0x67){log('✓ Bridge channel unlocked','rx');return {ok:true};}
  if(r.ok&&r.d&&r.d[0]===0x7F){
    const nrc=r.d.length>2?r.d[2]:0;
    return {ok:false,nrc,error:'bridge 27 02 NRC 0x'+_hx(nrc)};
  }
  return {ok:false,error:'bridge 27 02 no response: '+(r?.raw||'')};
}

/* Re-run an ADCM-style routine unlock (Routine 0x0312) on the bridge channel,
   with SBEC seed/key fallback that matches AdcmTab.startRoutine(). */
export async function reUnlockAdcmRoutine(engine,tx,rx,{addLog,hx}={}){
  const log=(m,t='info')=>{try{addLog&&addLog(m,t);}catch{}};
  const _hx=hx||((n,w=2)=>n.toString(16).toUpperCase().padStart(w,'0'));
  if(!engine||typeof engine.uds!=='function')return {ok:false,error:'no engine'};
  log('Re-running ADCM unlock on bridge channel (10 03)...','info');
  await engine.uds(tx,rx,[0x10,0x03]);
  await engine.uds(tx,rx,[0x3E,0x80]);
  const r=await engine.uds(tx,rx,[0x31,0x01,0x03,0x12]);
  if(r.ok&&r.d&&r.d[0]===0x71){log('✓ Bridge ADCM routine 0x0312 accepted','rx');return {ok:true};}
  if(r.ok&&r.d&&r.d[0]===0x7F)log('Bridge routine 0x0312 NRC 0x'+_hx(r.d[2]||0)+' — falling back to SBEC seed/key','warn');
  const s=await engine.uds(tx,rx,[0x27,0x01]);
  if(!s||!s.ok||!s.d||s.d.length===0)return {ok:false,error:'bridge 27 01 failed: '+(s?.raw||'no response')};
  if(s.d[0]===0x7F){
    const nrc=s.d.length>2?s.d[2]:0;
    return {ok:false,nrc,error:'bridge 27 01 NRC 0x'+_hx(nrc)};
  }
  if(s.d.length<4)return {ok:false,error:'bridge 27 01 short response: '+(s.raw||'')};
  const sb=Array.from(s.d).slice(-4);let sv=0;for(const b of sb)sv=(sv<<8)|b;sv=sv>>>0;
  log('Bridge seed: 0x'+_hx(sv,8),'info');
  const k=((sv*4+0x9018)>>>0);
  log('Bridge SBEC key: 0x'+_hx(k,8),'info');
  const kr=await engine.uds(tx,rx,[0x27,0x02,(k>>24)&0xFF,(k>>16)&0xFF,(k>>8)&0xFF,k&0xFF]);
  if(kr.ok&&kr.d&&kr.d[0]===0x67){log('✓ Bridge SBEC unlock succeeded','rx');return {ok:true};}
  if(kr.ok&&kr.d&&kr.d[0]===0x7F){
    const nrc=kr.d.length>2?kr.d[2]:0;
    return {ok:false,nrc,error:'bridge 27 02 NRC 0x'+_hx(nrc)};
  }
  return {ok:false,error:'bridge 27 02 no response'};
}
