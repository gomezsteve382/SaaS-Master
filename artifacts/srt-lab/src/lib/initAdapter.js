/* Shared adapter init — preserves the known-good ATZ 3000 ms + 1000 ms settle
   timing validated on the 11/3 bench test. Returns
     { send, uds, isSTN, adapter, readVoltage, disconnect, port }
   or null on failure. On failure, sets `initAdapter.lastError` to the
   classified `{kind, friendly, repickRequired}` object so the caller can
   render a Retry / "Pick a different port" recovery UI without having to
   reimplement the messaging. */

import { openSerialPort, cleanupPort, onPortDisconnect, classifySerialError } from './serialErrors.js';

export async function initAdapter(addLog, hxFn, opts = {}) {
  const { forceRepick = false, onDisconnect = null } = opts;
  initAdapter.lastError = null;

  const opened = await openSerialPort({ addLog, forceRepick });
  if (!opened.ok) {
    initAdapter.lastError = opened.error;
    return null;
  }
  const port = opened.port;
  let rd = null, w = null, detach = null;
  try {
    w = port.writable.getWriter();
    rd = port.readable.getReader();
    const tdec = new TextDecoder();
    let rbuf = '';
    const send = async (cmd, to = 3000) => {
      rbuf = '';
      await w.write(new TextEncoder().encode(cmd + '\r'));
      addLog('TX > ' + cmd, 'tx');
      const deadline = Date.now() + to;
      while (Date.now() < deadline) {
        try {
          const rp = rd.read();
          const tp = new Promise(r => setTimeout(() => r({ value: undefined, done: true }), Math.min(500, deadline - Date.now())));
          const res = await Promise.race([rp, tp]);
          if (res.done || !res.value) { if (Date.now() >= deadline) break; continue; }
          rbuf += tdec.decode(res.value);
          const pi = rbuf.indexOf('>');
          if (pi !== -1) {
            const r = rbuf.substring(0, pi).replace(/\r/g, '\n').replace(/\n+/g, '\n').trim();
            rbuf = rbuf.substring(pi + 1);
            addLog('RX < ' + r, 'rx');
            return r;
          }
        } catch { break; }
      }
      const t = rbuf.replace(/\r/g, '\n').replace(/\n+/g, '\n').replace(/>/g, '').trim();
      if (t) addLog('RX (to) < ' + t, 'warn');
      return t;
    };

    /* Known-good init sequence — DO NOT change timing without bench verification */
    await send('ATZ',3000);await new Promise(r=>setTimeout(r,1000));
    await send('ATE0');await new Promise(r=>setTimeout(r,150));
    const ati=await send('ATI');
    await new Promise(r=>setTimeout(r,150));
    const stdi=await send('STDI');
    const isSTN=!stdi.includes('?')&&stdi.length>2;
    addLog('Adapter: '+(isSTN?'STN/OBDLink':'ELM327')+' ('+ati+')','info');
    if(isSTN){
      await send('ATPP2CSV81',2000);await new Promise(r=>setTimeout(r,200));
      await send('ATPP2CON',2000);await new Promise(r=>setTimeout(r,200));
      await send('ATPP2DSV01',2000);await new Promise(r=>setTimeout(r,200));
      await send('ATPP2DON',2000);await new Promise(r=>setTimeout(r,200));
      await send('ATZ',3000);await new Promise(r=>setTimeout(r,1500));
      await send('ATE0',2000);await new Promise(r=>setTimeout(r,200));
    }
    await send('ATL0');await new Promise(r=>setTimeout(r,80));
    await send('ATS1');await new Promise(r=>setTimeout(r,80));
    await send('ATH1');await new Promise(r=>setTimeout(r,80));
    await send('ATSP6');await new Promise(r=>setTimeout(r,80));
    await send('ATAT2');await new Promise(r=>setTimeout(r,80));
    if(isSTN){await send('STPTO3000',1500);await new Promise(r=>setTimeout(r,100));}
    await send('ATST96');await new Promise(r=>setTimeout(r,80));
    await send('ATCAF1');await new Promise(r=>setTimeout(r,80));
    if(isSTN){
      await send('ATFCSH7E0');await new Promise(r=>setTimeout(r,80));
      await send('ATFCSD300000');await new Promise(r=>setTimeout(r,80));
      await send('ATFCSM1');await new Promise(r=>setTimeout(r,80));
    }

    let curTx=0,curRx=0;
    const uds=async(tx,rx,data,timeout)=>{
      if(tx!==curTx||rx!==curRx){
        await send('ATCRA');await new Promise(r=>setTimeout(r,50));
        await send('ATSH'+hxFn(tx,3));await new Promise(r=>setTimeout(r,50));
        if(isSTN){await send('ATFCSH'+hxFn(tx,3));await new Promise(r=>setTimeout(r,50));}
        await send('ATCRA'+hxFn(rx,3));await new Promise(r=>setTimeout(r,50));
        curTx=tx;curRx=rx;
      }
      const tm=timeout||(data.length>7?8000:4000);
      const h=Array.from(data).map(b=>hxFn(b)).join(' ');
      const r=await send(h,tm);
      if(!r||/NO DATA|CAN ERROR|UNABLE|BUS/.test(r))return{ok:false,raw:r||''};
      if(r.includes('?')||r.includes('ERROR'))return{ok:false,raw:r};
      const lines=r.split(/[\r\n]+/).map(l=>l.trim()).filter(Boolean);
      const all=[];
      for(const line of lines){
        if(line.includes('SEARCHING')||line==='OK')continue;
        const toks=line.split(/\s+/);
        if(toks.length<2)continue;
        if(/^[0-9A-F]{3}$/.test(toks[0].toUpperCase())){
          for(let i=1;i<toks.length;i++)if(/^[0-9A-Fa-f]{2}$/.test(toks[i]))all.push(parseInt(toks[i],16));
        }else{for(const t of toks)if(/^[0-9A-Fa-f]{2}$/.test(t))all.push(parseInt(t,16));}
      }
      if(!all.length)return{ok:false,raw:r};
      return{ok:true,d:new Uint8Array(all),raw:r};
    };

    const readVoltage=async()=>{
      const r=await send('ATRV',2000);
      if(!r)return null;
      const m=r.match(/(\d+\.\d+)\s*V?/i);
      return m?parseFloat(m[1]):null;
    };

    /* Mid-session unplug detection — if the cable is yanked while the
       tab is connected, fire onDisconnect so the UI can show the same
       friendly recovery flow as a failed init. */
    if (onDisconnect) {
      detach = onPortDisconnect(port, () => {
        addLog('Adapter unplugged — connection lost. Plug the cable back in and click Retry.', 'error');
        cleanupPort(port, rd, w);
        try { onDisconnect({ kind: 'disconnected', friendly: 'Adapter unplugged mid-session — re-plug the OBD cable, then click Retry.', repickRequired: false }); } catch { /* ignore */ }
      });
    }

    const disconnect = async () => {
      try { detach?.(); } catch { /* ignore */ }
      await cleanupPort(port, rd, w);
    };

    return { send, uds, isSTN, adapter: ati, readVoltage, disconnect, port };
  } catch (e) {
    const cls = classifySerialError(e);
    addLog(cls.friendly, 'error');
    initAdapter.lastError = cls;
    try { detach?.(); } catch { /* ignore */ }
    await cleanupPort(port, rd, w);
    return null;
  }
}

/* Parse VIN string from UDS response bytes */
export function parseVinFromResponse(d){
  if(!d||d.length<3)return null;
  const payload=d[0]===0x62?Array.from(d).slice(3):Array.from(d);
  const ascii=payload.filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('');
  return ascii.length>=10?ascii.slice(-17):null;
}

export { cleanupPort };
