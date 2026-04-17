import React, {useState} from "react";
import {vinHasSGW, parseVinYear} from "../lib/vin.js";
import {useBridgeStatus} from "../lib/bridgeClient.js";

// Pre-write confirmation modal — blocks any destructive write until tech confirms.
// onConfirm receives {reviewed,titleRef,titleNotes,technician,preWriteConfirmed}.
function ReadFirstModal({module,currentState,newVin,onConfirm,onCancel}){
  const sgwReq=vinHasSGW(newVin);
  const vinYear=parseVinYear(newVin);
  const{connected:bridgeOk,status:bridgeStatus}=useBridgeStatus(sgwReq?5000:0);
  const [reviewed,setReviewed]=useState(false);
  const [titleRef,setTitleRef]=useState('');
  const [titleNotes,setTitleNotes]=useState('');
  const [technician,setTechnician]=useState(()=>{
    try{return localStorage.getItem('srtlab_tech')||'';}catch{return '';}
  });
  const [confirmVin,setConfirmVin]=useState('');

  const handleConfirm=()=>{
    if(!reviewed){alert('Please check the box confirming you reviewed the current module state.');return;}
    if(confirmVin.toUpperCase()!==(newVin||'').toUpperCase()){
      alert('Re-typed VIN does not match. Type the target VIN exactly to continue.');return;
    }
    if(technician){try{localStorage.setItem('srtlab_tech',technician);}catch{}}
    onConfirm({reviewed,titleRef,titleNotes,technician,preWriteConfirmed:new Date().toISOString()});
  };

  return <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
    <div style={{background:'#fff',borderRadius:14,maxWidth:650,width:'100%',maxHeight:'90vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.5)'}}>
      <div style={{padding:'20px 24px',background:'linear-gradient(135deg,#1A1A1A 0%,#D32F2F 100%)',color:'#fff',borderRadius:'14px 14px 0 0'}}>
        <div style={{fontSize:10,letterSpacing:3,opacity:.7,fontWeight:700}}>PRE-WRITE CONFIRMATION</div>
        <div style={{fontFamily:"'Righteous'",fontSize:22,letterSpacing:1,marginTop:4}}>⚠ READ BEFORE WRITING</div>
        <div style={{fontSize:12,opacity:.9,marginTop:6}}>Review the current module state below. Once you write, the old VIN is overwritten.</div>
      </div>
      <div style={{padding:24}}>
        <div style={{marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:800,color:'#666',letterSpacing:2,marginBottom:8}}>CURRENT STATE — {module}</div>
          <div style={{background:'#FFF8F0',border:'2px solid #FFB300',borderRadius:8,padding:14}}>
            {(!currentState||currentState.length===0)?
              <div style={{fontSize:12,color:'#999',fontStyle:'italic'}}>No prior state was read. Strongly recommended: cancel this write, run "Read VINs" first, then try again.</div>
              :currentState.map((row,i)=><div key={i} style={{display:'grid',gridTemplateColumns:'180px 1fr',gap:8,fontSize:12,padding:'4px 0',borderTop:i===0?'none':'1px solid #FFE082'}}>
                <span style={{color:'#666',fontWeight:700}}>{row.label}:</span>
                <span style={{fontFamily:"'JetBrains Mono'",fontWeight:700,color:'#1A1A1A'}}>{row.value||<span style={{color:'#bbb',fontStyle:'italic'}}>(not set)</span>}</span>
              </div>)
            }
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:800,color:'#666',letterSpacing:2,marginBottom:8}}>NEW VIN TO WRITE</div>
          <div style={{padding:12,background:'#FFEBEE',border:'2px solid #D32F2F',borderRadius:8,fontFamily:"'JetBrains Mono'",fontSize:16,fontWeight:800,color:'#D32F2F',letterSpacing:2,textAlign:'center'}}>{newVin||'(no VIN entered)'}</div>
        </div>
        {sgwReq&&<div data-testid="sgw-routing-block" style={{marginBottom:14,background:bridgeOk?'#FFF3E0':'#FFF8E1',border:'2px solid '+(bridgeOk?'#FF6D00':'#FFB300'),borderRadius:8,padding:12}}>
          <div style={{fontSize:11,fontWeight:800,color:bridgeOk?'#E65100':'#B26500',letterSpacing:2,marginBottom:6}}>🔐 SECURE GATEWAY ROUTING</div>
          {bridgeOk?<div style={{fontSize:12,color:'#6D4C00',lineHeight:1.5}}>
            Routing through <b>{bridgeStatus?.vendor||'Autel MaxiFlash'}</b> (SGW authenticated).
            VIN model year <b>{vinYear}</b> requires Secure Gateway. Bridge is connected
            {bridgeStatus?.deviceSerial?<> · serial <b>{bridgeStatus.deviceSerial}</b></>:null}
            {bridgeStatus?.versions?.firmware?<> · firmware <b>{bridgeStatus.versions.firmware}</b></>:null}.
          </div>:<div style={{fontSize:12,color:'#6D4C00',lineHeight:1.5}}>
            VIN model year <b>{vinYear}</b> requires FCA Secure Gateway, but the local
            J2534 bridge daemon is <b>not reachable</b>. Open the <b>AUTEL SGW</b> tab,
            start <code>j2534_bridge.py</code>, and verify the Autel cable before retrying.
          </div>}
        </div>}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
          <div>
            <div style={{fontSize:11,fontWeight:800,color:'#666',letterSpacing:1,marginBottom:4}}>TECHNICIAN</div>
            <input value={technician} onChange={e=>setTechnician(e.target.value)} placeholder="Your name" style={{width:'100%',padding:'8px 10px',border:'1.5px solid #ddd',borderRadius:6,fontSize:12,boxSizing:'border-box'}}/>
          </div>
          <div>
            <div style={{fontSize:11,fontWeight:800,color:'#666',letterSpacing:1,marginBottom:4}}>WORK ORDER / RO #</div>
            <input value={titleRef} onChange={e=>setTitleRef(e.target.value)} placeholder="RO-12345 or title #" style={{width:'100%',padding:'8px 10px',border:'1.5px solid #ddd',borderRadius:6,fontSize:12,boxSizing:'border-box'}}/>
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:800,color:'#666',letterSpacing:1,marginBottom:4}}>NOTES (optional)</div>
          <textarea value={titleNotes} onChange={e=>setTitleNotes(e.target.value)} rows={2} placeholder="Customer info, reason for write, etc." style={{width:'100%',padding:'8px 10px',border:'1.5px solid #ddd',borderRadius:6,fontSize:12,boxSizing:'border-box',fontFamily:'inherit',resize:'vertical'}}/>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:800,color:'#666',letterSpacing:1,marginBottom:4}}>RE-TYPE TARGET VIN TO CONFIRM</div>
          <input value={confirmVin} onChange={e=>setConfirmVin(e.target.value.toUpperCase().replace(/\s/g,'').slice(0,17))} placeholder="Re-type the new VIN exactly" style={{width:'100%',padding:'10px 12px',border:'2px solid '+(confirmVin&&confirmVin===newVin?'#00C853':'#ddd'),borderRadius:6,fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:700,letterSpacing:2,boxSizing:'border-box'}}/>
        </div>
        <label style={{display:'flex',gap:10,padding:12,background:'#F5F5F5',borderRadius:8,marginBottom:18,cursor:'pointer'}}>
          <input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)} style={{marginTop:2}}/>
          <span style={{fontSize:12,color:'#333'}}>I have reviewed the current module state above and accept that proceeding will permanently overwrite it.</span>
        </label>
        <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
          <button onClick={onCancel} style={{padding:'10px 20px',background:'#fff',color:'#666',border:'1.5px solid #ddd',borderRadius:8,fontWeight:700,fontSize:12,cursor:'pointer'}}>Cancel</button>
          <button onClick={handleConfirm} disabled={!reviewed||confirmVin.toUpperCase()!==(newVin||'').toUpperCase()} style={{padding:'10px 24px',background:(reviewed&&confirmVin.toUpperCase()===(newVin||'').toUpperCase())?'#D32F2F':'#ccc',color:'#fff',border:'none',borderRadius:8,fontWeight:800,fontSize:12,cursor:(reviewed&&confirmVin.toUpperCase()===(newVin||'').toUpperCase())?'pointer':'not-allowed'}}>⚡ CONFIRM &amp; WRITE</button>
        </div>
      </div>
    </div>
  </div>;
}

export default ReadFirstModal;
export {ReadFirstModal};
