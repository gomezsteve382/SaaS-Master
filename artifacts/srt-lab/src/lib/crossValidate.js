import {arrEq} from './parseModule.js';

/* Legacy GPEC↔BCM key comparator. As of Task #380 we no longer fire this
 * rule from crossValidate (GPEC2A 0x0203 is the GPEC-internal vehicle/skim
 * key, NOT the BCM-pairing field — BCM↔PCM pairing flows through SEC6 at
 * GPEC 0x03C8 / BCM SEC16). Kept exported for backwards compatibility with
 * SecurityTab.jsx, which still surfaces the byte-level overlap as a
 * diagnostic table row. */
function compareGpecBcmKey(gpecKey,bcmKey){
  const bcmBE=Array.from(bcmKey).reverse();
  const bcmCmp=new Uint8Array(bcmBE.slice(0,8));
  const gpecCmp=new Uint8Array(gpecKey.slice(0,8));
  const match=arrEq(gpecCmp,bcmCmp);
  return{
    match,
    gpecBytes:gpecCmp,
    bcmBytes:bcmCmp,
    bcmFull:new Uint8Array(bcmBE),
    rule:'BCM[16B LE] reversed → first 8B vs GPEC[8B]'
  };
}

const fmtHex=arr=>Array.from(arr).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ');

