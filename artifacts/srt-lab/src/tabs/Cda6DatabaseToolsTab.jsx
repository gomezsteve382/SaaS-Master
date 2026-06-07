import React, {useMemo, useRef, useState} from 'react';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import reportMarkdown from '../docs/CDA_DB_DECRYPTION_REPORT.md?raw';
import {C} from '../lib/constants.js';
import {Btn, Card, Tag} from '../lib/ui.jsx';
import {DEFAULT_PASSWORD, bytesToHex, prepareCda6DatabaseBytes} from '../lib/cda6DbCodec.js';
import {CONFIG_KEY_HEX, CONFIG_PASSWORD, EHTML_LOG_IV_HEX, EHTML_LOG_KEY_HEX, HTTP_TRAFFIC_IV_HEX, HTTP_TRAFFIC_KEY_HEX, aesCbcDecryptBytes, bytesToBase64, bytesToHex as cryptoBytesToHex, decodeCipherInput, decodePlaintext, decryptCdaConfigBytes, hexToBytes} from '../lib/cda6CryptoTools.js';
import {AUTO_PROGRAM_EXAMPLES, OPERATION_PRESETS, buildAutoProgramPlan, spacedHex as plannerSpacedHex, summarizeSecurityRows} from '../lib/cda6AutoProgramPlanner.js';

const PYTHON_TOOL_PATH = '/tools/decrypt_cda_db.py';
const DEFAULT_ROW_LIMIT = 200;
const GLOBAL_SEARCH_LIMIT = 80;

const KEY_TABLES = [
  {name:'var_ver',label:'ECU variants',hint:'Variant/version records that anchor CDA6 ECU coverage.'},
  {name:'com_ser_var_ver',label:'DIDs and services',hint:'Communication services, DIDs, and variant links.'},
  {name:'msg_new',label:'Message definitions',hint:'Message definitions and payload metadata.'},
  {name:'dtc_to_dtc_set',label:'Trouble codes',hint:'Diagnostic trouble-code set membership.'},
  {name:'routine',label:'Routines',hint:'Routine-control definitions and supported routines.'},
  {name:'security',label:'Security access',hint:'Security-access levels and related metadata.'},
  {name:'ecu_to_bus',label:'Addressing',hint:'ECU-to-bus addressing and network placement.'},
];

let sqlInitPromise;
function loadSqlJs(){
  if(!sqlInitPromise){
    sqlInitPromise = initSqlJs({locateFile:()=>wasmUrl});
  }
  return sqlInitPromise;
}

function quoteIdent(name){
  return `"${String(name).replaceAll('"','""')}"`;
}

function sqlString(value){
  return `'${String(value).replaceAll("'","''")}'`;
}

function formatBytes(size){
  if(size<1024) return `${size} B`;
  if(size<1024*1024) return `${(size/1024).toFixed(1)} KB`;
  return `${(size/(1024*1024)).toFixed(2)} MB`;
}

function normaliseCell(value){
  if(value===null || value===undefined) return '';
  if(value instanceof Uint8Array) return `0x${bytesToHex(value.slice(0,64))}${value.length>64?'...':''}`;
  if(Array.isArray(value)) return `0x${bytesToHex(Uint8Array.from(value).slice(0,64))}${value.length>64?'...':''}`;
  return String(value);
}

function extractFirstResult(db, sql){
  const result = db.exec(sql);
  return result?.[0] || {columns:[],values:[]};
}

function scalar(db, sql, fallback=0){
  try{
    const result = extractFirstResult(db, sql);
    return result.values?.[0]?.[0] ?? fallback;
  }catch(_err){
    return fallback;
  }
}

function rowObjects(result){
  return (result.values || []).map((values)=>Object.fromEntries((result.columns || []).map((column,index)=>[column, values[index]])));
}

function tableInfo(db, tableName){
  const info = extractFirstResult(db, `PRAGMA table_info(${quoteIdent(tableName)})`);
  return rowObjects(info).map((row)=>({
    cid: row.cid,
    name: row.name,
    type: row.type || '',
    notnull: Boolean(row.notnull),
    defaultValue: row.dflt_value,
    pk: Boolean(row.pk),
  }));
}

function loadTableCatalog(db){
  const schemaRows = rowObjects(extractFirstResult(db, "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"));
  return schemaRows.map((entry)=>{
    const columns = tableInfo(db, entry.name);
    const rowCount = entry.type === 'table' ? Number(scalar(db, `SELECT COUNT(*) FROM ${quoteIdent(entry.name)}`, 0)) : null;
    const keyMeta = KEY_TABLES.find((item)=>item.name === entry.name);
    return {
      name: entry.name,
      type: entry.type,
      schema: entry.sql || '',
      columns,
      rowCount,
      isKey: Boolean(keyMeta),
      keyLabel: keyMeta?.label,
      keyHint: keyMeta?.hint,
    };
  });
}

function buildSearchWhere(columns, query){
  const trimmed = query.trim();
  if(!trimmed) return '';
  const like = sqlString(`%${trimmed}%`);
  const searchable = columns.length ? columns : [{name:'rowid'}];
  return searchable.map((column)=>`CAST(${quoteIdent(column.name)} AS TEXT) LIKE ${like}`).join(' OR ');
}

function queryTableRows(db, table, query='', limit=DEFAULT_ROW_LIMIT){
  if(!db || !table) return {columns:[],rows:[],total:0};
  const where = buildSearchWhere(table.columns, query);
  const from = quoteIdent(table.name);
  const countSql = `SELECT COUNT(*) FROM ${from}${where?` WHERE ${where}`:''}`;
  const selectSql = `SELECT * FROM ${from}${where?` WHERE ${where}`:''} LIMIT ${Number(limit) || DEFAULT_ROW_LIMIT}`;
  const result = extractFirstResult(db, selectSql);
  return {columns: result.columns || [], rows: rowObjects(result), total: Number(scalar(db, countSql, 0))};
}

function runGlobalSearch(db, tables, query){
  const trimmed = query.trim();
  if(!db || !trimmed) return [];
  const matches = [];
  for(const table of tables){
    if(matches.length >= GLOBAL_SEARCH_LIMIT) break;
    const where = buildSearchWhere(table.columns, trimmed);
    if(!where) continue;
    const perTableLimit = Math.min(10, GLOBAL_SEARCH_LIMIT - matches.length);
    try{
      const result = extractFirstResult(db, `SELECT * FROM ${quoteIdent(table.name)} WHERE ${where} LIMIT ${perTableLimit}`);
      for(const row of rowObjects(result)){
        matches.push({table: table.name, keyLabel: table.keyLabel, row});
      }
    }catch(_err){
      // Keep searching the remaining tables; malformed legacy views should not block the tool.
    }
  }
  return matches;
}

function downloadBytes(bytes, filename, mime='application/octet-stream'){
  const blob = new Blob([bytes], {type:mime});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function Stat({label,value,accent=C.sr}){
  return <div style={{padding:14,border:`1px solid ${C.bd}`,borderRadius:14,background:C.c2}}>
    <div style={{fontSize:11,fontWeight:900,color:C.ts,letterSpacing:.5,textTransform:'uppercase'}}>{label}</div>
    <div style={{fontSize:22,fontWeight:900,color:accent,marginTop:4}}>{value}</div>
  </div>;
}

function DataTable({columns,rows,maxHeight=440}){
  if(!columns.length){
    return <div style={{padding:24,color:C.ts,border:`1px dashed ${C.bd}`,borderRadius:14,background:C.c2}}>No rows are available for the current selection.</div>;
  }
  return <div style={{overflow:'auto',maxHeight,border:`1px solid ${C.bd}`,borderRadius:14,background:'#fff'}}>
    <table style={{borderCollapse:'collapse',width:'100%',fontSize:12}}>
      <thead style={{position:'sticky',top:0,zIndex:2}}>
        <tr>{columns.map((column)=><th key={column} style={{textAlign:'left',padding:'10px 12px',background:'#2B2B2B',color:'#fff',fontWeight:900,borderRight:'1px solid #444',whiteSpace:'nowrap'}}>{column}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row,index)=><tr key={index} style={{background:index%2?C.c2:'#fff'}}>{columns.map((column)=><td key={column} style={{padding:'9px 12px',borderTop:`1px solid ${C.bd}`,verticalAlign:'top',maxWidth:360,whiteSpace:'pre-wrap',wordBreak:'break-word',fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}}>{normaliseCell(row[column])}</td>)}</tr>)}
      </tbody>
    </table>
  </div>;
}

