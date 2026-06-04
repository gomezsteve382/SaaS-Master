/* RadioCodesTab — Mopar radio anti-theft PIN derivation (Task #634).
 * Pure client-side: type a serial, get the deterministic 4-digit PIN for
 * the covered head-unit families (RBZ / RHB / REJ / REC / RAQ / RA2-4).
 * Unsupported prefixes surface a clear refusal — no guessing. */
import React, { useMemo, useState } from 'react';
import { Card, Btn } from '../lib/ui.jsx';
import { C } from '../lib/constants.js';
import { deriveMoparRadioCode, moparRadioFamilies } from '../lib/moparRadioCode.js';

export default function RadioCodesTab() {
  const [serial, setSerial] = useState('');
  const [copied, setCopied] = useState(false);
  const families = useMemo(() => moparRadioFamilies(), []);
  const result = useMemo(() => (serial.trim() ? deriveMoparRadioCode(serial) : null), [serial]);

  const copyPin = async (pin) => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(pin);
      else {
        const ta = document.createElement('textarea');
        ta.value = pin; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { setCopied(false); }
  };

  return <div style={{ padding: 16, maxWidth: 880 }}>
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 800, fontSize: 13, color: C.a1, letterSpacing: 1.5, marginBottom: 6 }}>
        📻 MOPAR RADIO CODE DERIVER
      </div>
      <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.5, marginBottom: 12 }}>
        Deterministic 4-digit anti-theft PIN derived from the radio serial label
        (printed on the chassis, also readable via the head-unit's hidden diag screen).
        Per-family multiplier + offset, mod 10000. Bench-pending: pinned vectors lock
        the algorithm in tests; ground-truth confirmation happens off-platform.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={serial}
          onChange={(e) => setSerial(e.target.value.toUpperCase())}
          placeholder="e.g. RBZ12345"
          style={{
            padding: '10px 14px', border: '2px solid ' + C.bd, borderRadius: 8,
            fontFamily: "'JetBrains Mono'", fontSize: 14, fontWeight: 700, letterSpacing: 2, width: 220,
          }}
        />
        <Btn onClick={() => setSerial('')} color={C.tm} outline>Clear</Btn>
      </div>
    </Card>

    {result && result.ok && <Card style={{ marginBottom: 14, background: '#E8F5E9', border: '2px solid ' + C.gn }}>
      <div style={{ fontSize: 11, color: C.gn, fontWeight: 800, letterSpacing: 1.5, marginBottom: 6 }}>✓ PIN DERIVED</div>
      <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 36, fontWeight: 900, color: C.gn, letterSpacing: 8 }}>{result.pin}</div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Btn onClick={() => copyPin(result.pin)} color={C.gn}>{copied ? 'Copied ✓' : 'Copy PIN'}</Btn>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: C.ts, fontFamily: "'JetBrains Mono'" }}>
        Serial: <b>{result.serial}</b> · Family: <b>{result.family}</b> ({result.label}) · Numeric: <b>{result.numeric}</b>
      </div>
    </Card>}

    {result && !result.ok && <Card style={{ marginBottom: 14, background: '#FFEBEE', border: '2px solid ' + C.er }}>
      <div style={{ fontSize: 11, color: C.er, fontWeight: 800, letterSpacing: 1.5, marginBottom: 6 }}>✗ CANNOT DERIVE</div>
      <div style={{ fontSize: 12, color: C.ts, lineHeight: 1.5 }}>{result.reason}</div>
    </Card>}

    <Card>
      <div style={{ fontWeight: 800, fontSize: 11, color: C.a2, marginBottom: 10, letterSpacing: 1.5 }}>SUPPORTED FAMILIES</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 8 }}>
        {families.map((f) => <div key={f.key} style={{ padding: '8px 10px', background: '#fff', borderRadius: 6, border: '1px solid ' + C.bd, fontSize: 11 }}>
          <div style={{ fontFamily: "'JetBrains Mono'", fontWeight: 800, color: C.a1 }}>{f.key}</div>
          <div style={{ color: C.ts, marginTop: 2 }}>{f.label}</div>
        </div>)}
      </div>
    </Card>
  </div>;
}
