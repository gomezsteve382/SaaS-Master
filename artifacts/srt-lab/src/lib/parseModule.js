import {crc16,crc8rf,rfhGen2VinCs,rfhGen2DetectMagic,rfhSec16Cs,RFH_GEN2_VIN_CS_KNOWN_MAGICS} from './crc.js';
import {isXc2268Rfhub,parseXc2268Image} from './xc2268Rfhub.js';
import {isZf8hpImage,parseZf8hpImage} from './zf8hp.js';
import {TC,TL,SKIM_VALUES,IMMO_REC,IMMO_KC,IMMO_BLOCK,SKIM_OFF} from './constants.js';
import {analyzeCflash} from './cflashAnalyzer.js';
import {BCM_PARTIAL_VIN_OFFSETS,BCM_PARTIAL_VIN_LEN,findBcmPartialVinSlots,BCM_FULL_VIN_BASES_ALT} from './donorLeakScan.js';

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
  // Task #634 — XC2268-class RFHUB internal flash dump is 64 KB; ZF-8HP TCU
  // images are 256 KB / 512 KB / 1 MB depending on variant (845RE / 8HP70 /
  // 8HP90). Listed here so MODULE_MIN_SIZES / MODULE_MIN_LABELS computes a
  // valid floor for the inspector's tooSmall guard.
  XC2268_RFHUB:[65536],
  ZF_8HP_TCU:[262144,524288,1048576],
};

/* Canonical VIN slot offsets per module family — SINGLE SOURCE OF TRUTH.
 *
 * Both the parser (this file) and the anonymizer helper
 * (`scripts/anonymize-real-dump.mjs`) MUST import these constants instead
 * of repeating the literals inline. That way, when a new VIN slot is
 * documented for a module family, updating it here automatically extends
 * scrubbing coverage in lock-step with parsing — no more "scrubber knew
 * about 0x4098 / 0x40B0 but not the freshly-added partial-VIN slot at
 * 0x4118" drift (the failure mode that surfaced as Task #436).
 *
 * BCM_FULL_VIN_BASES:
 *   The 5 documented full-VIN slot bases. Each base holds a 17-byte VIN
 *   at base+0 (legacy layout) OR base+8 (Redeye 2020+ FEE-record
 *   header), with a BE16 CRC16 at vinOff+17/+18. The parser only scans
 *   the inner 4 bases (0x5320..0x5380) because those are the only ones
 *   that have ever held a populated VIN on real captures; the
 *   anonymizer is conservative and scrubs 0x5300 too, in case a future
 *   firmware revision starts populating it.
 * BCM_FULL_VIN_BASES_PARSED: the inner 4 actually scanned by the parser.
 * BCM_PARTIAL_VIN_OFFSETS: the 8-char trailing-serial slots (the field
 *   Task #436 missed).
 * RFH_GEN2_VIN_OFFSETS: the 4 reverse-VIN slots on Gen2 RFHUB (24C32, 4 KB).
 * RFH_GEN1_VIN_OFFSET: the single plain-VIN slot on Gen1 RFHUB (24C16,
 *   2 KB) — the 0xEA5+ Gen2 table is past the end of a 24C16 image.
 * PCM_VIN_OFFSETS_GPEC2A: the 4 plaintext VIN slots that appear in both the
 *   4 KB (95320) and 8 KB (95640) sibling Continental GPEC2A PCM captures.
 *   Per Task #439 / #443 this is the single source of truth; every PCM
 *   read/write call site (parser, ImmoVINTab, ModuleSync, App.jsx,
 *   fileUtils.js, rfhPcmPair.js, scripts/trim-pcm-to-4kb.mjs and the
 *   anonymizer) imports this constant instead of inlining the literal
 *   array (which historically drifted as 3 vs 4 slots and shipped the
 *   donor-VIN-leak bug).
 * EEP95640_VIN_OFFSETS: the 3 plaintext VIN slots in a 95640 BCM-backup
 *   EEPROM dump (8 KB).
 * SGW_VIN_OFFSETS: intentionally EMPTY — DESIGN DECISION, not a TODO
 *   (Task #457). SGW (Secure Gateway, 0x74F req / 0x76F resp on 2018+
 *   FCA) does NOT store the vehicle VIN in any documented flash /
 *   EEPROM slot. **No VIN slot — confirmed by bench trace on dump X =
 *   the cracked OEM Chrysler diagnostic SWF
 *   (`attached_assets/CDA_1776448059516.swf`, the same SWF that
 *   produced the SGW XTEA key per `docs/SGW_XTEA_ALGORITHM.md`).**
 *   The trace is automated in
 *   `src/lib/__tests__/cdaSwfSgwBenchTrace.test.js`: it decompresses
 *   the 8.7 MB AS3 body, asserts the SGW authentication / status /
 *   timeout API surface IS present (so we know we're inspecting the
 *   right binary), and asserts the SGW VIN read/write API surface is
 *   ABSENT across 17 naming-convention variants plus the F190 UDS
 *   DID. The OEM tool exposes no API to write a VIN to the SGW or
 *   read one from it — and three corroborating angles all agree:
 *     1. SGW is an authentication module, not a content module — its
 *        only documented job is the XTEA(32) seed/key dance documented
 *        in `docs/SGW_XTEA_ALGORITHM.md` (stateless block transform
 *        keyed by the firmware-baked 128-bit constant, no VIN-keyed
 *        material anywhere in the derivation). `src/lib/algos.js`
 *        (`xtea_sgw`), `src/lib/sgwAuth.js` (in-memory TTL cache),
 *        and `src/tabs/AutelSgwTab.jsx` (live-bus 27 01/02 dance)
 *        between them touch zero EEPROM bytes.
 *     2. `moduleRegistry.js` declares SGW as kind:'unsupported' with
 *        the note "SGW authenticates other writes; it does not store a
 *        VIN slot. Excluded from Program-All." — single source of
 *        truth used by every Program-All / module-batch flow.
 *     3. The repo's 30+ ECU dumps under `attached_assets/` carry zero
 *        SGW captures (no SGW images surface from the field for the
 *        workflows SRT Lab supports — SGW firmware is signed and not
 *        exposed via UDS reads on Autel/AlfaOBD/Drew Tech tools).
 *   Full rationale + escape hatch: `docs/SGW_VIN_STORAGE.md`.
 *
 *   The constant is still exported so the anonymizer
 *   (`scripts/anonymize-real-dump.mjs`) accepts the `--module sgw`
 *   CLI alias today: with an empty slot table the scrubber is a no-op
 *   and the post-scrub leak guard runs WITHOUT MASKING — any donor-VIN
 *   occurrence anywhere in a hypothetical SGW buffer (audit log,
 *   config table, future firmware revision that started caching VINs)
 *   trips the guard at the exact offset. That fail-loud behavior is
 *   the only way the design decision can be revisited safely: if a
 *   real SGW dump ever surfaces with an embedded VIN, the helper
 *   refuses to write the output and tells the maintainer where to
 *   dig. Until then, the empty array is the correct, intentional state.
 */
