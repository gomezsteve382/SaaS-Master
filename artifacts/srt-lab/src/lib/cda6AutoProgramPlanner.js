import {buildIsoTpFrames} from './isotp.js';

const OPERATION_PRESETS = {
  natural: 'Natural language intent',
  program: 'Full programming sequence',
  readAllDids: 'Read all DIDs',
  clearAllDtcs: 'Clear all DTCs',
  vehicleScan: 'Full vehicle scan',
  dumpMemory: 'Memory-read plan',
  security: 'Security access',
  routine: 'RoutineControl',
  reset: 'ECU reset',
  session: 'Diagnostic session',
};

const SECURITY_NOTICE = 'Review-only output. Use only on ECUs you own or are explicitly authorized to diagnose. Seed/key computation, unrestricted memory dumping, and flash payload generation are intentionally represented with operator-provided placeholders.';

function normaliseCell(value){
  if(value===null || value===undefined) return '';
  if(value instanceof Uint8Array) return `0x${bytesToHex(value.slice(0,64))}${value.length>64?'...':''}`;
  if(Array.isArray(value)) return `0x${bytesToHex(Uint8Array.from(value).slice(0,64))}${value.length>64?'...':''}`;
  return String(value);
}

function bytesToHex(bytes){
  return Array.from(bytes || []).map((b)=>Number(b).toString(16).toUpperCase().padStart(2,'0')).join('');
}

function hexToBytes(hex){
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g,'');
  const out = [];
  for(let i=0;i<clean.length;i+=2) out.push(parseInt(clean.slice(i,i+2),16));
  return Uint8Array.from(out.filter((n)=>Number.isFinite(n)));
}

function spacedHex(hex){
  return String(hex || '').replace(/[^0-9a-fA-F]/g,'').toUpperCase().replace(/(..)/g,'$1 ').trim();
}

function valueToBytes(value){
  if(value instanceof Uint8Array) return value;
  if(Array.isArray(value)) return Uint8Array.from(value.map((item)=>Number(item) & 0xff));
  if(value instanceof ArrayBuffer) return new Uint8Array(value);
  if(typeof value === 'string'){
    const trimmed = value.trim();
    const hex = trimmed.replace(/^0x/i,'').replace(/[^0-9a-fA-F]/g,'');
    if(hex.length >= 2 && hex.length % 2 === 0 && /^(?:0x)?[0-9a-fA-F\s,:;-]+$/.test(trimmed)){
      const out = new Uint8Array(hex.length / 2);
      for(let index=0; index<out.length; index+=1) out[index] = parseInt(hex.slice(index*2,index*2+2),16);
      return out;
    }
    return new TextEncoder().encode(trimmed);
  }
  return new Uint8Array();
}

function readLe32(bytes, offset){
  return (bytes[offset] | (bytes[offset+1] << 8) | (bytes[offset+2] << 16) | (bytes[offset+3] << 24)) >>> 0;
}

function isLikelyUdsPayload(bytes){
  if(!bytes?.length || bytes.length > 4095) return false;
  return [0x10,0x11,0x14,0x19,0x22,0x23,0x27,0x28,0x2E,0x2F,0x31,0x34,0x36,0x37,0x3E,0x85].includes(bytes[0]);
}

function parseLengthPrefixedPayload(bytes, offset, endian){
  if(offset + 4 > bytes.length) return null;
  const length = endian === 'be'
    ? (((bytes[offset] << 24) | (bytes[offset+1] << 16) | (bytes[offset+2] << 8) | bytes[offset+3]) >>> 0)
    : readLe32(bytes, offset);
  if(length > 0 && length <= 4095 && offset + 4 + length <= bytes.length){
    const payload = bytes.slice(offset + 4, offset + 4 + length);
    if(isLikelyUdsPayload(payload)) return payload;
  }
  return null;
}