function EmptyState(){
  return <Card glow style={{minHeight:360,display:'flex',alignItems:'center',justifyContent:'center',textAlign:'center'}}>
    <div style={{maxWidth:760}}>
      <div style={{fontSize:12,fontWeight:900,color:C.sr,letterSpacing:1,textTransform:'uppercase'}}>CDA6 Database Tools</div>
      <h2 style={{fontSize:34,margin:'12px 0 10px',color:C.bk}}>Upload encrypted CDA6 .db files to decrypt and inspect them in-browser.</h2>
      <p style={{fontSize:15,lineHeight:1.7,color:C.ts,margin:0}}>The tool ports the recovered AES-128 page codec to JavaScript, opens the decrypted SQLite database locally with WebAssembly, highlights the most important CDA6 tables, and lets you search across the complete schema without sending the file to a server.</p>
    </div>
  </Card>;
}

function DatabaseSidebar({databases,currentId,onSelect,onRemove}){
  return <Card style={{padding:16}}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:12}}>
      <div style={{fontSize:13,fontWeight:900,color:C.tx}}>Loaded databases</div>
      <Tag color={C.a3}>{databases.length}</Tag>
    </div>
    <div style={{display:'grid',gap:10}}>
      {databases.length===0 && <div style={{fontSize:12,color:C.ts,lineHeight:1.6}}>Batch uploads appear here after decryption.</div>}
      {databases.map((item)=><button key={item.id} onClick={()=>onSelect(item.id)} style={{textAlign:'left',border:`1.5px solid ${currentId===item.id?C.sr:C.bd}`,background:currentId===item.id?'#D32F2F0D':'#fff',borderRadius:14,padding:12,cursor:'pointer'}}>
        <div style={{display:'flex',justifyContent:'space-between',gap:10,alignItems:'start'}}>
          <div style={{fontSize:12,fontWeight:900,color:C.tx,wordBreak:'break-word'}}>{item.fileName}</div>
          <span onClick={(event)=>{event.stopPropagation(); onRemove(item.id);}} style={{fontSize:11,color:C.er,fontWeight:900}}>Remove</span>
        </div>
        <div style={{fontSize:11,color:C.ts,marginTop:6,lineHeight:1.5}}>{formatBytes(item.fileSize)} · {item.tables.length} tables · {item.totalRows.toLocaleString()} rows</div>
        <div style={{marginTop:8,display:'flex',gap:6,flexWrap:'wrap'}}>
          <Tag color={item.alreadyDecrypted?C.a3:C.gn}>{item.alreadyDecrypted?'Plain SQLite':'Decrypted'}</Tag>
          <Tag color={item.integrityOk?C.gn:C.wn}>{item.integrityText}</Tag>
        </div>
      </button>)}
    </div>
  </Card>;
}

function KeyTables({database,onSelect}){
  const tableMap = new Map((database?.tables || []).map((table)=>[table.name, table]));
  return <Card style={{padding:18}}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:14}}>
      <div>
        <div style={{fontSize:13,fontWeight:900,color:C.tx}}>Key CDA6 tables</div>
        <div style={{fontSize:12,color:C.ts,marginTop:3}}>Priority tables requested for ECU variants, services, trouble codes, routines, security, and addressing.</div>
      </div>
      <Tag color={C.a1}>{KEY_TABLES.filter((item)=>tableMap.has(item.name)).length}/{KEY_TABLES.length} found</Tag>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:10}}>
      {KEY_TABLES.map((item)=>{
        const table = tableMap.get(item.name);
        return <button key={item.name} disabled={!table} onClick={()=>table && onSelect(table.name)} style={{textAlign:'left',border:`1px solid ${table?C.bd:'#E5E5E5'}`,background:table?'#fff':'#F4F4F4',borderRadius:14,padding:13,cursor:table?'pointer':'not-allowed',opacity:table?1:.58}}>
          <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
            <div style={{fontSize:12,fontWeight:900,color:C.tx}}>{item.name}</div>
            <Tag color={table?C.gn:C.tm}>{table?'Present':'Missing'}</Tag>
          </div>
          <div style={{fontSize:12,fontWeight:800,color:table?C.sr:C.ts,marginTop:4}}>{item.label}</div>
          <div style={{fontSize:11,color:C.ts,lineHeight:1.45,marginTop:6}}>{item.hint}</div>
          {table && <div style={{fontSize:11,color:C.tx,fontWeight:900,marginTop:8}}>{Number(table.rowCount || 0).toLocaleString()} rows · {table.columns.length} columns</div>}
        </button>;
      })}
    </div>
  </Card>;
}

function BrowserPane({database,selectedTableName,setSelectedTableName,tableFilter,setTableFilter,rowLimit,setRowLimit}){
  const selectedTable = useMemo(()=>database?.tables.find((table)=>table.name===selectedTableName) || database?.tables[0], [database, selectedTableName]);
  const data = useMemo(()=>queryTableRows(database?.db, selectedTable, tableFilter, rowLimit), [database, selectedTable, tableFilter, rowLimit]);
  const filteredTables = useMemo(()=>{
    const q = tableFilter.trim().toLowerCase();
    if(!q) return database?.tables || [];
    return (database?.tables || []).filter((table)=>table.name.toLowerCase().includes(q) || table.columns.some((column)=>column.name.toLowerCase().includes(q)));
  }, [database, tableFilter]);

  if(!database) return <EmptyState/>;

  return <div style={{display:'grid',gridTemplateColumns:'280px minmax(0,1fr)',gap:16,alignItems:'start'}}>
    <Card style={{padding:14}}>
      <div style={{fontSize:13,fontWeight:900,color:C.tx,marginBottom:10}}>Tables and views</div>
      <input value={tableFilter} onChange={(event)=>setTableFilter(event.target.value)} placeholder="Filter tables, columns, or current rows" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:'10px 11px',fontFamily:'Nunito',fontSize:12,outline:'none',marginBottom:10}} />
      <div style={{display:'grid',gap:8,maxHeight:680,overflow:'auto',paddingRight:4}}>
        {filteredTables.map((table)=><button key={table.name} onClick={()=>setSelectedTableName(table.name)} style={{textAlign:'left',border:`1px solid ${selectedTable?.name===table.name?C.sr:C.bd}`,background:selectedTable?.name===table.name?'#D32F2F0D':'#fff',borderRadius:12,padding:10,cursor:'pointer'}}>
          <div style={{display:'flex',justifyContent:'space-between',gap:8,alignItems:'center'}}>
            <span style={{fontSize:12,fontWeight:900,color:C.tx,wordBreak:'break-word'}}>{table.name}</span>
            {table.isKey && <Tag color={C.a1}>Key</Tag>}
          </div>
          <div style={{fontSize:11,color:C.ts,marginTop:4}}>{table.type} · {table.rowCount===null?'view':`${Number(table.rowCount).toLocaleString()} rows`} · {table.columns.length} columns</div>
        </button>)}
      </div>
    </Card>
    <div style={{display:'grid',gap:16}}>
      <Card style={{padding:18}}>
        <div style={{display:'flex',alignItems:'start',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}>
          <div>
            <div style={{fontSize:12,fontWeight:900,color:C.sr,letterSpacing:.5,textTransform:'uppercase'}}>{selectedTable?.type || 'table'}</div>
            <h3 style={{fontSize:24,margin:'5px 0',color:C.tx}}>{selectedTable?.name || 'No table selected'}</h3>
            <div style={{fontSize:12,color:C.ts}}>{data.total.toLocaleString()} matching rows · showing up to {rowLimit}</div>
          </div>
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
            <select value={rowLimit} onChange={(event)=>setRowLimit(Number(event.target.value))} style={{border:`1px solid ${C.bd}`,borderRadius:10,padding:'9px 10px',fontFamily:'Nunito',fontWeight:800,fontSize:12,background:'#fff'}}>
              {[50,100,200,500,1000].map((limit)=><option key={limit} value={limit}>{limit} rows</option>)}
            </select>
            <Btn outline onClick={()=>downloadBytes(database.decryptedBytes, database.downloadName)}>Download decrypted DB</Btn>
          </div>
        </div>
        {selectedTable?.keyHint && <div style={{marginTop:12,padding:12,borderRadius:12,background:'#FF6D0010',border:`1px solid ${C.a1}26`,fontSize:12,color:C.ts}}><strong style={{color:C.a1}}>{selectedTable.keyLabel}:</strong> {selectedTable.keyHint}</div>}
      </Card>
      <Card style={{padding:18}}>
        <div style={{fontSize:13,fontWeight:900,color:C.tx,marginBottom:10}}>Schema</div>
        <pre style={{whiteSpace:'pre-wrap',wordBreak:'break-word',fontSize:12,lineHeight:1.6,margin:0,padding:14,borderRadius:12,background:'#1F1F1F',color:'#F8F8F2',overflow:'auto'}}>{selectedTable?.schema || 'Schema unavailable.'}</pre>
      </Card>
      <Card style={{padding:18}}>
        <DataTable columns={data.columns} rows={data.rows}/>
      </Card>
    </div>
  </div>;
}