const BCM_FULL_VIN_BASES=[0x5300,0x5320,0x5340,0x5360,0x5380];
const BCM_FULL_VIN_BASES_PARSED=[0x5320,0x5340,0x5360,0x5380];
// Task #463 — alternate BCM VIN base zone observed on FCA SINCRO output
// for some Charger BCMs (a smaller-flash MPC5605B-class variant or an
// early-year LX firmware revision keeps the same record layout but
// places the four populated VIN slots at 0x1328 / 0x1348 / 0x1368 /
// 0x1388 instead of 0x5328..0x5388 — same 32-byte stride, same per-
// record header, same trailing CRC16). The parser prefers the canonical
// zone; the alternate zone is consulted only when the canonical zone
// yields zero VINs, so a normal LX BCM (always populated at 0x5320..)
// can never silently switch to the alternate base. We mirror the
// canonical zone's "outer five / inner four" split so the donor-leak
// scrubber covers the leading 0x1300 slot defensively even though no
// captured dump has yet populated it.
// BCM_FULL_VIN_BASES_ALT (Task #463) is the alternate base zone — see line 4
// import. Single source of truth lives in donorLeakScan.js so the in-app
// scrubber, this parser, and the offline anonymizer stay in lock-step. The
// _PARSED variant is the inner 4 bases the parser actually scans (the
// outer base 0x1300, like canonical 0x5300, has historically held no VINs
// in any captured dump and is masked only by the leak scanner as a safety
// margin).
const BCM_FULL_VIN_BASES_ALT_PARSED=BCM_FULL_VIN_BASES_ALT.slice(1);
// BCM_PARTIAL_VIN_OFFSETS is imported from ./donorLeakScan.js (see line 3) —
// the leak-scan module is the single source of truth so the in-app pre-share
// scanner, the anonymizer helper, and the parser all share one constant.
const RFH_GEN2_VIN_OFFSETS=[0x0EA5,0x0EB9,0x0ECD,0x0EE1];
const RFH_GEN1_VIN_OFFSET=0x92;
const PCM_VIN_OFFSETS_GPEC2A=[0x0000,0x01F0,0x0224,0x0CE0];
const EEP95640_VIN_OFFSETS=[0x275,0x288,0x1B82];
const SGW_VIN_OFFSETS=[];

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
  XC2268_RFHUB:Math.min(...CANONICAL_SIZES_BY_TYPE.XC2268_RFHUB),
  ZF_8HP_TCU:Math.min(...CANONICAL_SIZES_BY_TYPE.ZF_8HP_TCU),
};

