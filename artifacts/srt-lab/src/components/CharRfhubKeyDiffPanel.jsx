/**
 * CharRfhubKeyDiffPanel — before/after self-check for an offline key-add on
 * MPC-based Charger/Challenger RFHUB 4 KB dumps.
 *
 * Self-contained: two file pickers (before + after), no live OBD needed. Runs
 * the pure `diffCharKeyTables(before, after)` harness and renders its verdict:
 *   - added / removed keys (by UID)
 *   - master-secret-changed flag (the full-re-key tell)
 *   - isSingleKeyAdd
 *   - expected vs actual inserted slot (highest-free-slot rule MATCH/MISMATCH)
 *   - companion-table candidate runs (changes OUTSIDE the key table + master)
 *
 * A clean single-add with no companion regions surfaces a clear "this matches a
 * real key-add" result; anything else is flagged. This is the on-bench check
 * that clears the Offline Key Adder's "NOT BENCH-VERIFIED" caveat: capture a
 * real before/after pair on a working car and confirm the verdict here.
 *
 * Pure read-only: neither file is ever modified and nothing is downloaded.
 * Visual style matches CharRfhubKeyAdderPanel / ImmoChecksumPanel.
 */

import React, {useMemo, useState, useCallback, useEffect} from 'react';
import {Card, Btn} from '../lib/ui.jsx';
import {C} from '../lib/constants.js';
import {diffCharKeyTables, CHAR_MASTER_OFFSET, CHAR_MASTER_LEN} from '../lib/charRfhubKeyTable.js';
import {
  CHAR_MPC_8SLOT_LAYOUT,
  isVerifiableCleanAdd,
  saveVerification,
  isLayoutVerified,
  refreshVerificationsFromServer,
} from '../lib/charKeyAddVerification.js';

const mono = "'JetBrains Mono'";

const hex2 = n => '0x' + (n ?? 0).toString(16).toUpperCase().padStart(2, '0');
const hexOff = n => '0x' + (n ?? 0).toString(16).toUpperCase();

function FilePicker({label, bytes, filename, onLoad, onClear, testid}) {
  const onFileChange = useCallback(e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = ev => onLoad(new Uint8Array(ev.target.result), file.name);
    r.readAsArrayBuffer(file);
    e.target.value = '';
  }, [onLoad]);

  return (
    <div style={{flex: '1 1 220px'}}>
      <div style={{fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6}}>
        {label}
      </div>
      <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
        <label style={{padding: '8px 14px', borderRadius: 8, border: '2px dashed ' + C.sr + '50', background: C.c2, cursor: 'pointer', fontSize: 11, fontWeight: 800, color: C.sr}}>
          Load .bin
          <input type="file" accept=".bin,.BIN,.eep,.EEP" hidden data-testid={testid} onChange={onFileChange} />
        </label>
        {bytes && (
          <>
            <span style={{fontFamily: mono, fontSize: 10, color: C.ts}}>{filename} · {(bytes.length / 1024).toFixed(1)} KB</span>
            <button onClick={onClear} style={{border: 'none', background: 'transparent', color: C.tm, cursor: 'pointer', fontSize: 12}} title="Clear loaded file">✕</button>
          </>
        )}
      </div>
    </div>
  );
}