function extractUdsFromXmitStr(value){
  const bytes = valueToBytes(value);
  if(!bytes.length) return '';
  const candidates = [parseLengthPrefixedPayload(bytes,0,'le'), parseLengthPrefixedPayload(bytes,0,'be'), parseLengthPrefixedPayload(bytes,4,'le'), parseLengthPrefixedPayload(bytes,4,'be')].filter(Boolean);
  for(let offset=0; offset<Math.min(bytes.length,32); offset+=1){
    const slice = bytes.slice(offset);
    if(isLikelyUdsPayload(slice)) candidates.push(slice);
  }
  const best = candidates.map((candidate)=>Array.from(candidate || [])).filter((candidate)=>candidate.length && isLikelyUdsPayload(candidate)).sort((a,b)=>a.length-b.length)[0];
  return best ? bytesToHex(Uint8Array.from(best)) : '';
}

function normalizeHex(value, fallback='', bytes=0){
  const raw = String(value ?? '').trim();
  const source = raw || String(fallback || '');
  if(!source) return '';
  let hex = '';
  if(/^0x[0-9a-fA-F]+$/.test(source)) hex = source.slice(2);
  else if(/^[0-9a-fA-F]+$/.test(source) && (/[a-fA-F]/.test(source) || source.length % 2 === 0)) hex = source;
  else if(/^[0-9]+$/.test(source)) hex = Number(source).toString(16);
  else {
    const match = source.match(/0x([0-9a-fA-F]+)/) || source.match(/\b([0-9a-fA-F]{2,16})\b/);
    hex = match?.[1] || '';
  }
  hex = hex.replace(/[^0-9a-fA-F]/g,'').toUpperCase();
  if(hex.length % 2) hex = `0${hex}`;
  if(bytes) hex = hex.padStart(bytes*2,'0').slice(-bytes*2);
  return hex;
}

function pickValue(row, patterns){
  if(!row) return '';
  const entries = Object.entries(row);
  for(const pattern of patterns){
    const found = entries.find(([key,value])=>value!==null && value!==undefined && String(key).toLowerCase() === pattern.toLowerCase());
    if(found) return found[1];
  }
  for(const pattern of patterns){
    const needle = pattern.toLowerCase();
    const found = entries.find(([key,value])=>value!==null && value!==undefined && String(key).toLowerCase().includes(needle));
    if(found) return found[1];
  }
  return '';
}

function rowText(row){
  return Object.entries(row || {}).map(([key,value])=>`${key}:${normaliseCell(value)}`).join(' ').toLowerCase();
}

function describeRow(row, preferred=[]){
  if(!row) return 'Unspecified row';
  const chosen = [];
  for(const key of preferred){
    const entry = Object.entries(row).find(([column,value])=>String(column).toLowerCase().includes(key.toLowerCase()) && value!==null && value!==undefined && value!=='');
    if(entry && !chosen.some(([column])=>column===entry[0])) chosen.push(entry);
  }
  if(chosen.length < 3){
    for(const entry of Object.entries(row)){
      if(entry[1]!==null && entry[1]!==undefined && entry[1]!=='' && !chosen.some(([column])=>column===entry[0])) chosen.push(entry);
      if(chosen.length >= 4) break;
    }
  }
  return chosen.slice(0,4).map(([key,value])=>`${key}: ${normaliseCell(value)}`).join(' · ');
}

function moduleLabel(row){
  return normaliseCell(pickValue(row, ['ecu','module','variant','var','name','short_name','address']) || describeRow(row, ['ecu','module','variant','name','bus','address']));
}

