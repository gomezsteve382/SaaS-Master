/**
 * KeyTransferTab — primary-nav home for the offline Charger/Challenger RFHUB
 * transponder-key transfer flow.
 *
 * Hosts the self-contained CharRfhubKeyAdderPanel (load .bin → add key into a
 * free slot → download patched image) and a clean read-only hex viewer of the
 * 8-slot key-table region (@0xC5E). The hex viewer tints the 128-byte table
 * window and highlights exactly which bytes an add changes (the new record + its
 * mirror), so the operator can eyeball the edit before flashing.
 *
 * No write path of its own: every byte change goes through addCharKey inside the
 * panel, which never mutates the original buffer and touches no checksum/SEC16.
 */

import React, {useState, useMemo, useCallback} from 'react';
import {Card} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import CharRfhubKeyAdderPanel from '../components/CharRfhubKeyAdderPanel.jsx';
import {
  CHAR_KEYTABLE_BASE,
  CHAR_KEYTABLE_SLOTS,
  CHAR_KEYTABLE_STRIDE,
} from '../lib/charRfhubKeyTable.js';

const mono = "'JetBrains Mono'";

const TABLE_START = CHAR_KEYTABLE_BASE;
const TABLE_END = CHAR_KEYTABLE_BASE + CHAR_KEYTABLE_SLOTS * CHAR_KEYTABLE_STRIDE; // exclusive
const ROW_START = TABLE_START & ~0xF;
const ROW_END = (TABLE_END + 15) & ~0xF;

const addr = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
const byteHex = n => n.toString(16).toUpperCase().padStart(2, '0');
const asciiOf = n => (n >= 0x20 && n <= 0x7E ? String.fromCharCode(n) : '.');

/** Read-only hex dump of the key-table region with table-window + changed-byte
 *  highlighting. Rows are aligned to 16-byte boundaries around the table. */