function SearchPane({database,globalSearch,setGlobalSearch}){
  const matches = useMemo(()=>runGlobalSearch(database?.db, database?.tables || [], globalSearch), [database, globalSearch]);
  if(!database) return <EmptyState/>;
  return <Card style={{padding:20}}>
    <div style={{display:'flex',justifyContent:'space-between',gap:16,alignItems:'start',flexWrap:'wrap'}}>
      <div>
        <div style={{fontSize:13,fontWeight:900,color:C.tx}}>Search across all tables</div>
        <p style={{fontSize:13,color:C.ts,lineHeight:1.6,margin:'6px 0 0'}}>The global search casts every column to text and scans every table, returning the first {GLOBAL_SEARCH_LIMIT} matching rows. Use this to find DIDs, routine IDs, ECU names, addresses, DTCs, and security-level labels.</p>
      </div>
      <Tag color={C.a3}>{matches.length} matches</Tag>
    </div>
    <input value={globalSearch} onChange={(event)=>setGlobalSearch(event.target.value)} placeholder="Search value, DID, DTC, routine, ECU, address, or service name" style={{width:'100%',boxSizing:'border-box',border:`1.5px solid ${C.bd}`,borderRadius:12,padding:'13px 14px',fontFamily:'Nunito',fontSize:14,outline:'none',margin:'16px 0'}} />
    {!globalSearch.trim() && <div style={{padding:18,border:`1px dashed ${C.bd}`,borderRadius:14,color:C.ts,background:C.c2}}>Enter a search term to scan all loaded CDA6 tables.</div>}
    {globalSearch.trim() && matches.length===0 && <div style={{padding:18,border:`1px dashed ${C.bd}`,borderRadius:14,color:C.ts,background:C.c2}}>No matches were found in the current database.</div>}
    <div style={{display:'grid',gap:10}}>
      {matches.map((match,index)=>{
        const entries = Object.entries(match.row).slice(0,8);
        return <div key={`${match.table}-${index}`} style={{border:`1px solid ${C.bd}`,borderRadius:14,padding:14,background:'#fff'}}>
          <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:8,flexWrap:'wrap'}}>
            <span style={{fontSize:12,fontWeight:900,color:C.sr}}>{match.table}</span>
            {match.keyLabel && <Tag color={C.a1}>{match.keyLabel}</Tag>}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:8}}>
            {entries.map(([key,value])=><div key={key} style={{fontSize:11,lineHeight:1.45,padding:8,borderRadius:10,background:C.c2}}><strong style={{color:C.tx}}>{key}</strong><br/><span style={{fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',color:C.ts,wordBreak:'break-word'}}>{normaliseCell(value)}</span></div>)}
          </div>
        </div>;
      })}
    </div>
  </Card>;
}