function canAddressInfo(row){
  const request = normalizeHex(pickValue(row, ['request_can_id','req_can_id','request_id','req_id','tester_to_ecu','tx_id','can_req','physical_request','address']), '', 0);
  const response = normalizeHex(pickValue(row, ['response_can_id','resp_can_id','response_id','res_id','ecu_to_tester','rx_id','can_resp','physical_response']), '', 0);
  const bus = normaliseCell(pickValue(row, ['bus','network','can_bus','channel']) || '');
  const reqNum = request ? parseInt(request,16) : null;
  const respNum = response ? parseInt(response,16) : null;
  return {request,response,bus,isExtended:Boolean((reqNum && reqNum > 0x7FF) || (respNum && respNum > 0x7FF)), requestDisplay: request ? `0x${request}` : 'Not detected', responseDisplay: response ? `0x${response}` : 'Not detected'};
}

function guessDid(row){
  const fromXmit = extractUdsFromXmitStr(pickValue(row, ['xmit_str','xmit','tx','request','request_bytes','uds_request','command','cmd']));
  if(fromXmit && ['22','2E','2F'].includes(fromXmit.slice(0,2)) && fromXmit.length >= 6) return fromXmit.slice(2,6);
  return normalizeHex(pickValue(row, ['did','data_identifier','dataid','identifier','ident','param_id','com_ser','service_id']), '', 2);
}

function guessRoutineId(row){
  const fromXmit = extractUdsFromXmitStr(pickValue(row, ['xmit_str','xmit','tx','request','request_bytes','uds_request','command','cmd']));
  if(fromXmit?.startsWith('31') && fromXmit.length >= 8) return fromXmit.slice(4,8);
  return normalizeHex(pickValue(row, ['routine_id','routineid','rid','identifier','ident','routine']), '', 2);
}

function guessSecurityLevel(row){
  const fromXmit = extractUdsFromXmitStr(pickValue(row, ['xmit_str','xmit','tx','request','request_bytes','uds_request','command','cmd']));
  if(fromXmit?.startsWith('27') && fromXmit.length >= 4) return fromXmit.slice(2,4);
  return normalizeHex(pickValue(row, ['level','security_level','access_level','seed_level','sec_level','service']), '', 1);
}

function commandFromCdaRow(row, fallback=''){
  const xmit = pickValue(row, ['xmit_str','xmit','tx','request','request_bytes','uds_request','command','cmd']);
  const fromXmit = extractUdsFromXmitStr(xmit);
  return fromXmit || normalizeHex(fallback, '', 0);
}

function matchModuleRows(rows, moduleRow, limit=250){
  if(!rows?.length) return [];
  if(!moduleRow) return rows.slice(0, limit);
  const label = moduleLabel(moduleRow).toLowerCase();
  const usefulTokens = label.split(/[^a-z0-9]+/i).filter((token)=>token.length >= 3 && !['module','address','variant','name','bus','can','ecu'].includes(token)).slice(0,8);
  const scored = rows.map((row)=>{
    const text = rowText(row);
    const score = usefulTokens.reduce((sum,token)=>sum + (text.includes(token) ? 1 : 0), 0);
    return {row,score};
  }).filter((item)=>item.score>0).sort((a,b)=>b.score-a.score).map((item)=>item.row);
  return (scored.length ? scored : rows).slice(0, limit);
}

function serviceName(hex){
  const sid = normalizeHex(hex, '', 1);
  return ({
    '10':'DiagnosticSessionControl', '11':'ECUReset', '14':'ClearDiagnosticInformation', '22':'ReadDataByIdentifier',
    '27':'SecurityAccess', '2E':'WriteDataByIdentifier', '31':'RoutineControl', '34':'RequestDownload',
    '36':'TransferData', '37':'RequestTransferExit', '3E':'TesterPresent', '85':'ControlDTCSetting', '28':'CommunicationControl',
    '23':'ReadMemoryByAddress',
  })[sid] || `UDS 0x${sid || '??'}`;
}

