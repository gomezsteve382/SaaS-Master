import React, {useState, useEffect, useCallback} from "react";
import {C} from "@/lib/srt/constants.js";
import {getBackupList} from "@/lib/srt/backups.js";
import {getSessions} from "@/lib/srt/paperTrail.js";

/* Deep-link helpers — navigate to the Backups/Sessions tab with an item
   pre-selected. BackupsTab/SessionsTab read window.location.hash on mount
   and react to the same `srtlab:navigate` event. */
export function navigateToBackup(key){
  try{window.location.hash="backup="+encodeURIComponent(key);}catch{}
  window.dispatchEvent(new CustomEvent("srtlab:navigate",{detail:{tab:"backups",key}}));
}
export function navigateToSession(id){
  try{window.location.hash="session="+encodeURIComponent(id);}catch{}
  window.dispatchEvent(new CustomEvent("srtlab:navigate",{detail:{tab:"sessions",id}}));
}

/* Collapsible inline panel showing the last N backups & sessions for a
   single module, so users can pre-write review without leaving the tab. */
export default function ModuleHistoryPanel({moduleType, limit=5}){
  const [open,setOpen]=useState(true);
  const [backups,setBackups]=useState(()=>getBackupList(moduleType));
  const [sessions,setSessions]=useState(()=>getSessions({module:moduleType}));

  const refresh=useCallback(()=>{
    setBackups(getBackupList(moduleType));
    setSessions(getSessions({module:moduleType}));
  },[moduleType]);

  useEffect(()=>{
    refresh();
    const onStorage=(e)=>{
      if(!e || !e.key || e.key==="srtlab_backup_index" || e.key==="srtlab_sessions" || e.key.startsWith("srtlab_backup_")) refresh();
    };
    const onCustom=()=>refresh();
    window.addEventListener("storage",onStorage);
    window.addEventListener("srtlab:audit",onCustom);
    const id=setInterval(refresh,4000);
    return()=>{
      window.removeEventListener("storage",onStorage);
      window.removeEventListener("srtlab:audit",onCustom);
      clearInterval(id);
    };
  },[refresh]);

  const recentBackups=backups.slice(0,limit);
  const recentSessions=sessions.slice(0,limit);

  return (
    <div data-testid={"history-panel-"+moduleType} style={{
      marginBottom:14, border:"1px solid "+C.bd, borderRadius:12,
      background:"#FAF9F7", overflow:"hidden",
    }}>
      <button
        type="button"
        data-testid={"history-toggle-"+moduleType}
        onClick={()=>setOpen(o=>!o)}
        style={{
          width:"100%", display:"flex", alignItems:"center", gap:10,
          padding:"10px 14px", background:"transparent", border:"none",
          cursor:"pointer", textAlign:"left",
        }}>
        <span style={{fontSize:14}}>{open?"▾":"▸"}</span>
        <span style={{fontWeight:800,fontSize:11,color:C.ts,letterSpacing:2}}>📜 HISTORY</span>
        <span style={{fontSize:10,color:C.tm,letterSpacing:1}}>
          {backups.length} backup{backups.length===1?"":"s"} · {sessions.length} session{sessions.length===1?"":"s"} for {moduleType}
        </span>
      </button>

      {open && (
        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:0, borderTop:"1px solid "+C.bd}}>
          <Column
            title={"BACKUPS (last "+Math.min(limit,backups.length)+")"}
            empty="No backups yet for this module."
            items={recentBackups}
            renderItem={(b)=>(
              <button
                key={b.key}
                type="button"
                data-testid={"history-backup-"+b.key}
                onClick={()=>navigateToBackup(b.key)}
                style={rowStyle()}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontWeight:800,fontSize:12,color:C.tx}}>{b.module}</span>
                  <span style={{fontSize:9,color:C.tm,fontFamily:"'JetBrains Mono'"}}>{b.didCount} DIDs</span>
                </div>
                <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.ts,marginTop:2}}>{b.vin}</div>
                <div style={{fontSize:10,color:C.tm,marginTop:2}}>{new Date(b.timestamp).toLocaleString()}</div>
              </button>
            )}
          />
          <Column
            title={"SESSIONS (last "+Math.min(limit,sessions.length)+")"}
            empty="No sessions yet for this module."
            items={recentSessions}
            leftBorder
            renderItem={(s)=>(
              <button
                key={s.id}
                type="button"
                data-testid={"history-session-"+s.id}
                onClick={()=>navigateToSession(s.id)}
                style={rowStyle(s.success===false?C.er:s.success?C.gn:C.tm)}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontWeight:800,fontSize:12,color:C.tx}}>{s.operation||"Write"}</span>
                  <span style={{
                    fontSize:9,padding:"1px 6px",borderRadius:4,fontWeight:800,
                    background:s.success?"#E8F5E9":"#FFEBEE",
                    color:s.success?C.gn:C.er,
                  }}>{s.success?"✓ OK":"✗ FAIL"}</span>
                </div>
                <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.ts,marginTop:2}}>
                  {s.newVin||s.oldVin||"—"}
                </div>
                {(s.adapter||s.sgwRouted) && (
                  <div style={{display:"flex",alignItems:"center",gap:6,marginTop:3,flexWrap:"wrap"}}>
                    {s.sgwRouted && (
                      <span title="Authenticated through Security Gateway via Autel J2534" style={{
                        fontSize:9,fontWeight:800,padding:"1px 6px",borderRadius:4,
                        background:"#E3F2FD",color:"#1565C0",border:"1px solid #1565C055",letterSpacing:1,
                      }}>🔒 SGW</span>
                    )}
                    {s.adapter && (
                      <span style={{fontSize:10,color:C.ts,fontFamily:"'JetBrains Mono'"}}>{s.adapter}</span>
                    )}
                  </div>
                )}
                <div style={{fontSize:10,color:C.tm,marginTop:2}}>{new Date(s.timestamp).toLocaleString()}</div>
              </button>
            )}
          />
        </div>
      )}
    </div>
  );
}

function Column({title, items, renderItem, empty, leftBorder}){
  return (
    <div style={{borderLeft:leftBorder?"1px solid "+C.bd:"none"}}>
      <div style={{
        padding:"8px 14px", fontSize:10, fontWeight:800,
        color:C.ts, letterSpacing:2, background:"#F4F1EC",
        borderBottom:"1px solid "+C.bd,
      }}>{title}</div>
      {items.length===0 ? (
        <div style={{padding:"14px 14px",fontSize:11,color:C.tm,fontStyle:"italic"}}>{empty}</div>
      ) : (
        <div>{items.map(renderItem)}</div>
      )}
    </div>
  );
}

function rowStyle(borderColor){
  return {
    display:"block", width:"100%", textAlign:"left",
    padding:"10px 14px", borderBottom:"1px solid "+C.bd,
    borderLeft:"3px solid "+(borderColor||"transparent"),
    background:"#fff", cursor:"pointer", fontFamily:"inherit",
  };
}
