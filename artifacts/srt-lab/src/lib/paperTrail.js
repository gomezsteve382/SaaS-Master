/* Session Log Service — paper trail of every write op.
   Ported verbatim (names preserved) from reference App.jsx for easy migration. */

const SESSIONS_KEY='srtlab_sessions';
const MAX_SESSIONS=500;

export function logSession(entry){
  try{
    const sessions=JSON.parse(localStorage.getItem(SESSIONS_KEY)||'[]');
    const record={
      id:'sess_'+Date.now()+'_'+Math.random().toString(36).slice(2,8),
      timestamp:new Date().toISOString(),
      ...entry,
    };
    sessions.unshift(record);
    localStorage.setItem(SESSIONS_KEY,JSON.stringify(sessions.slice(0,MAX_SESSIONS)));
    return record;
  }catch(e){console.error('Session log failed:',e);return null;}
}

export function getSessions(filter){
  try{
    const s=JSON.parse(localStorage.getItem(SESSIONS_KEY)||'[]');
    if(!filter)return s;
    return s.filter(x=>(!filter.module||x.module===filter.module)&&(!filter.vin||x.newVin===filter.vin||x.oldVin===filter.vin));
  }catch{return[];}
}

export function deleteSession(id){
  try{
    const s=JSON.parse(localStorage.getItem(SESSIONS_KEY)||'[]');
    localStorage.setItem(SESSIONS_KEY,JSON.stringify(s.filter(x=>x.id!==id)));
  }catch{/* ignore */}
}

export function clearSessions(){
  try{localStorage.removeItem(SESSIONS_KEY);}catch{/* ignore */}
}

/* Export sessions as printable HTML report */
export function generateSessionReport(sessions,shopInfo={}){
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SRT Lab Session Report</title>
<style>
body{font-family:-apple-system,sans-serif;max-width:800px;margin:20px auto;padding:20px;color:#222;line-height:1.5}
h1{border-bottom:3px solid #D32F2F;padding-bottom:8px;margin-bottom:4px}
.shop{color:#666;font-size:13px;margin-bottom:20px}
.sess{border:1px solid #ddd;border-radius:8px;padding:16px;margin:14px 0;page-break-inside:avoid}
.sess h3{margin:0 0 10px;font-size:16px;display:flex;justify-content:space-between}
.sess h3 .mod{color:#D32F2F}
.sess h3 .ts{color:#666;font-size:12px;font-weight:normal}
.grid{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;margin:10px 0}
.grid span:nth-child(odd){color:#666;font-weight:bold}
.vin{font-family:'Courier New',monospace;font-weight:bold;color:#D32F2F}
.title-ref{background:#FFF8F0;padding:8px 12px;border-left:3px solid #FFB300;margin:8px 0;font-size:12px}
.result{display:inline-block;padding:3px 10px;border-radius:4px;font-weight:bold;font-size:11px}
.ok{background:#E8F5E9;color:#1B5E20}
.fail{background:#FFEBEE;color:#B71C1C}
.sig{margin-top:30px;padding-top:20px;border-top:1px solid #ddd;font-size:12px;color:#666}
.sig-line{margin-top:30px;border-bottom:1px solid #333;width:300px}
@media print{body{margin:0}.sess{page-break-inside:avoid}}
</style></head><body>
<h1>SRT Lab — Module Programming Report</h1>
<div class="shop">
${shopInfo.shopName?'<b>'+shopInfo.shopName+'</b><br>':''}
${shopInfo.address||''}
${shopInfo.license?'<br>Dealer License: '+shopInfo.license:''}
${shopInfo.tech?'<br>Technician: '+shopInfo.tech:''}
<br>Report Generated: ${new Date().toLocaleString()}
<br>Sessions Included: ${sessions.length}
</div>
${sessions.map(s=>`
<div class="sess">
<h3><span class="mod">${s.module} — ${s.operation||'VIN Write'}</span><span class="ts">${new Date(s.timestamp).toLocaleString()}</span></h3>
<div class="grid">
<span>Result:</span><span><span class="result ${s.success?'ok':'fail'}">${s.success?'✓ SUCCESS':'✗ FAILED'}</span></span>
<span>Old VIN:</span><span class="vin">${s.oldVin||'(not read)'}</span>
<span>New VIN:</span><span class="vin">${s.newVin||'—'}</span>
${s.moduleAddr?`<span>Module Address:</span><span>TX 0x${s.moduleAddr.tx.toString(16).toUpperCase()} / RX 0x${s.moduleAddr.rx.toString(16).toUpperCase()}</span>`:''}
${s.adapter?`<span>Adapter:</span><span>${s.adapter}${s.sgwRouted?' <b style="color:#1565C0">[SGW ROUTED]</b>':''}</span>`:''}
${s.technician?`<span>Technician:</span><span>${s.technician}</span>`:''}
${s.preWriteConfirmed?`<span>Pre-Write Review:</span><span>✓ Confirmed at ${new Date(s.preWriteConfirmed).toLocaleTimeString()}</span>`:''}
</div>
${s.titleRef?`<div class="title-ref"><b>Title Reference:</b> ${s.titleRef}${s.titleNotes?' — '+s.titleNotes:''}</div>`:''}
${s.notes?`<div style="font-size:12px;color:#555;margin-top:8px"><b>Notes:</b> ${s.notes}</div>`:''}
</div>
`).join('')}
<div class="sig">
<p>I certify that the above module programming operations were performed on modules legitimately in my possession, with VINs corresponding to vehicles documented in my records.</p>
<div class="sig-line"></div>Signature / Date
</div>
</body></html>`;
}