function isoTpFor(hex, can){
  const payload = hexToBytes(hex);
  if(!payload.length || payload.length > 4095) return null;
  const built = buildIsoTpFrames(payload, {padByte:0x00, canFD:false});
  return {
    requiresFlowControl: built.requiresFlowControl,
    frameCount: built.frames.length,
    frames: built.frames.slice(0,8).map((frame,index)=>({index:index+1, canId:can.requestDisplay, hex:spacedHex(bytesToHex(frame)), type:index===0 && built.requiresFlowControl?'First frame':built.requiresFlowControl?'Consecutive frame':'Single frame'})),
    timing: built.requiresFlowControl ? 'Wait for ECU FlowControl (0x30) before consecutive frames; use negotiated BlockSize and STmin. Default review assumption: BS=0, STmin=10 ms until confirmed.' : 'Single CAN frame; observe ECU P2/P2* response timing and application-specific inter-request delay.',
  };
}

function makeStep({title, hex, displayHex, explanation, expectation='', can, warnings=[], placeholder=false, source=''}){
  const concreteHex = placeholder ? '' : normalizeHex(hex || displayHex, '', 0);
  return {
    title,
    service: concreteHex ? serviceName(concreteHex.slice(0,2)) : 'Operator-supplied payload',
    hex: concreteHex,
    displayHex: displayHex || spacedHex(concreteHex),
    explanation,
    expectation,
    can,
    warnings,
    placeholder,
    source,
    isoTp: concreteHex ? isoTpFor(concreteHex, can) : null,
  };
}

function findBestRow(rows, moduleRow, keywords, kind){
  const scoped = matchModuleRows(rows, moduleRow, 500);
  const q = (keywords || []).filter(Boolean).map((k)=>String(k).toLowerCase());
  const ranked = scoped.map((row)=>{
    const text = rowText(row);
    const score = q.reduce((sum,token)=>sum + (text.includes(token) ? 2 : 0), 0) + (kind === 'did' && guessDid(row) ? 1 : 0) + (kind === 'routine' && guessRoutineId(row) ? 1 : 0) + (kind === 'security' && guessSecurityLevel(row) ? 1 : 0);
    return {row,score};
  }).sort((a,b)=>b.score-a.score);
  return ranked[0]?.score > 0 ? ranked[0].row : scoped[0];
}

function parseIntent(intent='', rows={}){
  const text = String(intent || '').toLowerCase();
  const operation = text.includes('scan') || text.includes('all modules') || text.includes('vehicle') ? 'vehicleScan'
    : text.includes('clear') && text.includes('dtc') ? 'clearAllDtcs'
    : text.includes('dump') || text.includes('eeprom') || text.includes('memory') ? 'dumpMemory'
    : text.includes('program') || text.includes('flash') || text.includes('download') ? 'program'
    : text.includes('unlock') || text.includes('security') || text.includes('seed') ? 'security'
    : text.includes('routine') || text.includes('adapt') || text.includes('learn') ? 'routine'
    : text.includes('reset') ? 'reset'
    : text.includes('session') ? 'session'
    : text.includes('all did') || text.includes('all dids') ? 'readAllDids'
    : 'readDid';
  const moduleCandidates = rows.ecuRows || [];
  const moduleRow = moduleCandidates.find((row)=>{
    const label = moduleLabel(row).toLowerCase();
    const tokens = label.split(/[^a-z0-9]+/).filter((token)=>token.length>=3);
    return tokens.some((token)=>text.includes(token));
  }) || null;
  const didKeywords = ['vin','odometer','part','software','calibration','config','proxi','variant','serial','fingerprint'].filter((word)=>text.includes(word));
  const levelMatch = text.match(/level\s*(\d+|0x[0-9a-f]+)/i);
  const keySlotMatch = text.match(/slot\s*(\d+)/i);
  return {operation,moduleRow,didKeywords,securityLevel:levelMatch?.[1] || '', routineKeywords:keySlotMatch ? ['key','slot',keySlotMatch[1]] : text.split(/[^a-z0-9]+/).filter((token)=>token.length>3).slice(0,8)};
}

