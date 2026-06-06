/**
 * ChecksumCalculatorTab.jsx
 * Checksum Calculator — CB Master Premium v6 Stellantis 2025
 *
 * Algorithms:
 *   1. ADD16 + NOT   — RFH Continental RAM (TRA), RFH RAM Chrysler
 *   2. 16-bit Linear — BCM Fujitsu MB91F526 (Argo, Cronos, Toro, Renegade B1)
 *   3. CRC16-CCITT   — RFH C200 (Chrysler 200 sync block)
 *   4. F2 8-bit      — BCM Renesas R7F70xxxx (Compass MP, Renegade BU) — READ ONLY
 *
 * Source: CB-MasterPremium-Stellantis2026-CB-2026-0094 pages 43-44
 */

import React, { useState, useMemo } from 'react';
import { C } from '../lib/constants.js';
import { Card, Tag, Btn, SLine } from '../lib/ui.jsx';
import { CB_CHECKSUM_ALGOS } from '../lib/udsEngine.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseHexInput(raw) {
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, '').replace(/0x/gi, '');
  if (!/^[0-9A-Fa-f]*$/.test(clean) || clean.length % 2 !== 0) return null;
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  return bytes;
}

const fmtHex16 = (v) => '0x' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const fmtHex8 = (v) => '0x' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const fmtBytes = (arr) => arr.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

