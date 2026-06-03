#!/usr/bin/env node
  /*
   * diff_dumps.mjs  before.bin  after.bin
   * Prints key records that appear in after.bin but not before.bin (the keys your tool added),
   * with their assigned INDEX byte. Also flags master-secret changes.
   */
  import fs from 'fs';
  const [,,beforeP, afterP] = process.argv;
  if(!beforeP || !afterP){ console.error('usage: node diff_dumps.mjs before.bin after.bin'); process.exit(1); }
  const hx=a=>Buffer.from(a).toString('hex').toUpperCase();
  function recs(b){
    const out=new Map();
    for(let i=0;i+14<=b.length;i++){
      if(b[i+6]===0xFF && b[i+7]===0xFF){
        const a=b.subarray(i,i+6), c=b.subarray(i+8,i+14);
        if(Buffer.compare(a,c)===0){
          const flag=a[5], uid=hx(a.subarray(0,4));
          if((flag===0x01||flag===0x03)&&!['5A5A5A5A','FFFFFFFF','00000000'].includes(uid)){
            const keyId=hx([a[3],a[2],a[1],a[0]]);
            out.set(keyId+':'+a[4]+':'+flag,{keyId,index:a[4],flag,off:i});
            i+=13;
          }
        }
      }
    }
    return out;
  }
  const A=fs.readFileSync(beforeP), B=fs.readFileSync(afterP);
  for(const [p,b] of [[beforeP,A],[afterP,B]]) if(![4096,8192,65536].includes(b.length))
    console.log('!! WARN '+p+' is '+b.length+' B — not a typical RFHUB EEPROM size (4096/8192/65536); results may be unreliable.');
  const ra=recs(A), rb=recs(B);
  const ma = A.length>=0x236?hx(A.subarray(0x226,0x236)):'?';
  const mb = B.length>=0x236?hx(B.subarray(0x226,0x236)):'?';
  console.log('before:',beforeP,A.length,'B  master',ma);
  console.log('after :',afterP,B.length,'B  master',mb);
  if(ma!==mb) console.log('!! master secret CHANGED between dumps');
  console.log('\nNEW key records (in after, not before):');
  let n=0;
  for(const [k,v] of rb) if(!ra.has(k)){ n++;
    console.log('  keyId='+v.keyId+'  INDEX=0x'+v.index.toString(16).padStart(2,'0').toUpperCase()+
                '  flag=0x0'+v.flag+'  @0x'+v.off.toString(16)); }
  if(!n) console.log('  (none — no new keys detected)');
  console.log('\n>>> Send back: before.bin, after.bin, and the keyId you added.');
  