function safeTableRows(database, tableName, limit=5000){
  const table = database?.tables?.find((item)=>item.name === tableName);
  if(!database?.db || !table) return [];
  try{
    return rowObjects(extractFirstResult(database.db, `SELECT * FROM ${quoteIdent(tableName)} LIMIT ${Number(limit) || 5000}`));
  }catch(_err){
    return [];
  }
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

function rowSearchText(row){
  return Object.entries(row || {}).map(([key,value])=>`${key}:${normaliseCell(value)}`).join(' ').toLowerCase();
}

function describeRow(row, preferred=[]){
  if(!row) return 'Select a row';
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
  const sid = bytes[0];
  if(sid === 0x00 && bytes.length > 1 && [0x19,0x22,0x2E,0x31].includes(bytes[1])) return true;
  return [0x10,0x11,0x14,0x19,0x22,0x23,0x27,0x28,0x2E,0x2F,0x31,0x34,0x36,0x37,0x3E,0x85].includes(sid);
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
  const candidates = [
    parseLengthPrefixedPayload(bytes, 0, 'le'),
    parseLengthPrefixedPayload(bytes, 0, 'be'),
    parseLengthPrefixedPayload(bytes, 4, 'le'),
    parseLengthPrefixedPayload(bytes, 4, 'be'),
  ].filter(Boolean);
  for(let offset=0; offset<Math.min(bytes.length, 32); offset+=1){
    if(isLikelyUdsPayload(bytes.slice(offset))) candidates.push(bytes.slice(offset));
  }
  const best = candidates
    .map((candidate)=>Array.from(candidate || []))
    .filter((candidate)=>candidate.length && isLikelyUdsPayload(candidate))
    .sort((a,b)=>{
      const aScore = ([0x22,0x2E,0x31,0x27,0x10,0x11,0x14,0x19].includes(a[0]) ? 10 : 0) - a.length;
      const bScore = ([0x22,0x2E,0x31,0x27,0x10,0x11,0x14,0x19].includes(b[0]) ? 10 : 0) - b.length;
      return bScore - aScore;
    })[0];
  return best ? bytesToHex(Uint8Array.from(best)) : '';
}

function commandFromCdaRow(row, fallbackMode='readDid'){
  const xmit = pickValue(row, ['xmit_str','xmit','tx','request','request_bytes','uds_request','command','cmd']);
  const fromXmit = extractUdsFromXmitStr(xmit);
  if(fromXmit){
    if(fallbackMode === 'writeDid' && fromXmit.startsWith('22') && fromXmit.length >= 6) return `2E${fromXmit.slice(2,6)}`;
    return fromXmit;
  }
  const service = fallbackMode === 'writeDid' ? '2E'
    : fallbackMode === 'routine' ? '31'
    : fallbackMode === 'security' ? '27'
    : fallbackMode === 'readDid' ? '22'
    : normalizeHex(pickValue(row, ['uds_service','service','service_id','sid']), '22', 1);
  if(service === '31') return `31${normalizeHex(pickValue(row, ['subfunction','sub_function','routine_subfunction']), '01', 1)}${guessRoutineId(row)}`;
  if(service === '27') return `27${guessSecurityLevel(row)}`;
  const did = guessDid(row);
  if(['22','2E','2F'].includes(service) && did) return `${service}${did}`;
  return service;
}

function spacedHex(hex){
  return String(hex || '').replace(/[^0-9a-fA-F]/g,'').toUpperCase().replace(/(..)/g,'$1 ').trim();
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

function guessDtcCode(row){
  return normalizeHex(pickValue(row, ['dtc','dtc_code','code','trouble_code','fault_code']), '', 3);
}

function guessModuleName(row){
  return normaliseCell(pickValue(row, ['ecu','module','variant','var','name','short_name','address']) || describeRow(row, ['ecu','module','variant','name']));
}

function canAddressInfo(row){
  const request = normalizeHex(pickValue(row, ['request_can_id','req_can_id','request_id','req_id','tester_to_ecu','tx_id','can_req','physical_request','address']), '', 0);
  const response = normalizeHex(pickValue(row, ['response_can_id','resp_can_id','response_id','res_id','ecu_to_tester','rx_id','can_resp','physical_response']), '', 0);
  const bus = normaliseCell(pickValue(row, ['bus','network','can_bus','channel']) || '');
  return {request,response,bus};
}

function filterRows(rows, query){
  const q = String(query || '').trim().toLowerCase();
  if(!q) return rows;
  return rows.filter((row)=>rowSearchText(row).includes(q));
}

function UdsCommandBuilderPane({database}){
  const [ecuIndex,setEcuIndex] = useState(0);
  const [didIndex,setDidIndex] = useState(0);
  const [routineIndex,setRoutineIndex] = useState(0);
  const [securityIndex,setSecurityIndex] = useState(0);
  const [mode,setMode] = useState('readDid');
  const [writeData,setWriteData] = useState('');
  const [routineSub,setRoutineSub] = useState('01');
  const [sessionType,setSessionType] = useState('03');
  const [resetType,setResetType] = useState('01');
  const [manualDid,setManualDid] = useState('');
  const [manualRoutine,setManualRoutine] = useState('');
  const [manualSecurity,setManualSecurity] = useState('');
  const ecuRows = useMemo(()=>safeTableRows(database, 'ecu_to_bus', 3000), [database]);
  const didRows = useMemo(()=>safeTableRows(database, 'com_ser_var_ver', 7000), [database]);
  const routineRows = useMemo(()=>safeTableRows(database, 'routine', 3000), [database]);
  const securityRows = useMemo(()=>safeTableRows(database, 'security', 3000), [database]);
  const ecu = ecuRows[ecuIndex] || ecuRows[0];
  const did = didRows[didIndex] || didRows[0];
  const routine = routineRows[routineIndex] || routineRows[0];
  const security = securityRows[securityIndex] || securityRows[0];
  const didHex = normalizeHex(manualDid, guessDid(did), 2);
  const routineHex = normalizeHex(manualRoutine, guessRoutineId(routine), 2);
  const securityHex = normalizeHex(manualSecurity, guessSecurityLevel(security), 1);
  const dataHex = normalizeHex(writeData, '', 0);
  const command = useMemo(()=>{
    if(mode==='readDid') return commandFromCdaRow(did, 'readDid') || `22${didHex}`;
    if(mode==='writeDid') return `${(commandFromCdaRow(did, 'writeDid') || `2E${didHex}`)}${dataHex}`;
    if(mode==='routine') return commandFromCdaRow(routine, 'routine') || `31${normalizeHex(routineSub,'01',1)}${routineHex}`;
    if(mode==='security') return commandFromCdaRow(security, 'security') || `27${securityHex}`;
    if(mode==='reset') return `11${normalizeHex(resetType,'01',1)}`;
    if(mode==='session') return `10${normalizeHex(sessionType,'03',1)}`;
    return '';
  }, [mode,didHex,dataHex,routineSub,routineHex,securityHex,resetType,sessionType]);
  const ids = canAddressInfo(ecu);
  if(!database) return <EmptyState/>;
  return <Card style={{padding:20}}>
    <div style={{display:'flex',justifyContent:'space-between',gap:18,alignItems:'start',flexWrap:'wrap'}}>
      <div>
        <div style={{fontSize:13,fontWeight:900,color:C.tx}}>UDS Command Builder</div>
        <p style={{fontSize:13,color:C.ts,lineHeight:1.6,margin:'6px 0 0'}}>Build diagnostic request bytes from CDA6 services, routines, security levels, and ECU addressing tables. Guessed identifiers stay editable so ambiguous legacy schemas can still produce exact commands.</p>
      </div>
      <Tag color={C.sr}>CDA6 driven</Tag>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:14,marginTop:16}}>
      <label style={{display:'grid',gap:6,fontSize:12,fontWeight:900,color:C.tx}}>ECU module<select value={ecuIndex} onChange={(event)=>setEcuIndex(Number(event.target.value))} style={{border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'Nunito'}}>{ecuRows.map((row,index)=><option key={index} value={index}>{describeRow(row, ['ecu','module','bus','address'])}</option>)}</select></label>
      <label style={{display:'grid',gap:6,fontSize:12,fontWeight:900,color:C.tx}}>UDS operation<select value={mode} onChange={(event)=>setMode(event.target.value)} style={{border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'Nunito'}}><option value="readDid">ReadDataByIdentifier (0x22)</option><option value="writeDid">WriteDataByIdentifier (0x2E)</option><option value="routine">RoutineControl (0x31)</option><option value="security">SecurityAccess (0x27)</option><option value="reset">ECUReset (0x11)</option><option value="session">DiagnosticSessionControl (0x10)</option></select></label>
      {(mode==='readDid' || mode==='writeDid') && <label style={{display:'grid',gap:6,fontSize:12,fontWeight:900,color:C.tx}}>DID / service row<select value={didIndex} onChange={(event)=>setDidIndex(Number(event.target.value))} style={{border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'Nunito'}}>{didRows.map((row,index)=><option key={index} value={index}>{describeRow(row, ['did','service','name','identifier'])}</option>)}</select></label>}
      {mode==='routine' && <label style={{display:'grid',gap:6,fontSize:12,fontWeight:900,color:C.tx}}>Routine row<select value={routineIndex} onChange={(event)=>setRoutineIndex(Number(event.target.value))} style={{border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'Nunito'}}>{routineRows.map((row,index)=><option key={index} value={index}>{describeRow(row, ['routine','id','name'])}</option>)}</select></label>}
      {mode==='security' && <label style={{display:'grid',gap:6,fontSize:12,fontWeight:900,color:C.tx}}>Security level row<select value={securityIndex} onChange={(event)=>setSecurityIndex(Number(event.target.value))} style={{border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'Nunito'}}>{securityRows.map((row,index)=><option key={index} value={index}>{describeRow(row, ['level','security','algorithm','name'])}</option>)}</select></label>}
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12,marginTop:14}}>
      {(mode==='readDid' || mode==='writeDid') && <label style={{fontSize:12,fontWeight:900,color:C.tx}}>DID hex<input value={manualDid || didHex} onChange={(event)=>setManualDid(event.target.value)} style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>}
      {mode==='writeDid' && <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Write data hex<input value={writeData} onChange={(event)=>setWriteData(event.target.value)} placeholder="Payload bytes after DID" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>}
      {mode==='routine' && <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Routine sub-function<input value={routineSub} onChange={(event)=>setRoutineSub(event.target.value)} style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>}
      {mode==='routine' && <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Routine ID hex<input value={manualRoutine || routineHex} onChange={(event)=>setManualRoutine(event.target.value)} style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>}
      {mode==='security' && <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Security level hex<input value={manualSecurity || securityHex} onChange={(event)=>setManualSecurity(event.target.value)} style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>}
      {mode==='reset' && <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Reset type<input value={resetType} onChange={(event)=>setResetType(event.target.value)} style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>}
      {mode==='session' && <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Session type<input value={sessionType} onChange={(event)=>setSessionType(event.target.value)} style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>}
    </div>
    <div style={{display:'grid',gridTemplateColumns:'minmax(0,1.3fr) minmax(260px,.7fr)',gap:14,marginTop:16}}>
      <div style={{padding:16,borderRadius:14,background:'#1F1F1F',color:'#fff'}}>
        <div style={{fontSize:11,fontWeight:900,color:'#FFB199',letterSpacing:.5,textTransform:'uppercase'}}>UDS request hex</div>
        <div style={{fontSize:26,fontWeight:900,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',wordBreak:'break-word',marginTop:8}}>{spacedHex(command) || '—'}</div>
      </div>
      <div style={{padding:16,borderRadius:14,background:C.c2,border:`1px solid ${C.bd}`}}>
        <div style={{fontSize:12,fontWeight:900,color:C.tx}}>CAN addressing</div>
        <div style={{fontSize:12,color:C.ts,lineHeight:1.7,marginTop:8}}><strong>Request ID:</strong> {ids.request ? `0x${ids.request}` : 'Not detected'}<br/><strong>Response ID:</strong> {ids.response ? `0x${ids.response}` : 'Not detected'}<br/><strong>Bus:</strong> {ids.bus || 'Not detected'}</div>
      </div>
    </div>
  </Card>;
}

function AutoProgramPane({database}){
  const [intent,setIntent] = useState('Read VIN from BCM');
  const [operation,setOperation] = useState('natural');
  const [moduleIndex,setModuleIndex] = useState(0);
  const [params,setParams] = useState({did:'',securityLevel:'',routineId:'',routineSubFunction:'01',sessionType:'03',resetType:'01',memoryAddress:'',memoryLength:'',downloadAddress:'00000000',downloadLength:'00000000'});
  const rows = useMemo(()=>({
    ecuRows: safeTableRows(database, 'ecu_to_bus', 3000),
    didRows: safeTableRows(database, 'com_ser_var_ver', 12000),
    dtcRows: safeTableRows(database, 'dtc_to_dtc_set', 12000),
    routineRows: safeTableRows(database, 'routine', 6000),
    securityRows: safeTableRows(database, 'security', 6000),
    variantRows: safeTableRows(database, 'var_ver', 6000),
    messageRows: safeTableRows(database, 'msg_new', 6000),
  }), [database]);
  const selectedModule = rows.ecuRows[moduleIndex] || rows.ecuRows[0] || null;
  const plan = useMemo(()=>buildAutoProgramPlan({intent, operation, moduleRow:selectedModule, rows, params}), [intent, operation, selectedModule, rows, params]);
  const securitySummary = useMemo(()=>summarizeSecurityRows(rows.securityRows, selectedModule).slice(0,8), [rows.securityRows, selectedModule]);
  const concreteHex = plan.steps.filter((step)=>step.hex).map((step)=>plannerSpacedHex(step.hex));
  const planText = [`${plan.title} — ${plan.moduleLabel}`, plan.summary, `CAN request: ${plan.can.requestDisplay || 'n/a'} response: ${plan.can.responseDisplay || 'n/a'} bus: ${plan.can.bus || 'n/a'}`, '', ...plan.steps.map((step,index)=>`${String(index+1).padStart(2,'0')}. ${step.title}\n   ${step.displayHex || plannerSpacedHex(step.hex) || 'operator placeholder'}\n   ${step.explanation}`)].join('\n');
  const setParam = (key,value)=>setParams((current)=>({...current,[key]:value}));
  if(!database) return <EmptyState/>;
  return <div style={{display:'grid',gap:16}}>
    <Card glow style={{padding:0,overflow:'hidden',border:'1px solid #3B1F1F',background:'linear-gradient(135deg,#141414 0%,#241414 52%,#351313 100%)',color:'#fff'}}>
      <div style={{padding:24,display:'grid',gridTemplateColumns:'minmax(0,1.1fr) minmax(280px,.9fr)',gap:20,alignItems:'start'}}>
        <div>
          <div style={{fontSize:12,fontWeight:900,color:'#FFB199',letterSpacing:1,textTransform:'uppercase'}}>Auto Program Mode</div>
          <h2 style={{fontSize:32,lineHeight:1.1,margin:'8px 0 10px',color:'#fff'}}>CDA6-aware UDS sequence planner</h2>
          <p style={{fontSize:14,lineHeight:1.7,color:'#F4D7D7',margin:0}}>Type an objective in plain English or choose a batch/programming preset. The planner maps CDA6 database rows to ECU addressing, DIDs, routines, security levels, CAN IDs, ISO-TP frames, and a full review-only command sequence.</p>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:14}}>{AUTO_PROGRAM_EXAMPLES.slice(0,6).map((example)=><button key={example} onClick={()=>{setIntent(example); setOperation('natural');}} style={{border:'1px solid #FFFFFF33',background:'#FFFFFF12',color:'#fff',borderRadius:999,padding:'7px 10px',fontSize:11,fontWeight:900,fontFamily:'Nunito',cursor:'pointer'}}>{example}</button>)}</div>
        </div>
        <div style={{display:'grid',gap:10,padding:16,borderRadius:16,background:'#FFFFFF10',border:'1px solid #FFFFFF20'}}>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
            <Stat label="ECUs" value={rows.ecuRows.length.toLocaleString()} accent="#FFB199"/>
            <Stat label="DIDs" value={rows.didRows.length.toLocaleString()} accent="#FFD166"/>
            <Stat label="Routines" value={rows.routineRows.length.toLocaleString()} accent="#8BE9FD"/>
          </div>
          <div style={{fontSize:12,lineHeight:1.6,color:'#F4D7D7'}}><strong style={{color:'#fff'}}>Guardrail:</strong> this is an offline planning/review tool. It does not calculate seed/key bypasses, generate unauthorized flash payloads, or infer unrestricted memory ranges.</div>
        </div>
      </div>
    </Card>

    <Card style={{padding:20}}>
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1.2fr) minmax(260px,.8fr)',gap:16}}>
        <label style={{display:'grid',gap:7,fontSize:12,fontWeight:900,color:C.tx}}>Natural language request<textarea value={intent} onChange={(event)=>setIntent(event.target.value)} placeholder="Examples: unlock PCM, read all DIDs from BCM, clear DTCs on ABS, program ECM with file metadata" rows={4} style={{border:`1.5px solid ${C.bd}`,borderRadius:14,padding:14,fontFamily:'Nunito',fontSize:14,resize:'vertical',lineHeight:1.55}} /></label>
        <div style={{display:'grid',gap:12}}>
          <label style={{display:'grid',gap:7,fontSize:12,fontWeight:900,color:C.tx}}>Planner preset<select value={operation} onChange={(event)=>setOperation(event.target.value)} style={{border:`1px solid ${C.bd}`,borderRadius:12,padding:11,fontFamily:'Nunito'}}>{Object.entries(OPERATION_PRESETS).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
          <label style={{display:'grid',gap:7,fontSize:12,fontWeight:900,color:C.tx}}>Target ECU module<select value={moduleIndex} onChange={(event)=>setModuleIndex(Number(event.target.value))} style={{border:`1px solid ${C.bd}`,borderRadius:12,padding:11,fontFamily:'Nunito'}}>{rows.ecuRows.map((row,index)=><option key={index} value={index}>{describeRow(row, ['ecu','module','bus','address'])}</option>)}</select></label>
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:10,marginTop:14}}>
        <label style={{fontSize:12,fontWeight:900,color:C.tx}}>DID override<input value={params.did} onChange={(event)=>setParam('did', event.target.value)} placeholder="F190" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>
        <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Security level<input value={params.securityLevel} onChange={(event)=>setParam('securityLevel', event.target.value)} placeholder="03" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>
        <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Routine ID<input value={params.routineId} onChange={(event)=>setParam('routineId', event.target.value)} placeholder="FF00" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>
        <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Routine sub<input value={params.routineSubFunction} onChange={(event)=>setParam('routineSubFunction', event.target.value)} placeholder="01" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>
        <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Session<input value={params.sessionType} onChange={(event)=>setParam('sessionType', event.target.value)} placeholder="03" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>
        <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Reset<input value={params.resetType} onChange={(event)=>setParam('resetType', event.target.value)} placeholder="01" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>
        <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Memory address<input value={params.memoryAddress} onChange={(event)=>setParam('memoryAddress', event.target.value)} placeholder="00000000" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>
        <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Memory length<input value={params.memoryLength} onChange={(event)=>setParam('memoryLength', event.target.value)} placeholder="0100" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>
        <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Download address<input value={params.downloadAddress} onChange={(event)=>setParam('downloadAddress', event.target.value)} placeholder="00000000" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>
        <label style={{fontSize:12,fontWeight:900,color:C.tx}}>Download length<input value={params.downloadLength} onChange={(event)=>setParam('downloadLength', event.target.value)} placeholder="00000000" style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label>
      </div>
    </Card>

    <div style={{display:'grid',gridTemplateColumns:'minmax(0,1.15fr) minmax(300px,.85fr)',gap:16,alignItems:'start'}}>
      <Card style={{padding:0,overflow:'hidden',background:'#111',border:'1px solid #2E2E2E'}}>
        <div style={{padding:18,borderBottom:'1px solid #2E2E2E',display:'flex',justifyContent:'space-between',gap:12,alignItems:'center',flexWrap:'wrap'}}>
          <div><div style={{fontSize:12,fontWeight:900,color:'#FFB199',letterSpacing:.6,textTransform:'uppercase'}}>Command output panel</div><div style={{fontSize:20,fontWeight:900,color:'#fff',marginTop:4}}>{plan.title}</div><div style={{fontSize:12,color:'#CDBABA',marginTop:4}}>{plan.summary}</div></div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button onClick={()=>navigator.clipboard?.writeText(planText)} style={{border:'1px solid #FFFFFF30',background:'#FFFFFF12',color:'#fff',borderRadius:12,padding:'10px 12px',fontFamily:'Nunito',fontWeight:900,cursor:'pointer'}}>Copy plan</button><Tag color={plan.can.isExtended?'#8BE9FD':'#70C67A'}>{plan.can.isExtended?'29-bit CAN':'11-bit CAN'}</Tag></div>
        </div>
        <div style={{padding:18,display:'grid',gap:12,maxHeight:760,overflow:'auto'}}>
          {plan.steps.map((step,index)=><div key={index} style={{border:'1px solid #333',borderRadius:16,background:index%2?'#191919':'#151515',padding:15}}>
            <div style={{display:'flex',justifyContent:'space-between',gap:10,alignItems:'start',flexWrap:'wrap'}}><div><div style={{fontSize:11,fontWeight:900,color:'#FFB199'}}>STEP {index+1} · {step.service}</div><div style={{fontSize:15,fontWeight:900,color:'#fff',marginTop:4}}>{step.title}</div></div><Tag color={step.placeholder?'#FFD166':'#70C67A'}>{step.placeholder?'Placeholder':'Concrete'}</Tag></div>
            <div style={{marginTop:10,padding:12,borderRadius:12,background:'#000',border:'1px solid #383838',fontSize:16,fontWeight:900,color:'#F8F8F8',fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',wordBreak:'break-word'}}>{step.displayHex || plannerSpacedHex(step.hex) || '—'}</div>
            <div style={{fontSize:12,lineHeight:1.65,color:'#D8CACA',marginTop:10}}>{step.explanation}</div>
            {step.expectation && <div style={{fontSize:12,lineHeight:1.55,color:'#AEE6B4',marginTop:6}}><strong>Expected response:</strong> {step.expectation}</div>}
            {step.isoTp && <div style={{marginTop:10,padding:10,borderRadius:12,background:'#FFFFFF08',border:'1px solid #FFFFFF14'}}><div style={{fontSize:11,fontWeight:900,color:'#8BE9FD',textTransform:'uppercase'}}>ISO-TP framing · {step.isoTp.frameCount} frame{step.isoTp.frameCount===1?'':'s'}</div><div style={{fontSize:11,color:'#CDBABA',lineHeight:1.5,marginTop:5}}>{step.isoTp.timing}</div><div style={{display:'grid',gap:5,marginTop:7}}>{step.isoTp.frames.map((frame)=><div key={frame.index} style={{display:'grid',gridTemplateColumns:'70px minmax(0,1fr)',gap:8,fontSize:11,color:'#EEE',fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}}><span>{frame.type}</span><span>{frame.canId} · {frame.hex}</span></div>)}</div></div>}
          </div>)}
        </div>
      </Card>

      <div style={{display:'grid',gap:14}}>
        <Card style={{padding:18}}>
          <div style={{fontSize:13,fontWeight:900,color:C.tx}}>Resolved target</div>
          <div style={{fontSize:12,color:C.ts,lineHeight:1.7,marginTop:8}}><strong>Module:</strong> {plan.moduleLabel}<br/><strong>Request CAN ID:</strong> {plan.can.requestDisplay}<br/><strong>Response CAN ID:</strong> {plan.can.responseDisplay}<br/><strong>Bus:</strong> {plan.can.bus || 'Not detected'}<br/><strong>Arbitration:</strong> {plan.can.isExtended?'29-bit extended':'11-bit standard or unknown'}</div>
        </Card>
        <Card style={{padding:18}}>
          <div style={{fontSize:13,fontWeight:900,color:C.tx}}>Raw hex sequence</div>
          <pre style={{whiteSpace:'pre-wrap',wordBreak:'break-word',fontSize:12,lineHeight:1.6,margin:'10px 0 0',padding:12,borderRadius:12,background:C.c2,border:`1px solid ${C.bd}`,color:C.tx}}>{concreteHex.length ? concreteHex.join('\n') : 'Concrete request bytes will appear here after the plan has resolvable parameters.'}</pre>
        </Card>
        <Card style={{padding:18,border:`1px solid ${C.sr}33`,background:'#FFF7F7'}}>
          <div style={{fontSize:13,fontWeight:900,color:C.tx}}>Security Access Reference</div>
          <p style={{fontSize:12,color:C.ts,lineHeight:1.6,margin:'6px 0 12px'}}>CDA6 security rows are summarized for operator review. BLOBs are previewed for evidence only; the planner does not derive seed/key secrets.</p>
          <div style={{display:'grid',gap:10}}>{securitySummary.length ? securitySummary.map((item,index)=><div key={index} style={{padding:10,borderRadius:12,background:'#fff',border:`1px solid ${C.bd}`}}><div style={{fontSize:12,fontWeight:900,color:C.sr}}>Level {item.level}</div><div style={{fontSize:11,color:C.ts,lineHeight:1.5,marginTop:4}}><strong>Algorithm:</strong> {item.algorithm}<br/><strong>Unlocks:</strong> {item.unlocks}</div><pre style={{fontSize:10,whiteSpace:'pre-wrap',wordBreak:'break-word',margin:'6px 0 0',color:C.ts}}>{item.blobPreview}</pre></div>) : <div style={{fontSize:12,color:C.ts}}>No security table rows are available for this database/module.</div>}</div>
        </Card>
        <Card style={{padding:18}}>
          <div style={{fontSize:13,fontWeight:900,color:C.tx}}>Planner warnings</div>
          <div style={{display:'grid',gap:8,marginTop:10}}>{plan.warnings.map((warning,index)=><div key={index} style={{fontSize:12,lineHeight:1.55,color:C.ts,padding:10,borderRadius:10,background:C.c2,border:`1px solid ${C.bd}`}}>{warning}</div>)}</div>
        </Card>
      </div>
    </div>
  </div>;
}

function DtcDecoderPane({database}){
  const [query,setQuery] = useState('');
  const rows = useMemo(()=>safeTableRows(database, 'dtc_to_dtc_set', 10000), [database]);
  const filtered = useMemo(()=>filterRows(rows, query).slice(0,500), [rows, query]);
  if(!database) return <EmptyState/>;
  const columns = Object.keys(filtered[0] || rows[0] || {});
  return <Card style={{padding:20}}>
    <div style={{display:'flex',justifyContent:'space-between',gap:16,alignItems:'start',flexWrap:'wrap'}}><div><div style={{fontSize:13,fontWeight:900,color:C.tx}}>DTC Decoder</div><p style={{fontSize:13,color:C.ts,lineHeight:1.6,margin:'6px 0 0'}}>Browse diagnostic trouble-code mappings from <strong>dtc_to_dtc_set</strong>, including raw hex codes, names, set memberships, and associated ECU/module hints when present.</p></div><Tag color={C.a1}>{rows.length.toLocaleString()} DTC rows</Tag></div>
    <input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Search DTC hex, name, module, or set" style={{width:'100%',boxSizing:'border-box',border:`1.5px solid ${C.bd}`,borderRadius:12,padding:'13px 14px',fontFamily:'Nunito',fontSize:14,outline:'none',margin:'16px 0'}} />
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(210px,1fr))',gap:10,marginBottom:14}}>{filtered.slice(0,12).map((row,index)=><div key={index} style={{border:`1px solid ${C.bd}`,borderRadius:14,padding:13,background:index%2?C.c2:'#fff'}}><div style={{fontSize:18,fontWeight:900,color:C.sr,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}}>0x{guessDtcCode(row) || '—'}</div><div style={{fontSize:12,fontWeight:900,color:C.tx,marginTop:4}}>{normaliseCell(pickValue(row, ['name','dtc_name','description','text','label']) || 'Unnamed DTC')}</div><div style={{fontSize:11,color:C.ts,lineHeight:1.45,marginTop:5}}>{guessModuleName(row)}</div></div>)}</div>
    <DataTable columns={columns} rows={filtered} maxHeight={560}/>
  </Card>;
}

