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

export {VIN_RX};
