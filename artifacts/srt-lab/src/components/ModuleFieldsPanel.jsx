import React from "react";
import {Card,Tag} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";

const hxArr=a=>Array.from(a).map(b=>b.toString(16).toUpperCase().padStart(2,"0")).join(" ");
const fO=n=>"0x"+n.toString(16).toUpperCase().padStart(4,"0");

function Row({label,children}){
  return <div style={{display:"grid",gridTemplateColumns:"170px 1fr",gap:8,padding:"3px 0",fontSize:11,alignItems:"baseline"}}>
    <span style={{color:C.tm,fontWeight:700}}>{label}</span>
    <span style={{fontFamily:"'JetBrains Mono'",color:C.tx}}>{children}</span>
  </div>;
}

function Hex({children,muted}){
  return <span style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:muted?'#D5D0C8':C.a4,fontWeight:700}}>{children}</span>;
}

/* Renders the byte-level fields exposed by parseModule for a single module.
   Used by the FCA Analyzer tab and as an embedded "Module File Inspector"
   in BCM / RFHUB / GPEC2A tabs. Read-only. */
export default function ModuleFieldsPanel({mod,onSyncImmo}){
  if(!mod||mod.type==='UNKNOWN')return <div style={{fontSize:11,color:C.tm,padding:10}}>Unknown module type — no enriched fields available.</div>;

  return <div>
    {/* GPEC2A ------------------------------------------------------------- */}
    {mod.type==='GPEC2A'&&<>
      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:8,letterSpacing:1.5}}>⚙️ GPEC2A SECURITY</div>
        <Row label="SKIM byte @0x0011">
          <Tag color={mod.skimByte===0x80?C.gn:C.wn}>{mod.skimStatus}</Tag>
          <span style={{marginLeft:6,color:C.tm}}>0x{mod.skimByte.toString(16).toUpperCase().padStart(2,'0')}</span>
        </Row>
        <Row label="Secret key @0x0203"><Hex muted={mod.skb}>{mod.secretKey.hex}</Hex></Row>
        <Row label="Mirror @0x0361"><Hex muted={mod.skb}>{mod.secretKeyMirror.hex}</Hex>{' '}<Tag color={mod.keyConsistent?C.gn:C.er}>{mod.keyConsistent?'MATCH':'MISMATCH'}</Tag></Row>
        <Row label="ZZZZ tamper @0x0C8C">
          <Tag color={mod.zzzzTamper.intact?C.gn:C.er}>{mod.zzzzTamper.intact?'INTACT':'CLEARED'}</Tag>
          <span style={{marginLeft:6,fontSize:10,color:C.ts}}>{mod.zzzzTamper.hex}</span>
        </Row>
        {mod.pcmSec6&&<Row label="PCM SEC6 @0x03C8">
          <Hex muted={mod.pcmSec6.blank}>{mod.pcmSec6.hex}</Hex>{' '}
          <Tag color={mod.pcmSec6.damaged?C.er:C.gn}>{mod.pcmSec6.immoState}</Tag>
        </Row>}
        <Row label="Part number @0x0FA1">{mod.partNumberStr||<span style={{color:C.tm}}>—</span>}</Row>
      </Card>

      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:8,letterSpacing:1.5}}>🔐 TRANSPONDER KEYS @0x0888</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          {mod.transponderKeys.map((k,i)=>{
            const blank=Array.from(k.hex.split(' ').map(h=>parseInt(h,16))).every(b=>b===0xFF||b===0);
            return <div key={i} style={{padding:8,borderRadius:8,background:C.c2,border:'1px solid '+(blank?C.bd:C.gn+'40'),textAlign:'center'}}>
              <div style={{fontSize:9,color:C.tm,fontWeight:700}}>KEY {i+1} · {fO(k.offset)}</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:700,color:blank?'#D5D0C8':C.a4,marginTop:3}}>{k.hex}</div>
              <Tag color={blank?C.tm:C.gn}>{blank?'—':'SET'}</Tag>
            </div>;
          })}
        </div>
      </Card>

      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:8,letterSpacing:1.5}}>📊 RUNTIME COUNTERS</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          {[
            {n:'Counter A',c:mod.runtimeCounters.counterA},
            {n:'Counter B',c:mod.runtimeCounters.counterB},
            {n:'Distance',c:mod.runtimeCounters.distance},
            {n:'Key cycles',c:mod.runtimeCounters.keyCycles},
          ].map(x=>{
            const v=(x.c.value>>>0);
            return <div key={x.n} style={{padding:8,borderRadius:8,background:C.c2,border:'1px solid '+C.bd,textAlign:'center'}}>
              <div style={{fontSize:9,color:C.tm}}>{x.n}</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:C.a1,marginTop:2}}>{v.toLocaleString()}</div>
              <div style={{fontSize:8,color:C.tm}}>{fO(x.c.offset)} · {x.c.hex}</div>
            </div>;
          })}
        </div>
      </Card>
    </>}

    {/* RFHUB -------------------------------------------------------------- */}
    {mod.type==='RFHUB'&&<>
      <Card glow style={{marginBottom:14}}>
        <div style={{fontSize:16,fontWeight:900,marginBottom:12}}>🔑 RFHUB Analysis</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+C.a3+'40'}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>FOBIK SLOTS @0x0880</div>
            <div style={{fontSize:28,fontWeight:900,color:C.a3,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>{mod.fobikSlots}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:4}}>AA50 markers · Gen {mod.rfhGen}</div>
          </div>
          {mod.rfhVin92?<div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+(mod.rfhVin92.csOk?C.gn+'40':C.er+'40')}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>VIN @0x0092</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:900,color:C.a1,lineHeight:1.1,wordBreak:'break-all'}}>{mod.rfhVin92.vin}</div>
            <div style={{marginTop:6}}><Tag color={mod.rfhVin92.csOk?C.gn:C.er}>CRC16 {mod.rfhVin92.csOk?'✓ VALID':'✗ INVALID'}</Tag></div>
          </div>:<div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>VIN @0x0092</div>
            <div style={{fontSize:24,fontWeight:900,color:C.tm,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>—</div>
          </div>}
        </div>
      </Card>

      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>📊 RFHUB Markers</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
          {[
            {n:'SECURITY MARKERS',v:mod.securityMarkers,sub:'CC 66 AA 55'},
            {n:'ZZZZ BLOCKS',v:mod.zzzzBlocks,sub:'5A 5A 5A 5A'},
            {n:'FOBIK SLOTS',v:mod.fobikSlots,sub:'AA50 @0x0880'},
          ].map(t=><div key={t.n} style={{padding:12,borderRadius:10,background:C.c2,border:'1px solid '+C.bd,textAlign:'center'}}>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:1}}>{t.n}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:24,fontWeight:900,color:C.a3,marginTop:4,lineHeight:1.1}}>{t.v}</div>
            <div style={{fontSize:9,color:C.tm,marginTop:2}}>{t.sub}</div>
          </div>)}
        </div>
      </Card>

      {mod.vehicleSecret&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔐 Vehicle Secret @0x050E</div>
        <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
          <Hex muted={mod.vehicleSecret.bytes.every(b=>b===0xFF||b===0)}>{mod.vehicleSecret.hex}</Hex>
        </div>
      </Card>}

      {mod.sec16s?.length>0&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔒 SEC16 Slots</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {mod.sec16s.map(s=><div key={s.slot} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+(s.blank?C.bd:s.csOk===false?C.er+'40':C.gn+'40')}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <span style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:1}}>SLOT {s.slot} · {fO(s.offset)}</span>
              {s.blank?<Tag color={C.tm}>BLANK</Tag>:s.csOk!==undefined&&<Tag color={s.csOk?C.gn:C.er}>CS {s.csOk?'✓':'✗'}</Tag>}
            </div>
            {!s.blank&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.a4,wordBreak:'break-all'}}>{s.hex}</div>}
          </div>)}
        </div>
        {mod.sec16match!==undefined&&<div style={{marginTop:8}}>
          <Tag color={mod.sec16valid?C.gn:C.wn}>{mod.sec16valid?'SEC16 VALID — slots match':'SEC16 mismatch / blank'}</Tag>
        </div>}
      </Card>}

      {(mod.partNumbers.hw||mod.partNumbers.sw||mod.partNumbers.cal)&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🏷️ Part Numbers</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
          {[{l:'HW',o:0x0808,v:mod.partNumbers.hw},{l:'SW',o:0x0812,v:mod.partNumbers.sw},{l:'CAL',o:0x082C,v:mod.partNumbers.cal}].map(p=>p.v?<div key={p.l} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:10,color:C.tm,marginBottom:4}}>{p.l} @{fO(p.o)}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:C.a3,letterSpacing:1}}>{p.v}</div>
          </div>:null)}
        </div>
      </Card>}
    </>}

    {/* BCM ---------------------------------------------------------------- */}
    {mod.type==='BCM'&&<>
      <Card glow style={{marginBottom:14}}>
        <div style={{fontSize:16,fontWeight:900,marginBottom:12}}>🧠 BCM Analysis</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+(mod.securityLock.locked?C.gn+'40':C.wn+'40')}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>SECURITY LOCK @0x8028</div>
            <div style={{fontSize:28,fontWeight:900,color:mod.securityLock.locked?C.gn:C.wn,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>{mod.securityLock.locked?'LOCKED':'UNLOCKED'}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:4}}>0x{mod.securityLock.value.toString(16).toUpperCase().padStart(2,'0')} {mod.securityLock.locked?'(0x5A)':''}</div>
          </div>
          <div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+C.a1+'40'}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>FOBIK COUNT @0x5862</div>
            <div style={{fontSize:28,fontWeight:900,color:C.a1,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>{mod.fobikCount}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:4}}>{mod.fobikParts||'—'}</div>
          </div>
        </div>
      </Card>

      <Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔐 IMMO Status</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:14,borderRadius:10,background:C.c2,border:'1px solid '+(mod.immoBlank?C.wn+'40':C.gn+'40')}}>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:1.5}}>IMMO PRIMARY @0x40C0</div>
            <div style={{fontSize:24,fontWeight:900,color:mod.immoBlank?C.wn:C.gn,fontFamily:"'JetBrains Mono'",marginTop:4,lineHeight:1.1}}>{mod.immoBlank?'BLANK':mod.immoRecs}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:2}}>{mod.immoBlank?'no SKIM keys':'SKIM key'+(mod.immoRecs===1?'':'s')}</div>
          </div>
          <div style={{padding:14,borderRadius:10,background:C.c2,border:'1px solid '+(mod.bakBlank?C.bd:C.gn+'40')}}>
            <div style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:1.5}}>IMMO BACKUP @0x2000</div>
            <div style={{fontSize:24,fontWeight:900,color:mod.bakBlank?C.tm:C.gn,fontFamily:"'JetBrains Mono'",marginTop:4,lineHeight:1.1}}>{mod.bakBlank?'BLANK':mod.bakRecs}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:2}}>
              {!mod.bakBlank&&!mod.immoBlank?<Tag color={mod.immoSynced?C.gn:C.wn}>{mod.immoSynced?'SYNCED ✓':'OUT OF SYNC'}</Tag>:(mod.bakBlank?'no backup keys':'')}
            </div>
          </div>
        </div>
        {onSyncImmo&&!mod.immoBlank&&(mod.bakBlank||!mod.immoSynced)&&<div style={{marginTop:10}}>
          <button onClick={onSyncImmo} style={{padding:'8px 14px',border:'2px solid '+C.a1+'55',borderRadius:8,background:'transparent',color:C.a1,fontWeight:800,fontSize:11,cursor:'pointer',fontFamily:"'Nunito'",letterSpacing:.5}}>🔄 Sync IMMO primary → backup</button>
        </div>}
      </Card>

      {mod.vehicleSecret&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔑 Vehicle Secret @0x40C9 <span style={{fontSize:10,color:C.tm,fontWeight:600}}>(LE)</span></div>
        <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
          <Hex muted={mod.skb}>{mod.vehicleSecret.hex}</Hex>
        </div>
      </Card>}

      {mod.immoKeys?.length>0&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🗝️ SKIM Key Slots</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
          {mod.immoKeys.map((k,i)=>{
            const bytes=k.hex.split(' ').map(h=>parseInt(h,16));
            const blank=bytes.every(b=>b===0xFF||b===0);
            return <div key={i} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+(blank?C.bd:C.gn+'40'),textAlign:'center'}}>
              <div style={{fontSize:10,fontWeight:800,color:C.tm}}>SLOT {i+1}</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:700,color:blank?'#D5D0C8':C.a4,marginTop:4,wordBreak:'break-all'}}>{k.hex}</div>
              <div style={{fontSize:9,color:C.tm,marginTop:2}}>{fO(k.offset)}</div>
              <Tag color={blank?C.tm:C.gn}>{blank?'—':'SET'}</Tag>
            </div>;
          })}
        </div>
      </Card>}

      {mod.partialVins?.length>0&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔢 Partial VINs (last 8 chars)</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {mod.partialVins.map((p,i)=><div key={i} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+(p.crcOk?C.gn+'40':C.er+'40')}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <span style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:1}}>{fO(p.offset)}</span>
              <Tag color={p.crcOk?C.gn:C.er}>CRC16 {p.crcOk?'✓':'✗'}</Tag>
            </div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:900,color:C.a1,lineHeight:1.1}}>…{p.tail}</div>
            <div style={{fontSize:9,color:C.tm,marginTop:4,fontFamily:"'JetBrains Mono'"}}>stored 0x{p.storedCrc.toString(16).toUpperCase().padStart(4,'0')} · calc 0x{p.calcCrc.toString(16).toUpperCase().padStart(4,'0')}</div>
          </div>)}
        </div>
      </Card>}
    </>}

    {/* 95640 -------------------------------------------------------------- */}
    {mod.type==='95640'&&<>
      <Card glow style={{marginBottom:14}}>
        <div style={{fontSize:16,fontWeight:900,marginBottom:12}}>💾 95640 Analysis</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+(mod.skb?C.wn+'40':C.gn+'40')}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>SECRET KEY @0x0040</div>
            <div style={{fontSize:28,fontWeight:900,color:mod.skb?C.wn:C.gn,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>{mod.skb?'ERASED':'SET'}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:4}}>16-byte key block</div>
          </div>
          <div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+(mod.fobBlank?C.bd:C.gn+'40')}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>FOB BLOCK @0x0200</div>
            <div style={{fontSize:28,fontWeight:900,color:mod.fobBlank?C.tm:C.gn,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>{mod.fobBlank?'BLANK':'HAS FOBS'}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:4}}>0x0200 – 0x0240</div>
          </div>
        </div>
      </Card>

      {!mod.skb&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔐 Secret Key Bytes</div>
        <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
          <Hex>{hxArr(mod.skey)}</Hex>
        </div>
      </Card>}

      {mod.bcmSec16&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔒 BCM-SEC16 @0x0838</div>
        <div style={{padding:12,borderRadius:10,background:C.c2,border:'1px solid '+(mod.bcmSec16.blank?C.wn+'40':mod.bcmSec16.csOk?C.gn+'40':C.er+'40')}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
            <span style={{fontSize:11,fontWeight:800,color:C.tm,letterSpacing:1.5}}>SEC16 BLOCK</span>
            {mod.bcmSec16.blank?<Tag color={C.wn}>BLANK</Tag>:<Tag color={mod.bcmSec16.csOk?C.gn:C.er}>CRC16 {mod.bcmSec16.csOk?'✓ VALID':'✗ INVALID'}</Tag>}
          </div>
          {!mod.bcmSec16.blank&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.a4,wordBreak:'break-all'}}>{mod.bcmSec16.hex}</div>}
        </div>
      </Card>}
    </>}
  </div>;
}

export {Row,Hex};
