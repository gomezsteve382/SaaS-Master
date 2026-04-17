import {TR,WT,WMI,YR} from './constants.js';

const VIN_RX=/^[A-HJ-NPR-Z0-9]{17}$/;

function checkVin(v){
  if(!v||v.length!==17)return{ok:false};
  const u=v.toUpperCase();
  if(!VIN_RX.test(u))return{ok:false,err:'Invalid chars'};
  let sum=0;for(let i=0;i<17;i++)sum+=(TR[u[i]]||0)*WT[i];
  const cd='0123456789X'[sum%11];
  return{ok:u[8]===cd,cd,wmi:u.slice(0,3),mfr:WMI[u.slice(0,3)]||'',yr:YR[u[9]]||'',err:u[8]!==cd?'Check digit: need '+cd:''};
}

function parseVinYear(vin){
  if(!vin||vin.length<10)return null;
  const c=vin[9].toUpperCase();
  return YR[c]||null;
}

// SGW (Security Gateway Module) shipped on FCA platforms beginning model year 2018.
// Heuristic: any FCA/Stellantis VIN whose model-year code maps to >= 2018.
// Conservative; consumer-side code should still probe the bus to confirm.
function vinHasSGW(vin){
  const yr=parseVinYear(vin);
  if(!yr)return false;
  return yr>=2018;
}

export {checkVin,parseVinYear,vinHasSGW,VIN_RX};