function crossValidate(modules){
  const issues=[],warnings=[],passed=[];
  const allVins=new Set();
  modules.forEach(m=>{if(m.vins)m.vins.forEach(v=>allVins.add(v.vin));});
  if(allVins.size===0)warnings.push("No VINs found.");
  else if(allVins.size===1)passed.push("VIN consistent: "+Array.from(allVins)[0]);
  else issues.push("VIN MISMATCH: "+Array.from(allVins).join(", "));

  const rfhub=modules.find(m=>m.type==="RFHUB");
  const bcm=modules.find(m=>m.type==="BCM");
  const gpec=modules.find(m=>m.type==="GPEC2A");
  const e95=modules.find(m=>m.type==="95640");
  /* Task #678 — XC2268 (2019+ Ram) RFHUB has no offline SEC16 in flash.
   * Previously crossValidate silently produced no SEC16 verdict for these
   * dumps, which let the Mismatch Wizard report "0 errors" on a Ram dump
   * even though the platform is unverifiable offline. Surface the
   * live-only nature explicitly so sec16Preflight + the GO/NO-GO panel
   * can flip to LIVE_ONLY instead of mis-rendering GO. */
  const xcRfhub=modules.find(m=>m.type==='XC2268_RFHUB');
  if(xcRfhub){
    warnings.push("XC2268 RFHUB detected — offline SEC16 not stored in flash; read and write SEC16 live over OBD only.");
  }

  /* RFHUB ↔ BCM SEC16 (Task #380) — uses the resolved SEC16 instead of
   * the flat 0x40C9 slice so synced Redeye dumps stop firing false
   * MISMATCHes. BLANK is reported only when the resolver flags every
   * candidate (split + mirrors + flat) as all-FF/00.
   * Task #815: when sec16Absent the BCM is in ALERT_NO_SECURITY state
   * (no real key material anywhere, including the flat noise slice). Do NOT
   * compare phantom noise against the RFHUB secret — that would be both a
   * false MISMATCH and a leakage of fabricated bytes to the wizard / AI. */
  if(rfhub&&rfhub.vehicleSecret&&bcm&&bcm.bcmSec16){
    if(bcm.sec16Absent){
      passed.push("BCM SEC16 absent — RFHUB ↔ BCM pairing not evaluable (ALERT_NO_SECURITY; VIN-only edition)");
    }else{
      const bRes=bcm.bcmSec16;
      if(bRes.blank||!bRes.bytes)warnings.push("BCM SEC16 BLANK (virgin) — split records, inactive-bank mirrors and flat 0x40C9 are all empty");
      else{
        const rev=Array.from(bRes.bytes).reverse();
        if(arrEq(new Uint8Array(Array.from(rfhub.vehicleSecret.bytes)),new Uint8Array(rev)))
          passed.push("RFHUB ↔ BCM vehicle secret: MATCH (BCM "+bRes.source+" → reversed = RFH SEC16)");
        else issues.push("RFHUB ↔ BCM vehicle secret: MISMATCH — BCM("+bRes.source+")="+fmtHex(bRes.bytes)+" RFH="+fmtHex(rfhub.vehicleSecret.bytes));
      }
    }
  }
  /* BCM legacy flat 0x40C9 staleness (Task #385) — even on imported dumps the
   * tech didn't sync themselves, surface a warning when the live record-table
   * SEC16 (split / mirror) disagrees with the flat slice so legacy CGDI/Autel
   * tools that still read the flat field stop seeing the old secret silently.
   * Task #815: skip entirely when sec16Absent (no real SEC16 = no flat to check). */
  if(!bcm?.sec16Absent&&bcm&&bcm.bcmSec16&&bcm.bcmSec16.bytes&&!bcm.bcmSec16.blank
     &&bcm.bcmSec16.source&&bcm.bcmSec16.source!=='flat'
     &&bcm.bcmSec16.candidates&&bcm.bcmSec16.candidates.flat
     &&bcm.bcmSec16.candidates.flat.bytes){
    const resolved=bcm.bcmSec16.bytes;
    const flat=bcm.bcmSec16.candidates.flat.bytes;
    const expectedLe=Array.from(resolved).reverse();
    const flatArr=Array.from(flat);
    let same=flatArr.length===16;
    for(let i=0;i<16&&same;i++)if(flatArr[i]!==expectedLe[i])same=false;
    if(!same){
      warnings.push("BCM legacy flat 0x40C9 STALE — live SEC16 ("+bcm.bcmSec16.source+")="+fmtHex(resolved)+" but flat slice (LE)="+fmtHex(flat)+". Open Module Sync → 'Repair flat 0x40C9 from split records' so legacy CGDI/Autel readers see the live secret.");
    }
  }
  /* Shared-constant guard — the BCM SEC16 resolved to the `00…31 3E…0A`
   * block that is byte-identical across unrelated VINs and only appears on
   * un-programmed/donor BCMs (proven, see resolveBcmSec16). Warn so the marry/
   * key flows never treat it as a confident per-car secret. */
  if(bcm?.bcmSec16?.sharedConstant){
    warnings.push("BCM SEC16: SHARED-DEFAULT value ("+fmtHex(bcm.bcmSec16.bytes)+") — this block is byte-identical across multiple unrelated cars and only appears on un-programmed/donor BCMs. Treat as a placeholder, NOT a confirmed per-car secret; do not derive RFHUB/PCM security from it without a bench-verified secret.");
  }
  if(rfhub&&rfhub.sec16s){
    if(rfhub.sec16valid)passed.push("RFHUB SEC16: VALID — slots 1&2 match, non-blank");
    else if(rfhub.sec16s[0]?.blank)warnings.push("RFHUB SEC16: BLANK (all FF/00) — virgin module");
    else warnings.push("RFHUB SEC16: Slot 1/2 MISMATCH or unreadable");
  }
  /* PCM SEC6 standalone state. Task #396 widens the "damaged" judgement
   * via the shared classifyPcmSec6() — mostly-FF (e.g. FF FF 00 FF FF FF)
   * now correctly trips IMMO_DAMAGED instead of the old strict all-FF gate. */
  /* Treat legacy PCM SEC6 records (pre-#396, populated field absent)
   * as populated when !damaged, so older crossValidate fixtures keep
   * passing while parseModule.js callers get the new precise gating. */
  const pcmPopulated=g=>g&&g.pcmSec6&&(g.pcmSec6.populated===undefined?!g.pcmSec6.damaged:!!g.pcmSec6.populated);
  if(gpec&&gpec.pcmSec6){
    if(!pcmPopulated(gpec))issues.push("PCM SEC6 @ 0x3C8: "+gpec.pcmSec6.hex+" — IMMO_DAMAGED / virgin. Open the Module Sync tab and load your RFHUB or paired BCM dump to apply the SEC6 import.");
    else passed.push("PCM SEC6 @ 0x3C8: "+gpec.pcmSec6.hex+" ("+gpec.pcmSec6.immoState+")");
  }
  if(rfhub&&gpec&&rfhub.sec16valid&&gpec.pcmSec6&&pcmPopulated(gpec)){
    const s16=rfhub.sec16s[0].raw;const s6=gpec.pcmSec6.raw;
    const match=arrEq(Array.from(s6),Array.from(s16.slice(0,6)));
    if(match)passed.push("RFHUB SEC16[0:6] ↔ PCM SEC6: MATCH ✓");
    else warnings.push("RFHUB SEC16[0:6] ↔ PCM SEC6: MISMATCH — open the Module Sync tab to apply the RFH→PCM SEC6 import");
  }
  /* BCM SEC16 ↔ PCM SEC6 (Task #380, widened in #396). The BCM-pairing
   * field on the GPEC side is SEC6 at 0x03C8 — first six bytes of
   * reverse(BCM SEC16). Pre-#396 this was gated on `!damaged`, so a
   * paired BCM against a virgin PCM produced no message at all and the
   * Mismatch Wizard reported "Found 0 errors". Now we fire an issue in
   * BOTH cases: virgin PCM against paired BCM ("never paired"), and
   * non-matching populated SEC6 ("MISMATCH").
   * Task #815: when sec16Absent, BCM has no authoritative SEC16 to derive
   * SEC6 from — skip the rule entirely so phantom noise never produces a
   * spurious "PCM never paired" / MISMATCH issue. */
  if(!bcm?.sec16Absent&&bcm&&bcm.bcmSec16&&gpec&&gpec.pcmSec6){
    const bRes=bcm.bcmSec16;
    if(!bRes.blank&&bRes.bytes){
      const rev6=Array.from(bRes.bytes).reverse().slice(0,6);
      if(!pcmPopulated(gpec)){
        issues.push("BCM SEC16 → SEC6 ↔ PCM SEC6: PCM never paired with this BCM — apply BCM→PCM SEC6 sync before key programming. BCM(rev)[0:6]="+fmtHex(rev6)+" PCM SEC6="+gpec.pcmSec6.hex+" (virgin/damaged)");
      }else{
        const s6=Array.from(gpec.pcmSec6.raw);
        if(arrEq(rev6,s6))passed.push("BCM SEC16 → SEC6 ↔ PCM SEC6: MATCH ✓ (reverse(BCM "+bRes.source+")[0:6] = PCM SEC6)");
        else issues.push("BCM SEC16 → SEC6 ↔ PCM SEC6: MISMATCH — open Module Sync to apply BCM→PCM SEC6 import. BCM(rev)[0:6]="+fmtHex(rev6)+" PCM="+fmtHex(s6));
      }
    }
  }
  if(gpec){
    const skimDisabled=gpec.skimByte===0x00||gpec.skimByte===0x02;
    if(gpec.skimByte===0x80)passed.push("GPEC2A SKIM: ENABLED (0x80)");
    else if(skimDisabled){
      // Loud catch (user request): an ECM/PCM can read as fully "synced"
      // (SEC6 populated + FF FF FF AA marker) yet have SKIM OFF, so the
      // engine starts regardless of the secret. A naive verdict calls that
      // "good"; we surface it as an explicit warning (NOT an export-blocking
      // issue — SKIM at its default is legitimate; the writers never touch
      // it) with a message spelling out the consequence, louder when paired.
      const looksPaired=pcmPopulated(gpec);
      warnings.push("GPEC2A/ECM SKIM @0x0011 = 0x"+(gpec.skimByte||0).toString(16).padStart(2,'0').toUpperCase()+" — IMMOBILIZER DISABLED / BYPASSED. The engine module ignores the secret and starts regardless"+(looksPaired?", even though its SEC6 reads as paired — a SEC6 sync will NOT be enforced until SKIM is re-enabled (0x80).":". Re-enable SKIM (0x80) for the immo to be enforced."));
    }
    /* Skip the key-consistency mismatch when the GPEC vehicle/skim key is
     * virgin/erased (all-FF) — that's expected on a virgin GPEC, not a
     * fault. The 0x0203 field is GPEC-internal and unrelated to the
     * BCM-pairing path (SEC6). */
    const gpecKeyVirgin=!!(gpec.skb||(gpec.secretKey&&gpec.secretKey.bytes&&Array.from(gpec.secretKey.bytes).every(b=>b===0xFF)));
    if(gpecKeyVirgin)warnings.push("GPEC2A vehicle key: ERASED/virgin (all-FF @ 0x0203)");
    else if(!gpec.keyConsistent)issues.push("GPEC2A secret key INCONSISTENT (0x0203 vs 0x0361)!");
    else passed.push("GPEC2A secret key consistent (0x0203 = 0x0361)");
    if(gpec.zzzzTamper&&!gpec.zzzzTamper.intact)warnings.push("GPEC2A ZZZZ tamper: CLEARED");
    else if(gpec.zzzzTamper&&gpec.zzzzTamper.intact)passed.push("GPEC2A ZZZZ tamper: INTACT");
  }
  if(bcm&&bcm.securityLock){if(bcm.securityLock.locked)passed.push("BCM lock: 0x5A LOCKED");else warnings.push("BCM lock: UNLOCKED");}
  if(rfhub){passed.push("RFHUB FOBIK: "+rfhub.fobikSlots+" slots");passed.push("RFHUB CC66AA55: "+rfhub.securityMarkers);}
  if(bcm){passed.push("BCM FOBIK: "+bcm.fobikCount+" keys");if(rfhub&&rfhub.fobikSlots!==bcm.fobikCount)warnings.push("Key count mismatch: RFHUB="+rfhub.fobikSlots+" BCM="+bcm.fobikCount);}
  if(e95){if(!e95.skb)passed.push("95640 secret key: SET");else warnings.push("95640 secret key: ERASED");}
  if(e95&&rfhub&&!e95.skb&&!rfhub.skb){
    if(arrEq(e95.skey,rfhub.skey))passed.push("95640 ↔ RFHUB secret key: MATCH");
    else issues.push("95640 ↔ RFHUB secret key: MISMATCH!");
  }
  if(e95&&e95.bcmSec16){
    if(e95.bcmSec16.blank)warnings.push("95640 BCM-SEC16 @ 0x838: BLANK (virgin EEPROM)");
    else if(e95.bcmSec16.csOk)passed.push("95640 BCM-SEC16 @ 0x838: SET, CRC16 ✓ (→RFH: "+e95.bcmSec16.reversedHex.slice(0,16)+"…)");
    else warnings.push("95640 BCM-SEC16 @ 0x838: CRC16 BAD (stored="+e95.bcmSec16.storedCs.toString(16).toUpperCase()+" calc="+e95.bcmSec16.calcCs.toString(16).toUpperCase()+")");
  }
  if(rfhub&&e95&&rfhub.sec16valid&&e95.bcmSec16&&!e95.bcmSec16.blank){
    const rfhHex=rfhub.sec16s[0].hex;
    const match=rfhHex===e95.bcmSec16.reversedHex;
    if(match)passed.push("RFHUB SEC16 ↔ 95640 BCM-SEC16 (reversed): MATCH ✓");
    else warnings.push("RFHUB SEC16 ↔ 95640 BCM-SEC16 (reversed): MISMATCH — use RFH→BCM Import tool");
  }
  if(rfhub&&rfhub.rfhVin92&&e95&&e95.vins?.length){
    const e95VinSet=new Set(e95.vins.map(v=>v.vin));
    if(e95VinSet.has(rfhub.rfhVin92.vin))passed.push("RFH VIN@0x92 ↔ 95640 VIN: MATCH ("+rfhub.rfhVin92.vin+")");
    else warnings.push("RFH VIN@0x92 ("+rfhub.rfhVin92.vin+") not found in 95640 VINs");
  }
  return{issues,warnings,passed};
}

function computeDiff(a,b){
  const changes=[],len=Math.max(a.length,b.length);
  for(let i=0;i<len;i++){if((a[i]||0)!==(b[i]||0))changes.push(i);}
  const groups=[];
  if(changes.length){let s=changes[0],p=changes[0];for(let i=1;i<changes.length;i++){if(changes[i]>p+1){groups.push([s,p]);s=changes[i];}p=changes[i];}groups.push([s,p]);}
  return{totalChanged:changes.length,groups,changedSet:new Set(changes)};
}

export {compareGpecBcmKey,crossValidate,computeDiff};
