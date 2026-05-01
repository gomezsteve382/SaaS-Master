import React from "react";
import {Card,Tag} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {formatBcmSec16SourceLabel} from "../lib/sec16SourceLabel.js";
import {fmtOff} from "../tabs/ModuleSync.jsx";

const hxArr=a=>Array.from(a).map(b=>b.toString(16).toUpperCase().padStart(2,"0")).join(" ");
/* Task #470 — local `fO` helper retired; `fmtOff` (SINCRO-style
 * "0xHHHH (D)" render) is now shared with the rest of the analyzer
 * tabs so techs see one consistent offset grammar. */

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
   Used as an embedded "Module File Inspector" in BCM / RFHUB / GPEC2A
   tabs. Read-only. */
export function SizeWarnBanner({warn}){
  if(!warn)return null;
  const isOver=warn.kind==='oversized';
  return <Card style={{marginBottom:12,padding:12,border:'1px solid '+C.wn+'66',background:C.wn+'14'}}>
    <div style={{fontWeight:800,fontSize:12,color:C.wn,marginBottom:4,letterSpacing:.5}}>⚠ {isOver?'OVERSIZED':'TRUNCATED'} CAPTURE — {warn.message}</div>
    <div style={{fontSize:11,color:C.tx,lineHeight:1.45,marginBottom:6}}>
      The bytes {isOver?'past offset 0x'+warn.expected.toString(16).toUpperCase()+' are not part of the module image':'past offset 0x'+warn.actual.toString(16).toUpperCase()+' are missing from this capture'}.
      The app is parsing the file from offset 0, which usually still works, but the dump is non-standard.
    </div>
    <ul style={{margin:'4px 0 0 18px',padding:0,fontSize:11,color:C.tx,lineHeight:1.5}}>
      {warn.causes.map((c,i)=><li key={i}>{c}</li>)}
    </ul>
  </Card>;
}

// Renders the "this file doesn't look like a real <family>" banner. Fires
// when a capture was auto-detected as <family> purely on size / signature
// but has none of that family's defining structures — i.e. the kind of
// padded / blank capture that would otherwise surface garbage in the
// per-family panel.
//
// Originally added for 64 KB / 128 KB BCM mis-classifications (Task #527 /
// Task #538). Task #542 generalized the banner to also serve the 4 KB
// family (GPEC2A / RFHUB), which share an image size and so suffer the
// mirror failure mode: a padded GPEC2A or a virgin RFHUB classified as the
// other family used to silently render fake VIN / SKIM / FOBIK output.
// `warn.family` selects the headline / body text; legacy callers without
// a family field default to 'BCM' for backwards compatibility.
export function ContentWarnBanner({warn}){
  if(!warn)return null;
  const family=warn.family||'BCM';
  return <Card style={{marginBottom:12,padding:12,border:'1px solid '+C.wn+'66',background:C.wn+'14'}}>
    <div style={{fontWeight:800,fontSize:12,color:C.wn,marginBottom:4,letterSpacing:.5}}>⚠ DOESN'T LOOK LIKE A {family} — {warn.message}</div>
    <div style={{fontSize:11,color:C.tx,lineHeight:1.45,marginBottom:6}}>
      The file is being parsed as a {family} because it is {warn.sizeLabel} (the same size as a real {family} image),
      but none of the {family}-defining structures are present. The fields below may be misleading.
    </div>
    <ul style={{margin:'4px 0 0 18px',padding:0,fontSize:11,color:C.tx,lineHeight:1.5}}>
      {warn.causes.map((c,i)=><li key={i}>{c}</li>)}
    </ul>
  </Card>;
}