function KeyTableHexView({bytes, changedOffsets}) {
  const rows = useMemo(() => {
    const out = [];
    for (let r = ROW_START; r < ROW_END; r += 16) out.push(r);
    return out;
  }, []);

  return (
    <Card data-testid="key-table-hex-view" style={{marginBottom: 14}}>
      <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 4, letterSpacing: 2}}>
        KEY TABLE HEX — {addr(TABLE_START)}{'\u2026'}{addr(TABLE_END - 1)}
      </div>
      <div style={{fontSize: 10, color: C.ts, lineHeight: 1.6, marginBottom: 10}}>
        Read-only view of the {CHAR_KEYTABLE_SLOTS}-slot key table. The tinted bytes are the
        128-byte table window; bytes written by an add are highlighted in red. No checksum
        covers this region and your original file is never modified.
      </div>

      {!bytes ? (
        <div data-testid="key-table-hex-empty" style={{fontSize: 11, color: C.tm, fontStyle: 'italic'}}>
          Load an RFHUB .bin above to view the key-table bytes.
        </div>
      ) : (
        <>
          <div style={{display: 'flex', gap: 16, alignItems: 'center', marginBottom: 10, fontSize: 10, color: C.ts, fontFamily: mono}}>
            <span style={{display: 'flex', alignItems: 'center', gap: 6}}>
              <span style={{width: 12, height: 12, borderRadius: 3, background: C.sr + '14', border: '1px solid ' + C.bd, display: 'inline-block'}} />
              table region
            </span>
            <span style={{display: 'flex', alignItems: 'center', gap: 6}}>
              <span style={{width: 12, height: 12, borderRadius: 3, background: C.sr, display: 'inline-block'}} />
              changed by add
            </span>
          </div>

          <div style={{overflowX: 'auto'}}>
            <table style={{borderCollapse: 'collapse', fontFamily: mono, fontSize: 11.5}}>
              <tbody>
                {rows.map(rowOff => (
                  <tr key={rowOff} data-testid={'hexrow-' + addr(rowOff)}>
                    <td style={{padding: '2px 12px 2px 2px', color: C.tm, whiteSpace: 'nowrap', userSelect: 'none'}}>
                      {addr(rowOff)}
                    </td>
                    {Array.from({length: 16}, (_, c) => {
                      const off = rowOff + c;
                      const present = off < bytes.length;
                      const inTable = off >= TABLE_START && off < TABLE_END;
                      const changed = !!(changedOffsets && changedOffsets.has(off));
                      return (
                        <td
                          key={c}
                          data-testid={changed ? 'hexbyte-changed-' + addr(off) : undefined}
                          style={{
                            padding: '2px 5px',
                            paddingLeft: c === 8 ? 12 : 5,
                            textAlign: 'center',
                            borderRadius: 3,
                            color: !present ? C.tm : changed ? '#fff' : inTable ? C.tx : C.tm,
                            background: changed ? C.sr : inTable ? C.sr + '14' : 'transparent',
                            fontWeight: changed ? 800 : inTable ? 700 : 400,
                          }}
                        >
                          {present ? byteHex(bytes[off]) : '\u00b7\u00b7'}
                        </td>
                      );
                    })}
                    <td style={{padding: '2px 4px 2px 14px', color: C.ts, whiteSpace: 'pre', userSelect: 'none'}}>
                      {Array.from({length: 16}, (_, c) => {
                        const off = rowOff + c;
                        return off < bytes.length ? asciiOf(bytes[off]) : ' ';
                      }).join('')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

export default function KeyTransferTab() {
  const [loaded, setLoaded] = useState(null); // {bytes, filename} | null
  const [added, setAdded] = useState(null);   // addCharKey result | null

  const onBytesLoaded = useCallback((bytes, filename) => {
    setAdded(null);
    setLoaded(bytes ? {bytes, filename} : null);
  }, []);

  const onAdded = useCallback(result => { setAdded(result); }, []);

  const changedOffsets = useMemo(() => {
    if (!added || !loaded) return null;
    const before = loaded.bytes;
    const after = added.bytes;
    const s = new Set();
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i++) if (before[i] !== after[i]) s.add(i);
    return s;
  }, [added, loaded]);

  const displayBytes = added ? added.bytes : loaded ? loaded.bytes : null;

  return (
    <div data-testid="key-transfer-tab">
      <div style={{marginBottom: 16}}>
        <div style={{fontFamily: "'Righteous'", fontSize: 22, color: C.bk, letterSpacing: 1}}>KEY PROGRAM</div>
        <div style={{fontSize: 12, color: C.ts, marginTop: 4, maxWidth: 760, lineHeight: 1.6}}>
          Offline transponder-key transfer for MPC-based Charger / Challenger RFHUB dumps.
          Load a 4&nbsp;KB .bin, add a key into a free slot, and download a patched image &mdash;
          the original file is never modified. The hex viewer below shows the {CHAR_KEYTABLE_SLOTS}-slot
          key-table region and highlights exactly which bytes an add changes.
        </div>
      </div>

      <CharRfhubKeyAdderPanel defaultOpen onBytesLoaded={onBytesLoaded} onAdded={onAdded} />

      {added && (
        <div
          data-testid="key-transfer-change-summary"
          style={{
            padding: '10px 14px', borderRadius: 10, fontSize: 11, fontWeight: 700, marginBottom: 14,
            background: C.gn + '12', border: '1px solid ' + C.gn + '40', color: C.gn,
          }}
        >
          Wrote key {added.keyId} to slot {added.slot} &mdash; {changedOffsets ? changedOffsets.size : 0} byte(s) changed
          (record @{addr(added.offset)} + mirror @{addr(added.mirrorOffset)}). Highlighted below.
        </div>
      )}

      <KeyTableHexView bytes={displayBytes} changedOffsets={changedOffsets} />
    </div>
  );
}
