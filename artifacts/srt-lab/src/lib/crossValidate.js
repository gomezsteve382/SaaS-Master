import {arrEq} from './parseModule.js';

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

  if(rfhub&&rfhub.vehicleSecret&&bcm&&bcm.vehicleSecret){
    const rev=Array.from(bcm.vehicleSecret.bytes).reverse();
    if(arrEq(new Uint8Array(Array.from(rfhub.vehicleSecret.bytes)),new Uint8Array(rev)))
      passed.push("RFHUB ↔ BCM vehicle secret: MATCH (byte-reversed)");
    else issues.push("RFHUB ↔ BCM vehicle secret: MISMATCH!");
  }
  if(rfhub&&rfhub.sec16s){
    if(rfhub.sec16valid)passed.push("RFHUB SEC16: VALID — slots 1&2 match, non-blank");
    else if(rfhub.sec16s[0]?.blank)warnings.push("RFHUB SEC16: BLANK (all FF/00) — virgin module");
    else warnings.push("RFHUB SEC16: Slot 1/2 MISMATCH or unreadable");
  }
  if(gpec&&gpec.pcmSec6){
    if(gpec.pcmSec6.damaged)issues.push("PCM SEC6 @ 0x3C8: IMMO_DAMAGED (FF FF FF FF FF FF) — open the Module Sync tab and load your RFHUB dump alongside this PCM to apply the RFH→PCM SEC6 import");
    else passed.push("PCM SEC6 @ 0x3C8: "+gpec.pcmSec6.hex+" ("+gpec.pcmSec6.immoState+")");
  }
  if(rfhub&&gpec&&rfhub.sec16valid&&gpec.pcmSec6&&!gpec.pcmSec6.damaged){
    const s16=rfhub.sec16s[0].raw;const s6=gpec.pcmSec6.raw;
    const match=arrEq(Array.from(s6),Array.from(s16.slice(0,6)));
    if(match)passed.push("RFHUB SEC16[0:6] ↔ PCM SEC6: MATCH ✓");
    else warnings.push("RFHUB SEC16[0:6] ↔ PCM SEC6: MISMATCH — open the Module Sync tab to apply the RFH→PCM SEC6 import");
  }
  if(gpec&&gpec.secretKey&&bcm&&bcm.vehicleSecret){const cmp=compareGpecBcmKey(gpec.secretKey.bytes,bcm.vehicleSecret.bytes);if(cmp.match)passed.push("GPEC↔BCM key: MATCH ✓ (BCM LE reversed, first 8B = GPEC 8B)");else issues.push("GPEC↔BCM key: MISMATCH! GPEC="+Array.from(cmp.gpecBytes).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' ')+" BCM(rev)[0:8]="+Array.from(cmp.bcmBytes).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' '));}
  else if(gpec&&gpec.secretKey&&bcm)warnings.push("GPEC↔BCM key: BCM vehicle secret not found for comparison");
  if(gpec){
    if(gpec.skimByte===0x80)passed.push("GPEC2A SKIM: ENABLED (0x80)");
    else if(gpec.skimByte===0x00)warnings.push("GPEC2A SKIM: DISABLED (0x00) — bypassed");
    if(!gpec.keyConsistent)issues.push("GPEC2A secret key INCONSISTENT (0x0203 vs 0x0361)!");
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