export default function ModuleFieldsPanel({mod,onSyncImmo}){
  if(!mod||mod.type==='UNKNOWN')return <div style={{fontSize:11,color:C.tm,padding:10}}>
    {mod&&mod.sizeWarn&&<SizeWarnBanner warn={mod.sizeWarn}/>}
    Unknown module type — no enriched fields available.
  </div>;

  return <div>
    <SizeWarnBanner warn={mod.sizeWarn}/>
    <ContentWarnBanner warn={mod.contentWarn}/>
    {/* GPEC2A ------------------------------------------------------------- */}
    {mod.type==='GPEC2A'&&(()=>{
      const rc=mod.runtimeCounters||{};
      const tks=mod.transponderKeys||[];
      const sz=mod.size;
      const missing=[];
      if(mod.skimByte==null)missing.push({n:'SKIM byte @0x0011',need:0x12});
      if(!mod.secretKey)missing.push({n:'secret key @0x0203',need:0x020B});
      if(!mod.secretKeyMirror)missing.push({n:'key mirror @0x0361',need:0x0369});
      if(!mod.zzzzTamper)missing.push({n:'ZZZZ tamper @0x0C8C',need:0x0C94});
      if(!mod.pcmSec6)missing.push({n:'PCM SEC6 @0x03C8',need:0x03CE});
      if(!mod.partNumberStr)missing.push({n:'part number @0x0FA1',need:0x0FAE});
      if(!rc.counterA)missing.push({n:'runtime counter A @0x0E61',need:0x0E65});
      if(!rc.counterB)missing.push({n:'runtime counter B @0x0E69',need:0x0E6D});
      if(!rc.distance)missing.push({n:'runtime distance @0x0E6D',need:0x0E71});
      if(!rc.keyCycles)missing.push({n:'runtime keyCycles @0x0E75',need:0x0E79});
      tks.forEach((k,i)=>{if(k.hex==null)missing.push({n:`transponder key ${i+1} @${fmtOff(k.offset)}`,need:k.offset+4});});
      const undersized=missing.length>0;
      const Missing=({need})=><span title={need!=null?`needs ${need.toLocaleString()} bytes, got ${sz.toLocaleString()}`:undefined} style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.wn,fontWeight:700}}>buffer too small{need!=null?` (needs ${need.toLocaleString()} B, got ${sz.toLocaleString()})`:''}</span>;
      return <>
      {undersized&&<Card style={{marginBottom:12,padding:12,border:'1px solid '+C.wn+'66',background:C.wn+'14'}}>
        <div style={{fontWeight:800,fontSize:12,color:C.wn,marginBottom:4,letterSpacing:.5}}>⚠️ FILE TOO SMALL</div>
        <div style={{fontSize:11,color:C.tx,lineHeight:1.4,marginBottom:6}}>
          This dump is only {sz.toLocaleString()} bytes — a full GPEC2A is 4,096 bytes.
          The following region{missing.length===1?'':'s'} could not be read:
        </div>
        <ul style={{margin:'4px 0 0 18px',padding:0,fontSize:11,color:C.tx,lineHeight:1.5}}>
          {missing.map(x=><li key={x.n}><span style={{color:C.wn,fontWeight:700}}>{x.n}</span> <span style={{color:C.tm}}>— needs {x.need.toLocaleString()} B, got {sz.toLocaleString()}</span></li>)}
        </ul>
      </Card>}
      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:8,letterSpacing:1.5}}>⚙️ GPEC2A SECURITY</div>
        <Row label="SKIM byte @0x0011">{mod.skimByte!=null?<>
          <Tag color={mod.skimByte===0x80?C.gn:C.wn}>{mod.skimStatus}</Tag>
          <span style={{marginLeft:6,color:C.tm}}>0x{mod.skimByte.toString(16).toUpperCase().padStart(2,'0')}</span>
        </>:<Missing need={0x12}/>}</Row>
        <Row label="Secret key @0x0203">{mod.secretKey?<Hex muted={mod.skb}>{mod.secretKey.hex}</Hex>:<Missing need={0x020B}/>}</Row>
        <Row label="Mirror @0x0361">{mod.secretKeyMirror?<><Hex muted={mod.skb}>{mod.secretKeyMirror.hex}</Hex>{' '}<Tag color={mod.keyConsistent?C.gn:C.er}>{mod.keyConsistent?'MATCH':'MISMATCH'}</Tag></>:<Missing need={0x0369}/>}</Row>
        <Row label="ZZZZ tamper @0x0C8C">{mod.zzzzTamper?<>
          <Tag color={mod.zzzzTamper.intact?C.gn:C.er}>{mod.zzzzTamper.intact?'INTACT':'CLEARED'}</Tag>
          <span style={{marginLeft:6,fontSize:10,color:C.ts}}>{mod.zzzzTamper.hex}</span>
        </>:<Missing need={0x0C94}/>}</Row>
        <Row label="PCM marker @0x03C4">{mod.pcmSec6?<>
          <Hex muted={!mod.pcmSec6.markerOk}>{mod.pcmSec6.markerHex}</Hex>{' '}
          <Tag color={mod.pcmSec6.markerOk?C.gn:C.er}>{mod.pcmSec6.markerOk?'✓ FF FF FF AA':'✗ MISSING'}</Tag>
        </>:<Missing need={0x03C8}/>}</Row>
        <Row label="PCM SEC6 @0x03C8">{mod.pcmSec6?<>
          <Hex muted={mod.pcmSec6.blank}>{mod.pcmSec6.hex}</Hex>{' '}
          <Tag color={mod.pcmSec6.damaged?C.er:C.gn}>{mod.pcmSec6.immoState}</Tag>
        </>:<Missing need={0x03CE}/>}</Row>
        {mod.pcmSec6&&!mod.pcmSec6.markerOk&&!mod.pcmSec6.blank&&mod.pcmSec6.classification?.populated&&
          <div style={{gridColumn:'1 / -1',marginTop:6,padding:'8px 10px',borderRadius:8,background:C.er+'14',border:'1px solid '+C.er+'55',fontSize:11,color:C.tx,lineHeight:1.45}}>
            <span style={{color:C.er,fontWeight:800}}>⚠ Secret bytes present but marker missing</span> — the 6 SEC bytes look populated, but the canonical <span style={{fontFamily:"'JetBrains Mono'",fontWeight:700}}>FF FF FF AA</span> marker @ 0x03C4 is absent, so the PCM bootloader still treats this dump as IMMO_DAMAGED. Apply a BCM→PCM SEC6 sync to restamp the marker.
          </div>}
        <Row label="Part number @0x0FA1">{mod.partNumberStr||<Missing need={0x0FAE}/>}</Row>
      </Card>

      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:8,letterSpacing:1.5}}>🔐 TRANSPONDER KEYS @0x0888</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          {tks.map((k,i)=>{
            const unread=k.hex==null;
            const blank=!unread&&Array.from(k.hex.split(' ').map(h=>parseInt(h,16))).every(b=>b===0xFF||b===0);
            const need=k.offset+4;
            return <div key={i} style={{padding:8,borderRadius:8,background:C.c2,border:'1px solid '+(unread?C.wn+'66':blank?C.bd:C.gn+'40'),textAlign:'center'}}>
              <div style={{fontSize:9,color:C.tm,fontWeight:700}}>KEY {i+1} · {fmtOff(k.offset)}</div>
              <div title={unread?`needs ${need.toLocaleString()} bytes, got ${sz.toLocaleString()}`:undefined} style={{fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:700,color:unread?C.wn:blank?'#D5D0C8':C.a4,marginTop:3}}>{unread?'buffer too small':k.hex}</div>
              {unread&&<div style={{fontSize:8,color:C.tm,marginTop:2}}>needs {need.toLocaleString()} B · got {sz.toLocaleString()}</div>}
              <Tag color={unread?C.wn:blank?C.tm:C.gn}>{unread?'N/A':blank?'—':'SET'}</Tag>
            </div>;
          })}
        </div>
      </Card>

      <Card style={{marginBottom:12,padding:14}}>
        <div style={{fontWeight:800,fontSize:11,color:C.a2,marginBottom:8,letterSpacing:1.5}}>📊 RUNTIME COUNTERS</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          {[
            {n:'Counter A',c:rc.counterA,need:0x0E65},
            {n:'Counter B',c:rc.counterB,need:0x0E6D},
            {n:'Distance',c:rc.distance,need:0x0E71},
            {n:'Key cycles',c:rc.keyCycles,need:0x0E79},
          ].map(x=>{
            if(!x.c)return <div key={x.n} title={`needs ${x.need.toLocaleString()} bytes, got ${sz.toLocaleString()}`} style={{padding:8,borderRadius:8,background:C.c2,border:'1px solid '+C.wn+'66',textAlign:'center'}}>
              <div style={{fontSize:9,color:C.tm}}>{x.n}</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.wn,marginTop:6}}>buffer too small</div>
              <div style={{fontSize:8,color:C.tm,marginTop:2}}>needs {x.need.toLocaleString()} B · got {sz.toLocaleString()}</div>
            </div>;
            const v=(x.c.value>>>0);
            return <div key={x.n} style={{padding:8,borderRadius:8,background:C.c2,border:'1px solid '+C.bd,textAlign:'center'}}>
              <div style={{fontSize:9,color:C.tm}}>{x.n}</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:C.a1,marginTop:2}}>{v.toLocaleString()}</div>
              <div style={{fontSize:8,color:C.tm}}>{fmtOff(x.c.offset)} · {x.c.hex}</div>
            </div>;
          })}
        </div>
      </Card>
    </>;})()}

    {/* RFHUB -------------------------------------------------------------- */}
    {mod.type==='RFHUB'&&(()=>{
      const rfhSz=mod.size;
      const rfhMissing=[];
      const vin92Missing=!mod.rfhVin92&&rfhSz<0xA5;
      const hwMissing=!mod.partNumbers.hw&&rfhSz<0x0812;
      const swMissing=!mod.partNumbers.sw&&rfhSz<0x081C;
      const calMissing=!mod.partNumbers.cal&&rfhSz<0x083A;
      const vsMissing=!mod.vehicleSecret&&rfhSz<0x051E;
      if(vin92Missing)rfhMissing.push({n:'rfhVin92 @0x0092',need:0xA5});
      if(hwMissing)rfhMissing.push({n:'partNumber HW @0x0808',need:0x0812});
      if(swMissing)rfhMissing.push({n:'partNumber SW @0x0812',need:0x081C});
      if(calMissing)rfhMissing.push({n:'partNumber CAL @0x082C',need:0x083A});
      if(vsMissing)rfhMissing.push({n:'vehicleSecret @0x050E',need:0x051E});
      // sec16: default to Gen2 layout (matches parser when sz===4096||sz===8192, and is the
      // typical truncated-dump case since type==='RFHUB' is set when sz===4096)
      const sec16IsGen2=rfhSz===4096||rfhSz===8192||rfhSz<2048;
      const expectedSec16=sec16IsGen2?[[1,0x050E,0x0520],[2,0x0522,0x0534]]:[[1,0xAE,0xC0],[2,0xC0,0xD2]];
      const sec16MissingSlots=[];
      for(const[slot,off,need]of expectedSec16){
        if(rfhSz<need&&!(mod.sec16s||[]).find(s=>s.slot===slot)){
          rfhMissing.push({n:`sec16s slot${slot} @${fmtOff(off)}`,need});
          sec16MissingSlots.push({slot,offset:off,need});
        }
      }
      const rfhUndersized=rfhMissing.length>0;
      const RfhMissing=({need})=><span title={`needs ${need.toLocaleString()} bytes, got ${rfhSz.toLocaleString()}`} style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.wn,fontWeight:700}}>buffer too small (needs {need.toLocaleString()} B, got {rfhSz.toLocaleString()})</span>;
      return <>
      {rfhUndersized&&<Card style={{marginBottom:12,padding:12,border:'1px solid '+C.wn+'66',background:C.wn+'14'}}>
        <div style={{fontWeight:800,fontSize:12,color:C.wn,marginBottom:4,letterSpacing:.5}}>⚠️ FILE TOO SMALL</div>
        <div style={{fontSize:11,color:C.tx,lineHeight:1.4,marginBottom:6}}>
          This dump is only {rfhSz.toLocaleString()} bytes — a full RFHUB is 4,096 bytes (Gen2) or 2,048 bytes (Gen1).
          The following region{rfhMissing.length===1?'':'s'} could not be read:
        </div>
        <ul style={{margin:'4px 0 0 18px',padding:0,fontSize:11,color:C.tx,lineHeight:1.5}}>
          {rfhMissing.map(x=><li key={x.n}><span style={{color:C.wn,fontWeight:700}}>{x.n}</span> <span style={{color:C.tm}}>— needs {x.need.toLocaleString()} B, got {rfhSz.toLocaleString()}</span></li>)}
        </ul>
      </Card>}
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
          </div>:vin92Missing?<div title={`needs ${(0xA5).toLocaleString()} bytes, got ${rfhSz.toLocaleString()}`} style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+C.wn+'66'}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>VIN @0x0092</div>
            <div style={{fontSize:18,fontWeight:900,color:C.wn,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>buffer too small</div>
            <div style={{fontSize:10,color:C.tm,marginTop:4}}>needs {(0xA5).toLocaleString()} B · got {rfhSz.toLocaleString()}</div>
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

      {(mod.vehicleSecret||vsMissing)&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔐 Vehicle Secret @0x050E</div>
        <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+(vsMissing?C.wn+'66':C.bd)}}>
          {mod.vehicleSecret?<Hex muted={mod.vehicleSecret.bytes.every(b=>b===0xFF||b===0)}>{mod.vehicleSecret.hex}</Hex>:<RfhMissing need={0x051E}/>}
        </div>
      </Card>}

      {(mod.sec16s?.length>0||sec16MissingSlots.length>0)&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔒 SEC16 Slots</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          {(mod.sec16s||[]).map(s=><div key={'p'+s.slot} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+(s.blank?C.bd:s.csOk===false?C.er+'40':C.gn+'40')}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <span style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:1}}>SLOT {s.slot} · {fmtOff(s.offset)}</span>
              {s.blank?<Tag color={C.tm}>BLANK</Tag>:s.csOk!==undefined&&<Tag color={s.csOk?C.gn:C.er}>CS {s.csOk?'✓':'✗'}</Tag>}
            </div>
            {!s.blank&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.a4,wordBreak:'break-all'}}>{s.hex}</div>}
          </div>)}
          {sec16MissingSlots.map(s=><div key={'m'+s.slot} title={`needs ${s.need.toLocaleString()} bytes, got ${rfhSz.toLocaleString()}`} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.wn+'66'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <span style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:1}}>SLOT {s.slot} · {fmtOff(s.offset)}</span>
              <Tag color={C.wn}>N/A</Tag>
            </div>
            <RfhMissing need={s.need}/>
          </div>)}
        </div>
        {mod.sec16match!==undefined&&<div style={{marginTop:8}}>
          <Tag color={mod.sec16valid?C.gn:C.wn}>{mod.sec16valid?'SEC16 VALID — slots match':'SEC16 mismatch / blank'}</Tag>
        </div>}
      </Card>}

      {(mod.partNumbers.hw||mod.partNumbers.sw||mod.partNumbers.cal||hwMissing||swMissing||calMissing)&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🏷️ Part Numbers</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
          {[
            {l:'HW',o:0x0808,v:mod.partNumbers.hw,miss:hwMissing,need:0x0812},
            {l:'SW',o:0x0812,v:mod.partNumbers.sw,miss:swMissing,need:0x081C},
            {l:'CAL',o:0x082C,v:mod.partNumbers.cal,miss:calMissing,need:0x083A},
          ].map(p=>p.v?<div key={p.l} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
            <div style={{fontSize:10,color:C.tm,marginBottom:4}}>{p.l} @{fmtOff(p.o)}</div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:800,color:C.a3,letterSpacing:1}}>{p.v}</div>
          </div>:p.miss?<div key={p.l} title={`needs ${p.need.toLocaleString()} bytes, got ${rfhSz.toLocaleString()}`} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.wn+'66'}}>
            <div style={{fontSize:10,color:C.tm,marginBottom:4}}>{p.l} @{fmtOff(p.o)}</div>
            <RfhMissing need={p.need}/>
          </div>:null)}
        </div>
      </Card>}
    </>;})()}

    {/* BCM ---------------------------------------------------------------- */}
    {mod.type==='BCM'&&(()=>{
      const bcmSz=mod.size;
      const bcmMissing=[];
      if(!mod.securityLock)bcmMissing.push({n:'security lock @0x8028',need:0x8029});
      if(mod.fobikCount==null)bcmMissing.push({n:'FOBIK count @0x5862',need:0x5863});
      const bcmUndersized=bcmMissing.length>0;
      return <>
      {bcmUndersized&&<Card style={{marginBottom:12,padding:12,border:'1px solid '+C.wn+'66',background:C.wn+'14'}}>
        <div style={{fontWeight:800,fontSize:12,color:C.wn,marginBottom:4,letterSpacing:.5}}>⚠️ FILE TOO SMALL</div>
        <div style={{fontSize:11,color:C.tx,lineHeight:1.4,marginBottom:6}}>
          This dump is only {bcmSz.toLocaleString()} bytes — a full BCM is 65,536 or 131,072 bytes.
          The following region{bcmMissing.length===1?'':'s'} could not be read:
        </div>
        <ul style={{margin:'4px 0 0 18px',padding:0,fontSize:11,color:C.tx,lineHeight:1.5}}>
          {bcmMissing.map(x=><li key={x.n}><span style={{color:C.wn,fontWeight:700}}>{x.n}</span> <span style={{color:C.tm}}>— needs {x.need.toLocaleString()} B, got {bcmSz.toLocaleString()}</span></li>)}
        </ul>
      </Card>}
      <Card glow style={{marginBottom:14}}>
        <div style={{fontSize:16,fontWeight:900,marginBottom:12}}>🧠 BCM Analysis</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          {mod.securityLock?<div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+(mod.securityLock.locked?C.gn+'40':C.wn+'40')}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>SECURITY LOCK @0x8028</div>
            <div style={{fontSize:28,fontWeight:900,color:mod.securityLock.locked?C.gn:C.wn,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>{mod.securityLock.locked?'LOCKED':'UNLOCKED'}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:4}}>0x{mod.securityLock.value.toString(16).toUpperCase().padStart(2,'0')} {mod.securityLock.locked?'(0x5A)':''}</div>
          </div>:<div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+C.wn+'66'}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>SECURITY LOCK @0x8028</div>
            <div style={{fontSize:18,fontWeight:900,color:C.wn,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>buffer too small</div>
            <div style={{fontSize:10,color:C.tm,marginTop:4}}>needs {(0x8029).toLocaleString()} B · got {bcmSz.toLocaleString()}</div>
          </div>}
          {mod.fobikCount!=null?<div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+C.a1+'40'}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>FOBIK COUNT @0x5862</div>
            <div style={{fontSize:28,fontWeight:900,color:C.a1,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>{mod.fobikCount}</div>
            <div style={{fontSize:10,color:C.tm,marginTop:4}}>{mod.fobikParts||'—'}</div>
          </div>:<div style={{padding:16,borderRadius:12,background:C.c2,border:'1px solid '+C.wn+'66'}}>
            <div style={{fontSize:11,fontWeight:800,color:C.tm,marginBottom:6,letterSpacing:1.5}}>FOBIK COUNT @0x5862</div>
            <div style={{fontSize:18,fontWeight:900,color:C.wn,fontFamily:"'JetBrains Mono'",lineHeight:1.1}}>buffer too small</div>
            <div style={{fontSize:10,color:C.tm,marginTop:4}}>needs {(0x5863).toLocaleString()} B · got {bcmSz.toLocaleString()}</div>
          </div>}
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

      {(mod.vehicleSecret||mod.bcmSec16)&&(()=>{
        /* Task #381 — surface SEC16 provenance (split/mirror1/mirror2/flat) and
         * a clear BLANK / virgin badge so operators can see at a glance which
         * record the resolver picked, instead of a bare "@0x40C9 (LE)" header
         * that always implied the legacy flat slice. */
        const res=mod.bcmSec16;
        const src=res?.source;
        const blank=!!res?.blank;
        /* Task #471 — share the provenance label with MismatchWizard and the
         * Key Prog wizard via the canonical helper. Falls back to '(no SEC16
         * source)' when bcmSec16 exists with no recognised source. */
        const srcLabel=formatBcmSec16SourceLabel(res)||'unresolved';
        const endian=mod.vehicleSecret?.endian||(src==='flat'?'little':'big');
        return <Card style={{marginBottom:14,padding:16}}>
          <div style={{fontSize:13,fontWeight:800,marginBottom:10,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <span>🔑 BCM SEC16 / Vehicle Secret</span>
            <Tag color={blank?C.wn:src==='flat'?C.wn:C.gn}>{srcLabel}</Tag>
            {blank&&<Tag color={C.wn}>BLANK / virgin</Tag>}
            <span style={{fontSize:10,color:C.tm,fontWeight:600}}>({endian.toUpperCase()})</span>
          </div>
          {blank?(
            <div style={{padding:10,borderRadius:8,background:C.wn+'10',border:'1px solid '+C.wn+'40',fontSize:11,color:C.tx,lineHeight:1.5}}>
              Every SEC16 candidate (split records @0x81A0/C0/E0, mirror1 0xEB, mirror2 0xCA,
              flat @0x40C9) is all 0xFF/0x00. This BCM has never been paired to a vehicle —
              the Key Prog wizard will refuse to derive a shared secret from it.
            </div>
          ):mod.vehicleSecret?(
            <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd}}>
              <Hex muted={mod.skb}>{mod.vehicleSecret.hex}</Hex>
            </div>
          ):(
            <div style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+C.bd,fontSize:11,color:C.tm}}>
              SEC16 not resolved.
            </div>
          )}
        </Card>;
      })()}

      {mod.immoKeys?.length>0&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🗝️ SKIM Key Slots</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
          {mod.immoKeys.map((k,i)=>{
            const bytes=k.hex.split(' ').map(h=>parseInt(h,16));
            const blank=bytes.every(b=>b===0xFF||b===0);
            return <div key={i} style={{padding:10,borderRadius:8,background:C.c2,border:'1px solid '+(blank?C.bd:C.gn+'40'),textAlign:'center'}}>
              <div style={{fontSize:10,fontWeight:800,color:C.tm}}>SLOT {i+1}</div>
              <div style={{fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:700,color:blank?'#D5D0C8':C.a4,marginTop:4,wordBreak:'break-all'}}>{k.hex}</div>
              <div style={{fontSize:9,color:C.tm,marginTop:2}}>{fmtOff(k.offset)}</div>
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
              <span style={{fontSize:10,fontWeight:800,color:C.tm,letterSpacing:1}}>{fmtOff(p.offset)}</span>
              <Tag color={p.crcOk?C.gn:C.er}>CRC16 {p.crcOk?'✓':'✗'}</Tag>
            </div>
            <div style={{fontFamily:"'JetBrains Mono'",fontSize:14,fontWeight:900,color:C.a1,lineHeight:1.1}}>…{p.tail}</div>
            <div style={{fontSize:9,color:C.tm,marginTop:4,fontFamily:"'JetBrains Mono'"}}>stored 0x{p.storedCrc.toString(16).toUpperCase().padStart(4,'0')} · calc 0x{p.calcCrc.toString(16).toUpperCase().padStart(4,'0')}</div>
          </div>)}
        </div>
      </Card>}
    </>;})()}

    {/* 95640 -------------------------------------------------------------- */}
    {mod.type==='95640'&&(()=>{
      const eepSz=mod.size;
      const eepMissing=[];
      const sec16Missing=!mod.bcmSec16&&eepSz<0x84A;
      const hasThirdVin=(mod.vins||[]).some(v=>v.offset===0x1B82);
      const vin3Missing=!hasThirdVin&&eepSz<0x1B95;
      if(sec16Missing)eepMissing.push({n:'bcmSec16 @0x0838',need:0x84A});
      if(vin3Missing)eepMissing.push({n:'VIN slot 3 @0x1B82',need:0x1B95});
      const eepUndersized=eepMissing.length>0;
      const EepMissing=({need})=><span title={`needs ${need.toLocaleString()} bytes, got ${eepSz.toLocaleString()}`} style={{fontFamily:"'JetBrains Mono'",fontSize:11,color:C.wn,fontWeight:700}}>buffer too small (needs {need.toLocaleString()} B, got {eepSz.toLocaleString()})</span>;
      return <>
      {eepUndersized&&<Card style={{marginBottom:12,padding:12,border:'1px solid '+C.wn+'66',background:C.wn+'14'}}>
        <div style={{fontWeight:800,fontSize:12,color:C.wn,marginBottom:4,letterSpacing:.5}}>⚠️ FILE TOO SMALL</div>
        <div style={{fontSize:11,color:C.tx,lineHeight:1.4,marginBottom:6}}>
          This dump is only {eepSz.toLocaleString()} bytes — a full 95640 is 8,192 bytes.
          The following region{eepMissing.length===1?'':'s'} could not be read:
        </div>
        <ul style={{margin:'4px 0 0 18px',padding:0,fontSize:11,color:C.tx,lineHeight:1.5}}>
          {eepMissing.map(x=><li key={x.n}><span style={{color:C.wn,fontWeight:700}}>{x.n}</span> <span style={{color:C.tm}}>— needs {x.need.toLocaleString()} B, got {eepSz.toLocaleString()}</span></li>)}
        </ul>
      </Card>}
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

      {(mod.bcmSec16||sec16Missing)&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔒 BCM-SEC16 @0x0838</div>
        <div style={{padding:12,borderRadius:10,background:C.c2,border:'1px solid '+(sec16Missing?C.wn+'66':mod.bcmSec16.blank?C.wn+'40':mod.bcmSec16.csOk?C.gn+'40':C.er+'40')}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
            <span style={{fontSize:11,fontWeight:800,color:C.tm,letterSpacing:1.5}}>SEC16 BLOCK</span>
            {sec16Missing?<Tag color={C.wn}>N/A</Tag>:mod.bcmSec16.blank?<Tag color={C.wn}>BLANK</Tag>:<Tag color={mod.bcmSec16.csOk?C.gn:C.er}>CRC16 {mod.bcmSec16.csOk?'✓ VALID':'✗ INVALID'}</Tag>}
          </div>
          {sec16Missing?<EepMissing need={0x84A}/>:!mod.bcmSec16.blank&&<div style={{fontFamily:"'JetBrains Mono'",fontSize:11,fontWeight:700,color:C.a4,wordBreak:'break-all'}}>{mod.bcmSec16.hex}</div>}
        </div>
      </Card>}

      {(hasThirdVin||vin3Missing)&&<Card style={{marginBottom:14,padding:16}}>
        <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>🔢 VIN Slot 3 @0x1B82</div>
        <div style={{padding:12,borderRadius:10,background:C.c2,border:'1px solid '+(vin3Missing?C.wn+'66':C.bd)}}>
          {vin3Missing?<EepMissing need={0x1B95}/>:<span style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:800,color:C.a1}}>{(mod.vins||[]).find(v=>v.offset===0x1B82)?.vin}</span>}
        </div>
      </Card>}
    </>;})()}
  </div>;
}

export {Row,Hex};