function SecurityReferencePane({database}){
  const [query,setQuery] = useState('');
  const rows = useMemo(()=>safeTableRows(database, 'security', 7000), [database]);
  const filtered = useMemo(()=>filterRows(rows, query).slice(0,500), [rows, query]);
  if(!database) return <EmptyState/>;
  const columns = Object.keys(filtered[0] || rows[0] || {});
  return <Card style={{padding:20}}>
    <div style={{display:'flex',justifyContent:'space-between',gap:16,alignItems:'start',flexWrap:'wrap'}}><div><div style={{fontSize:13,fontWeight:900,color:C.tx}}>Security Access Reference</div><p style={{fontSize:13,color:C.ts,lineHeight:1.6,margin:'6px 0 0'}}>Summarize security levels per ECU, algorithm metadata, and the services/routines each level appears to unlock from the CDA6 security table.</p></div><Tag color={C.sr}>{rows.length.toLocaleString()} security rows</Tag></div>
    <input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Search ECU, level, algorithm, seed/key, routine, or service" style={{width:'100%',boxSizing:'border-box',border:`1.5px solid ${C.bd}`,borderRadius:12,padding:'13px 14px',fontFamily:'Nunito',fontSize:14,outline:'none',margin:'16px 0'}} />
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(230px,1fr))',gap:10,marginBottom:14}}>{filtered.slice(0,12).map((row,index)=>{const algorithm=normaliseCell(pickValue(row, ['algorithm','algo','seed_key','seedkey','crypt','type']) || 'Algorithm not labelled'); const unlocks=normaliseCell(pickValue(row, ['unlock','service','routine','access','permission','operation']) || describeRow(row, ['service','routine','access'])); return <div key={index} style={{border:`1px solid ${C.bd}`,borderRadius:14,padding:13,background:'#fff'}}><div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}><Tag color={C.a3}>Level 0x{guessSecurityLevel(row) || '—'}</Tag><span style={{fontSize:12,fontWeight:900,color:C.tx}}>{guessModuleName(row)}</span></div><div style={{fontSize:12,color:C.ts,lineHeight:1.55,marginTop:8}}><strong style={{color:C.tx}}>Algorithm:</strong> {algorithm}<br/><strong style={{color:C.tx}}>Unlocks:</strong> {unlocks}</div></div>;})}</div>
    <DataTable columns={columns} rows={filtered} maxHeight={560}/>
  </Card>;
}