function addSecurityPair(steps, securityRow, moduleRow, can, overrideLevel=''){
  const level = normalizeHex(overrideLevel, guessSecurityLevel(securityRow) || '01', 1);
  const keyLevel = normalizeHex((parseInt(level || '01',16) + 1).toString(16), '', 1);
  steps.push(makeStep({title:`SecurityAccess seed request (level 0x${level})`,hex:`27${level}`,can,explanation:'Requests a seed for the selected CDA6 security level. The next request must use the authorized seed/key algorithm outside this planner.',expectation:`Positive response 67 ${level} <seed>.`}));
  steps.push(makeStep({title:`SecurityAccess key response placeholder (level 0x${keyLevel})`,displayHex:`27 ${keyLevel} <KEY_FROM_AUTHORIZED_ALGORITHM>`,can,placeholder:true,explanation:'Placeholder for the key calculated by an authorized routine. This planner does not derive or bypass seed/key algorithms.',expectation:`Positive response 67 ${keyLevel}.`,warnings:['Seed/key derivation is intentionally not automated.']}));
}

function buildProgrammingSequence({moduleRow, can, rows, params}){
  const securityRow = findBestRow(rows.securityRows || [], moduleRow, ['program','security','level'], 'security');
  const didRows = matchModuleRows(rows.didRows || [], moduleRow, 12).filter(guessDid).slice(0,5);
  const routineRows = matchModuleRows(rows.routineRows || [], moduleRow, 20).filter(guessRoutineId);
  const eraseRoutine = findBestRow(routineRows, moduleRow, ['erase','program'], 'routine') || routineRows[0];
  const checkRoutine = findBestRow(routineRows, moduleRow, ['check','verify','dependency'], 'routine') || routineRows[1] || routineRows[0];
  const address = normalizeHex(params.downloadAddress || params.memoryAddress || '00000000', '', 4);
  const length = normalizeHex(params.downloadLength || params.memoryLength || '00000000', '', 4);
  const steps = [];
  steps.push(makeStep({title:'Enter extended diagnostic session',hex:'1003',can,explanation:'Places the ECU in extended diagnostics before pre-programming checks.',expectation:'Positive response 50 03.'}));
  steps.push(makeStep({title:'ControlDTCSetting off',hex:'8502',can,explanation:'Suppresses DTC setting during the programming window where supported.',expectation:'Positive response C5 02 or documented NRC handling.'}));
  steps.push(makeStep({title:'CommunicationControl quiet bus chatter',hex:'280303',can,explanation:'Review-only step for reducing non-essential communication during programming. Confirm module support before use.',expectation:'Positive response 68 03.'}));
  steps.push(makeStep({title:'Enter programming session',hex:'1002',can,explanation:'Requests programming session before security access and download.',expectation:'Positive response 50 02 with timing bytes when provided.'}));
  addSecurityPair(steps, securityRow, moduleRow, can, params.securityLevel);
  steps.push(makeStep({title:'TesterPresent keep-alive',hex:'3E00',can,explanation:'Keep-alive to repeat at the negotiated interval during long operations.',expectation:'Positive response 7E 00 unless suppress-positive-response is used.'}));
  for(const did of didRows){
    const didHex = guessDid(did);
    steps.push(makeStep({title:`Pre-check DID 0x${didHex}`,hex:commandFromCdaRow(did, `22${didHex}`),can,explanation:`Reads a CDA6-derived pre-check identifier: ${describeRow(did, ['did','name','service'])}`,expectation:`Positive response 62 ${didHex} <data>.`,source:'com_ser_var_ver'}));
  }
  if(eraseRoutine){
    const rid = guessRoutineId(eraseRoutine) || 'FF00';
    steps.push(makeStep({title:`RoutineControl erase/dependency step 0x${rid}`,hex:`3101${rid}${address}${length}`,can,explanation:`Starts the CDA6-derived erase or dependency routine candidate: ${describeRow(eraseRoutine, ['routine','erase','name'])}`,expectation:`Positive response 71 01 ${rid}.`,source:'routine'}));
  }
  steps.push(makeStep({title:'RequestDownload placeholder',hex:`340044${address}${length}`,can,explanation:'Requests a download window for the operator-selected address and length. The data format is left as no-compression/no-encryption review default and must be confirmed per ECU.',expectation:'Positive response 74 <maxNumberOfBlockLength>.',warnings:['Address, length, and data-format identifier must come from an authorized calibration package or service procedure.']}));
  steps.push(makeStep({title:'TransferData chunk stream placeholder',displayHex:'36 <BLOCK_COUNTER> <AUTHORIZED_FILE_CHUNK_BYTES>',can,placeholder:true,explanation:'Represents sequential TransferData frames. Actual bytes are not generated without an authorized programming payload.',expectation:'Positive response 76 <BLOCK_COUNTER>.',warnings:['Flash payload generation and unrestricted transfer are intentionally not automated.']}));
  steps.push(makeStep({title:'RequestTransferExit',hex:'37',can,explanation:'Closes the active download transfer after the final accepted chunk.',expectation:'Positive response 77.'}));
  if(checkRoutine){
    const rid = guessRoutineId(checkRoutine) || 'FF01';
    steps.push(makeStep({title:`RoutineControl verify/check 0x${rid}`,hex:`3101${rid}`,can,explanation:`Runs CDA6-derived post-transfer verification candidate: ${describeRow(checkRoutine, ['routine','check','verify','name'])}`,expectation:`Positive response 71 01 ${rid}.`,source:'routine'}));
  }
  steps.push(makeStep({title:'Post-programming DID write placeholder',displayHex:'2E <DID> <AUTHORIZED_CONFIG_BYTES>',can,placeholder:true,explanation:'Optional post-programming WriteDataByIdentifier step for authorized configuration data.',expectation:'Positive response 6E <DID>.',warnings:['Exact DID and data must be confirmed from service documentation or CDA6 rows.']}));
  steps.push(makeStep({title:'ECU hard reset',hex:'1101',can,explanation:'Resets the ECU after programming and verification.',expectation:'Positive response 51 01 or communication drop during reset.'}));
  steps.push(makeStep({title:'Restore DTC setting',hex:'8501',can,explanation:'Restores normal DTC logging after the programming workflow.',expectation:'Positive response C5 01.'}));
  return steps;
}

