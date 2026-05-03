/* Module Backup Service — snapshots critical DIDs to localStorage before writes.
   Ported from reference App.jsx (vault/server/module-backup-service.ts). */
import {nrcMsg} from './nrc.js';
import {sha256Hex,backupDidsToBytes} from './checksum.js';

const INDEX_KEY='srtlab_backup_index';
const MAX_BACKUPS=50;

/* Critical DIDs per module — what we back up before writing anything */
export const CRITICAL_DIDS={
  BCM:[
    {did:0xF190,name:'VIN',critical:true},
    {did:0xF187,name:'Part Number'},
    {did:0xF189,name:'Software Version'},
    {did:0xF191,name:'Hardware Version'},
    {did:0xF18C,name:'Serial Number'},
    {did:0xF1A0,name:'BCM Config',critical:true},
    {did:0xF1A1,name:'BCM Feature Bytes',critical:true},
    {did:0xF1D0,name:'Key Fob Data'},
    {did:0xF1D1,name:'SKIM Data',critical:true},
    {did:0x7B90,name:'Current VIN',critical:true},
    {did:0x7B88,name:'Original VIN',critical:true},
  ],
  RFHUB:[
    {did:0xF190,name:'VIN',critical:true},
    {did:0xF187,name:'Part Number'},
    {did:0xF189,name:'Software Version'},
    {did:0xF18C,name:'PIN / Serial',critical:true},
    {did:0xF1E0,name:'Tire Sensors'},
    {did:0xF1E1,name:'Secret Key',critical:true},
  ],
  ECM:[
    {did:0xF190,name:'VIN',critical:true},
    {did:0xF187,name:'Part Number'},
    {did:0xF189,name:'Software Version'},
    {did:0xF191,name:'Hardware Version'},
    {did:0xF18C,name:'Serial Number'},
    {did:0xF194,name:'Software Fingerprint'},
    {did:0xF195,name:'Calibration ID'},
    {did:0xF40D,name:'Odometer',critical:true},
    {did:0xF1C1,name:'Engine Hours'},
    {did:0xF1C0,name:'Calibration Data',critical:true},
  ],
  ADCM:[
    {did:0xF190,name:'VIN',critical:true},
    {did:0xF187,name:'Part Number'},
    {did:0xF189,name:'Software Version'},
    {did:0xF1A1,name:'Suspension Mode'},
    {did:0xDE10,name:'Vehicle Config'},
    {did:0xDE11,name:'Variant Code'},
    {did:0x7B90,name:'Current VIN',critical:true},
    {did:0x7B88,name:'Original VIN',critical:true},
  ],
  /* VILLAIN-extracted Chrysler/FCA DIDs. Source:
     /tmp/villain_gpec/villain_extraction/VILLAIN_COMPLETE_EXTRACTION.md (lines 70-77, 88-103).
     This group is LABEL-ONLY — it is NOT a real moduleType. dids.js seeds
     from every value in this map, so the labels show up in the UI regardless
     of whether anyone calls backupModule() with this key. The 24-bit and
     32-bit DIDs cannot be issued via a standard 0x22 two-byte read frame;
     backupModule() guards against accidental wide-DID requests. */
  VILLAIN_EXT:[
    {did:0x7B90,name:'Current VIN'},
    {did:0x7B88,name:'Original VIN'},
    {did:0x6E2025,name:'Bus Transmitted VIN'},
    {did:0x6E2027,name:'WCM Configured VIN'},
    {did:0x6E9EB0,name:'SKIM State (0x80=Enabled, 0x00=Disabled)'},
    {did:0x6EF190,name:'EPS VIN'},
    {did:0xF79EB045,name:'SKIM state flag (SCI-B)'},
  ],
};

/* Read all critical DIDs from a module and persist to localStorage.
   engUds(tx,rx,bytes) -> {ok,d} */
