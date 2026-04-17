import {useEffect, useRef, useState, useCallback} from 'react';

/* bridgeClient — talks to the local J2534 HTTP daemon (j2534_bridge.py)
   shipped from public/. The daemon listens on http://127.0.0.1:8765 by
   default; the user can override the URL from the AUTEL SGW tab.

   Persisted config lives in localStorage under 'srtlab_autel':
     { url, autoOpen, lastOk, lastChecked, vendor, dllPath } */

const LS_KEY='srtlab_autel';
export const DEFAULT_BRIDGE_URL='http://localhost:8765';

export function getAutelState(){
  try{
    const raw=localStorage.getItem(LS_KEY);
    if(!raw)return {url:DEFAULT_BRIDGE_URL,autoOpen:true};
    const parsed=JSON.parse(raw);
    return {url:DEFAULT_BRIDGE_URL,autoOpen:true,...parsed};
  }catch{return {url:DEFAULT_BRIDGE_URL,autoOpen:true};}
}

export function setAutelState(patch){
  try{
    const cur=getAutelState();
    const next={...cur,...patch};
    localStorage.setItem(LS_KEY,JSON.stringify(next));
    return next;
  }catch{return patch;}
}

function trimUrl(u){return (u||DEFAULT_BRIDGE_URL).replace(/\/+$/,'');}

async function call(url,path,method='GET',body=null,timeoutMs=4000){
  const ctl=new AbortController();
  const tm=setTimeout(()=>ctl.abort(),timeoutMs);
  try{
    const res=await fetch(trimUrl(url)+path,{
      method,
      headers:body?{'Content-Type':'application/json'}:undefined,
      body:body?JSON.stringify(body):undefined,
      signal:ctl.signal,
    });
    const text=await res.text();
    let json;try{json=text?JSON.parse(text):{};}catch{json={ok:false,error:'non-JSON: '+text.slice(0,120)};}
    if(!res.ok&&json.ok!==false)json.ok=false;
    if(!res.ok&&!json.error)json.error='HTTP '+res.status;
    return json;
  }catch(e){
    if(e.name==='AbortError')return {ok:false,error:'Bridge timed out (is j2534_bridge.py running?)'};
    return {ok:false,error:e.message||String(e)};
  }finally{clearTimeout(tm);}
}

/* Named API — each function takes an optional `url` (defaults to whatever
   `getAutelState().url` returns). This matches the contract the rest of
   the app expects: getStatus(), open(), connect({...}), etc. */
const u=(url)=>url||getAutelState().url;

export function getStatus(url){return call(u(url),'/status','GET');}
export function open(url){return call(u(url),'/open','POST',{});}
export function close(url){return call(u(url),'/close','POST',{});}
export function connect(opts={},url){
  return call(u(url),'/connect','POST',{
    protocol:opts.protocol??6,flags:opts.flags??0,baudrate:opts.baudrate??500000,
  });
}
export function disconnect(url){return call(u(url),'/disconnect','POST',{});}
export function setFilter({txId,rxId},url){return call(u(url),'/setfilter','POST',{txId,rxId});}
export function sendMsg({txId,data,flags=0x40,timeoutMs=1000},url){
  return call(u(url),'/sendmsg','POST',{txId,data,flags,timeoutMs});
}
export function readMsg({timeoutMs=1000}={},url){
  return call(u(url),'/readmsg','POST',{timeoutMs},timeoutMs+1000);
}

/* Back-compat object wrapper used internally by the AUTEL tab and the
   useBridgeStatus hook. Each method takes (url, …) so callers that
   already have a URL handy can pass it positionally. */
export const bridgeClient={
  status:(url)=>getStatus(url),
  open:(url)=>open(url),
  close:(url)=>close(url),
  connect:(url,opts={})=>connect(opts,url),
  disconnect:(url)=>disconnect(url),
  setFilter:(url,txId,rxId)=>setFilter({txId,rxId},url),
  sendMsg:(url,txId,dataHex,opts={})=>sendMsg({txId,data:dataHex,...opts},url),
  readMsg:(url,timeoutMs=1000)=>readMsg({timeoutMs},url),
};

/* React hook — polls /status at the given interval, returns the latest
   snapshot plus a `refresh()` to force an immediate poll. */
export function useBridgeStatus(intervalMs=4000){
  const[state,setState]=useState({loading:true,connected:false,status:null,error:null,url:getAutelState().url});
  const mounted=useRef(true);

  const refresh=useCallback(async(overrideUrl)=>{
    const url=overrideUrl||getAutelState().url;
    const res=await bridgeClient.status(url);
    if(!mounted.current)return res;
    if(res&&res.ok){
      setState({loading:false,connected:true,status:res,error:null,url});
      setAutelState({url,lastOk:Date.now(),vendor:res.vendor,dllPath:res.dllPath});
    }else{
      setState({loading:false,connected:false,status:null,error:res?.error||'unreachable',url});
    }
    return res;
  },[]);

  useEffect(()=>{
    mounted.current=true;
    refresh();
    if(!intervalMs)return ()=>{mounted.current=false;};
    const t=setInterval(()=>refresh(),intervalMs);
    return ()=>{mounted.current=false;clearInterval(t);};
  },[intervalMs,refresh]);

  return {...state,refresh};
}
