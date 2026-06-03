#!/usr/bin/env node
  /*
   * solve_index.mjs  -- harness to crack RFHUB INDEX = F(keyId, master)
   *
   *   node solve_index.mjs            # load pairs, run built-in sweeps (CRC8 ruled out, CRC16 sweep)
   *   node solve_index.mjs --builtins # same, verbose
   *
   * To test YOUR candidate: edit candidate() below and run. It must return one byte (0-255).
   * A candidate is CORRECT only if matchAll() reports it reproduces every non-sentinel pair.
   */
  import fs from 'fs';
  import path from 'path';
  import { fileURLToPath } from 'url';

  const here = path.dirname(fileURLToPath(import.meta.url));
  const csvLines = fs.readFileSync(path.join(here,'pairs_all.csv'),'utf8')
    .replace(/\r/g,'').split('\n').map(l=>l.trim()).filter(Boolean).slice(1);
  const PAIRS = csvLines.map(l=>{
    const f = l.split(',').map(s=>s.trim());
    const [vehicle,master,keyId,idxDec,,flag,off,sent]=f;
    if(!/^[0-9A-Fa-f]{32}$/.test(master||'') || !/^[0-9A-Fa-f]{8}$/.test(keyId||'')){
      console.error('skipping malformed CSV row:', l); return null;
    }
    return { vehicle, master, masterBytes:Buffer.from(master,'hex'),
             keyId, keyBE:Buffer.from(keyId,'hex'), keyLE:Buffer.from(keyId,'hex').reverse(),
             index:Number(idxDec), flag, sentinel: sent==='yes' };
  }).filter(Boolean);
  if(PAIRS.length===0){ console.error('No valid pairs loaded from pairs_all.csv — aborting.'); process.exit(1); }
  const REAL = PAIRS.filter(p=>!p.sentinel);
  console.log('Loaded', PAIRS.length, 'pairs (', REAL.length, 'real ) across',
              new Set(PAIRS.map(p=>p.vehicle)).size, 'vehicles\n');

  // ---- helpers ----------------------------------------------------------------
  function crc16(bytes, poly, init, refin, refout, xorout){
    const rev16=x=>{let r=0;for(let i=0;i<16;i++)r=(r<<1)|((x>>i)&1);return r&0xFFFF;};
    const rev8=x=>{let r=0;for(let i=0;i<8;i++)r=(r<<1)|((x>>i)&1);return r&0xFF;};
    let c=init&0xFFFF;
    for(let x of bytes){ if(refin)x=rev8(x); c^=(x<<8); for(let i=0;i<8;i++) c=(c&0x8000)?((c<<1)^poly)&0xFFFF:(c<<1)&0xFFFF; }
    if(refout)c=rev16(c); return (c^xorout)&0xFFFF;
  }

  function matchAll(fn, pairs=REAL){
    let ok=0; const miss=[];
    for(const p of pairs){ if((fn(p)&0xFF)===p.index) ok++; else miss.push(p.keyId); }
    return { ok, total:pairs.length, miss };
  }

  // ---- YOUR CANDIDATE ---------------------------------------------------------
  // return a byte 0-255. p.keyBE / p.keyLE are 4-byte Buffers; p.masterBytes is 16 bytes.
  function candidate(p){
    // EXAMPLE (replace): return p.keyBE[0] ^ p.keyBE[1] ^ p.keyBE[2] ^ p.keyBE[3];
    return -1;
  }

  // ---- built-in CRC16 sweep over several input compositions -------------------
  function crc16Sweep(){
    const polys=[0x1021,0x8005,0x3D65,0xA001,0xC867,0x8BB7,0x1DCF,0x755B];
    const inits=[0x0000,0xFFFF,0x1D0F,0xB2AA,0x89EC];
    const inputs = p => ({
      'keyBE': p.keyBE,
      'keyLE': p.keyLE,
      'keyBE|master': Buffer.concat([p.keyBE,p.masterBytes]),
      'master|keyBE': Buffer.concat([p.masterBytes,p.keyBE]),
      'keyLE|master': Buffer.concat([p.keyLE,p.masterBytes]),
    });
    const picks=['hi','lo','hi^lo'];
    let found=0;
    for(const poly of polys) for(const init of inits)
     for(const refin of [0,1]) for(const refout of [0,1])
      for(const compName of Object.keys(inputs(PAIRS[0])))
       for(const pick of picks){
        const fn=p=>{ const c=crc16(inputs(p)[compName],poly,init,refin,refout,0);
          const hi=(c>>8)&0xFF, lo=c&0xFF; return pick==='hi'?hi:pick==='lo'?lo:(hi^lo); };
        const r=matchAll(fn);
        if(r.ok===r.total){ console.log('MATCH  CRC16 poly=0x'+poly.toString(16),'init=0x'+init.toString(16),
          'refin='+refin,'refout='+refout,'in='+compName,'pick='+pick); found++; }
      }
    console.log(found? '\n^ CRC16 candidate(s) above reproduce ALL real pairs.' : 'CRC16 sweep: no full match.');
  }

  // ---- run --------------------------------------------------------------------
  const cr = matchAll(candidate);
  if(cr.ok>0 && cr.miss.length===0) console.log('candidate(): FULL MATCH on all real pairs!');
  else if(candidate(PAIRS[0])!==-1) console.log('candidate(): '+cr.ok+'/'+cr.total+' (miss: '+cr.miss.join(',')+')');
  else console.log('candidate(): (stub not implemented — edit candidate())');

  console.log('\n--- CRC16 sweep ---');
  crc16Sweep();
  console.log('\nPer-vehicle pair counts:');
  for(const v of [...new Set(PAIRS.map(p=>p.vehicle))])
    console.log(' ', v, REAL.filter(p=>p.vehicle===v).length, 'real /', PAIRS.filter(p=>p.vehicle===v).length, 'total');
  