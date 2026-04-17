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
      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a3,marginBottom:8,letterSpacing:1.5}}>🔑 RFHUB FIELDS</div>
        <Row label="Generation"><Tag color={C.a3}>{mod.rfhGen}</Tag></Row>
        <Row label="FOBIK slots"><b>{mod.fobikSlots}</b> <span style={{color:C.tm}}>(AA50 markers @0x0880)</span></Row>
        <Row label="Security markers"><b>{mod.securityMarkers}</b> <span style={{color:C.tm}}>(CC 66 AA 55)</span></Row>
        <Row label="ZZZZ blocks"><b>{mod.zzzzBlocks}</b> <span style={{color:C.tm}}>(5A 5A 5A 5A)</span></Row>
        {mod.vehicleSecret&&<Row label="Vehicle secret @0x050E"><Hex muted={mod.vehicleSecret.bytes.every(b=>b===0xFF||b===0)}>{mod.vehicleSecret.hex}</Hex></Row>}
        {mod.rfhVin92&&<Row label="VIN @0x0092">
          <span style={{fontWeight:700,color:C.a1}}>{mod.rfhVin92.vin}</span>{' '}
          <Tag color={mod.rfhVin92.csOk?C.gn:C.er}>CRC16 {mod.rfhVin92.csOk?'✓':'✗'}</Tag>
        </Row>}
      </Card>

      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a3,marginBottom:8,letterSpacing:1.5}}>🏷️ PART NUMBERS</div>
        {mod.partNumbers.hw&&<Row label="HW @0x0808">{mod.partNumbers.hw}</Row>}
        {mod.partNumbers.sw&&<Row label="SW @0x0812">{mod.partNumbers.sw}</Row>}
        {mod.partNumbers.cal&&<Row label="CAL @0x082C">{mod.partNumbers.cal}</Row>}
      </Card>

      {mod.sec16s?.length>0&&<Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a3,marginBottom:8,letterSpacing:1.5}}>🔒 SEC16 SLOTS</div>
        {mod.sec16s.map(s=><Row key={s.slot} label={'Slot '+s.slot+' @'+fO(s.offset)}>
          {s.blank?<Tag color={C.tm}>BLANK</Tag>:<>
            <Hex>{s.hex}</Hex>{' '}
            {s.csOk!==undefined&&<Tag color={s.csOk?C.gn:C.er}>CS {s.csOk?'✓':'✗'}</Tag>}
          </>}
        </Row>)}
        {mod.sec16match!==undefined&&<div style={{marginTop:6,fontSize:11}}>
          <Tag color={mod.sec16valid?C.gn:C.wn}>{mod.sec16valid?'SEC16 VALID — slots match':'SEC16 mismatch / blank'}</Tag>
        </div>}
      </Card>}
    </>}

    {/* BCM ---------------------------------------------------------------- */}
    {mod.type==='BCM'&&<>
      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a1,marginBottom:8,letterSpacing:1.5}}>🧠 BCM FIELDS</div>
        {mod.vehicleSecret&&<Row label="Vehicle secret @0x40C9"><Hex muted={mod.skb}>{mod.vehicleSecret.hex}</Hex> <span style={{color:C.tm,fontSize:10}}>(LE)</span></Row>}
        <Row label="Security lock @0x8028">
          <Tag color={mod.securityLock.locked?C.gn:C.wn}>{mod.securityLock.locked?'LOCKED 0x5A':'UNLOCKED 0x'+mod.securityLock.value.toString(16).toUpperCase().padStart(2,'0')}</Tag>
        </Row>
        <Row label="FOBIK count @0x5862"><b>{mod.fobikCount}</b></Row>
        <Row label="FOBIK part @0x5818">{mod.fobikParts}</Row>
        <Row label="IMMO primary @0x40C0">
          <Tag color={mod.immoBlank?C.wn:C.gn}>{mod.immoBlank?'BLANK':mod.immoRecs+' SKIM keys'}</Tag>
        </Row>
        <Row label="IMMO backup @0x2000">
          <Tag color={mod.bakBlank?C.tm:C.gn}>{mod.bakBlank?'BLANK':mod.bakRecs+' keys'}</Tag>{' '}
          {!mod.bakBlank&&!mod.immoBlank&&<Tag color={mod.immoSynced?C.gn:C.wn}>{mod.immoSynced?'SYNCED':'OUT OF SYNC'}</Tag>}
        </Row>
        {onSyncImmo&&!mod.immoBlank&&(mod.bakBlank||!mod.immoSynced)&&<div style={{marginTop:8}}>
          <button onClick={onSyncImmo} style={{padding:'8px 14px',border:'2px solid '+C.a1+'55',borderRadius:8,background:'transparent',color:C.a1,fontWeight:800,fontSize:11,cursor:'pointer',fontFamily:"'Nunito'",letterSpacing:.5}}>🔄 Sync IMMO primary → backup</button>
        </div>}
      </Card>

      {mod.partialVins?.length>0&&<Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a1,marginBottom:8,letterSpacing:1.5}}>🔢 PARTIAL VINs (last 8 chars)</div>
        {mod.partialVins.map((p,i)=><Row key={i} label={fO(p.offset)}>
          <span style={{fontWeight:700,color:C.a1}}>…{p.tail}</span>{' '}
          <Tag color={p.crcOk?C.gn:C.er}>CRC16 {p.crcOk?'✓':'✗'}</Tag>
          <span style={{color:C.tm,marginLeft:6}}>stored=0x{p.storedCrc.toString(16).toUpperCase().padStart(4,'0')} calc=0x{p.calcCrc.toString(16).toUpperCase().padStart(4,'0')}</span>
        </Row>)}
      </Card>}

      {mod.immoKeys?.length>0&&<Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a1,marginBottom:8,letterSpacing:1.5}}>🗝️ IMMO KEY SLOTS</div>
        {mod.immoKeys.map((k,i)=><Row key={i} label={'Slot '+(i+1)+' @'+fO(k.offset)}><Hex>{k.hex}</Hex></Row>)}
      </Card>}
    </>}

    {/* 95640 -------------------------------------------------------------- */}
    {mod.type==='95640'&&<Card style={{marginBottom:12,padding:14}}>
      <div style={{fontWeight:800,fontSize:11,color:C.a4,marginBottom:8,letterSpacing:1.5}}>💾 95640 FIELDS</div>
      <Row label="Secret key @0x0040"><Hex muted={mod.skb}>{hxArr(mod.skey)}</Hex> <Tag color={mod.skb?C.wn:C.gn}>{mod.skb?'ERASED':'SET'}</Tag></Row>
      <Row label="Fob block @0x0200"><Tag color={mod.fobBlank?C.tm:C.gn}>{mod.fobBlank?'BLANK':'HAS FOBS'}</Tag></Row>
      {mod.bcmSec16&&<Row label="BCM-SEC16 @0x0838">
        {mod.bcmSec16.blank?<Tag color={C.wn}>BLANK</Tag>:<>
          <Hex>{mod.bcmSec16.hex}</Hex>{' '}
          <Tag color={mod.bcmSec16.csOk?C.gn:C.er}>CRC16 {mod.bcmSec16.csOk?'✓':'✗'}</Tag>
        </>}
      </Row>}
    </Card>}
  </div>;
}

export {Row,Hex};