// Human-readable hint shown in the "Required min" line of each tooSmall
// card so techs know what kind of dump the slot actually expects.
const MODULE_MIN_LABELS={
  BCM:'64 KB MPC5605B/06B DFLASH',
  RFHUB:'2 KB Yazaki FCM EEPROM (Gen1 24C16)',
  GPEC2A:'4 KB Continental GPEC2A',
  PCM:'4 KB Continental GPEC2A (smallest PCM image)',
  '95640':'8 KB BCM-backup EEPROM (95640)',
  XC2268_RFHUB:'64 KB Infineon XC2268 internal flash (2019+ RFHUB)',
  ZF_8HP_TCU:'256 KB / 512 KB / 1 MB ZF-8HP TCU image (845RE / 8HP70 / 8HP90)',
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

// Slot label → canonical module-family key. Mirrors the slot-override map in
// `fileUtils.js#analyzeFile` so the wrong-module guard and the slot-aware
// classifier resolve the same family for a given slot label. PCM is the
// human-friendly slot name; the underlying family is GPEC2A (4 KB / 8 KB
// Continental EXT EEPROM) — a 95640 BCM-backup chip would never be uploaded
// through the PCM slot, so the two families do NOT collide here.
const SLOT_TO_FAMILY={PCM:'GPEC2A',GPEC2A:'GPEC2A',BCM:'BCM',RFHUB:'RFHUB','95640':'95640'};

// Task #484 — wrong-module guard. The slot-aware classifier added in #483
// only flips the type when the buffer size is canonical for the slot's
// family (e.g. 4 KB / 8 KB into the PCM slot). A 64 KB BCM dropped into
// the PCM slot bypassed the slot override (64 KB isn't a canonical PCM
// size) AND the size guard (`moduleTooSmall` only rejects undersized
// files), so the file silently landed in workspace state typed as a BCM.
//
// This guard fires when:
//   1. The slot label resolves to a known module family.
//   2. The buffer size does NOT match any canonical size for that family.
//   3. The buffer size DOES match a canonical size for some OTHER family.
//
// Returns a structured rejection that the upload card renders with a
// "this looks like a <X>, did you mean to drop it in the <X> slot?"
// message — surfaced BEFORE the file is added to workspace state.
//
// Cross-checked cases (covered by upload-time tests):
//   - 64 KB BCM dropped into the PCM slot → detected as BCM
//   - 64 KB BCM dropped into the RFHUB slot → detected as BCM
//   - 8 KB 95640/GPEC2A dropped into the BCM slot → detected as 95640 (8 KB
//     also matches GPEC2A canonically; we list both candidates)
//   - 2 KB Gen1 RFHUB dropped into the PCM slot → detected as RFHUB
//
// The guard is paired with `moduleTooSmall` at the call sites — wrong-module
// runs first so the user gets the more informative message; truly undersized
// or unknown-size buffers fall through to the existing too-small card.
function wrongModuleForSlot(bytes,slotType,filename){
  if(!slotType||!bytes)return null;
  const slotFamily=SLOT_TO_FAMILY[slotType];
  if(!slotFamily)return null;
  const sz=bytes.length;
  const slotCanonical=CANONICAL_SIZES_BY_TYPE[slotFamily];
  // Size matches the slot's family — not a wrong-module mistake.
  if(slotCanonical&&slotCanonical.includes(sz))return null;
  // Find every other family this exact size canonically matches. Header-
  // signature-required families (Task #634: XC2268_RFHUB needs "XC22"/"RFHUB"
  // at 0x0000/0x0010, ZF_8HP_TCU needs "ZF8HP" header) are intentionally
  // excluded from this size-only sweep — including them would make every
  // 64 KB BCM look like an XC2268 candidate, which is a regression in the
  // wrong-module hint quality.
  const HEADER_REQUIRED_TYPES=new Set(['XC2268_RFHUB','ZF_8HP_TCU']);
  const candidates=[];
  for(const type of Object.keys(CANONICAL_SIZES_BY_TYPE)){
    if(type===slotFamily)continue;
    if(HEADER_REQUIRED_TYPES.has(type)){
      // Only surface as a candidate if the buffer actually carries the header.
      if(type==='XC2268_RFHUB'&&isXc2268Rfhub(bytes))candidates.push(type);
      else if(type==='ZF_8HP_TCU'&&isZf8hpImage(bytes))candidates.push(type);
      continue;
    }
    if(CANONICAL_SIZES_BY_TYPE[type].includes(sz))candidates.push(type);
  }
  if(candidates.length===0)return null;
  // Pick the first candidate as the primary "this looks like…" hint.
  // Object.keys preserves insertion order: BCM, 95640, GPEC2A, RFHUB —
  // which gives the most distinctive family priority (e.g. 8 KB into
  // BCM slot surfaces as 95640 first, even though GPEC2A also matches
  // 8 KB canonically).
  const detected=candidates[0];
  return{
    wrongModule:true,
    slotType,
    slotFamily,
    detectedType:detected,
    detectedCandidates:candidates,
    size:sz,
    ext:fileExt(filename),
    slotLabel:MODULE_MIN_LABELS[slotFamily]||slotFamily,
    detectedLabel:MODULE_MIN_LABELS[detected]||detected,
    message:'This '+sz.toLocaleString()+'-byte file looks like a '+detected+' dump, not a '+slotType+'. Did you mean to upload it to the '+detected+' slot?',
  };
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
  // Task #483 — plain "PCM" in the filename means a Continental GPEC2A
  // PCM capture (4 KB 95320 or 8 KB 95640 EXT EEPROM). Without this,
  // an 8 KB file named "..._PCM.bin" would fall through to size-only
  // detection and be misclassified as 95640 (BCM-backup EEPROM), which
  // skips the SYNC ALL MODULES PCM resize path entirely. The
  // word-boundary anchors prevent collisions with "PCMUPGRADE" /
  // "BCMUPGRADE" / sub-strings inside other names.
  if(/(?:^|[^A-Z])PCM(?:[^A-Z]|$)/.test(u))return'GPEC2A';
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
  // Task #463 — accept either VIN base zone (canonical 0x5320..0x5380 or
  // alternate 0x1320..0x1380) so the SINCRO-output Charger BCM variant
  // is recognized as a real BCM during type detection / tiebreaking.
  for(const base of [...BCM_FULL_VIN_BASES_PARSED,...BCM_FULL_VIN_BASES_ALT_PARSED]){
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
  // 1. VIN slot scan — both layouts (base+0 legacy, base+8 Redeye 2020+) and
  //    both base zones (canonical 0x5320..0x5380, alternate 0x1320..0x1380
  //    for the Task #463 Charger SINCRO variant). A hit at either zone
  //    counts as BCM-defining content.
  let vinHits=0;
  for(const base of [...BCM_FULL_VIN_BASES_PARSED,...BCM_FULL_VIN_BASES_ALT_PARSED]){
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
    family:'BCM',
    sizeLabel:sz.toLocaleString()+' B',
    message:'This '+sz.toLocaleString()+'-byte capture has no BCM-defining content — it may not actually be a BCM dump.',
    causes:[
      'No VINs found at the canonical BCM slots (0x5320, 0x5340, 0x5360, 0x5380) or the alternate Charger-SINCRO slots (0x1320, 0x1340, 0x1360, 0x1380).',
      'No partial VINs found at 0x4098 / 0x40B0.',
      'IMMO record bank at 0x40C0 and backup bank at 0x2000 are both blank.',
      'If this is an oversized GPEC2A capture (real size 4 KB), re-load it through the GPEC2A tab.',
      'If this is an oversized 95640 capture (real size 8 KB), re-load it through the 95640 tab.',
      'A blank/virgin BCM is also possible — confirm with the source ECU before writing.',
    ],
  };
}

// Content sanity check for a 4 KB capture that was classified as GPEC2A
// (PCM EEPROM). Returns a warn object describing why the content does NOT
// look like a real GPEC2A — no VINs at the canonical PCM slots, secret
// key + mirror both blank, PCM SEC6 marker missing — or null when at
// least one GPEC2A-defining structure is populated. Mirrors the BCM
// content-sanity check (Task #527/#538) for the 4 KB family: a padded
// GPEC2A capture and a blank RFHUB EEE share the same size, so a
// signature/size-only classification can mis-label one as the other and
// then surface garbage VIN / SKIM / FOBIK verdicts off random padding.
function buildGpecContentWarn(data){
  if(data.length!==4096)return null;
  const sz=data.length;
  // 1. VIN slot scan at canonical PCM_VIN_OFFSETS_GPEC2A.
  let vinHits=0;
  for(const o of PCM_VIN_OFFSETS_GPEC2A){
    if(o+17>sz)continue;
    if(extractVIN(data,o))vinHits++;
  }
  // 2. Secret key at 0x0203 (8 bytes) — non-blank.
  let skNonblank=false;
  if(sz>=0x020B){
    for(let j=0;j<8;j++){const b=data[0x0203+j];if(b!==0xFF&&b!==0x00){skNonblank=true;break;}}
  }
  // 3. Secret key mirror at 0x0361 (8 bytes) — non-blank.
  let skmNonblank=false;
  if(sz>=0x0369){
    for(let j=0;j<8;j++){const b=data[0x0361+j];if(b!==0xFF&&b!==0x00){skmNonblank=true;break;}}
  }
  // 4. PCM SEC6 marker (FF FF FF AA at 0x03C4) AND non-blank SEC6 at 0x03C8.
  let sec6Populated=false;
  if(sz>=0x3CE){
    const markerOk=data[0x3C4]===0xFF&&data[0x3C5]===0xFF&&data[0x3C6]===0xFF&&data[0x3C7]===0xAA;
    if(markerOk){
      for(let j=0;j<6;j++){const b=data[0x3C8+j];if(b!==0xFF&&b!==0x00){sec6Populated=true;break;}}
    }
  }
  if(vinHits>0||skNonblank||skmNonblank||sec6Populated)return null;
  return{
    kind:'maybe-not-gpec2a',
    family:'GPEC2A',
    sizeLabel:sz.toLocaleString()+' B',
    message:'This '+sz.toLocaleString()+'-byte capture has no GPEC2A-defining content — it may not actually be a GPEC2A dump.',
    causes:[
      'No VINs found at the canonical GPEC2A slots (0x0000, 0x01F0, 0x0224, 0x0CE0).',
      'Secret key at 0x0203 and its mirror at 0x0361 are both blank.',
      'PCM SEC6 marker (FF FF FF AA at 0x03C4) is missing or its 6-byte secret at 0x03C8 is blank.',
      'If this is actually an RFHUB capture (also 4 KB), re-load it through the RFHUB tab.',
      'A blank/virgin GPEC2A is also possible — confirm with the source ECU before writing.',
    ],
  };
}

// Content sanity check for a 4 KB capture that was classified as RFHUB
// (Gen2 24C32 EEE). Returns a warn object describing why the content does
// NOT look like a real Gen2 RFHUB — no reverse-encoded VINs at the
// canonical 0x0EA5+ slots, header signature missing at 0x0500, vehicle
// secret + SEC16 mirror both blank, no AA-50 fobik markers — or null
// when at least one RFHUB-defining structure is populated. Mirror of
// buildGpecContentWarn for the RFHUB side of the 4 KB family.
function buildRfhubContentWarn(data){
  if(data.length!==4096)return null;
  const sz=data.length;
  // 1. VIN slot scan at byte-reversed RFH_GEN2_VIN_OFFSETS — at least one
  //    slot decodes to a valid VIN-shaped 17-char string after reversal.
  let vinHits=0;
  for(const o of RFH_GEN2_VIN_OFFSETS){
    if(o+17>sz)continue;
    const st=data.slice(o,o+17);
    if(st.every(b=>b===0xFF||b===0))continue;
    let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(st[16-j]);
    if(/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s))vinHits++;
  }
  // 2. Gen2 RFHUB header signature at 0x0500 = AA 55 31 01.
  const headerOk=sz>=0x0504&&data[0x0500]===0xAA&&data[0x0501]===0x55&&data[0x0502]===0x31&&data[0x0503]===0x01;
  // 3. Vehicle secret / SEC16 slot 1 at 0x050E (16 bytes) — non-blank.
  let sec1Nonblank=false;
  if(sz>=0x051E){
    for(let j=0;j<16;j++){const b=data[0x050E+j];if(b!==0xFF&&b!==0x00){sec1Nonblank=true;break;}}
  }
  // 4. SEC16 slot 2 at 0x0522 (16 bytes) — non-blank.
  let sec2Nonblank=false;
  if(sz>=0x0532){
    for(let j=0;j<16;j++){const b=data[0x0522+j];if(b!==0xFF&&b!==0x00){sec2Nonblank=true;break;}}
  }
  // 5. AA-50 fobik occupancy markers at 0x0880 (Gen2 stride 2, up to 10 slots).
  let aa50Hits=0;
  if(sz>=0x0894){
    for(let i=0;i<10;i++){
      const o=0x0880+i*2;
      if(data[o]===0xAA&&data[o+1]===0x50)aa50Hits++;
    }
  }
  if(vinHits>0||headerOk||sec1Nonblank||sec2Nonblank||aa50Hits>0)return null;
  return{
    kind:'maybe-not-rfhub',
    family:'RFHUB',
    sizeLabel:sz.toLocaleString()+' B',
    message:'This '+sz.toLocaleString()+'-byte capture has no RFHUB-defining content — it may not actually be an RFHUB dump.',
    causes:[
      'No reverse-encoded VINs found at the canonical Gen2 RFHUB slots (0x0EA5, 0x0EB9, 0x0ECD, 0x0EE1).',
      'Gen2 RFHUB header signature (AA 55 31 01 at 0x0500) is missing.',
      'Vehicle secret / SEC16 mirror slots at 0x050E and 0x0522 are both blank.',
      'No AA 50 fobik occupancy markers found at 0x0880.',
      'If this is actually a GPEC2A capture (also 4 KB), re-load it through the GPEC2A tab.',
      'A blank/virgin RFHUB is also possible — confirm with the source ECU before writing.',
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
  /* -- pick winner: prefer the first non-blank candidate in priority order
   * (split → mirror1 → mirror2 → flat). Any candidate that is not
   * structurally blank (all-FF / all-00) is accepted — including low-entropy
   * flat slices on pre-Redeye paired BCMs (e.g. the 6.2 Charger bench set
   * whose flat slice `00 00 00 00 00 00 00 31 3E 00 10 00 18 00 0A 00` has
   * only 5 non-zero/non-FF bytes but IS the authoritative vehicle secret,
   * confirmed by FCA SINCRO). */
  let chosen=null,source=null;
  for(const key of ['split','mirror1','mirror2','flat']){
    const c=candidates[key];
    if(c&&!c.blank){chosen=c;source=key;break;}
  }
  /* allBlank: all candidates are structurally blank (all-FF / all-00).
   * This is the only condition under which a BCM is treated as virgin. */
  const allBlank=
    (!candidates.split||candidates.split.blank)&&
    (!candidates.mirror1||candidates.mirror1.blank)&&
    (!candidates.mirror2||candidates.mirror2.blank)&&
    (!candidates.flat||candidates.flat.blank);
  /* sec16Absent: true only when every candidate is blank — i.e. the module
   * is in a fully virgin / factory state with no real SEC16 anywhere.
   * When sec16Absent is true we return bytes:null so downstream consumers
   * (crossValidate, wizard, AI context) never fabricate a phantom key. */
  const sec16Absent=allBlank;
  return{
    bytes:chosen?new Uint8Array(chosen.bytes):null,
    offset:chosen?chosen.offset:null,
    source:chosen?source:null,
    inactiveBase,
    candidates,
    blank:allBlank,
    sec16Absent,
  };
}

// Detects obviously corrupt / tool-error fill patterns in a raw binary buffer.
// Returns null when the buffer looks like a real capture, or a structured
// {corruptFill, reason, detail} object the caller can surface at upload time.
//
// Covered patterns
//   1. Single-byte fill — the entire file is ≥98% one repeated byte value
//      (catches blank erases, all-FF/all-00 virgin reads that slipped past
//      the type guard, and OBDSTAR/dealer-tool "fill on error" patterns like
//      0x55-filled captures seen in the wild).
//   2. Repeated short ASCII string — the canonical OBDSTAR6 failure mode:
//      a 4–32 printable-ASCII byte sequence that tiles ≥90% of the file.
//      "OBDSTAR6" (8 B) repeated 16,384× across a 128 KB capture is the
//      exact incident that triggered this guard.
//
// The minimum scannable size is 64 bytes — shorter buffers are handled by
// the existing too-small guards and are too small to distinguish a real
// header from a coincidental short pattern.
function detectCorruptFill(data){
  if(!data||data.length<64)return null;

  // ── Check 1: single-byte fill ──────────────────────────────────────────
  // 0xFF (flash erase) and 0x00 (EEPROM blank) are explicitly excluded:
  // an all-FF or all-00 buffer is a legitimate virgin module read and is
  // already handled upstream by the contentWarn / ContentWarnBanner system.
  // We only reject fills of other byte values (e.g. 0x55, 0xAA, or any
  // OBDSTAR-class error byte) because those have no legitimate meaning in
  // a real module capture.
  const counts=new Uint32Array(256);
  for(let i=0;i<data.length;i++)counts[data[i]]++;
  let maxCount=0,maxByte=0;
  for(let b=0;b<256;b++){if(counts[b]>maxCount){maxCount=counts[b];maxByte=b;}}
  const fillRatio=maxCount/data.length;
  if(fillRatio>=0.98&&maxByte!==0xFF&&maxByte!==0x00){
    const byteHex='0x'+maxByte.toString(16).toUpperCase().padStart(2,'0');
    return{
      corruptFill:true,
      reason:'single-byte fill',
      detail:`File is ${Math.round(fillRatio*100)}% byte ${byteHex} — looks like a tool error response, not a real module dump.`,
    };
  }

  // ── Check 2: repeated short ASCII string ──────────────────────────────
  // Scan the leading 32 bytes for a printable-ASCII window of length 4–32.
  // If that exact window tiles ≥90% of the file's full-length blocks, the
  // file is a repeated-string error response (OBDSTAR6, "NO DATA", etc.).
  const scanWindow=Math.min(32,data.length);
  const PRINT_LO=0x20,PRINT_HI=0x7E;
  for(let len=4;len<=scanWindow;len++){
    // If byte at position len-1 is not printable, no longer window can be
    // an all-printable ASCII candidate — stop expanding.
    if(data[len-1]<PRINT_LO||data[len-1]>PRINT_HI)break;
    // Check whether this len-byte window tiles the whole file.
    const fullBlocks=Math.floor(data.length/len);
    if(fullBlocks<2)continue; // degenerate: pattern is basically the whole file
    let matchingBlocks=0;
    for(let block=0;block<fullBlocks;block++){
      const base=block*len;let match=true;
      for(let k=0;k<len;k++){if(data[base+k]!==data[k]){match=false;break;}}
      if(match)matchingBlocks++;
    }
    if(matchingBlocks/fullBlocks>=0.90){
      let pat='';
      for(let i=0;i<len;i++)pat+=String.fromCharCode(data[i]);
      return{
        corruptFill:true,
        reason:'repeated ASCII string',
        detail:`File appears to be "${pat}" repeated ${matchingBlocks.toLocaleString()} times — this looks like a tool error response, not a real module dump.`,
      };
    }
  }

  return null;
}

function parseModule(data,filename,opts){
  const sz=data.length;let type='UNKNOWN';
  const forceType=opts&&opts.forceType;
  if(sz===65536){type='BCM';}
  else if(sz===131072){
    // 128 KB sits at the boundary between BCM and the firmware-class bucket
    // (Task #488 spec: 128 KB / 256 KB / 384 KB classify as FW). Real BCMs
    // have populated VIN slots / immo records; firmware-class captures at
    // this size do not. Promote 128 KB files with no BCM-defining content
    // to FW so the C-flash analyzer can scan them for tuner signatures.
    type=looksLikeRealBcm(data)?'BCM':'FW';
  }
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
  else if(sz>=1048576)type='CFLASH';
  else if(sz>131072)type='FW';
  // Task #634 — XC2268-class RFHUB (newer Ram dealer tool image). Header
  // signature wins over the size bucket so an XC2268 64 KB read isn't
  // misclassified as BCM. ZF-8HP TCU image (845RE / 8HP70 / 8HP90) is
  // checked against its own header so 1 MB TCU dumps don't fall through
  // to the generic CFLASH/FW bucket.
  if(isXc2268Rfhub(data))type='XC2268_RFHUB';
  else if(isZf8hpImage(data))type='ZF_8HP_TCU';
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
    if(type==='FW'||type==='CFLASH')type=fnType;
    else if(type==='BCM'&&(fnType==='GPEC2A'||fnType==='95640')&&!looksLikeRealBcm(data))type=fnType;
  }
  // Filename hint for C-flash captures regardless of size — anything
  // matching CFLASH / C_FLASH / CAL_FLASH stays as CFLASH so it routes to
  // the flasher tab instead of the generic FW bucket.
  const u=(filename||'').toUpperCase();
  if((type==='FW'||type==='UNKNOWN')&&/(C[_\- ]?FLASH|CAL[_\- ]?FLASH|ECU[_\- ]?FLASH)/.test(u))type='CFLASH';
  // Tab context (Gpec2aTab, BcmTab, etc.) can force a type when the user
  // explicitly loads a file under a known module type even if the size is
  // non-canonical. The size warning will then explain the discrepancy.
  if(forceType&&CANONICAL_SIZES_BY_TYPE[forceType])type=forceType;

  const info={type,filename,data,size:sz,name:TL[type]||type,color:TC[type]||'#9E9E9E'};
  // Pre-parse sanity check: reject files whose content matches known tool-error
  // patterns (single-byte fills, repeated ASCII strings like "OBDSTAR6") before
  // any module-specific field extraction runs. The result is attached here so
  // every consumer — FcaModuleInspector, BenchTab, SecurityTab, etc. — can gate
  // on info.corruptFill without repeating the detection logic.
  info.corruptFill=detectCorruptFill(data);
  info.sizeWarn=buildSizeWarn(type,sz);
  // Content sanity check — fires when size-only / signature classification
  // routes a buffer to a family whose defining structures are all blank.
  // Task #527/#538: 64 KB / 128 KB BCM mis-classifications. Task #542: the
  // mirror failure on the 4 KB family — GPEC2A and Gen2 RFHUB share the
  // same image size, so a padded GPEC2A or a virgin RFHUB can land in the
  // wrong family without this guard and surface garbage VIN / SKIM / FOBIK
  // verdicts off random padding bytes.
  info.contentWarn=
    type==='BCM'?buildBcmContentWarn(data)
    :type==='GPEC2A'?buildGpecContentWarn(data)
    :type==='RFHUB'?buildRfhubContentWarn(data)
    :null;
  if(type==='UNKNOWN')info.hexOnly=true;

  if(type==='GPEC2A'){
    info.vins=PCM_VIN_OFFSETS_GPEC2A.map(o=>({offset:o,vin:extractVIN(data,o)})).filter(v=>v.vin);
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
    const knownOffsets=RFH_GEN2_VIN_OFFSETS;
    // Gen2 (24C32, 4096 B): VINs stored byte-reversed; CS = rfhGen2VinCs (XOR^0x87)
    // Gen1 (24C16, 2048 B): VINs stored plain or mirrored; CS = crc8rf
    const rfhIsGen2=sz===4096;
    if(rfhIsGen2){
      info.vins=[];
      // auto-detect VIN CS magic (0xDB=2020+ Redeye, 0x87=older Gen2)
      let rfhMagic=0xDB;
      for(const _o of knownOffsets){const _st=data.slice(_o,_o+17);const _sc=_o+17<sz?data[_o+17]:0;if(!_st.every(b=>b===0xFF||b===0)&&_sc!==0x00&&_sc!==0xFF){rfhMagic=rfhGen2DetectMagic(_st,_sc);break;}}
      // magicKnown: true iff the auto-detected magic is one of the canonical
      // values the FCA SINCRO bench tool accepts (0xDB on 2020+ Redeye, 0x87
      // on earlier Gen2).  When false, our crcOk verdict will still be true
      // (every slot is internally consistent with the derived magic) but
      // SINCRO will report "Checksum ERROR" on the same file because it does
      // not accept off-spec magic bytes.  See .agents/memory/charger62-bench-set.md.
      const rfhMagicKnown=RFH_GEN2_VIN_CS_KNOWN_MAGICS.includes(rfhMagic);
      info.rfhVinMagic=rfhMagic;
      info.rfhVinMagicKnown=rfhMagicKnown;
      for(const o of knownOffsets){if(o+17>sz)continue;const st=data.slice(o,o+17);if(st.every(b=>b===0xFF||b===0))continue;const rev=new Uint8Array(17);for(let j=0;j<17;j++)rev[j]=st[16-j];let s='';for(let j=0;j<17;j++)s+=String.fromCharCode(rev[j]);if(!/^[1-9A-HJ-NPR-Z]/.test(s))continue;const sc=o+17<sz?data[o+17]:0,cc=rfhGen2VinCs(st,rfhMagic);info.vins.push({offset:o,vin:s,mirrored:true,sc,cc,crcOk:sc===cc,magic:rfhMagic,magicKnown:rfhMagicKnown});}
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
    if(sz>=RFH_GEN1_VIN_OFFSET+19){
      const raw17=data.slice(RFH_GEN1_VIN_OFFSET,RFH_GEN1_VIN_OFFSET+17);
      const notBlank=!raw17.every(b=>b===0xFF||b===0x00);
      if(notBlank){let s='';for(let i=0;i<17;i++)s+=String.fromCharCode(raw17[i]);
        const sc=(data[RFH_GEN1_VIN_OFFSET+17]<<8)|data[RFH_GEN1_VIN_OFFSET+18];const cc=crc16(raw17);
        if(/^[1-9A-HJ-NPR-Z][A-HJ-NPR-Z0-9]{16}$/.test(s)){
          info.rfhVin92={offset:RFH_GEN1_VIN_OFFSET,vin:s,storedCs:sc,calcCs:cc,csOk:sc===cc};
          // Gen1 (2 KB) RFHUB stores its VIN here — the 0xEA5+ slot table
          // is past the end of a 24C16 image, so this is the only VIN the
          // module carries. Surface it through info.vins so the Key Prog
          // wizard's "RFH already carries target VIN" check can see it.
          if(sz===2048&&info.vins.length===0)
            info.vins.push({offset:RFH_GEN1_VIN_OFFSET,vin:s,sc,cc,crcOk:sc===cc,algo:'c16'});
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
  }else if(type==='XC2268_RFHUB'){
    // Task #634 — Infineon XC2268-class RFHUB. Surface VIN slots + CRC16/CCITT
    // status + image-wide checksum so the inspector renders bench-ready data
    // and Diff/Mismatch wizards can cross-check VIN against BCM/ECM.
    // Field names mirror parseXc2268Image() exactly so a schema drift trips
    // the new types' tests instead of surfacing as silent undefineds.
    const x=parseXc2268Image(data);
    info.sec16s=[];
    if(!x.ok){info.xc2268={ok:false,reason:x.reason||'parse failed'};info.vins=[];}
    else{
      info.xc2268={
        ok:true,
        variant:x.variant,
        variantByte:x.variantByte,
        variantLabel:x.variantLabel,
        variantSupported:x.variantSupported,
        vinSlots:x.vinSlots,
        imageChecksum:x.imageChecksum,
        writeSafe:x.writeSafe,
        banners:x.banners||[],
      };
      info.vins=x.vinSlots.filter(v=>v.vin).map(v=>({offset:v.offset,vin:v.vin,sc:v.csStored,cc:v.csCalc,crcOk:v.csOk}));
      // Surface SEC16 mirror slots in the SAME shape the Gen1/Gen2 RFHUB
      // branch uses (slot/offset/raw/hex/cs/csCalc/csOk/bcmHex/blank) so the
      // Key Prog wizard and ModuleSync compare/patch paths work without any
      // XC2268 special-casing. hex is RFH-endian; bcmHex is the byte-reversed
      // (BCM-endian) view.
      info.sec16s=(x.sec16Slots||[]).map((s,i)=>{
        const raw=s.raw?Uint8Array.from(s.raw):new Uint8Array(0);
        const hex=Array.from(raw).map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
        const bcmHex=Array.from(raw).reverse().map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('');
        return {slot:i+1,offset:s.offset,raw,hex,cs:s.csStored,csCalc:s.csCalc,csOk:s.csOk,bcmHex,blank:s.blank};
      });
      if(info.sec16s.length===2){
        info.sec16match=x.sec16Match;
        info.sec16valid=!info.sec16s[0].blank&&x.sec16Match&&!!info.sec16s[0].csOk;
      }
      info.sec16SourceSlot=1;
    }
  }else if(type==='ZF_8HP_TCU'){
    // Task #634 — ZF 8HP TCU image (845RE / 8HP70 / 8HP90). Per-64KB-block
    // CRC32 (zlib polynomial) is exposed so a VIN patch + re-CRC step has
    // ground-truth block boundaries to write back into. Field names mirror
    // parseZf8hpImage() so a schema drift surfaces in tests, not at runtime.
    const z=parseZf8hpImage(data);
    if(!z.ok){info.zf8hp={ok:false,reason:z.reason||'parse failed'};info.vins=[];}
    else{
      info.zf8hp={
        ok:true,
        variant:z.variant,
        variantLabel:z.variantLabel,
        variantTag:z.variantTag,
        variantSupported:z.variantSupported,
        sizeSupported:z.sizeSupported,
        vinSlots:z.vinSlots,
        vin:z.vin,
        vinAllSlotsMatch:z.vinAllSlotsMatch,
        blocks:z.blocks,
        blocksOk:z.blocksOk,
        writeSafe:z.writeSafe,
        banners:z.banners||[],
      };
      info.vins=z.vinSlots.filter(v=>v.vin).map(v=>({offset:v.offset,vin:v.vin,sc:v.csStored,cc:v.csCalc,crcOk:v.csOk}));
    }
  }else if(type==='BCM'){
    // Scan canonical slot bases at both base+0 (legacy/no-header layout) and
    // base+8 (Redeye 2020+ layout: 8-byte FEE record header → 17-byte VIN →
    // 2-byte BE CRC16 → 5-byte trailer). Whichever yields a valid 17-byte
    // VIN is the slot's true VIN offset, so writers can target it precisely
    // without clobbering the header or trailer.
    //
    // Task #463 — if the canonical 0x5320..0x5380 zone yields zero VINs,
    // fall back to the alternate 0x1320..0x1380 zone (FCA SINCRO output
    // for some Charger BCMs uses the same record layout at the lower
    // base address). Canonical is tried first so a normal LX BCM never
    // silently picks the alternate zone. `info.vinZone` records which
    // zone was used so consumers (UI label, writers) can branch on it.
    const crcAt=(off)=>{if(off+19>sz)return null;return(data[off+17]<<8)|data[off+18];};
    const scanVinBases=(bases)=>{
      const vins=[];
      for(const base of bases){
        const v8=extractVIN(data,base+8);
        const v0=extractVIN(data,base);
        const c8=v8?crcAt(base+8):null;
        const c0=v0?crcAt(base):null;
        const ok8=v8&&c8!==null&&c8===crc16(data.slice(base+8,base+8+17));
        const ok0=v0&&c0!==null&&c0===crc16(data.slice(base,base+17));
        if(ok8){vins.push({offset:base+8,vin:v8,slotBase:base,headerBytes:8,crcOk:true});continue;}
        if(ok0){vins.push({offset:base,vin:v0,slotBase:base,headerBytes:0,crcOk:true});continue;}
        if(v8){vins.push({offset:base+8,vin:v8,slotBase:base,headerBytes:8,crcOk:false});continue;}
        if(v0){vins.push({offset:base,vin:v0,slotBase:base,headerBytes:0,crcOk:false});}
      }
      return vins;
    };
    info.vins=scanVinBases(BCM_FULL_VIN_BASES_PARSED);
    info.vinZone=info.vins.length>0?'canonical':null;
    if(info.vins.length===0){
      const altVins=scanVinBases(BCM_FULL_VIN_BASES_ALT_PARSED);
      if(altVins.length>0){
        info.vins=altVins;
        info.vinZone='alt-0x1328';
      }
    }
    // Partial-VIN scan (Task #452): always include the registered offsets in
    // `BCM_PARTIAL_VIN_OFFSETS` (so a CRC mismatch still surfaces a slot
    // entry with `crcOk:false`, matching the existing parser/test contract),
    // then merge in any additional partial-VIN-shaped slot the helper
    // auto-detects elsewhere in the buffer (8 VIN-character bytes + valid
    // CRC16 at +8/+9). 2020+ Redeye BCMs may grow extra partial-VIN slots
    // (cluster-B mirror etc.); the auto-detector picks them up without
    // any code change here.
    info.partialVins=[];
    const seenPartialOff=new Set();
    for(const po of BCM_PARTIAL_VIN_OFFSETS){
      if(po+BCM_PARTIAL_VIN_LEN+2>sz)continue;
      let s='',ok=true;
      for(let j=0;j<BCM_PARTIAL_VIN_LEN;j++){const b=data[po+j];if(b<0x20||b>0x7E){ok=false;break;}s+=String.fromCharCode(b);}
      if(!ok||s.length!==BCM_PARTIAL_VIN_LEN)continue;
      const sc=(data[po+BCM_PARTIAL_VIN_LEN]<<8)|data[po+BCM_PARTIAL_VIN_LEN+1];
      const cc=crc16(data.slice(po,po+BCM_PARTIAL_VIN_LEN));
      info.partialVins.push({offset:po,tail:s,storedCrc:sc,calcCrc:cc,crcOk:sc===cc});
      seenPartialOff.add(po);
    }
    for(const d of findBcmPartialVinSlots(data)){
      if(seenPartialOff.has(d.offset))continue;
      info.partialVins.push({offset:d.offset,tail:d.tail,storedCrc:d.storedCrc,calcCrc:d.calcCrc,crcOk:true});
      seenPartialOff.add(d.offset);
    }
    info.partialVins.sort((a,b)=>a.offset-b.offset);
    /* BCM SEC16 — resolved from split / mirror / flat (Task #380). The legacy
     * flat slice at 0x40C9 holds residual garbage on synced Redeye dumps; the
     * resolver consults the FEE-record table and falls back to the flat slice
     * only when no record-table source is populated. `info.vehicleSecret`
     * stays populated for backwards compatibility (callers like crossValidate
     * / Key Prog wizard read .bytes / .hex), and `info.bcmSec16` exposes the
     * full provenance (source, candidates, inactiveBase, blank flag). */
    info.bcmSec16=resolveBcmSec16(data);
    /* sec16Absent: propagated from the resolver. When true the BCM is in
     * ALERT_NO_SECURITY / VIN-only state — no authoritative 128-bit secret
     * can be read. We null out vehicleSecret so callers (crossValidate, the
     * Key Prog wizard, the AI assistant context) never see fabricated bytes. */
    info.sec16Absent=info.bcmSec16.sec16Absent;
    if(info.bcmSec16.bytes&&!info.sec16Absent){
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
    for(const off of EEP95640_VIN_OFFSETS){
      // 0x1B82 lives near the end of the 8 KB image — guard the read so
      // a truncated capture doesn't false-positive past EOF.
      if(off+17>sz)continue;
      const v=extractVIN(data,off);
      if(v)info.vins.push({offset:off,vin:v});
    }
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

  // Firmware-class scan (Task #488). CFLASH (>=1 MB ECM dump) and FW
  // (128 KB - 1 MB capture) both get the C-flash analyzer attached so the
  // CFlashTab and the Dumps tab tuner-warning row can light up. Smaller
  // EEPROM-class dumps (BCM/RFHUB/GPEC2A/95640/etc) are gated out so the
  // tuner-sig sweep cannot misfire on them.
  if(type==='CFLASH'||type==='FW'){
    info.security=analyzeCflash(data);
    if(info.security){
      info.calId=info.security.calId||null;
      info.buildDate=info.security.buildDate||null;
      info.tunerSigs=info.security.tunerSigs||[];
    }
  }

  return info;
}

// Shared helper for all upload handlers: returns a human-readable error
// string when a parsed module result indicates a corrupt capture, or null
// when the file looks clean. Use this instead of inspecting m.corruptFill
// directly so every tab produces the same rejection message format.
//
//   const err = corruptFillError(m);
//   if (err) { setMsg(err); return; }
//
function corruptFillError(m){
  if(!m?.corruptFill)return null;
  const cf=m.corruptFill;
  const base='✖ Corrupt capture'+(cf.reason?' ('+cf.reason+')':'')+': '+(cf.detail||'file looks like a tool-error response')+'.';
  return base+' Re-read the module with your programming tool — do not use this capture for VIN or key operations.';
}

export {parseModule,detectCorruptFill,corruptFillError,countSkimRecs,syncImmoBackup,extractVIN,extractHex,arrEq,detectBySignature,fO,rd32,buildSizeWarn,typeFromFilename,CANONICAL_SIZES_BY_TYPE,looksLikeRealBcm,buildBcmContentWarn,buildGpecContentWarn,buildRfhubContentWarn,BCM_MIN_SIZE,bcmTooSmall,MODULE_MIN_SIZES,MODULE_MIN_LABELS,moduleTooSmall,wrongModuleForSlot,SLOT_TO_FAMILY,detectModuleType,PCM_CHIPS,pcmChipFromSize,pcmChipFromKey,resolveBcmSec16,classifyPcmSec6,
  // Canonical VIN slot tables (single source of truth shared with
  // scripts/anonymize-real-dump.mjs — see the block-comment at the top
  // of this file for the per-family explanation). PCM_VIN_OFFSETS_GPEC2A
  // is also consumed by ImmoVINTab, ModuleSync, App.jsx, fileUtils.js,
  // rfhPcmPair.js and scripts/trim-pcm-to-4kb.mjs.
  BCM_FULL_VIN_BASES,BCM_FULL_VIN_BASES_PARSED,BCM_PARTIAL_VIN_OFFSETS,
  RFH_GEN2_VIN_OFFSETS,RFH_GEN1_VIN_OFFSET,
  PCM_VIN_OFFSETS_GPEC2A,EEP95640_VIN_OFFSETS,SGW_VIN_OFFSETS};
