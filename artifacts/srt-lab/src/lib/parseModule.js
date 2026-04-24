import {crc16,crc8rf,rfhGen2VinCs,rfhGen2DetectMagic,rfhSec16Cs} from './crc.js';
import {TC,TL,SKIM_VALUES,IMMO_REC,IMMO_KC,IMMO_BLOCK,SKIM_OFF} from './constants.js';

const fO=n=>"0x"+n.toString(16).toUpperCase().padStart(4,"0");

function countSkimRecs(d,base){let c=0;for(let i=0;i<IMMO_KC;i++){const o=base+i*IMMO_REC;if(o+IMMO_REC>d.length)break;const r=d.slice(o,o+IMMO_REC);if(!r.every(b=>b===0xFF||b===0x00))c++;}return c;}
function syncImmoBackup(d){if(d.length<0x40C0+IMMO_BLOCK||d.length<0x2000+IMMO_BLOCK)return null;const o=new Uint8Array(d);for(let i=0;i<IMMO_BLOCK;i++)o[0x2000+i]=o[0x40C0+i];return o;}

function extractVIN(data,offset,len){if(!len)len=17;if(offset+len>data.length)return null;const bytes=data.slice(offset,offset+len);for(let i=0;i<bytes.length;i++){if(bytes[i]<0x30||bytes[i]>0x5a)return null;}return String.fromCharCode.apply(null,bytes);}
function extractHex(data,offset,len){if(offset+len>data.length)return null;const r=[];for(let i=0;i<len;i++){r.push(data[offset+i].toString(16).padStart(2,"0").toUpperCase());}return r.join(" ");}
function arrEq(a,b){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
function rd32(data,o){if(o<0||o+4>data.length)return null;return(data[o]<<24)|(data[o+1]<<16)|(data[o+2]<<8)|data[o+3];}
function countAA50(d,s,n){let c=0;for(let i=0;i<n;i++)if(d[s+i*2]===0xaa&&d[s+i*2+1]===0x50)c++;return c;}
function countPat(d,a,b,c2,d2){let c=0;for(let i=0;i<d.length-3;i++)if(d[i]===a&&d[i+1]===b&&d[i+2]===c2&&d[i+3]===d2)c++;return c;}

// Canonical EEPROM/flash sizes per module type (in bytes). Captures from the
// real world are sometimes padded (oversized) or truncated; we detect that
// against this table and surface a warning so the user knows the dump is
// non-standard rather than silently parsing potentially-corrupted regions.
const CANONICAL_SIZES_BY_TYPE={
  BCM:[65536,131072],
  '95640':[8192],
  GPEC2A:[4096,8192],
  RFHUB:[2048,4096],
};

// PCM EXT-EEPROM chip catalog (Task #379). The same Continental GPEC2A
// firmware ships with either a 95320 (4 KB) or 95640 (8 KB) external
// EEPROM depending on the PCM hardware revision — not by engine
// displacement. Single source of truth used by:
//   - the inspector chip badge (Sincro PcmCard, Gpec2aTab),
//   - the SYNC-time size-mismatch guard,
//   - the wizard virgin auto-pick,
//   - the KEYPROG bundler's --pcm-chip flag and output-name suffix.
// `chipKey` is the lower-case short form used on CLI / filenames
// (e.g. `4kb`, `8kb`); `label` is the human-readable badge text.
const PCM_CHIPS=[
  {chip:'95320',sizeBytes:4096,chipKey:'4kb',label:'95320 · 4 KB',sizeLabel:'4 KB'},
  {chip:'95640',sizeBytes:8192,chipKey:'8kb',label:'95640 · 8 KB',sizeLabel:'8 KB'},
];

// Resolve a PCM chip descriptor from a buffer length. Returns null when
// the size doesn't match any known PCM chip — callers should treat that
// as "unknown chip, surface size and let the user decide."
function pcmChipFromSize(sizeBytes){
  if(sizeBytes==null)return null;
  return PCM_CHIPS.find(c=>c.sizeBytes===sizeBytes)||null;
}

// Resolve a PCM chip descriptor from a `--pcm-chip` style key
// (case-insensitive, accepts `4kb`/`8kb` or the chip number `95320`/`95640`).
function pcmChipFromKey(key){
  if(!key)return null;
  const k=String(key).toLowerCase();
  return PCM_CHIPS.find(c=>c.chipKey===k||c.chip===k)||null;
}

/* Task #396 — single source of truth for "is this PCM SEC6 byte slice
 * actually populated, or is it just FF padding noise that happens to
 * look like a 6-byte secret?". Pre-#396 both the parseModule.js path
 * and the engParsePcm path used `bytes.every(b===0xFF)` which let a
 * single stray non-FF byte (e.g. the real-world `FF FF 00 FF FF FF`
 * that surfaced on a 4 KB GPEC2A virgin) slip through as "✓ Populated"
 * — so the Mismatch Wizard reported "Found 0 errors" on a virgin PCM
 * and the in-app AI told the user "safe to program a key". This
 * classifier is exported and consumed from BOTH parsers + the
 * crossValidate gate so they cannot drift again. */
function classifyPcmSec6(bytes){
  if(!bytes||bytes.length!==6){
    return{populated:false,blank:false,damaged:true,allFF:false,allZero:false,nonFF:0,label:'MISSING'};
  }
  let ffCount=0,zeroCount=0;
  for(let i=0;i<6;i++){if(bytes[i]===0xFF)ffCount++;if(bytes[i]===0x00)zeroCount++;}
  const allFF=ffCount===6;
  const allZero=zeroCount===6;
  const nonFF=6-ffCount;
  // virgin: all-FF, all-zero, OR mostly-FF (≥4 of 6 are FF, i.e. nonFF<=2).
  // populated: ≥3 non-FF bytes AND not all-zero.
  const populated=nonFF>=3&&!allZero;
  let label;
  if(allFF)label='Virgin (all FF)';
  else if(allZero)label='Virgin (all 00)';
  else if(!populated)label='Virgin (mostly FF)';
  else label='\u2713 Populated';
  return{populated,blank:allFF||allZero,damaged:!populated,allFF,allZero,nonFF,label};
}

// Minimum byte size for any file we will treat as a real BCM dump. Files
// smaller than this are EEPROM slices, fragments, or wrong-module dumps —
// not a usable MPC5605B/06B DFLASH image. Single source of truth for the
// BCM size guard used by parseModule + ModuleSync (Task #370).
const BCM_MIN_SIZE=Math.min(...CANONICAL_SIZES_BY_TYPE.BCM);

// Per-module canonical-minimum sizes derived from CANONICAL_SIZES_BY_TYPE.
// Files smaller than these are EEPROM slices, fragments, or wrong-module
// dumps; the inspector should refuse them with a structured "isn't a full
// <module> dump" card rather than partial-parse and surface fake VIN /
// security verdicts. 'PCM' aliases GPEC2A so callers using the ModuleSync
// PCM slot label resolve to the same 4 KB floor (Task #372).
const MODULE_MIN_SIZES={
  BCM:Math.min(...CANONICAL_SIZES_BY_TYPE.BCM),
  RFHUB:Math.min(...CANONICAL_SIZES_BY_TYPE.RFHUB),
  GPEC2A:Math.min(...CANONICAL_SIZES_BY_TYPE.GPEC2A),
  PCM:Math.min(...CANONICAL_SIZES_BY_TYPE.GPEC2A),
  '95640':Math.min(...CANONICAL_SIZES_BY_TYPE['95640']),
};

// Human-readable hint shown in the "Required min" line of each tooSmall
// card so techs know what kind of dump the slot actually expects.
const MODULE_MIN_LABELS={
  BCM:'64 KB MPC5605B/06B DFLASH',
  RFHUB:'2 KB Yazaki FCM EEPROM (Gen1 24C16)',
  GPEC2A:'4 KB Continental GPEC2A',
  PCM:'4 KB Continental GPEC2A (smallest PCM image)',
  '95640':'8 KB BCM-backup EEPROM (95640)',
};

function fileExt(filename){
  if(!filename)return '';
  const m=String(filename).match(/\.([A-Za-z0-9]+)$/);
  return m?'.'+m[1].toLowerCase():'';
}

// Generic per-type size guard (Task #372). Returns null when the buffer is
// at or above the canonical minimum, or a structured tooSmall object the
// inspector / standalone tab can render directly.
function moduleTooSmall(bytes,type,filename){
  const min=MODULE_MIN_SIZES[type];
  if(min==null)return null;
  const sz=bytes?bytes.length:0;
  if(sz>=min)return null;
  return{tooSmall:true,type,size:sz,min,ext:fileExt(filename),label:MODULE_MIN_LABELS[type]||type};
}

// BCM-specific shim — preserves the Task #370 result shape (no `type`/`label`
// keys) so existing callers and tests stay green.
function bcmTooSmall(bytes,filename){
  const sz=bytes?bytes.length:0;
  if(sz>=BCM_MIN_SIZE)return null;
  return{tooSmall:true,size:sz,min:BCM_MIN_SIZE,ext:fileExt(filename)};
}

// Slot-aware module type detection used by every workspace upload entry
// point (DumpsTabV2 slot uploads + the shared `loadF` that backs the
// Samples Library and any future tab). Slot context wins, then explicit
// PCM filename hints, then `typeFromFilename`, then `parseModule`'s
// size/signature fallback. Centralized here so the upload-time size
// guard stays consistent regardless of which tab triggered the upload
// (Task #376).
function detectModuleType(bytes,name,slotType){
  if(slotType)return slotType;
  const u=(name||'').toUpperCase();
  if(/(?:^|[^A-Z])PCM(?:[^A-Z]|$)/.test(u))return'PCM';
  const fn=typeFromFilename(name);
  if(fn)return fn;
  try{const p=parseModule(bytes,name);return p&&p.type?p.type:null;}
  catch{return null;}
}

function typeFromFilename(name){
  if(!name)return null;
  const u=String(name).toUpperCase();
  if(/GPEC/.test(u))return'GPEC2A';
  if(/RFH/.test(u))return'RFHUB';
  if(/95640/.test(u))return'95640';
  if(/\bBCM\b|DFLASH/.test(u))return'BCM';
  return null;
}

function buildSizeWarn(type,sz){
  const canonical=CANONICAL_SIZES_BY_TYPE[type];
  if(!canonical||canonical.includes(sz))return null;
  // Pick the closest canonical size as the "expected" reference so the user
  // sees a sensible expected vs got pair (e.g. 384 KB vs 4 KB, not 64 KB).
  let expected=canonical[0];
  let bestDist=Math.abs(sz-expected);
  for(const c of canonical){const d=Math.abs(sz-c);if(d<bestDist){bestDist=d;expected=c;}}
  const causes=[];
  const kind=sz>expected?'oversized':'truncated';
  if(kind==='oversized'){
    if(sz%expected===0&&sz/expected>=2)causes.push('Padded capture: file is '+(sz/expected)+'× the expected size — the dumper read past the EEPROM and filled the rest with 0xFF/0x00.');
    else causes.push('Padded capture: extra bytes were appended by the dumper after the real module image.');
    causes.push('Only the first '+expected.toLocaleString()+' bytes are the real '+type+' image — the trailing region is not part of the module.');
    causes.push('Re-dump with the read length set to the module\u2019s real EEPROM size to clean it up.');
  }else{
    causes.push('Truncated dump: the dumper stopped before reading the full module.');
    causes.push('Some fields past offset 0x'+sz.toString(16).toUpperCase()+' will be missing or read as padding.');
    causes.push('Re-dump using the full read length so no bytes are missed.');
  }
  return{
    actual:sz,
    expected,
    kind,
    actualLabel:sz.toLocaleString()+' B',
    expectedLabel:expected.toLocaleString()+' B',
    message:'Unusual size: got '+sz.toLocaleString()+' B, expected '+expected.toLocaleString()+' B for '+type+'.',
    causes,
  };
}

// Content sanity check: do the BCM-defining structures look populated?
// Used as a tiebreaker when the file size matches BCM (64 KB / 128 KB) but
// the filename explicitly names a non-BCM module type. Real BCMs have either
// VINs at the canonical 0x5320..0x5380 slots OR a structured immo block at
// 0x40C0; padded GPEC2A/95640 captures have neither.
function looksLikeRealBcm(data){
  if(data.length<0x5400)return false;
  for(const base of [0x5320,0x5340,0x5360,0x5380]){
    if(extractVIN(data,base)||extractVIN(data,base+8))return true;
  }
  for(let i=0;i<8;i++){
    const o=0x40C0+i*24;
    if(o+24>data.length)break;
    let nonblank=0;
    for(let j=0;j<24;j++)if(data[o+j]!==0xFF&&data[o+j]!==0)nonblank++;
    if(nonblank>2)return true;
  }
  return false;
}

// Content sanity check for a 64 KB / 128 KB capture that was auto-detected
// as BCM purely on size. Returns a warn object describing why the content
// does NOT look like a real BCM (no VINs in the canonical 0x5320..0x5380
// slots, no immo records at 0x40C0 or backup at 0x2000), or null when at
// least one BCM-defining structure is populated. Used to flag oversized
// GPEC2A / 95640 captures that collide with the BCM size and would
// otherwise be silently parsed as BCMs and surface garbage in the BCM panel.
function buildBcmContentWarn(data){
  if(data.length!==65536&&data.length!==131072)return null;
  const sz=data.length;
  // 1. VIN slot scan — both layouts (base+0 legacy, base+8 Redeye 2020+).
  let vinHits=0;
  for(const base of[0x5320,0x5340,0x5360,0x5380]){
    if(extractVIN(data,base)||extractVIN(data,base+8))vinHits++;
  }
  // 2. Immo record scan — at least one populated 24-byte slot in the
  //    primary (0x40C0) or backup (0x2000) bank.
  const hasImmo=(base)=>{
    if(base+IMMO_BLOCK>sz)return false;
    for(let i=0;i<IMMO_KC;i++){
      const o=base+i*IMMO_REC;
      let nonblank=0;
      for(let j=0;j<IMMO_REC;j++)if(data[o+j]!==0xFF&&data[o+j]!==0)nonblank++;
      if(nonblank>2)return true;
    }
    return false;
  };
  const immoPrimary=hasImmo(0x40C0);
  const immoBackup=hasImmo(0x2000);
  // 3. Partial-VIN scan at 0x4098 / 0x40B0 — 8 ASCII chars + CRC16.
  let partialHits=0;
  for(const po of[0x4098,0x40B0]){
    if(po+10>sz)continue;
    let s='',ok=true;
    for(let j=0;j<8;j++){const b=data[po+j];if(b<0x20||b>0x7E){ok=false;break;}s+=String.fromCharCode(b);}
    if(ok&&s.length===8)partialHits++;
  }
  if(vinHits>0||immoPrimary||immoBackup||partialHits>0)return null;
  return{
    kind:'maybe-not-bcm',
    sizeLabel:sz.toLocaleString()+' B',
    message:'This '+sz.toLocaleString()+'-byte capture has no BCM-defining content — it may not actually be a BCM dump.',
    causes:[
      'No VINs found at the canonical BCM slots (0x5320, 0x5340, 0x5360, 0x5380).',
      'No partial VINs found at 0x4098 / 0x40B0.',
      'IMMO record bank at 0x40C0 and backup bank at 0x2000 are both blank.',
      'If this is an oversized GPEC2A capture (real size 4 KB), re-load it through the GPEC2A tab.',
      'If this is an oversized 95640 capture (real size 8 KB), re-load it through the 95640 tab.',
      'A blank/virgin BCM is also possible — confirm with the source ECU before writing.',
    ],
  };
}

function detectBySignature(data){
  const sz=data.length;
  if(sz>=4096&&sz<=20480){
    const b0=data[0],b1=data[1];
    const classMarker=data[0x10];
    const hasTcmMarker=(b0===0x00&&b1===0x00)||(b0===0xFF&&b1===0xFF);
    const tcmClass=classMarker>=0x01&&classMarker<=0x08;
    let has55AA=false;for(let i=0;i<Math.min(32,sz-1);i++)if(data[i]===0x55&&data[i+1]===0xAA){has55AA=true;break;}
    const hasA5=data[2]===0xA5||data[3]===0xA5||data[4]===0xA5;
    if((hasTcmMarker&&tcmClass)||(has55AA&&tcmClass)||(hasA5&&tcmClass))return'TCM';
  }
  if(sz>=1024&&sz<=10240){
    const tipmVariant=data[0x04]===0x36||data[0x04]===0x80||data[0x04]===0x81||data[0x04]===0x3C;
    let aaCount=0;for(let i=0;i<Math.min(16,sz);i++)if(data[i]===0xAA)aaCount++;
    const hasAaPattern=aaCount>=4;
    const tipmHeader=(data[0]===0x00&&data[1]===0x00)||(data[0]===0xFF&&data[1]===0xFF);
    if(tipmVariant&&(hasAaPattern||tipmHeader))return'TIPM';
  }
  return'UNKNOWN';
}

/* ----------------------------------------------------------------------------
 * BCM SEC16 resolver (Task #380)
 *
 * On real synced Redeye BCM dumps the canonical SEC16 does NOT live at the
 * flat little-endian slice 0x40C9..0x40D9 — that legacy field holds residual
 * garbage. The live SEC16 is instead written into:
 *   1. Three "split" records at 0x81A0 / 0x81C0 / 0x81E0
 *      (header FF FF 00 00 00 00 00 00, idx 01/02, prefix7@+9, sep
 *       04 04 00 14 @+16, suffix9@+20, trailer 7F/8F @+29).
 *      SEC16 = prefix7 ++ suffix9 (16 B).
 *   2. Mirror1 record (slot 0xEB / size 0x18) in the inactive bank
 *      (header 00 00 00 18 00 46 EB 00, idx@+8, SEC16@+9..+25).
 *   3. Mirror2 record (slot 0xCA / size 0x28) in the inactive bank
 *      (header 00 00 00 28 00 46 CA 00, idx@+8, SEC16@+9..+25).
 *   4. Legacy flat slice at 0x40C9 (kept as last-ditch fallback for
 *      pre-Redeye / non-split-record dumps).
 *
 * Inactive bank = the lower of the two FEE seq values at 0x0002 / 0x4002
 * (higher seq = active). Returns the chosen 16-byte secret + provenance so
 * callers can describe the source in audits / VERIFY reports without having
 * to re-implement the lookup.
 * ---------------------------------------------------------------------------- */
function resolveBcmSec16(data){
  const sz=data.length;
  const candidates={split:null,mirror1:null,mirror2:null,flat:null};
  let inactiveBase=null;
  /* -- split records (0x81A0/C0/E0) -- */
  if(sz>=0x8200){
    const splitOffs=[0x81A0,0x81C0,0x81E0];
    const reads=[];
    for(const off of splitOffs){
      const hdrFFok=data[off]===0xFF&&data[off+1]===0xFF;
      let hdrZeroOk=true;for(let j=2;j<8;j++)if(data[off+j]!==0x00){hdrZeroOk=false;break;}
      const idx=data[off+8];
      const idxOk=idx===0x01||idx===0x02;
      const sepOk=data[off+16]===0x04&&data[off+17]===0x04&&data[off+18]===0x00&&data[off+19]===0x14;
      if(!hdrFFok||!hdrZeroOk||!idxOk||!sepOk)continue;
      const sec=new Uint8Array(16);
      for(let k=0;k<7;k++)sec[k]=data[off+9+k];
      for(let k=0;k<9;k++)sec[7+k]=data[off+20+k];
      reads.push({offset:off,bytes:sec});
    }
    if(reads.length>0){
      const first=reads[0].bytes;
      const allSame=reads.every(r=>arrEq(r.bytes,first));
      const blank=first.every(b=>b===0xFF||b===0x00);
      candidates.split={offset:reads[0].offset,bytes:first,blank,records:reads,consistent:allSame};
    }
  }
  /* -- mirror records in inactive bank -- */
  if(sz>=0x4004){
    const bank0Seq=(data[0x0002]<<8)|data[0x0003];
    const bank1Seq=(data[0x4002]<<8)|data[0x4003];
    inactiveBase=bank0Seq>=bank1Seq?0x4000:0x0000;
    const findRec=(base,slotType,sizeByte)=>{
      const end=Math.min(sz,base+0x4000)-8;
      for(let i=base;i<end;i++){
        if(data[i]===0x00&&data[i+1]===0x00&&data[i+2]===0x00&&data[i+3]===sizeByte&&
           data[i+4]===0x00&&data[i+5]===0x46&&data[i+6]===slotType&&data[i+7]===0x00)return i;
      }
      return -1;
    };
    const m1=findRec(inactiveBase,0xEB,0x18);
    if(m1>=0&&m1+25<=sz){
      const idx=data[m1+8];
      const sec=data.slice(m1+9,m1+25);
      const blank=Array.from(sec).every(b=>b===0xFF||b===0x00);
      candidates.mirror1={offset:m1,bytes:new Uint8Array(sec),blank,idx};
    }
    const m2=findRec(inactiveBase,0xCA,0x28);
    if(m2>=0&&m2+25<=sz){
      const idx=data[m2+8];
      const sec=data.slice(m2+9,m2+25);
      const blank=Array.from(sec).every(b=>b===0xFF||b===0x00);
      candidates.mirror2={offset:m2,bytes:new Uint8Array(sec),blank,idx};
    }
  }
  /* -- legacy flat slice at 0x40C9 -- */
  if(sz>=0x40D9){
    const sec=data.slice(0x40C9,0x40D9);
    const blank=Array.from(sec).every(b=>b===0xFF||b===0x00);
    candidates.flat={offset:0x40C9,bytes:new Uint8Array(sec),blank};
  }
  /* -- pick winner: prefer the first non-blank candidate in priority order -- */
  let chosen=null,source=null;
  for(const key of ['split','mirror1','mirror2','flat']){
    const c=candidates[key];
    if(c&&!c.blank){chosen=c;source=key;break;}
  }
  /* If everything is blank but at least the flat slice exists, surface it
   * (so legacy tabs that read .bytes still have a value), and report blank. */
  const allBlank=
    (!candidates.split||candidates.split.blank)&&
    (!candidates.mirror1||candidates.mirror1.blank)&&
    (!candidates.mirror2||candidates.mirror2.blank)&&
    (!candidates.flat||candidates.flat.blank);
  if(!chosen){
    chosen=candidates.flat||candidates.split||candidates.mirror1||candidates.mirror2||null;
    if(chosen)source=allBlank?(candidates.split?'split':candidates.mirror1?'mirror1':candidates.mirror2?'mirror2':'flat'):source;
  }
  return{
    bytes:chosen?new Uint8Array(chosen.bytes):null,
    offset:chosen?chosen.offset:null,
    source:chosen?source:null,
    inactiveBase,
    candidates,
    blank:allBlank,
  };
}

function parseModule(data,filename,opts){
  const sz=data.length;let type='UNKNOWN';
  const forceType=opts&&opts.forceType;
  if(sz===65536||sz===131072){type='BCM';}
  else if(sz===8192||sz===16384){
    const sig=detectBySignature(data);
    type=sig!=='UNKNOWN'?sig:'95640';
  }
  else if(sz===4096){
    const sig4=detectBySignature(data);
    if(sig4!=='UNKNOWN'){type=sig4;}
    else{let va=true;for(let i=0;i<17&&i<sz;i++){const b=data[i];if(!((b>=0x30&&b<=0x39)||(b>=0x41&&b<=0x5A))){va=false;break;}}type=va?'GPEC2A':'RFHUB';}
  }
  // Gen1 RFHUB (24C16, 2048 B): older Cherokee/etc. RFH key-fob hubs. The
  // 2 KB image has no Gen2 0xEA5+ VIN slots (out of range) — VIN lives at
  // 0x92 and SEC16 at 0x00AE/0x00C0. Classify here so the wizard can drive
  // these older vehicles instead of bailing out as UNKNOWN. TIPM signature
  // wins (it overlaps the 1024-10240 detection window).
  else if(sz===2048){const sig=detectBySignature(data);type=sig!=='UNKNOWN'?sig:'RFHUB';}
  else if(sz>131072)type='FW';
  if(type==='UNKNOWN'){
    const CANONICAL_SIZES=[65536,131072,8192,16384,4096];
    const nearCanonical=CANONICAL_SIZES.some(s=>Math.abs(sz-s)<=4096&&sz!==s);
    if(nearCanonical||sz>=512){const sig=detectBySignature(data);if(sig!=='UNKNOWN')type=sig;}
  }
  // Filename hint is conservative — filenames in the wild are unreliable
  // (e.g. a virgin BCM may carry "RFHUB" in its name). We allow override in
  // three scenarios:
  //   1. Generic FW bucket (sz>128 KB) — anything is better than "FW".
  //   2. Size matches BCM (64 KB / 128 KB) but filename explicitly names a
  //      non-BCM type (GPEC2A or 95640) AND the file lacks BCM-defining
  //      content (no VINs in slots, no immo block) — handles padded
  //      GPEC2A/95640 captures that collide with the BCM size.
  // 8 KB files are intentionally NOT reclassified by filename: the
  // keyProgWizard treats 8 KB "doubled PCM" captures as 95640 first and
  // then reparses the first half as GPEC2A. Tabs that need GPEC2A behavior
  // for an 8 KB file should pass {forceType:'GPEC2A'}.
  const fnType=typeFromFilename(filename);
  if(fnType&&fnType!==type){
    if(type==='FW')type=fnType;
    else if(type==='BCM'&&(fnType==='GPEC2A'||fnType==='95640')&&!looksLikeRealBcm(data))type=fnType;
  }
  // Tab context (Gpec2aTab, BcmTab, etc.) can force a type when the user
  // explicitly loads a file under a known module type even if the size is
  // non-canonical. The size warning will then explain the discrepancy.
  if(forceType&&CANONICAL_SIZES_BY_TYPE[forceType])type=forceType;

  const info={type,filename,data,size:sz,name:TL[type]||type,color:TC[type]||'#9E9E9E'};
  info.sizeWarn=buildSizeWarn(type,sz);
  info.contentWarn=type==='BCM'?buildBcmContentWarn(data):null;
  if(type==='UNKNOWN')info.hexOnly=true;

  if(type==='GPEC2A'){
    info.vins=[{offset:0x0000,vin:extractVIN(data,0x0000)},{offset:0x01f0,vin:extractVIN(data,0x01f0)},{offset:0x0224,vin:extractVIN(data,0x0224)},{offset:0x0ce0,vin:extractVIN(data,0x0ce0)}].filter(v=>v.vin);
    if(sz>0x0011){
      info.skimByte=data[0x0011];
      info.skimStatus=SKIM_VALUES[info.skimByte]||"UNKNOWN (0x"+info.skimByte.toString(16).toUpperCase()+")";
    }else{
      info.skimByte=null;
      info.skimStatus=null;
    }
    info.secretKey=sz>=0x020b?{offset:0x0203,bytes:data.slice(0x0203,0x020b),hex:extractHex(data,0x0203,8)}:null;
    info.secretKeyMirror=sz>=0x0369?{offset:0x0361,bytes:data.slice(0x0361,0x0369),hex:extractHex(data,0x0361,8)}:null;
    info.keyConsistent=sz>=0x0369?arrEq(data.slice(0x0203,0x020b),data.slice(0x0361,0x0369)):null;
    info.skey=sz>=0x020b?data.slice(0x0203,0x020b):new Uint8Array(0);info.skoff=0x0203;info.skmoff=0x0361;info.skb=info.skey.every(b=>b===0xFF);
    info.transponderKeys=[];
    for(let i=0;i<4;i++){const o=0x0888+i*4;info.transponderKeys.push({offset:o,hex:o+4<=sz?extractHex(data,o,4):null});}
    info.zzzzTamper=sz>=0x0c94?{offset:0x0c8c,hex:extractHex(data,0x0c8c,8),intact:data[0x0c8c]===0x5a}:null;
    info.partNumberStr=sz>=0x0fae?(extractVIN(data,0x0fa1,13)||extractHex(data,0x0fa1,13)):null;
    info.runtimeCounters={
      counterA:sz>=0x0e65?{offset:0x0e61,value:rd32(data,0x0e61),hex:extractHex(data,0x0e61,4)}:null,
      counterB:sz>=0x0e6d?{offset:0x0e69,value:rd32(data,0x0e69),hex:extractHex(data,0x0e69,4)}:null,
      distance:sz>=0x0e71?{offset:0x0e6d,value:rd32(data,0x0e6d),hex:extractHex(data,0x0e6d,4)}:null,
      keyCycles:sz>=0x0e79?{offset:0x0e75,value:rd32(data,0x0e75),hex:extractHex(data,0x0e75,4)}:null,
    };
    if(sz>=0x3CE){
      const s6=data.slice(0x3C8,0x3CE);
      const marker=data.slice(0x3C4,0x3C8);
      const markerOk=marker[0]===0xFF&&marker[1]===0xFF&&marker[2]===0xFF&&marker[3]===0xAA;
      // Task #396 — share the classifier with engParsePcm so a mostly-FF
      // SEC6 (e.g. FF FF 00 FF FF FF on a 4 KB virgin) is correctly tagged
      // as IMMO_DAMAGED instead of slipping through as "SET".
      // Task #404 — also gate on the canonical FF FF FF AA marker at 0x3C4.
      // External tools (CGDI/Autel/AlfaOBD/SINCRO) and the PCM bootloader
      // itself ignore the 6 secret bytes when the marker is missing, so a
      // populated SEC6 + missing marker is effectively unpaired.
      const cls=classifyPcmSec6(s6);
      const populated=cls.populated&&markerOk;
      const damaged=!populated;
      info.pcmSec6={offset:0x3C8,raw:s6,hex:extractHex(data,0x3C8,6),
        markerOffset:0x3C4,markerHex:extractHex(data,0x3C4,4),markerOk,
        blank:cls.blank,damaged,populated,
        immoState:populated?'SET':'IMMO_DAMAGED',classification:cls};
    }
  }else if(type==='RFHUB'){
    const knownOffsets=[0x0ea5,0x0eb9,0x0ecd,0x0ee1];
    // Gen2 (24C32, 4096 B): VINs stored byte-reversed; CS = rfhGen2VinCs (XOR^0x87)
    // Gen1 (24C16, 2048 B): VINs stored plain or mirrored; CS = crc8rf
    const rfhIsGen2=sz===4096;
    if(rfhIsGen2){
      info.vins=[];
      // auto-detect VIN CS magic (0xDB=2020+ Redeye, 0x87=older Gen2)
      let rfhMagic=0xDB;
      for(const _o of knownOffsets){const _st=data.slice(_o,_o+17);const _sc=_o+17<sz?data[_o+17]:0;if(!_st.every(b=>b===0xFF||b===0)&&_sc!==0x00&&_sc!==0xFF){rfhMagic=rfhGen2DetectMagic(_st,_sc);break;}}
      for(const o of knownOffsets){if(o+17>sz)continue;const st=data.slice(o,o+17);if(st.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=st[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);if(!/^[1-9A-HJ-NPR-Z]/.test(s))continue;const sc=o+17<sz?data[o+17]:0,cc=rfhGen2VinCs(st,rfhMagic);info.vins.push({offset:o,vin:s,mirrored:true,sc,cc,crcOk:sc===cc});}
    }else{
      const knownVins=knownOffsets.map(o=>{const v=extractVIN(data,o);if(v)return{offset:o,vin:v,mirrored:false,sc:o+17<sz?data[o+17]:0,cc:crc8rf(data.slice(o,o+17)),crcOk:o+17<sz&&data[o+17]===crc8rf(data.slice(o,o+17))};return null;}).filter(v=>v);
      if(knownVins.length>0)info.vins=knownVins;
      else{info.vins=[];for(const o of knownOffsets){if(o+17>sz)continue;const st=data.slice(o,o+17);if(st.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=st[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);if(/^[1-9A-HJ-NPR-Z]/.test(s)){const sc=o+17<sz?data[o+17]:0,cc=crc8rf(st);info.vins.push({offset:o,vin:s,mirrored:true,sc,cc,crcOk:sc===cc});}}}
    }
    if(data.length>=0x051e)info.vehicleSecret={offset:0x050e,bytes:data.slice(0x050e,0x051e),hex:extractHex(data,0x050e,16),endian:"big"};
    // AA-50 occupancy markers: Gen2 @ 0x0880, Gen1 @ 0x00D2 (Task #409).
    info.fobikSlots=sz===2048?countAA50(data,0x00D2,4):countAA50(data,0x0880,10);
    info.securityMarkers=countPat(data,0xcc,0x66,0xaa,0x55);
    info.zzzzBlocks=countPat(data,0x5a,0x5a,0x5a,0x5a);
    info.partNumbers={};
    const hw=extractVIN(data,0x0808,10),sw=extractVIN(data,0x0812,10),cal=extractVIN(data,0x082c,14);
    if(hw)info.partNumbers.hw=hw;else if(data.length>=0x0812)info.partNumbers.hw=extractHex(data,0x0808,10);
    if(sw)info.partNumbers.sw=sw;else if(data.length>=0x081c)info.partNumbers.sw=extractHex(data,0x0812,10);
    if(cal)info.partNumbers.cal=cal;else if(data.length>=0x083a)info.partNumbers.cal=extractHex(data,0x082c,14);
    info.skey=data.slice(0x40,0x50);info.skoff=0x40;info.skb=info.skey.every(b=>b===0xFF);
    if(sz>=0x92+19){
      const raw17=data.slice(0x92,0x92+17);
      const notBlank=!raw17.every(b=>b===0xFF||b===0x00);
      if(notBlank){let s='';for(let i=0;i<17;i++)s+=String.fromCharCode(raw17[i]);
        const sc=(data[0x92+17]<<8)|data[0x92+18];const cc=crc16(raw17);
        if(/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s)){
          info.rfhVin92={offset:0x92,vin:s,storedCs:sc,calcCs:cc,csOk:sc===cc};
          // Gen1 (2 KB) RFHUB stores its VIN here — the 0xEA5+ slot table
          // is past the end of a 24C16 image, so this is the only VIN the
          // module carries. Surface it through info.vins so the Key Prog
          // wizard's "RFH already carries target VIN" check can see it.
          if(sz===2048&&info.vins.length===0)
            info.vins.push({offset:0x92,vin:s,sc,cc,crcOk:sc===cc,algo:'c16'});
        }
      }
    }
    info.sec16s=[];
    // Gen2 (24C32 4096 B, or 8192 B unusual): SEC16 at 0x050E / 0x0522
    // Gen1 (24C16, 2048 B): SEC16 at 0x00AE / 0x00C0
    const sec16IsGen2=sz===4096||sz===8192;
    const sec16Offsets=sec16IsGen2?[[1,0x050E],[2,0x0522]]:[[1,0xAE],[2,0xC0]];
    for(const[slot,off]of sec16Offsets){
      if(off+18>sz)continue;
      const raw=data.slice(off,off+16);
      const cs=(data[off+16]<<8)|data[off+17];
      const blank=raw.every(b=>b===0xFF||b===0x00);
      const hex=Array.from(raw).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
      // CS = rfhSec16Cs ((crc8_65 << 8) | 0x00) on both Gen1 and Gen2
      // (Task #409 confirmed Gen1 uses the same formula).
      const csCalc=rfhSec16Cs(raw);
      const csOk=cs===csCalc;
      // BCM-endian (derived): byte-reversed version of the 16 raw bytes
      const bcmHex=Array.from(raw).reverse().map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
      info.sec16s.push({slot,offset:off,raw,hex,cs,csCalc,csOk,bcmHex,blank});
    }
    if(info.sec16s.length===2){
      info.sec16match=arrEq(Array.from(info.sec16s[0].raw),Array.from(info.sec16s[1].raw));
      // Both Gen1 and Gen2 require slot 1 CS to be valid (Task #409
      // confirmed Gen1's CS formula matches Gen2's).
      info.sec16valid=!info.sec16s[0].blank&&info.sec16match&&!!info.sec16s[0].csOk;
    }
    info.sec16SourceSlot=1;
    info.rfhGen=sz===4096?'Gen2 (24C32)':sz===8192?'Gen2-x2 (8192B, unusual)':sz===2048?'Gen1 (24C16)':'Unknown';
  }else if(type==='BCM'){
    // Scan canonical slot bases at both base+0 (legacy/no-header layout) and
    // base+8 (Redeye 2020+ layout: 8-byte FEE record header → 17-byte VIN →
    // 2-byte BE CRC16 → 5-byte trailer). Whichever yields a valid 17-byte
    // VIN is the slot's true VIN offset, so writers can target it precisely
    // without clobbering the header or trailer.
    info.vins=[];
    // Prefer the candidate (base+8 vs base+0) whose stored BE16 CRC at
    // vinOff+17/+18 matches crc16(vin). This keeps a corrupted/mid-erase
    // dump from picking a coincidental ASCII run at the wrong offset and
    // misrouting a subsequent VIN write. Fall back to a CRC-less accept
    // (base+8 first, then base+0) when neither candidate has a valid CRC,
    // so legacy fixtures without trailing CRCs keep parsing.
    const crcAt=(off)=>{if(off+19>sz)return null;return(data[off+17]<<8)|data[off+18];};
    for(const base of[0x5320,0x5340,0x5360,0x5380]){
      const v8=extractVIN(data,base+8);
      const v0=extractVIN(data,base);
      const c8=v8?crcAt(base+8):null;
      const c0=v0?crcAt(base):null;
      const ok8=v8&&c8!==null&&c8===crc16(data.slice(base+8,base+8+17));
      const ok0=v0&&c0!==null&&c0===crc16(data.slice(base,base+17));
      if(ok8){info.vins.push({offset:base+8,vin:v8,slotBase:base,headerBytes:8,crcOk:true});continue;}
      if(ok0){info.vins.push({offset:base,vin:v0,slotBase:base,headerBytes:0,crcOk:true});continue;}
      if(v8){info.vins.push({offset:base+8,vin:v8,slotBase:base,headerBytes:8,crcOk:false});continue;}
      if(v0){info.vins.push({offset:base,vin:v0,slotBase:base,headerBytes:0,crcOk:false});}
    }
    info.partialVins=[];
    for(const po of[0x4098,0x40B0]){if(po+10>sz)continue;let s='',ok=true;for(let j=0;j<8;j++){const b=data[po+j];if(b<0x20||b>0x7E){ok=false;break;}s+=String.fromCharCode(b);}if(ok&&s.length===8){const sc=(data[po+8]<<8)|data[po+9],cc=crc16(data.slice(po,po+8));info.partialVins.push({offset:po,tail:s,storedCrc:sc,calcCrc:cc,crcOk:sc===cc});}}
    /* BCM SEC16 — resolved from split / mirror / flat (Task #380). The legacy
     * flat slice at 0x40C9 holds residual garbage on synced Redeye dumps; the
     * resolver consults the FEE-record table and falls back to the flat slice
     * only when no record-table source is populated. `info.vehicleSecret`
     * stays populated for backwards compatibility (callers like crossValidate
     * / Key Prog wizard read .bytes / .hex), and `info.bcmSec16` exposes the
     * full provenance (source, candidates, inactiveBase, blank flag). */
    info.bcmSec16=resolveBcmSec16(data);
    if(info.bcmSec16.bytes){
      const off=info.bcmSec16.offset;
      const endian=info.bcmSec16.source==='flat'?'little':'big';
      info.vehicleSecret={
        offset:off,
        bytes:info.bcmSec16.bytes,
        hex:Array.from(info.bcmSec16.bytes).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(' '),
        endian,
        source:info.bcmSec16.source,
        blank:info.bcmSec16.blank,
      };
    }else{
      info.vehicleSecret=null;
    }
    info.securityLock=sz>0x8028?{offset:0x8028,value:data[0x8028],locked:data[0x8028]===0x5a}:null;
    info.fobikCount=sz>0x5862?data[0x5862]:null;
    info.immoKeys=[0x81a4,0x81c4,0x81e4].map(o=>({offset:o,hex:extractHex(data,o,16)}));
    info.fobikParts=extractVIN(data,0x5818,10)||extractHex(data,0x5818,10);
    info.skey=data.slice(0x40c9,0x40d9);info.skoff=0x40c9;info.skb=info.skey.every(b=>b===0xFF);info.skEndian='little';
    info.immoRecs=countSkimRecs(data,0x40C0);info.immoBlank=info.immoRecs===0;
    info.bakRecs=countSkimRecs(data,0x2000);info.bakBlank=info.bakRecs===0;
    info.immoSynced=info.immoRecs>0&&info.bakRecs>0&&arrEq(data.slice(0x40C0,0x40C0+IMMO_BLOCK),data.slice(0x2000,0x2000+IMMO_BLOCK));
  }else if(type==='95640'){
    info.vins=[];
    for(const off of[0x275,0x288]){const v=extractVIN(data,off);if(v)info.vins.push({offset:off,vin:v});}
    if(sz>=0x1B95){const v=extractVIN(data,0x1B82);if(v)info.vins.push({offset:0x1B82,vin:v});}
    info.skey=data.slice(0x40,0x50);info.skoff=0x40;info.skb=info.skey.every(b=>b===0xFF);
    info.fobBlank=data.slice(0x200,0x240).every(b=>b===0xFF);
    if(sz>=0x84A){
      const raw16=data.slice(0x838,0x848);
      const storedCs=(data[0x848]<<8)|data[0x849];
      const calcCs=crc16(raw16);
      const csOk=storedCs===calcCs;
      const blank=raw16.every(b=>b===0xFF||b===0x00);
      const hex=Array.from(raw16).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
      const reversed=new Uint8Array(16);for(let i=0;i<16;i++)reversed[i]=raw16[15-i];
      const reversedHex=Array.from(reversed).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
      info.bcmSec16={offset:0x838,raw:raw16,hex,reversed,reversedHex,storedCs,calcCs,csOk,blank};
    }
  }

  return info;
}

export {parseModule,countSkimRecs,syncImmoBackup,extractVIN,extractHex,arrEq,detectBySignature,fO,rd32,buildSizeWarn,typeFromFilename,CANONICAL_SIZES_BY_TYPE,looksLikeRealBcm,buildBcmContentWarn,BCM_MIN_SIZE,bcmTooSmall,MODULE_MIN_SIZES,MODULE_MIN_LABELS,moduleTooSmall,detectModuleType,PCM_CHIPS,pcmChipFromSize,pcmChipFromKey,resolveBcmSec16,classifyPcmSec6};