export async function backupModule(engUds,tx,rx,moduleType,addLog,hxFn,snapshotKind='pre-write',preWriteKey=null){
  const dids=CRITICAL_DIDS[moduleType];
  if(!dids){addLog('No backup profile for '+moduleType,'warn');return null;}
  addLog('═══ CREATING MODULE BACKUP: '+moduleType+' ═══','info');
  addLog('Reading '+dids.length+' critical DIDs before any writes...','info');
  await engUds(tx,rx,[0x10,0x03]);
  const backup={module:moduleType,tx,rx,timestamp:new Date().toISOString(),dids:{}};
  let successCount=0;
  for(const d of dids){
    if(d.did>0xFFFF){addLog('  Skipping wide DID 0x'+d.did.toString(16).toUpperCase()+' ('+d.name+'): cannot fit a standard 2-byte 0x22 read','warn');continue;}
    const r=await engUds(tx,rx,[0x22,(d.did>>8)&0xFF,d.did&0xFF]);
    if(r.ok&&r.d&&r.d[0]===0x62){
      const raw=Array.from(r.d).slice(3);
      const hex=raw.map(b=>hxFn(b)).join('');
      const ascii=raw.filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('');
      backup.dids[d.did]={name:d.name,critical:!!d.critical,hex,ascii:ascii.length>=3?ascii:'',bytes:raw};
      addLog('  0x'+hxFn(d.did,4)+' ('+d.name+'): '+hex,'rx');
      successCount++;
    }else{
      backup.dids[d.did]={name:d.name,critical:!!d.critical,hex:'',bytes:[],missing:true};
      addLog('  0x'+hxFn(d.did,4)+' ('+d.name+'): not readable','warn');
    }
  }
  addLog('Backup complete: '+successCount+'/'+dids.length+' DIDs captured','info');
  const checksum=await sha256Hex(backupDidsToBytes(backup.dids)).catch(()=>null);
  backup.checksum=checksum;
  backup.snapshotKind=snapshotKind;
  if(preWriteKey)backup.preWriteKey=preWriteKey;
  const vin=backup.dids[0xF190]?.ascii?.slice(-17)||'unknown';
  const key='srtlab_backup_'+moduleType+'_'+vin+'_'+Date.now();

  // Persist to the project database so backup history survives across
  // browsers and shop machines. localStorage is kept as an offline cache.
  let savedRemote=false;
  try{
    const res=await fetch('/api/backups',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        id:key,module:moduleType,vin,didCount:successCount,
        tx,rx,timestamp:backup.timestamp,payload:backup,
        checksum,snapshotKind,preWriteKey:preWriteKey||null,
      }),
    });
    savedRemote=res.ok;
    if(res.ok)addLog('✓ Backup saved to database: '+key,'info');
    else addLog('Backup server returned '+res.status+' — keeping local copy only','warn');
  }catch(e){
    addLog('Backup server unreachable ('+e.message+') — keeping local copy only','warn');
  }

  try{
    localStorage.setItem(key,JSON.stringify(backup));
    const idx=JSON.parse(localStorage.getItem(INDEX_KEY)||'[]');
    idx.unshift({key,module:moduleType,vin,timestamp:backup.timestamp,didCount:successCount,tx,rx,checksum,snapshotKind,preWriteKey:preWriteKey||null});
    if(idx.length>MAX_BACKUPS){
      idx.slice(MAX_BACKUPS).forEach(b=>{try{localStorage.removeItem(b.key);}catch{/* ignore */}});
    }
    localStorage.setItem(INDEX_KEY,JSON.stringify(idx.slice(0,MAX_BACKUPS)));
    backup.key=key;
    try{window.dispatchEvent(new Event('srtlab:audit'));}catch{/* ignore */}
    if(savedRemote)addLog('✓ Backup saved to database: '+key,'info');
    else addLog('✓ Backup saved to localStorage: '+key,'info');
  }catch(e){addLog('Failed to save backup: '+e.message,'error');}
  return backup;
}

export async function restoreModule(engUds,tx,rx,backup,addLog,hxFn,fullRestore=false){
  if(!backup||!backup.dids){addLog('Invalid backup data','error');return false;}
  addLog('═══ RESTORING MODULE: '+backup.module+' ═══','info');
  addLog('Backup timestamp: '+backup.timestamp,'info');
  let restoredCount=0,failedCount=0;
  for(const[didStr,data] of Object.entries(backup.dids)){
    const did=parseInt(didStr);
    if(!data.bytes||data.bytes.length===0)continue;
    if(!fullRestore&&!data.critical)continue;
    addLog('Restoring 0x'+hxFn(did,4)+' ('+data.name+')...','info');
    const r=await engUds(tx,rx,[0x2E,(did>>8)&0xFF,did&0xFF,...data.bytes]);
    if(r.ok&&r.d&&r.d[0]===0x6E){addLog('  ✓ Restored','rx');restoredCount++;}
    else{
      if(r.ok&&r.d&&r.d[0]===0x7F)addLog('  NRC: '+nrcMsg(r.d[2]||0),'error');
      else addLog('  Failed','error');
      failedCount++;
    }
    await new Promise(r=>setTimeout(r,200));
  }
  addLog('Restore: '+restoredCount+' success, '+failedCount+' failed','info');
  return failedCount===0;
}

export function getBackupList(moduleType){
  try{
    const idx=JSON.parse(localStorage.getItem(INDEX_KEY)||'[]');
    return moduleType?idx.filter(b=>b.module===moduleType):idx;
  }catch{return[];}
}

export function getBackup(key){
  try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}
}

export function deleteBackup(key){
  try{
    localStorage.removeItem(key);
    const idx=JSON.parse(localStorage.getItem(INDEX_KEY)||'[]');
    localStorage.setItem(INDEX_KEY,JSON.stringify(idx.filter(b=>b.key!==key)));
    try{window.dispatchEvent(new Event('srtlab:audit'));}catch{/* ignore */}
  }catch{/* ignore */}
  fetch('/api/backups/'+encodeURIComponent(key),{method:'DELETE'}).catch(()=>{/* best-effort */});
}