function buildReadAllDids({moduleRow, can, rows}){
  const dids = matchModuleRows(rows.didRows || [], moduleRow, 2000).filter((row)=>guessDid(row));
  return dids.map((row)=>{
    const didHex = guessDid(row);
    return makeStep({title:`Read DID 0x${didHex}`,hex:commandFromCdaRow(row, `22${didHex}`),can,explanation:`Reads CDA6 DID/service row: ${describeRow(row, ['did','service','name','identifier'])}`,expectation:`Positive response 62 ${didHex} <data>.`,source:'com_ser_var_ver'});
  });
}

function buildVehicleScan({canRows, rows}){
  const modules = (canRows || []).slice(0,250);
  const scanSteps = [];
  for(const moduleRow of modules){
    const can = canAddressInfo(moduleRow);
    const did = findBestRow(rows.didRows || [], moduleRow, ['vin','part','software','identifier'], 'did');
    const didHex = guessDid(did) || 'F190';
    scanSteps.push(makeStep({title:`Scan ${moduleLabel(moduleRow)}: read identifier 0x${didHex}`,hex:commandFromCdaRow(did, `22${didHex}`),can,explanation:'Full-vehicle scan entry generated from ecu_to_bus plus the best matching CDA6 identifier row. If no obvious DID is labelled, VIN DID F190 is used as an editable default.',expectation:`Positive response 62 ${didHex} <data>.`,source:'ecu_to_bus/com_ser_var_ver'}));
    scanSteps.push(makeStep({title:`Scan ${moduleLabel(moduleRow)}: report DTCs`,hex:'1902FF',can,explanation:'Reads current DTCs for this ECU using UDS ReadDTCInformation reportDTCByStatusMask.',expectation:'Positive response 59 02 <DTC/status records>.'}));
  }
  return scanSteps;
}