// ─── Algorithm Card ───────────────────────────────────────────────────────────
function AlgoPanel({ algo, active, onSelect }) {
  return (
    <div
      onClick={onSelect}
      style={{
        padding: '12px 16px', borderRadius: 10, cursor: 'pointer', transition: 'all 0.2s',
        background: active ? C.a1 + '12' : C.c2,
        border: `1.5px solid ${active ? C.a1 : C.bd}`,
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ fontSize: 13, fontWeight: 800, color: active ? C.a1 : C.bk }}>{algo.name}</span>
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
            {algo.modules.map(m => <Tag key={m} color={C.a2}>{m}</Tag>)}
          </div>
        </div>
        <div style={{
          width: 20, height: 20, borderRadius: '50%',
          border: `2px solid ${active ? C.a1 : C.bd}`,
          background: active ? C.a1 : 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {active && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff' }} />}
        </div>
      </div>
      <div style={{ fontSize: 11, color: C.ts, marginTop: 6 }}>{algo.desc}</div>
    </div>
  );
}

// ─── ADD16 + NOT Calculator ───────────────────────────────────────────────────
function Add16NotCalc() {
  const [input, setInput] = useState('');
  const result = useMemo(() => {
    const bytes = parseHexInput(input);
    if (!bytes || bytes.length === 0) return null;
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xFFFF;
    const notSum = (~sum) & 0xFFFF;
    const hiLo = [(notSum >> 8) & 0xFF, notSum & 0xFF];
    return { sum, notSum, hiLo, byteCount: bytes.length };
  }, [input]);

  return (
    <div>
      <div style={{ fontSize: 11, color: C.ts, marginBottom: 8 }}>
        Paste the block bytes (hex, space-separated). The checksum is ADD16 of all bytes, then bitwise NOT.
      </div>
      <textarea
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="00 1A 2B 3C ... (paste full block)"
        rows={4}
        style={{
          width: '100%', padding: '10px 12px', borderRadius: 8,
          border: `1.5px solid ${C.bd}`, background: C.c2, color: C.bk,
          fontFamily: 'monospace', fontSize: 12, resize: 'vertical', boxSizing: 'border-box',
        }}
      />
      {result && (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div style={{ padding: '10px 14px', borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}` }}>
            <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>ADD16 (sum)</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.bk, fontFamily: 'monospace' }}>{fmtHex16(result.sum)}</div>
          </div>
          <div style={{ padding: '10px 14px', borderRadius: 8, background: C.gn + '10', border: `1.5px solid ${C.gn}40` }}>
            <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>NOT (checksum to write)</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.gn, fontFamily: 'monospace' }}>{fmtHex16(result.notSum)}</div>
          </div>
          <div style={{ padding: '10px 14px', borderRadius: 8, background: C.a1 + '10', border: `1.5px solid ${C.a1}40` }}>
            <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>Bytes to write (HI LO)</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.a1, fontFamily: 'monospace' }}>{fmtBytes(result.hiLo)}</div>
          </div>
        </div>
      )}
      {result && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.ts }}>
          Block: {result.byteCount} bytes · ADD16 = {fmtHex16(result.sum)} · NOT = {fmtHex16(result.notSum)}
        </div>
      )}
    </div>
  );
}

// ─── 16-bit Linear Calculator ─────────────────────────────────────────────────
function Linear16Calc() {
  const [input, setInput] = useState('');
  const [blockSize, setBlockSize] = useState('64');
  const result = useMemo(() => {
    const bytes = parseHexInput(input);
    if (!bytes || bytes.length === 0) return null;
    const bs = parseInt(blockSize) || bytes.length;
    const blocks = [];
    for (let i = 0; i < bytes.length; i += bs) {
      const block = bytes.slice(i, i + bs);
      let sum = 0;
      for (const b of block) sum = (sum + b) & 0xFFFF;
      blocks.push({ index: blocks.length, offset: i, bytes: block.length, sum });
    }
    return { blocks, totalBytes: bytes.length };
  }, [input, blockSize]);

  return (
    <div>
      <div style={{ fontSize: 11, color: C.ts, marginBottom: 8 }}>
        16-bit linear sum of block bytes. For BCM Fujitsu: 64B blocks (Argo/Cronos/Toro) or 28B blocks (Renegade B1).
        Δ=+1 when cfg byte passes 01→02 in dual-block pattern.
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10, alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>Block size (bytes)</div>
          <select
            value={blockSize}
            onChange={e => setBlockSize(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${C.bd}`, background: C.c2, color: C.bk, fontSize: 12 }}
          >
            <option value="64">64 (Argo/Cronos/Toro)</option>
            <option value="28">28 (Renegade B1)</option>
            <option value="0">Full input (single block)</option>
          </select>
        </div>
      </div>
      <textarea
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="Paste block bytes (hex, space-separated)"
        rows={4}
        style={{
          width: '100%', padding: '10px 12px', borderRadius: 8,
          border: `1.5px solid ${C.bd}`, background: C.c2, color: C.bk,
          fontFamily: 'monospace', fontSize: 12, resize: 'vertical', boxSizing: 'border-box',
        }}
      />
      {result && result.blocks.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {result.blocks.map(blk => (
            <div key={blk.index} style={{
              display: 'flex', gap: 12, alignItems: 'center',
              padding: '8px 14px', borderRadius: 8, background: C.c2,
              border: `1px solid ${C.bd}`, marginBottom: 6,
            }}>
              <span style={{ fontSize: 11, color: C.ts, minWidth: 60 }}>Block {blk.index + 1}</span>
              <span style={{ fontSize: 11, color: C.tm, minWidth: 80 }}>@ 0x{blk.offset.toString(16).toUpperCase()}</span>
              <span style={{ fontSize: 11, color: C.ts, minWidth: 60 }}>{blk.bytes}B</span>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.gn, fontFamily: 'monospace' }}>{fmtHex16(blk.sum)}</span>
              <span style={{ fontSize: 11, color: C.ts }}>({blk.sum})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── CRC16-CCITT Calculator ───────────────────────────────────────────────────
function Crc16CcittCalc() {
  const [input, setInput] = useState('');
  const result = useMemo(() => {
    const bytes = parseHexInput(input);
    if (!bytes || bytes.length === 0) return null;
    let crc = 0xFFFF;
    for (const b of bytes) {
      crc ^= (b << 8);
      for (let i = 0; i < 8; i++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xFFFF;
      }
    }
    const hiLo = [(crc >> 8) & 0xFF, crc & 0xFF];
    return { crc, hiLo, byteCount: bytes.length };
  }, [input]);

  return (
    <div>
      <div style={{ fontSize: 11, color: C.ts, marginBottom: 8 }}>
        CRC16-CCITT (poly 0x1021, init 0xFFFF). Used for Chrysler 200 RFH sync block (6 bytes → 2-byte CRC at offset+6).
      </div>
      <textarea
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder="3D 6E 11 38 5C 4C (paste 6 sync bytes)"
        rows={2}
        style={{
          width: '100%', padding: '10px 12px', borderRadius: 8,
          border: `1.5px solid ${C.bd}`, background: C.c2, color: C.bk,
          fontFamily: 'monospace', fontSize: 12, resize: 'none', boxSizing: 'border-box',
        }}
      />
      {result && (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ padding: '10px 14px', borderRadius: 8, background: C.gn + '10', border: `1.5px solid ${C.gn}40` }}>
            <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>CRC16-CCITT</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.gn, fontFamily: 'monospace' }}>{fmtHex16(result.crc)}</div>
          </div>
          <div style={{ padding: '10px 14px', borderRadius: 8, background: C.a1 + '10', border: `1.5px solid ${C.a1}40` }}>
            <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>Bytes to write (HI LO)</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.a1, fontFamily: 'monospace' }}>{fmtBytes(result.hiLo)}</div>
          </div>
        </div>
      )}
      {result && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.ts }}>
          Input: {result.byteCount} bytes · CRC = {fmtHex16(result.crc)}
        </div>
      )}
    </div>
  );
}