function AesUtilityPane(){
  const [trafficInput,setTrafficInput] = useState('');
  const [trafficEncoding,setTrafficEncoding] = useState('auto');
  const [trafficResult,setTrafficResult] = useState(null);
  const [trafficError,setTrafficError] = useState('');
  const [logInput,setLogInput] = useState('');
  const [logIv,setLogIv] = useState(EHTML_LOG_IV_HEX);
  const [logResult,setLogResult] = useState(null);
  const [logError,setLogError] = useState('');
  const [configInput,setConfigInput] = useState('');
  const [configResult,setConfigResult] = useState(null);
  const [configError,setConfigError] = useState('');

  function runTraffic(){
    setTrafficError(''); setTrafficResult(null);
    try{
      const cipherBytes = decodeCipherInput(trafficInput, trafficEncoding);
      const plainBytes = aesCbcDecryptBytes(cipherBytes, hexToBytes(HTTP_TRAFFIC_KEY_HEX), hexToBytes(HTTP_TRAFFIC_IV_HEX), {padding:'null'});
      setTrafficResult({text:decodePlaintext(plainBytes), hex:cryptoBytesToHex(plainBytes), base64:bytesToBase64(plainBytes)});
    }catch(err){ setTrafficError(err?.message || String(err)); }
  }
  async function handleLogFiles(files){
    const file = Array.from(files || [])[0];
    if(!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    setLogInput(cryptoBytesToHex(bytes));
  }
  async function handleConfigFiles(files){
    const file = Array.from(files || [])[0];
    if(!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    setConfigInput(cryptoBytesToHex(bytes));
  }
  function runLog(){
    setLogError(''); setLogResult(null);
    try{
      const cipherBytes = decodeCipherInput(logInput, 'auto');
      const plainBytes = aesCbcDecryptBytes(cipherBytes, hexToBytes(EHTML_LOG_KEY_HEX), hexToBytes(logIv || EHTML_LOG_IV_HEX), {padding:'null'});
      setLogResult({text:decodePlaintext(plainBytes), hex:cryptoBytesToHex(plainBytes), base64:bytesToBase64(plainBytes)});
    }catch(err){ setLogError(err?.message || String(err)); }
  }
  function runConfig(){
    setConfigError(''); setConfigResult(null);
    try{
      const cipherBytes = decodeCipherInput(configInput, 'auto');
      const result = decryptCdaConfigBytes(cipherBytes, CONFIG_PASSWORD);
      setConfigResult(result);
    }catch(err){ setConfigError(err?.message || String(err)); }
  }
  const Output = ({result,error}) => <div style={{marginTop:12}}>{error && <div style={{padding:12,borderRadius:12,background:'#FFF5F5',border:`1px solid ${C.er}44`,fontSize:12,color:C.er,lineHeight:1.5}}>{error}</div>}{result && <div style={{display:'grid',gap:10}}><textarea readOnly value={result.text} style={{width:'100%',minHeight:110,boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:12,padding:12,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:12}}/><details><summary style={{cursor:'pointer',fontSize:12,fontWeight:900,color:C.tx}}>Raw output encodings</summary><pre style={{whiteSpace:'pre-wrap',wordBreak:'break-word',fontSize:11,lineHeight:1.55,background:C.c2,border:`1px solid ${C.bd}`,borderRadius:12,padding:12}}>{`hex=${result.hex}\nbase64=${result.base64 || ''}${result.keyBytes ? `\nderivedKey=${cryptoBytesToHex(result.keyBytes)}\nsalt=${result.saltHex || ''}` : ''}`}</pre></details></div>}</div>;
  return <div style={{display:'grid',gap:16}}>
    <Card style={{padding:20}}><div style={{fontSize:13,fontWeight:900,color:C.tx}}>HTTP Traffic Decryptor</div><p style={{fontSize:13,color:C.ts,lineHeight:1.6}}>AES-128-CBC decryptor for captured CDA HTTP traffic using the supplied static key and IV.</p><textarea value={trafficInput} onChange={(event)=>setTrafficInput(event.target.value)} placeholder="Paste encrypted hex or base64 traffic" style={{width:'100%',minHeight:120,boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:12,padding:12,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:12}}/><div style={{display:'flex',gap:10,alignItems:'center',marginTop:10,flexWrap:'wrap'}}><select value={trafficEncoding} onChange={(event)=>setTrafficEncoding(event.target.value)} style={{border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'Nunito'}}><option value="auto">Auto-detect</option><option value="hex">Hex</option><option value="base64">Base64</option></select><Btn onClick={runTraffic}>Decrypt traffic</Btn><Tag color={C.a3}>AES-128-CBC</Tag></div><div style={{fontSize:11,color:C.ts,marginTop:8,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}}>key={HTTP_TRAFFIC_KEY_HEX} · iv={HTTP_TRAFFIC_IV_HEX}</div><Output result={trafficResult} error={trafficError}/></Card>
    <Card style={{padding:20}}><div style={{fontSize:13,fontWeight:900,color:C.tx}}>Log File Decryptor (.ehtml)</div><p style={{fontSize:13,color:C.ts,lineHeight:1.6}}>Upload or paste encrypted .ehtml content. The IV is editable because CBC log containers may either reuse a known IV or carry one alongside the encrypted content.</p><input type="file" accept=".ehtml,.html,.txt,application/octet-stream" onChange={(event)=>handleLogFiles(event.target.files)} style={{marginBottom:10}}/><textarea value={logInput} onChange={(event)=>setLogInput(event.target.value)} placeholder="Paste encrypted log data as hex or base64" style={{width:'100%',minHeight:120,boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:12,padding:12,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:12}}/><label style={{display:'block',fontSize:12,fontWeight:900,color:C.tx,marginTop:10}}>IV hex<input value={logIv} onChange={(event)=>setLogIv(event.target.value)} style={{width:'100%',boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:10,padding:10,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}} /></label><div style={{display:'flex',gap:10,alignItems:'center',marginTop:10,flexWrap:'wrap'}}><Btn onClick={runLog}>Decrypt log</Btn><Tag color={C.sr}>key {EHTML_LOG_KEY_HEX}</Tag></div><Output result={logResult} error={logError}/></Card>
    <Card style={{padding:20}}><div style={{fontSize:13,fontWeight:900,color:C.tx}}>Config File Decryptor</div><p style={{fontSize:13,color:C.ts,lineHeight:1.6}}>AES-128-ECB decryptor for CDA.swf Cryptographer files. The AES key is MD5(password bytes), with PKCS5/PKCS7 padding.</p><input type="file" accept=".cfg,.config,.xml,.txt,application/octet-stream" onChange={(event)=>handleConfigFiles(event.target.files)} style={{marginBottom:10}}/><textarea value={configInput} onChange={(event)=>setConfigInput(event.target.value)} placeholder="Paste encrypted config bytes as hex or base64" style={{width:'100%',minHeight:120,boxSizing:'border-box',border:`1px solid ${C.bd}`,borderRadius:12,padding:12,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:12}}/><div style={{display:'flex',gap:10,alignItems:'center',marginTop:10,flexWrap:'wrap'}}><Btn onClick={runConfig}>Decrypt config</Btn><Tag color={C.a1}>password {CONFIG_PASSWORD}</Tag><Tag color={C.sr}>MD5 key {CONFIG_KEY_HEX}</Tag></div><Output result={configResult} error={configError}/></Card>
  </div>;
}

function DocumentationPane(){
  return <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 320px',gap:16,alignItems:'start'}}>
    <Card style={{padding:22}}>
      <div style={{fontSize:12,fontWeight:900,color:C.sr,letterSpacing:.7,textTransform:'uppercase'}}>Reverse-engineering report</div>
      <h3 style={{fontSize:26,margin:'6px 0 12px',color:C.tx}}>CDA DB Decryption Report</h3>
      <pre style={{whiteSpace:'pre-wrap',wordBreak:'break-word',fontSize:13,lineHeight:1.65,margin:0,padding:18,borderRadius:14,background:C.c2,border:`1px solid ${C.bd}`,color:C.tx}}>{reportMarkdown}</pre>
    </Card>
    <Card glow style={{padding:20,position:'sticky',top:16}}>
      <div style={{fontSize:13,fontWeight:900,color:C.tx}}>Downloadable tool</div>
      <p style={{fontSize:13,color:C.ts,lineHeight:1.65}}>The original Python decryptor is bundled for offline workflows and verification against browser results. It uses the same password, key expansion, page IV, and OFB-like AES-ECB keystream.</p>
      <a href={PYTHON_TOOL_PATH} download="decrypt_cda_db.py" style={{textDecoration:'none'}}><Btn full>Download Python decryptor</Btn></a>
      <div style={{marginTop:16,padding:12,borderRadius:12,background:'#D32F2F0D',border:`1px solid ${C.sr}22`,fontSize:12,lineHeight:1.6,color:C.ts}}>
        <strong style={{color:C.sr}}>Codec summary:</strong> password {DEFAULT_PASSWORD}, AES-128 key 3253696d706c65324775337373325369, 1024-byte pages, 12-byte reserve trailer, and page-1 plaintext bytes 16-23.
      </div>
    </Card>
  </div>;
}

export default function Cda6DatabaseToolsTab(){
  const fileInputRef = useRef(null);
  const [databases,setDatabases] = useState([]);
  const [currentId,setCurrentId] = useState(null);
  const [activeView,setActiveView] = useState('browser');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [selectedTableName,setSelectedTableName] = useState('');
  const [tableFilter,setTableFilter] = useState('');
  const [globalSearch,setGlobalSearch] = useState('');
  const [rowLimit,setRowLimit] = useState(DEFAULT_ROW_LIMIT);

  const currentDb = useMemo(()=>databases.find((db)=>db.id===currentId) || databases[0], [databases, currentId]);

  async function handleFiles(files){
    const selectedFiles = Array.from(files || []);
    if(!selectedFiles.length) return;
    setBusy(true);
    setError('');
    try{
      const SQL = await loadSqlJs();
      const loaded = [];
      for(const [index,file] of selectedFiles.entries()){
        try{
          const raw = new Uint8Array(await file.arrayBuffer());
          const prepared = prepareCda6DatabaseBytes(raw, {password:DEFAULT_PASSWORD});
          if(!prepared.sqliteHeaderOk){
            throw new Error('Decryption completed, but the output does not start with a SQLite header.');
          }
          const db = new SQL.Database(prepared.bytes);
          const integrityText = String(scalar(db, 'PRAGMA integrity_check', 'not checked'));
          const tables = loadTableCatalog(db);
          const totalRows = tables.reduce((sum,table)=>sum + (Number(table.rowCount) || 0), 0);
          const id = `${Date.now()}-${index}-${file.name}`;
          loaded.push({
            id,
            db,
            fileName:file.name,
            fileSize:file.size,
            downloadName:file.name.replace(/(\.db|\.sqlite)?$/i,'.decrypted.db'),
            decryptedBytes:prepared.bytes,
            alreadyDecrypted:prepared.alreadyDecrypted,
            cipherName:prepared.cipherName,
            keyHex:prepared.keyHex,
            pageSize:prepared.pageSize,
            reserve:prepared.reserve,
            integrityText,
            integrityOk:integrityText.toLowerCase()==='ok',
            tables,
            totalRows,
          });
        }catch(fileError){
          loaded.push({
            id:`${Date.now()}-${index}-${file.name}-error`,
            fileName:file.name,
            fileSize:file.size,
            error:fileError?.message || String(fileError),
            tables:[],
            totalRows:0,
            integrityText:'error',
            integrityOk:false,
          });
        }
      }
      const usable = loaded.filter((item)=>!item.error);
      const failed = loaded.filter((item)=>item.error);
      setDatabases((existing)=>[...existing, ...usable]);
      if(usable.length){
        setCurrentId((existing)=>existing || usable[0].id);
        setSelectedTableName((existing)=>existing || usable[0].tables.find((table)=>table.isKey)?.name || usable[0].tables[0]?.name || '');
      }
      if(failed.length){
        setError(failed.map((item)=>`${item.fileName}: ${item.error}`).join('\n'));
      }
    }catch(err){
      setError(err?.message || String(err));
    }finally{
      setBusy(false);
      if(fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function removeDatabase(id){
    setDatabases((existing)=>{
      const removed = existing.find((item)=>item.id===id);
      try{ removed?.db?.close?.(); }catch(_err){}
      const next = existing.filter((item)=>item.id!==id);
      if(currentId===id){
        setCurrentId(next[0]?.id || null);
        setSelectedTableName(next[0]?.tables?.find((table)=>table.isKey)?.name || next[0]?.tables?.[0]?.name || '');
      }
      return next;
    });
  }

  function selectTable(name){
    setSelectedTableName(name);
    setActiveView('browser');
  }

  return <div style={{display:'grid',gap:18}}>
    <Card glow style={{padding:24,background:'linear-gradient(135deg,#FFFFFF 0%,#FFF7F7 100%)'}}>
      <div style={{display:'flex',justifyContent:'space-between',gap:20,alignItems:'start',flexWrap:'wrap'}}>
        <div style={{maxWidth:860}}>
          <div style={{fontSize:12,fontWeight:900,color:C.sr,letterSpacing:1,textTransform:'uppercase'}}>CDA6 Database Tools</div>
          <h1 style={{fontSize:34,margin:'8px 0 10px',color:C.tx}}>CDA6 Database Decryptor and Viewer</h1>
          <p style={{fontSize:15,lineHeight:1.7,color:C.ts,margin:0}}>Upload one or more encrypted CDA6 SQLite databases, decrypt each page locally using the recovered AES-128 OFB-like codec, browse schemas and rows, highlight critical reverse-engineering tables, and search across the full database.</p>
        </div>
        <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
          <input ref={fileInputRef} type="file" multiple accept=".db,.sqlite,.sqlite3,application/octet-stream" onChange={(event)=>handleFiles(event.target.files)} style={{display:'none'}} />
          <Btn onClick={()=>fileInputRef.current?.click()} disabled={busy}>{busy?'Processing...':'Upload CDA6 .db files'}</Btn>
          <a href={PYTHON_TOOL_PATH} download="decrypt_cda_db.py" style={{textDecoration:'none'}}><Btn outline>Python script</Btn></a>
        </div>
      </div>
    </Card>

    {error && <Card style={{padding:16,border:`1.5px solid ${C.er}55`,background:'#FFF5F5'}}><pre style={{margin:0,whiteSpace:'pre-wrap',fontSize:12,lineHeight:1.6,color:C.er,fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}}>{error}</pre></Card>}

    <div style={{display:'grid',gridTemplateColumns:'310px minmax(0,1fr)',gap:18,alignItems:'start'}}>
      <div style={{display:'grid',gap:14}}>
        <DatabaseSidebar databases={databases} currentId={currentDb?.id} onSelect={(id)=>{setCurrentId(id); const db=databases.find((item)=>item.id===id); setSelectedTableName(db?.tables?.find((table)=>table.isKey)?.name || db?.tables?.[0]?.name || '');}} onRemove={removeDatabase}/>
        {currentDb && <Card style={{padding:16}}>
          <div style={{fontSize:13,fontWeight:900,color:C.tx,marginBottom:12}}>Codec metadata</div>
          <div style={{display:'grid',gap:8,fontSize:12,color:C.ts,lineHeight:1.5}}>
            <div><strong style={{color:C.tx}}>Cipher:</strong> {currentDb.cipherName?.toUpperCase()}</div>
            <div><strong style={{color:C.tx}}>Page:</strong> {currentDb.pageSize} bytes · reserve {currentDb.reserve}</div>
            <div><strong style={{color:C.tx}}>Key:</strong> <span style={{fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace'}}>{currentDb.keyHex}</span></div>
            <div><strong style={{color:C.tx}}>Integrity:</strong> {currentDb.integrityText}</div>
          </div>
        </Card>}
      </div>

      <div style={{display:'grid',gap:16,minWidth:0}}>
        {currentDb && <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:12}}>
          <Stat label="Tables" value={currentDb.tables.length}/>
          <Stat label="Rows" value={currentDb.totalRows.toLocaleString()} accent={C.a1}/>
          <Stat label="Key tables" value={`${currentDb.tables.filter((table)=>table.isKey).length}/${KEY_TABLES.length}`} accent={C.a3}/>
          <Stat label="Mode" value={currentDb.alreadyDecrypted?'Plain':'Decrypted'} accent={currentDb.alreadyDecrypted?C.a3:C.gn}/>
        </div>}

        {currentDb && <KeyTables database={currentDb} onSelect={selectTable}/>} 

        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {[
            ['auto','Auto Program'],
            ['browser','Browse tables'],
            ['search','Search all tables'],
            ['uds','UDS Command Builder'],
            ['dtc','DTC Decoder'],
            ['security','Security Reference'],
            ['crypto','Traffic / Log / Config Decryptors'],
            ['docs','RE report and tools'],
          ].map(([id,label])=><button key={id} onClick={()=>setActiveView(id)} style={{border:`1.5px solid ${activeView===id?C.sr:C.bd}`,background:activeView===id?C.sr:'#fff',color:activeView===id?'#fff':C.tx,borderRadius:12,padding:'10px 14px',fontFamily:'Nunito',fontWeight:900,fontSize:12,cursor:'pointer'}}>{label}</button>)}
        </div>

        {activeView==='auto' && <AutoProgramPane database={currentDb}/>} 
        {activeView==='browser' && <BrowserPane database={currentDb} selectedTableName={selectedTableName} setSelectedTableName={setSelectedTableName} tableFilter={tableFilter} setTableFilter={setTableFilter} rowLimit={rowLimit} setRowLimit={setRowLimit}/>} 
        {activeView==='search' && <SearchPane database={currentDb} globalSearch={globalSearch} setGlobalSearch={setGlobalSearch}/>} 
        {activeView==='uds' && <UdsCommandBuilderPane database={currentDb}/>} 
        {activeView==='dtc' && <DtcDecoderPane database={currentDb}/>} 
        {activeView==='security' && <SecurityReferencePane database={currentDb}/>} 
        {activeView==='crypto' && <AesUtilityPane/>} 
        {activeView==='docs' && <DocumentationPane/>}
      </div>
    </div>
  </div>;
}