function buildClearAllDtcs({canRows}){
  return (canRows || []).slice(0,250).map((moduleRow)=>makeStep({title:`Clear all DTCs on ${moduleLabel(moduleRow)}`,hex:'14FFFFFF',can:canAddressInfo(moduleRow),explanation:'Generates ClearDiagnosticInformation for the all-groups DTC mask. Confirm emissions, safety, and service policy before use.',expectation:'Positive response 54.',warnings:['Clearing DTCs can erase diagnostic evidence and readiness data. Use only when authorized.'],source:'ecu_to_bus'}));
}

function buildMemoryReadPlan({moduleRow, can, params}){
  const address = normalizeHex(params.memoryAddress || '', '', 4);
  const length = normalizeHex(params.memoryLength || '', '', 2);
  const steps = [];
  if(address && length){
    steps.push(makeStep({title:`Read memory window 0x${address} length 0x${length}`,hex:`2324${address}${length}`,can,explanation:'Generates a bounded ReadMemoryByAddress request using operator-provided address and length. This is a review plan, not an unrestricted dump.',expectation:'Positive response 63 <data>.',warnings:['No default full-range EEPROM dump is generated. Enter only authorized, bounded ranges.']}));
  }else{
    steps.push(makeStep({title:'Bounded memory-read placeholder',displayHex:'23 <ALFID> <AUTHORIZED_ADDRESS> <AUTHORIZED_LENGTH>',can,placeholder:true,explanation:'Enter an explicit address and length to produce a concrete ReadMemoryByAddress request. The planner intentionally avoids generating an unrestricted EEPROM dump range.',expectation:'Positive response 63 <data>.',warnings:['Explicit authorized memory range required.']}));
  }
  return steps;
}

function buildSingleIntent({operation,moduleRow,can,rows,params,intentMeta}){
  if(operation === 'program') return buildProgrammingSequence({moduleRow, can, rows, params});
  if(operation === 'readAllDids') return buildReadAllDids({moduleRow, can, rows});
  if(operation === 'vehicleScan') return buildVehicleScan({canRows:rows.ecuRows || [], rows});
  if(operation === 'clearAllDtcs') return buildClearAllDtcs({canRows:rows.ecuRows || []});
  if(operation === 'dumpMemory') return buildMemoryReadPlan({moduleRow, can, params});
  if(operation === 'security'){
    const securityRow = findBestRow(rows.securityRows || [], moduleRow, ['security','unlock','program', intentMeta?.securityLevel], 'security');
    const steps = [];
    addSecurityPair(steps, securityRow, moduleRow, can, params.securityLevel || intentMeta?.securityLevel);
    return steps;
  }
  if(operation === 'routine'){
    const routineRow = findBestRow(rows.routineRows || [], moduleRow, intentMeta?.routineKeywords || ['routine'], 'routine');
    const rid = normalizeHex(params.routineId, guessRoutineId(routineRow), 2);
    const routineCommand = rid ? commandFromCdaRow(routineRow, `31${normalizeHex(params.routineSubFunction || '01','01',1)}${rid}`) : '';
    return [makeStep({title:`RoutineControl start routine 0x${rid || '????'}`,hex:routineCommand,displayHex:rid ? undefined : '31 <SUB_FUNCTION> <ROUTINE_ID>',placeholder:!rid,can,explanation:`Starts the selected CDA6 routine candidate: ${describeRow(routineRow, ['routine','name','id'])}`,expectation:rid ? `Positive response 71 ${normalizeHex(params.routineSubFunction || '01','01',1)} ${rid}.` : 'Positive response 71 <sub-function> <routine-id>.'})];
  }
  if(operation === 'reset') return [makeStep({title:'ECU reset',hex:`11${normalizeHex(params.resetType || '01','01',1)}`,can,explanation:'Generates an ECUReset request for the selected module.',expectation:'Positive response 51 <reset-type> or expected reset silence.'})];
  if(operation === 'session') return [makeStep({title:'Diagnostic session control',hex:`10${normalizeHex(params.sessionType || '03','03',1)}`,can,explanation:'Generates a DiagnosticSessionControl request for the selected module.',expectation:'Positive response 50 <session-type>.'})];
  const didRow = findBestRow(rows.didRows || [], moduleRow, intentMeta?.didKeywords || ['vin','identifier','data'], 'did');
  const didHex = normalizeHex(params.did, guessDid(didRow) || 'F190', 2);
  return [makeStep({title:`Read DID 0x${didHex}`,hex:commandFromCdaRow(didRow, `22${didHex}`),can,explanation:`Reads the best matching CDA6 DID/service row: ${describeRow(didRow, ['did','service','name','identifier'])}`,expectation:`Positive response 62 ${didHex} <data>.`,source:'com_ser_var_ver'})];
}

