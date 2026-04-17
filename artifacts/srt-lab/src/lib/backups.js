/* Module Backup Service — snapshots critical DIDs to localStorage before writes.
   Ported from reference App.jsx (vault/server/module-backup-service.ts). */
import {decodeNRC} from './nrc.js';

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
};

/* Read all critical DIDs from a module and persist to localStorage.
   engUds(tx,rx,bytes) -> {ok,d} */
export async function backupModule(engUds,tx,rx,moduleType,addLog,hxFn){
  const dids=CRITICAL_DIDS[moduleType];
  if(!dids){addLog('No backup profile for '+moduleType,'warn');return null;}
  addLog('═══ CREATING MODULE BACKUP: '+moduleType+' ═══','info');
  addLog('Reading '+dids.length+' critical DIDs before any writes...','info');
  await engUds(tx,rx,[0x10,0x03]);
  const backup={module:moduleType,tx,rx,timestamp:new Date().toISOString(),dids:{}};
  let successCount=0;
  for(const d of dids){
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
  const vin=backup.dids[0xF190]?.ascii?.slice(-17)||'unknown';
  const key='srtlab_backup_'+moduleType+'_'+vin+'_'+Date.now();
  try{
    localStorage.setItem(key,JSON.stringify(backup));
    const idx=JSON.parse(localStorage.getItem(INDEX_KEY)||'[]');
    idx.unshift({key,module:moduleType,vin,timestamp:backup.timestamp,didCount:successCount});
    if(idx.length>MAX_BACKUPS){
      idx.slice(MAX_BACKUPS).forEach(b=>{try{localStorage.removeItem(b.key);}catch{/* ignore */}});
    }
    localStorage.setItem(INDEX_KEY,JSON.stringify(idx.slice(0,MAX_BACKUPS)));
    backup.key=key;
    addLog('✓ Backup saved to localStorage: '+key,'info');
    try{window.dispatchEvent(new Event('srtlab:audit'));}catch{/* ignore */}
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
      if(r.ok&&r.d&&r.d[0]===0x7F)addLog('  NRC: '+decodeNRC(r.d[2]||0),'error');
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
  }catch{/* ignore */}
}
