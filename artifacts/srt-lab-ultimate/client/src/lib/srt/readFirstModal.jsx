import React, {useState, useCallback} from 'react';
import {vinHasSGW, parseVinYear} from "@/lib/srt/vin.js";
import {useBridgeStatus} from "@/lib/srt/bridgeClient.js";

/* ReadFirstModal — single shared pre-write confirmation gate.
 *
 * Supports two call shapes (kept compatible after collapsing the three
 * pre-cleanup variants into this one canonical component):
 *
 *   A) DID-write callers (BcmTab / RfhubTab / EcmTab / AdcmTab / App.jsx)
 *      Props: { module, currentState:[{label,value}], newVin, onConfirm, onCancel }
 *
 *   B) Backup-restore caller (BackupsTab)
 *      Props: { title, subtitle, module, summary, details, destructiveLabel,
 *               onConfirm, onCancel }   (no currentState/newVin)
 *
 * onConfirm is always invoked with
 *   { reviewed, titleRef, titleNotes, technician, preWriteConfirmed }.
 */
export function ReadFirstModal({
  module,
  currentState = [],
  newVin,
  title,
  subtitle,
  summary,
  details,
  destructiveLabel,
  onConfirm,
  onCancel,
}) {
  const sgwReq = vinHasSGW(newVin);
  const vinYear = parseVinYear(newVin);
  const {connected: bridgeOk, status: bridgeStatus} = useBridgeStatus(sgwReq ? 5000 : 0);
  const [reviewed, setReviewed] = useState(false);
  const [titleRef, setTitleRef] = useState('');
  const [titleNotes, setTitleNotes] = useState('');
  const [technician, setTechnician] = useState(() => {
    try { return localStorage.getItem('srtlab_tech') || ''; } catch { return ''; }
  });

  const handleConfirm = useCallback(() => {
    if (!reviewed) { alert('Please check the box confirming you reviewed the current module state.'); return; }
    if (technician) { try { localStorage.setItem('srtlab_tech', technician); } catch { /* ignore */ } }
    onConfirm({reviewed, titleRef, titleNotes, technician, preWriteConfirmed: new Date().toISOString()});
  }, [reviewed, titleRef, titleNotes, technician, onConfirm]);

  const headerTitle = title || '⚠ READ BEFORE WRITING';
  const headerSubtitle = subtitle || 'Review the current module state below. Once you write, the old VIN is overwritten.';
  const confirmLabel = destructiveLabel || '✓ CONFIRM & PROCEED WITH WRITE';
  const showCurrentState = Array.isArray(currentState);

  return <div data-testid="read-first-modal" style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
    <div style={{background:'#fff',borderRadius:14,maxWidth:650,width:'100%',maxHeight:'90vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.5)'}}>
      <div style={{padding:'20px 24px',background:'linear-gradient(135deg,#1A1A1A 0%,#D32F2F 100%)',color:'#fff',borderRadius:'14px 14px 0 0'}}>
        <div style={{fontSize:10,letterSpacing:3,opacity:.7,fontWeight:700}}>PRE-WRITE CONFIRMATION</div>
        <div style={{fontFamily:"'Righteous'",fontSize:22,letterSpacing:1,marginTop:4}}>{headerTitle}</div>
        <div style={{fontSize:12,opacity:.9,marginTop:6}}>{headerSubtitle}</div>
      </div>
      <div style={{padding:24}}>
        {showCurrentState && <div style={{marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:800,color:'#666',letterSpacing:2,marginBottom:8}}>CURRENT STATE — {module}</div>
          <div style={{background:'#FFF8F0',border:'2px solid #FFB300',borderRadius:8,padding:14}}>
            {currentState.length === 0
              ? <div style={{fontSize:12,color:'#999',fontStyle:'italic'}}>No prior state was read. Strongly recommended: cancel this write, run "Read VINs" first, then try again.</div>
              : currentState.map((item, i) => (
                <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:i<currentState.length-1?'1px solid #FFE0B2':'none'}}>
                  <div style={{fontSize:11,fontWeight:700,color:'#666'}}>{item.label}</div>
                  <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:item.value?'#D84315':'#999'}}>{item.value || '(empty)'}</div>
                </div>
              ))}
          </div>
        </div>}

        {summary && <div style={{fontSize:13,color:'#1A1A1A',marginBottom:14,lineHeight:1.5}}>{summary}</div>}

        {details && <div style={{maxHeight:220,overflow:'auto',border:'1px solid #E8E4DE',borderRadius:8,padding:10,background:'#FAF9F7',marginBottom:14,fontFamily:"'JetBrains Mono'",fontSize:11,color:'#5A5A5A'}}>{details}</div>}

        {newVin && <div style={{marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:800,color:'#666',letterSpacing:2,marginBottom:8}}>WRITING NEW VALUE</div>
          <div style={{background:'#E8F5E9',border:'2px solid #00C853',borderRadius:8,padding:14}}>
            <div style={{fontSize:10,color:'#2E7D32',fontWeight:700,marginBottom:4}}>Target VIN (from Master VIN bar)</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:18,fontWeight:800,letterSpacing:2,color:'#1B5E20'}}>{newVin}</div>
          </div>
        </div>}

        {sgwReq && <div data-testid="sgw-routing-block" style={{marginBottom:18,background:bridgeOk?'#FFF3E0':'#FFF8E1',border:'2px solid '+(bridgeOk?'#FF6D00':'#FFB300'),borderRadius:8,padding:14}}>
          <div style={{fontSize:11,fontWeight:800,color:bridgeOk?'#E65100':'#B26500',letterSpacing:2,marginBottom:6}}>🔐 SECURE GATEWAY ROUTING</div>
          {bridgeOk
            ? <div style={{fontSize:12,color:'#6D4C00',lineHeight:1.5}}>Routing through <b>{bridgeStatus?.vendor || 'Autel MaxiFlash'}</b> (SGW authenticated). VIN model year <b>{vinYear}</b> requires Secure Gateway. The Autel J2534 bridge is connected{bridgeStatus?.versions?.firmware ? <> · firmware <b>{bridgeStatus.versions.firmware}</b></> : null}.</div>
            : <div style={{fontSize:12,color:'#6D4C00',lineHeight:1.5}}>VIN model year <b>{vinYear}</b> requires FCA Secure Gateway, but the local J2534 bridge daemon is <b>not reachable</b>. The write will fail at the cable unless you start <code>j2534_bridge.py</code> and an Autel VCI is connected. Open the <b>AUTEL SGW</b> tab to verify, then retry.</div>}
        </div>}

        <div style={{marginBottom:18,background:'#F0F8FF',border:'1px solid #B0D4F0',borderRadius:8,padding:14}}>
          <div style={{fontSize:11,fontWeight:800,color:'#1976D2',letterSpacing:2,marginBottom:10}}>📄 TITLE REFERENCE</div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,color:'#666',marginBottom:3,fontWeight:700}}>TITLE NUMBER / CAR ID / STOCK # / WORK ORDER (RO)</div>
            <input value={titleRef} onChange={e=>setTitleRef(e.target.value)} placeholder="e.g. RO-2024-087, Title #FL4820193X" style={{width:'100%',padding:10,border:'1.5px solid #B0D4F0',borderRadius:6,fontSize:13,fontFamily:"'JetBrains Mono'",boxSizing:'border-box'}}/>
          </div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,color:'#666',marginBottom:3,fontWeight:700}}>NOTES (optional)</div>
            <textarea value={titleNotes} onChange={e=>setTitleNotes(e.target.value)} placeholder="e.g. Replacement BCM for 2017 Challenger" rows={2} style={{width:'100%',padding:10,border:'1.5px solid #B0D4F0',borderRadius:6,fontSize:12,resize:'vertical',fontFamily:"'Nunito'",boxSizing:'border-box'}}/>
          </div>
          <div>
            <div style={{fontSize:10,color:'#666',marginBottom:3,fontWeight:700}}>TECHNICIAN NAME</div>
            <input value={technician} onChange={e=>setTechnician(e.target.value)} placeholder="Your name" style={{width:'100%',padding:10,border:'1.5px solid #B0D4F0',borderRadius:6,fontSize:13,boxSizing:'border-box'}}/>
          </div>
        </div>

        <label style={{display:'flex',alignItems:'center',gap:10,padding:14,background:reviewed?'#E8F5E9':'#FFEBEE',border:'2px solid '+(reviewed?'#00C853':'#FF5252'),borderRadius:8,cursor:'pointer',marginBottom:18}}>
          <input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)} style={{width:20,height:20,cursor:'pointer'}}/>
          <span style={{fontSize:13,fontWeight:700,color:reviewed?'#1B5E20':'#B71C1C'}}>I have reviewed the current module state above and confirm this write is authorized.</span>
        </label>
        <div style={{display:'flex',gap:10}}>
          <button onClick={onCancel} style={{flex:1,padding:'14px 20px',background:'#F5F5F5',border:'1.5px solid #ccc',borderRadius:8,fontSize:14,fontWeight:700,cursor:'pointer',color:'#666'}}>Cancel</button>
          <button onClick={handleConfirm} disabled={!reviewed} style={{flex:2,padding:'14px 20px',background:reviewed?'linear-gradient(135deg,#D32F2F,#B71C1C)':'#ccc',border:'none',borderRadius:8,fontSize:14,fontWeight:800,color:'#fff',cursor:reviewed?'pointer':'not-allowed',letterSpacing:1}}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  </div>;
}

export default ReadFirstModal;