export function buildAutoProgramPlan({intent='', operation='natural', moduleRow=null, rows={}, params={}}={}){
  const intentMeta = parseIntent(intent, rows);
  const effectiveOperation = operation === 'natural' ? intentMeta.operation : operation;
  const effectiveModule = moduleRow || intentMeta.moduleRow || rows.ecuRows?.[0] || null;
  const can = canAddressInfo(effectiveModule);
  const steps = buildSingleIntent({operation:effectiveOperation,moduleRow:effectiveModule,can,rows,params,intentMeta});
  const title = OPERATION_PRESETS[effectiveOperation] || 'Auto Program command plan';
  const concreteCount = steps.filter((step)=>step.hex).length;
  const placeholderCount = steps.filter((step)=>step.placeholder).length;
  return {
    title,
    operation: effectiveOperation,
    requestedIntent: intent,
    moduleLabel: moduleLabel(effectiveModule),
    can,
    steps,
    warnings: [SECURITY_NOTICE, ...new Set(steps.flatMap((step)=>step.warnings || []))],
    summary: `${steps.length.toLocaleString()} planned step${steps.length===1?'':'s'} · ${concreteCount.toLocaleString()} concrete UDS request${concreteCount===1?'':'s'} · ${placeholderCount.toLocaleString()} operator placeholder${placeholderCount===1?'':'s'}`,
  };
}

export function summarizeSecurityRows(rows=[], moduleRow=null){
  return matchModuleRows(rows, moduleRow, 80).map((row)=>{
    const blobs = Object.entries(row).filter(([,value])=>value instanceof Uint8Array || Array.isArray(value) || /blob|algo|seed|key|crypt/i.test(String(value ?? ''))).slice(0,6);
    return {
      level: guessSecurityLevel(row) || '—',
      module: moduleLabel(row),
      algorithm: normaliseCell(pickValue(row, ['algorithm','algo','seed_key','seedkey','crypt','type']) || 'Algorithm metadata not labelled'),
      unlocks: normaliseCell(pickValue(row, ['unlock','service','routine','access','permission','operation']) || describeRow(row, ['service','routine','access'])),
      blobPreview: blobs.map(([key,value])=>`${key}: ${normaliseCell(value)}`).join('\n') || 'No seed/key BLOB preview detected in visible columns.',
      source: describeRow(row, ['level','security','algorithm','name']),
    };
  });
}

export const AUTO_PROGRAM_EXAMPLES = [
  'Read VIN from BCM',
  'Read all DIDs from PCM',
  'Security access level 3 on PCM',
  'Clear DTCs on ABS',
  'Full vehicle scan',
  'Program ECM with authorized file metadata',
  'Adapt key slot 3',
  'Dump EEPROM range 0x00000000 length 0x0100',
];

export {OPERATION_PRESETS, spacedHex};