// ─── F2 8-bit Calculator ──────────────────────────────────────────────────────
function F2_8bitCalc() {
  const [hiInput, setHiInput] = useState('');
  const [loInput, setLoInput] = useState('');
  const [kInput, setKInput] = useState('1');

  const result = useMemo(() => {
    const hi = parseInt(hiInput, 16);
    const lo = parseInt(loInput, 16);
    const k = parseInt(kInput) || 1;
    if (isNaN(hi) || isNaN(lo)) return null;
    const cs = (~(hi + lo + k)) & 0xFF;
    return { hi, lo, k, cs };
  }, [hiInput, loInput, kInput]);

  return (
    <div>
      <div style={{ marginBottom: 10, padding: '10px 14px', borderRadius: 8, background: C.er + '08', border: `1px solid ${C.er}30` }}>
        <SLine type="warn" msg="BCM Renesas R7F70xxxx (Compass MP, Renegade BU) is READ ONLY. Writing without valid OEM signature bricks the chip irreversibly. This calculator is for verification only." />
      </div>
      <div style={{ fontSize: 11, color: C.ts, marginBottom: 10 }}>
        Formula: cs = (~(HI + LO + K)) &amp; 0xFF · K = 1, 2, or 3 depending on FW version.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>HI byte (hex)</div>
          <input value={hiInput} onChange={e => setHiInput(e.target.value)} placeholder="A3"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.bk, fontFamily: 'monospace', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>LO byte (hex)</div>
          <input value={loInput} onChange={e => setLoInput(e.target.value)} placeholder="5F"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.bk, fontFamily: 'monospace', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>K value</div>
          <select value={kInput} onChange={e => setKInput(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1.5px solid ${C.bd}`, background: C.c2, color: C.bk, fontSize: 12, boxSizing: 'border-box' }}>
            <option value="1">K=1</option>
            <option value="2">K=2</option>
            <option value="3">K=3</option>
          </select>
        </div>
      </div>
      {result && (
        <div style={{ padding: '12px 16px', borderRadius: 8, background: C.gn + '10', border: `1.5px solid ${C.gn}40` }}>
          <div style={{ fontSize: 10, color: C.ts, marginBottom: 4 }}>
            (~(0x{result.hi.toString(16).toUpperCase().padStart(2,'0')} + 0x{result.lo.toString(16).toUpperCase().padStart(2,'0')} + {result.k})) &amp; 0xFF
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.gn, fontFamily: 'monospace' }}>
            {fmtHex8(result.cs)} ({result.cs})
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Tab ─────────────────────────────────────────────────────────────────
const ALGO_IDS = ['add16_not', '16bit_linear', 'crc16_ccitt', 'f2_8bit'];

export default function ChecksumCalculatorTab() {
  const [activeAlgo, setActiveAlgo] = useState('add16_not');

  const algoMap = useMemo(() => {
    const m = {};
    for (const a of CB_CHECKSUM_ALGOS) m[a.id] = a;
    return m;
  }, []);

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: C.bk, letterSpacing: 0.5 }}>
          CHECKSUM CALCULATOR
        </div>
        <div style={{ fontSize: 11, color: C.ts, marginTop: 4 }}>
          CB Master Premium v6 · 4 algorithms · RFH Continental · BCM Fujitsu · CRC16-CCITT · F2 8-bit
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20 }}>
        {/* Algorithm selector */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.ts, marginBottom: 10, letterSpacing: 0.5 }}>
            SELECT ALGORITHM
          </div>
          {ALGO_IDS.map(id => (
            <AlgoPanel
              key={id}
              algo={algoMap[id]}
              active={activeAlgo === id}
              onSelect={() => setActiveAlgo(id)}
            />
          ))}
        </div>

        {/* Calculator */}
        <Card>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.a1, marginBottom: 4 }}>
            {algoMap[activeAlgo]?.name}
          </div>
          <div style={{ fontSize: 11, color: C.ts, marginBottom: 16 }}>
            Used by: {algoMap[activeAlgo]?.modules.join(', ')}
          </div>

          {activeAlgo === 'add16_not' && <Add16NotCalc />}
          {activeAlgo === '16bit_linear' && <Linear16Calc />}
          {activeAlgo === 'crc16_ccitt' && <Crc16CcittCalc />}
          {activeAlgo === 'f2_8bit' && <F2_8bitCalc />}

          {/* Reference */}
          <div style={{ marginTop: 20, padding: '10px 14px', borderRadius: 8, background: C.c2, border: `1px solid ${C.bd}` }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, marginBottom: 6, letterSpacing: 0.5 }}>ALGORITHM REFERENCE</div>
            <div style={{ fontSize: 11, color: C.ts }}>{algoMap[activeAlgo]?.desc}</div>
            {algoMap[activeAlgo]?.example && (
              <div style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 11, color: C.a2 }}>
                Example: ADD16={algoMap[activeAlgo].example.add16} → NOT={algoMap[activeAlgo].example.not}
                {algoMap[activeAlgo].example.note && (
                  <span style={{ color: C.tm }}> ({algoMap[activeAlgo].example.note})</span>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
