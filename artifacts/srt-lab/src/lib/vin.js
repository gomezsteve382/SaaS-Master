import {TR,WT,WMI,YR} from './constants.js';

const VIN_RX=/^[A-HJ-NPR-Z0-9]{17}$/;

export function checkVin(v){
  if(!v||v.length!==17)return{ok:false};
  const u=v.toUpperCase();
  if(!VIN_RX.test(u))return{ok:false,err:'Invalid chars'};
  let sum=0;for(let i=0;i<17;i++)sum+=(TR[u[i]]||0)*WT[i];
  const cd='0123456789X'[sum%11];
  return{ok:u[8]===cd,cd,wmi:u.slice(0,3),mfr:WMI[u.slice(0,3)]||'',yr:YR[u[9]]||'',err:u[8]!==cd?'Check digit: need '+cd:''};
}

/* Parse the model-year char (position 10, index 9) of a 17-char VIN.
   Returns the 4-digit year (e.g. 2019) or null if the VIN is too short
   or the year code is not recognised. */
export function parseVinYear(vin){
  if(typeof vin!=='string'||vin.length<10)return null;
  const ch=vin[9].toUpperCase();
  return YR[ch]||null;
}

/* FCA Secure-Gateway (SGW) shipped on US-market 2018+ models.
   Returns true when the VIN's model year is >= 2018. Unknown / short
   VINs return false (callers must treat unknown as "not required"). */
export function vinHasSGW(vin){
  const y=parseVinYear(vin);
  return typeof y==='number'&&y>=2018;
}

/* True when the VIN is exactly 17 chars, uses only the legal alphabet,
   and the position-9 (index 8) check digit matches the ISO 3779 weighted
   sum. Thin wrapper around checkVin so every tab can share one source
   of truth instead of re-implementing it. */
export function vinCheckDigitValid(vin){
  if(typeof vin!=='string')return false;
  return checkVin(vin).ok===true;
}

/* Charger SRT trim & HP decoder for the 2C3CDX VIN family (LD-platform
   Dodge Charger Hellcat / Redeye / Jailbreak / Scat Pack / R/T / SRT
   392). Returns null for any non-Charger VIN so callers can render a
   silent fallback. Pulled from the v3 reference (Task #488) and kept
   here so every tab that already imports vin.js gets the same lookup. */
export function decodeChargerVin(vin){
  if(typeof vin!=='string'||vin.length!==17)return null;
  const u=vin.toUpperCase();
  if(!u.startsWith('2C3CDX'))return null;
  const engine=u[6];
  const trimByte=u[7];
  const year=parseVinYear(u)||0;
  let trim='';let hp='';
  if(engine==='L'){
    if(trimByte==='9'&&year>=2022){trim='SRT Hellcat Redeye Widebody Jailbreak';hp='807 HP / 707 lb-ft';}
    else if(trimByte==='5'&&year>=2018){trim='SRT Hellcat Redeye / Widebody';hp='797 HP / 707 lb-ft';}
    else if(trimByte==='7'||trimByte==='8'){trim='SRT Hellcat Redeye Widebody';hp='797 HP';}
    else if(trimByte==='6'){trim='SRT Hellcat Widebody';hp='717 HP';}
    else if(trimByte==='0'){trim='SRT Hellcat';hp=year>=2021?'717 HP':'707 HP';}
    else {trim='SRT Hellcat (variant)';hp='707-797 HP';}
  } else if(engine==='T'){trim='SRT 392 / Scat Pack';hp='485 HP / 475 lb-ft';}
  else if(engine==='G'){trim='R/T 5.7L HEMI';hp='370 HP';}
  else if(engine==='H'){trim='Scat Pack 6.4L';hp='485 HP';}
  if(!trim)return null;
  return{trim,hp,engine,trimByte,year,family:'Charger LD'};
}

export {VIN_RX};
