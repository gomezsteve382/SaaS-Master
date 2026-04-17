import React, {createContext, useContext, useState, useCallback, useMemo} from 'react';

/* MasterVinContext — single source of truth for the in-progress job VIN
   and the per-module write status (BCM / RFHUB / ECM / ADCM).
   Tabs read with `useContext(MasterVinContext)` or `useMasterVin()`.
   Values:
     vin             — current Master VIN string (uppercase, ≤17 chars)
     setVin          — setter (auto-uppercases / strips whitespace upstream)
     vinValid        — true when length===17 and chars are A-HJ-NPR-Z0-9
     moduleStatus    — { BCM, RFHUB, ECM, ADCM } each 'pending'|'writing'|'ok'|'fail'
     setModuleStatus — full setter (e.g. patch)
     updateStatus    — convenience: updateStatus('BCM','ok')
     setPg           — navigate to a different tab id from a tab
     resetStatus     — reset all four modules back to 'pending' */

const VIN_RX=/^[A-HJ-NPR-Z0-9]{17}$/i;

export const MasterVinContext=createContext({
  vin:'',setVin:()=>{},vinValid:false,
  moduleStatus:{BCM:'pending',RFHUB:'pending',ECM:'pending',ADCM:'pending'},
  setModuleStatus:()=>{},updateStatus:()=>{},resetStatus:()=>{},
  setPg:()=>{},
});

export function useMasterVin(){return useContext(MasterVinContext);}

export function MasterVinProvider({setPg,children}){
  const[vin,setVinRaw]=useState('');
  const[moduleStatus,setModuleStatus]=useState({BCM:'pending',RFHUB:'pending',ECM:'pending',ADCM:'pending'});

  const setVin=useCallback(v=>{
    if(typeof v!=='string')return;
    setVinRaw(v.toUpperCase().replace(/\s/g,'').slice(0,17));
  },[]);

  const updateStatus=useCallback((mod,st)=>{
    setModuleStatus(p=>({...p,[mod]:st}));
  },[]);

  const resetStatus=useCallback(()=>{
    setModuleStatus({BCM:'pending',RFHUB:'pending',ECM:'pending',ADCM:'pending'});
  },[]);

  const vinValid=vin.length===17&&VIN_RX.test(vin);

  const value=useMemo(()=>({
    vin,setVin,vinValid,
    moduleStatus,setModuleStatus,updateStatus,resetStatus,
    setPg:setPg||(()=>{}),
  }),[vin,setVin,vinValid,moduleStatus,updateStatus,resetStatus,setPg]);

  return <MasterVinContext.Provider value={value}>{children}</MasterVinContext.Provider>;
}