function KeyList({title, keys, color, testid}) {
  return (
    <div style={{flex: '1 1 220px'}} data-testid={testid}>
      <div style={{fontSize: 10, fontWeight: 800, color, letterSpacing: 1, marginBottom: 6}}>{title} ({keys.length})</div>
      {keys.length === 0 ? (
        <div style={{fontSize: 11, color: C.tm, fontStyle: 'italic'}}>none</div>
      ) : (
        <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: mono}}>
          <tbody>
            {keys.map(k => (
              <tr key={k.keyId} style={{borderBottom: '1px solid ' + C.bd}}>
                <td style={{padding: '4px 8px', color: C.tx, fontWeight: 700}}>{k.keyId}</td>
                <td style={{padding: '4px 8px', color: C.tm}}>slot {k.slot}</td>
                <td style={{padding: '4px 8px', color: C.tm}}>idx {hex2(k.indexLow)}</td>
                <td style={{padding: '4px 8px', color: C.tm}}>@{hexOff(k.offset)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const byteHex = b => (b == null ? '--' : b.toString(16).toUpperCase().padStart(2, '0'));

// Read-only before/after hex view of one changed run plus a few bytes of
// context on each side. Changed bytes are highlighted; context bytes (outside
// the coalesced run) are dimmed. Copy buttons yield a plain hex string of just
// the changed bytes for each side, and all bytes are plain selectable text.
function HexDiffRegion({before, after, region, context = 8, testid}) {
  const [copied, setCopied] = useState('');
  const len = Math.min(before.length, after.length);
  const from = Math.max(0, region.start - context);
  const to = Math.min(len - 1, region.end + context);

  const rows = [];
  for (let base = from; base <= to; base += 16) {
    const rowEnd = Math.min(to, base + 15);
    const cells = [];
    for (let i = base; i <= rowEnd; i++) {
      cells.push({
        i,
        before: before[i],
        after: after[i],
        changed: before[i] !== after[i],
        inRegion: i >= region.start && i <= region.end,
      });
    }
    rows.push({base, cells});
  }

  const regionHex = which => {
    const parts = [];
    for (let i = region.start; i <= region.end; i++) {
      parts.push(byteHex(which === 'before' ? before[i] : after[i]));
    }
    return parts.join(' ');
  };

  const copy = which => {
    const text = regionHex(which);
    const done = () => { setCopied(which); setTimeout(() => setCopied(''), 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      done();
    }
  };

  const offW = ('0x' + to.toString(16).toUpperCase()).length;

  const Column = ({which, color, label}) => (
    <div style={{flex: '1 1 320px', minWidth: 0}}>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6}}>
        <span style={{fontSize: 10, fontWeight: 800, color, letterSpacing: 1}}>{label}</span>
        <button
          onClick={() => copy(which)}
          data-testid={testid ? testid + '-copy-' + which : undefined}
          style={{border: '1px solid ' + C.bd, background: C.cd, color: C.ts, cursor: 'pointer', fontSize: 9, fontWeight: 800, borderRadius: 5, padding: '2px 8px', letterSpacing: 0.5}}
          title={'Copy changed ' + which + ' bytes as hex'}
        >
          {copied === which ? 'COPIED' : 'COPY'}
        </button>
      </div>
      <div style={{background: C.cd, border: '1px solid ' + C.bd, borderRadius: 6, padding: '8px 10px', overflowX: 'auto'}}>
        <pre style={{margin: 0, fontFamily: mono, fontSize: 11, lineHeight: 1.7, color: C.tx, whiteSpace: 'pre'}}>
          {rows.map(row => (
            <div key={row.base}>
              <span style={{color: C.tm}}>{('0x' + row.base.toString(16).toUpperCase()).padStart(offW, ' ')}</span>
              {'  '}
              {row.cells.map((c, idx) => (
                <span
                  key={c.i}
                  style={{
                    color: c.changed ? C.sr : c.inRegion ? C.tx : C.tm,
                    fontWeight: c.changed ? 800 : 400,
                  }}
                >
                  {idx > 0 ? ' ' : ''}{byteHex(which === 'before' ? c.before : c.after)}
                </span>
              ))}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );

  return (
    <div data-testid={testid} style={{padding: '4px 0 10px'}}>
      <div style={{fontSize: 10, color: C.tm, marginBottom: 8}}>
        Showing {region.startHex}–{region.endHex} ({region.length} B changed) with {context} bytes of context. Changed bytes in <span style={{color: C.sr, fontWeight: 800}}>red</span>.
      </div>
      <div style={{display: 'flex', gap: 14, flexWrap: 'wrap'}}>
        <Column which="before" color={C.ts} label="BEFORE" />
        <Column which="after" color={C.a2} label="AFTER" />
      </div>
    </div>
  );
}

function Verdict({label, ok, neutral = false, testid}) {
  const color = neutral ? C.tm : ok ? C.gn : C.er;
  return (
    <div style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 11}} data-testid={testid}>
      <span style={{
        fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6, minWidth: 56, textAlign: 'center',
        background: color + '18', color, fontFamily: mono,
      }}>
        {neutral ? '—' : ok ? 'YES' : 'NO'}
      </span>
      <span style={{color: C.ts, fontWeight: 600}}>{label}</span>
    </div>
  );
}

export default function CharRfhubKeyDiffPanel({defaultOpen = false}) {
  const [open, setOpen] = useState(defaultOpen);
  const [before, setBefore] = useState(null);
  const [beforeName, setBeforeName] = useState('');
  const [after, setAfter] = useState(null);
  const [afterName, setAfterName] = useState('');
  const [alreadyVerified, setAlreadyVerified] = useState(() => isLayoutVerified(CHAR_MPC_8SLOT_LAYOUT));
  const [saveMsg, setSaveMsg] = useState('');

  // Pull the canonical confirmation state from the server on mount so a
  // confirmation saved on another bench laptop is reflected here too.
  useEffect(() => {
    let live = true;
    refreshVerificationsFromServer(CHAR_MPC_8SLOT_LAYOUT)
      .then(list => { if (live) setAlreadyVerified(list.length > 0); })
      .catch(() => { /* offline — keep local state */ });
    return () => { live = false; };
  }, []);

  const diff = useMemo(() => {
    if (!before || !after) return null;
    return diffCharKeyTables(before, after);
  }, [before, after]);

  const [expanded, setExpanded] = useState(() => new Set());
  const toggleRow = useCallback(i => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }, []);

  const clearBefore = useCallback(() => { setBefore(null); setBeforeName(''); setSaveMsg(''); setExpanded(new Set()); }, []);
  const clearAfter = useCallback(() => { setAfter(null); setAfterName(''); setSaveMsg(''); setExpanded(new Set()); }, []);

  // Overall verdict: a clean single key-add, in the expected slot, with no
  // companion regions and no master change. Shared gate with the adder panel.
  const cleanAdd = isVerifiableCleanAdd(diff);

  const onSaveVerified = useCallback(() => {
    const r = saveVerification(diff, {layout: CHAR_MPC_8SLOT_LAYOUT, beforeName, afterName});
    if (!r.ok) { setSaveMsg(r.error || 'Could not save.'); return; }
    setAlreadyVerified(true);
    setSaveMsg(
      'Saved as bench evidence — the Offline Key Adder caveat is now cleared for this layout. '
      + 'Key ' + (r.entry.addedKeyId || '?') + ' → slot ' + (r.entry.slot ?? '?') + '.'
    );
  }, [diff, beforeName, afterName]);

  const headerSummary = !diff ? (before || after ? 'Load both dumps' : 'No files loaded')
    : !diff.ok ? 'Not a Charger key table'
    : cleanAdd ? 'Verified single key-add'
    : 'Review flagged';
  const headColor = !diff ? C.tm : !diff.ok ? C.er : cleanAdd ? C.gn : C.wn;

  return (
    <div data-testid="char-rfhub-key-diff-panel">
      <Card
        style={{marginBottom: open ? 0 : 14, borderRadius: open ? '10px 10px 0 0' : 10, cursor: 'pointer'}}
        onClick={() => setOpen(o => !o)}
        data-testid="char-rfhub-key-diff-toggle"
      >
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 10, minWidth: 0}}>
            <div style={{fontFamily: "'Righteous'", fontSize: 15, color: C.sr, letterSpacing: 1, whiteSpace: 'nowrap'}}>
              KEY-ADD SELF-CHECK (BEFORE / AFTER)
            </div>
            <span style={{
              fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6,
              background: headColor + '18', color: headColor, fontFamily: mono, whiteSpace: 'nowrap',
            }}>
              {headerSummary}
            </span>
          </div>
          <div style={{display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0}}>
            <span style={{fontSize: 10, color: C.tm, fontWeight: 700}}>READ-ONLY</span>
            <span style={{fontSize: 14, color: C.ts, transition: 'transform .2s', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'rotate(0deg)'}}>▶</span>
          </div>
        </div>
      </Card>

      {open && (
        <div style={{border: '1px solid ' + C.bd, borderTop: 'none', borderRadius: '0 0 10px 10px', padding: 14, background: C.bg, marginBottom: 14}}>

          {/* Intro / what this proves */}
          <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.a2}}>
            <div style={{fontWeight: 800, fontSize: 11, color: C.a2, marginBottom: 6, letterSpacing: 2}}>
              SELF-VERIFY AN OFFLINE KEY-ADD ON YOUR OWN BENCH
            </div>
            <div style={{fontSize: 11, color: C.ts, lineHeight: 1.6}}>
              Drop in a real <strong>before</strong> and <strong>after</strong> RFHUB EEPROM capture from a working car where
              you added <strong>exactly one</strong> key with a real tool. This compares the two dumps and confirms the key
              landed in the slot the Offline Key Adder would pick (the highest free slot) and that <strong>nothing changed
              outside the key table</strong>. Any extra changed run is flagged as a <strong>companion-table candidate</strong> —
              a region an offline add would also have to write for the key to start the car. A master-secret change means the
              pair is a full re-key, not a single add.
            </div>
            <ul style={{fontSize: 11, color: C.ts, lineHeight: 1.6, margin: '6px 0 0', paddingLeft: 18}}>
              <li>Read full RFHUB EEPROM → save as <code>before.bin</code> (4096 bytes for MPC modules).</li>
              <li>Add <strong>one</strong> key with your tool. Record its 4-byte Key ID (8 hex chars).</li>
              <li>Read the EEPROM again → save as <code>after.bin</code>. <strong>Do not virginize between reads.</strong></li>
              <li>EEPROM read/write does not consume PIN attempts (no 0x0401 OBD learn involved).</li>
            </ul>
            <div style={{fontSize: 10, color: C.tm, lineHeight: 1.6, marginTop: 6}}>
              Full protocol: <code>exports/RFHUB_INDEX_CRACK_KIT/BEFORE_AFTER_PROTOCOL.md</code>. Both files are read-only —
              neither is modified and nothing is downloaded.
            </div>
          </Card>

          {/* File pickers */}
          <Card style={{marginBottom: 12}}>
            <div style={{display: 'flex', gap: 16, flexWrap: 'wrap'}}>
              <FilePicker
                label="Before dump"
                bytes={before} filename={beforeName}
                onLoad={(b, n) => { setBefore(b); setBeforeName(n); setExpanded(new Set()); }}
                onClear={clearBefore}
                testid="char-key-diff-before-input"
              />
              <FilePicker
                label="After dump"
                bytes={after} filename={afterName}
                onLoad={(b, n) => { setAfter(b); setAfterName(n); setExpanded(new Set()); }}
                onClear={clearAfter}
                testid="char-key-diff-after-input"
              />
            </div>
            {(!before || !after) && (
              <div style={{fontSize: 11, color: C.tm, fontStyle: 'italic', marginTop: 10}}>
                Load both a before and an after 4 KB MPC-Charger RFHUB .bin to run the diff.
              </div>
            )}
          </Card>

          {/* Input-gate error (not a Charger key table) */}
          {diff && !diff.ok && (
            <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.er}} data-testid="char-key-diff-error">
              <div style={{fontWeight: 800, fontSize: 11, color: C.er, marginBottom: 4, letterSpacing: 2}}>CANNOT DIFF THESE FILES</div>
              <div style={{fontSize: 11, color: C.ts, lineHeight: 1.6}}>
                {diff.error}. This self-check only supports the MPC Charger/Challenger 8-slot table at 0xC5E.
              </div>
            </Card>
          )}

          {/* Verdict */}
          {diff && diff.ok && (
            <>
              {/* Overall banner */}
              <Card
                style={{marginBottom: 12, borderLeft: '3px solid ' + (cleanAdd ? C.gn : C.wn)}}
                data-testid="char-key-diff-overall"
              >
                <div style={{fontWeight: 800, fontSize: 12, color: cleanAdd ? C.gn : C.wn, letterSpacing: 1, marginBottom: 4}}>
                  {cleanAdd ? '✓ THIS MATCHES A REAL SINGLE KEY-ADD' : '⚠ REVIEW — DOES NOT MATCH A CLEAN SINGLE KEY-ADD'}
                </div>
                <div style={{fontSize: 11, color: C.ts, lineHeight: 1.6}}>
                  {cleanAdd
                    ? 'Exactly one key was added, in the highest free slot, with no master-secret change and no changes outside the key table. This is the bench evidence that clears the Offline Key Adder caveat for this layout.'
                    : 'See the breakdown below. A clean single key-add must add exactly one key (no removals), in the expected slot, with the master secret unchanged and no companion regions.'}
                </div>

                {cleanAdd && (
                  <div style={{marginTop: 12}}>
                    {alreadyVerified && !saveMsg && (
                      <div data-testid="char-key-diff-already-verified" style={{fontSize: 10, color: C.gn, fontWeight: 800, marginBottom: 8, letterSpacing: 1}}>
                        ✓ THIS LAYOUT IS ALREADY MARKED BENCH-VERIFIED — saving again records another confirming pair.
                      </div>
                    )}
                    <Btn data-testid="char-key-diff-save-btn" color={C.gn} full onClick={onSaveVerified}>
                      SAVE AS BENCH EVIDENCE &amp; CLEAR ADDER CAVEAT
                    </Btn>
                    {saveMsg && (
                      <div
                        data-testid="char-key-diff-save-status"
                        style={{
                          marginTop: 10, padding: '10px 14px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                          whiteSpace: 'pre-wrap', background: C.gn + '12', border: '1px solid ' + C.gn + '40', color: C.gn,
                        }}
                      >
                        {saveMsg}
                      </div>
                    )}
                  </div>
                )}
              </Card>

              {/* Verdict checklist */}
              <Card style={{marginBottom: 12}}>
                <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>VERDICT</div>
                <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
                  <Verdict
                    label={'Single key-add (one added, none removed, master unchanged)'}
                    ok={diff.isSingleKeyAdd}
                    testid="char-key-diff-single"
                  />
                  <Verdict
                    label={
                      diff.expectedSlotIdx == null
                        ? 'Inserted slot matches highest-free-slot rule (only checked for a clean single add)'
                        : 'Inserted slot ' + (diff.addedKeys[0] ? diff.addedKeys[0].slot : '?')
                          + ' matches expected slot ' + (diff.expectedSlotIdx + 1)
                          + ' (highest-free-slot rule)'
                    }
                    ok={diff.addedSlotMatchesRule === true}
                    neutral={diff.addedSlotMatchesRule == null}
                    testid="char-key-diff-slot"
                  />
                  <Verdict
                    label={'Master secret unchanged (a change means full re-key, not a single add)'}
                    ok={!diff.masterChanged}
                    testid="char-key-diff-master"
                  />
                  <Verdict
                    label={
                      diff.companionRegions.length === 0
                        ? 'No companion-table candidates (nothing changed outside the key table)'
                        : diff.companionRegions.length + ' companion-table candidate(s) — change(s) outside the key table'
                    }
                    ok={diff.companionRegions.length === 0}
                    testid="char-key-diff-companion"
                  />
                </div>
              </Card>

              {/* Added / removed keys */}
              <Card style={{marginBottom: 12}}>
                <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>
                  KEY DELTA — {diff.beforeKeyCount} → {diff.afterKeyCount} KEYS
                </div>
                <div style={{display: 'flex', gap: 16, flexWrap: 'wrap'}}>
                  <KeyList title="ADDED" keys={diff.addedKeys} color={C.gn} testid="char-key-diff-added" />
                  <KeyList title="REMOVED" keys={diff.removedKeys} color={C.er} testid="char-key-diff-removed" />
                </div>
              </Card>

              {/* Master change detail */}
              {diff.masterChanged && (
                <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.wn}}>
                  <div style={{fontWeight: 800, fontSize: 11, color: C.wn, marginBottom: 4, letterSpacing: 2}}>MASTER SECRET CHANGED</div>
                  <div style={{fontSize: 11, color: C.ts, lineHeight: 1.6}}>
                    The 16-byte vehicle master secret at {hexOff(CHAR_MASTER_OFFSET)} (…{hexOff(CHAR_MASTER_OFFSET + CHAR_MASTER_LEN - 1)})
                    differs between the two dumps. This is the signature of a full re-sync / cross-vehicle pairing, not a single
                    offline key-add — so it cannot be used as bench evidence for the key-add path.
                  </div>
                </Card>
              )}

              {/* Companion regions */}
              {diff.companionRegions.length > 0 && (
                <Card style={{marginBottom: 12, borderLeft: '3px solid ' + C.wn}} data-testid="char-key-diff-companion-detail">
                  <div style={{fontWeight: 800, fontSize: 11, color: C.wn, marginBottom: 6, letterSpacing: 2}}>COMPANION-TABLE CANDIDATES</div>
                  <div style={{fontSize: 11, color: C.ts, lineHeight: 1.6, marginBottom: 10}}>
                    Bytes changed <strong>outside</strong> the key table and the master-secret window. An offline key-add does
                    not touch these regions, so if the key requires them to start the car the offline add alone would be
                    incomplete. Expand a region to see the before/after bytes side by side and capture the layout for the writer.
                  </div>
                  <div style={{overflowX: 'auto'}}>
                    <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: mono}}>
                      <thead>
                        <tr style={{textAlign: 'left', color: C.ts, borderBottom: '1px solid ' + C.bd}}>
                          <th style={{padding: '6px 8px', width: 28}}></th>
                          <th style={{padding: '6px 8px'}}>Start</th>
                          <th style={{padding: '6px 8px'}}>End</th>
                          <th style={{padding: '6px 8px'}}>Length</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.companionRegions.map((r, i) => {
                          const isOpen = expanded.has(i);
                          return (
                            <React.Fragment key={i}>
                              <tr
                                data-testid={'char-key-diff-companion-row-' + i}
                                onClick={() => toggleRow(i)}
                                style={{borderBottom: '1px solid ' + C.bd, cursor: 'pointer', background: isOpen ? C.c2 : 'transparent'}}
                              >
                                <td style={{padding: '6px 8px', color: C.ts}}>
                                  <span
                                    data-testid={'char-key-diff-companion-toggle-' + i}
                                    style={{display: 'inline-block', transition: 'transform .15s', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)'}}
                                  >▶</span>
                                </td>
                                <td style={{padding: '6px 8px', color: C.tx}}>{r.startHex}</td>
                                <td style={{padding: '6px 8px', color: C.tx}}>{r.endHex}</td>
                                <td style={{padding: '6px 8px', color: C.tm}}>{r.length} B</td>
                              </tr>
                              {isOpen && (
                                <tr style={{borderBottom: '1px solid ' + C.bd}}>
                                  <td colSpan={4} style={{padding: '4px 8px', background: C.c2}}>
                                    <HexDiffRegion
                                      before={before}
                                      after={after}
                                      region={r}
                                      testid={'char-key-diff-companion-hex-' + i}
                                    />
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
