import React, {useMemo, useState, useCallback} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {
  analyzeGpec2aPcm,
  derivePcmSec6FromDonor,
  applyGpec2aChanges,
  applyGpec2aImmoFix,
  checkSec6MatchesBcm,
  isCanonicalGpec2a,
} from "../lib/gpec2aPcmAnalyzer.js";
import {scanChecksums, fixChecksum} from "../lib/checksumScanner.js";
import ImmoChecksumPanel, {StatBadge, dl, parseHexBytes} from "./ImmoChecksumPanel.jsx";

const mono = "'JetBrains Mono'";

export default function Gpec2aImmoPanel({mod, donorMods = [], onPatched = null}) {
  const bytes = mod?.data || null;
  const baseName = (mod?.filename || "gpec2a.bin").replace(/\.[^.]+$/, "");

  const analysis = useMemo(() => (bytes ? analyzeGpec2aPcm(bytes) : null), [bytes]);
  const checksums = useMemo(() => (bytes ? scanChecksums(bytes) : []), [bytes]);

  // First usable donor secret from any loaded BCM / RFHUB dump.
  const donor = useMemo(() => {
    for (const dm of donorMods) {
      const d = derivePcmSec6FromDonor(dm);
      if (d) return {...d, donorName: dm?.filename || dm?.type};
    }
    return null;
  }, [donorMods]);

  const consensusVin = useMemo(() => {
    const row = analysis?.vinRows?.find((r) => r.state === "WIN_OK");
    return row?.vin || "";
  }, [analysis]);

  const [newVin, setNewVin] = useState("");
  const [alsoWriteCe0, setAlsoWriteCe0] = useState(false);
  const [sec6Hex, setSec6Hex] = useState("");
  const [fixImmo, setFixImmo] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  // Holds the most recent patched buffer so it can be pushed straight back
  // into the shared workspace (re-analyzed in place) instead of forcing a
  // download-then-reload round trip. Cleared once pushed back.
  const [patched, setPatched] = useState(null);

  const donorHex = donor ? Array.from(donor.sec6).map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ") : "";

  const onApply = useCallback(() => {
    setMsg("");
    setErr("");
    const sec6 = sec6Hex.trim() ? parseHexBytes(sec6Hex) : null;
    if (sec6Hex.trim() && (!sec6 || sec6.length !== 6)) {
      setErr("SEC6 must be exactly 6 hex bytes (e.g. AA BB CC DD EE FF).");
      return;
    }
    const res = applyGpec2aChanges(bytes, {newVin, alsoWriteCe0, newSec6: sec6, fixImmo});
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    const guard = checkSec6MatchesBcm(res.bytes, donorMods, !!sec6);
    if (!guard.ok) {
      setErr(guard.error);
      return;
    }
    const fname = baseName + "_patched.bin";
    dl(res.bytes, fname);
    setPatched({bytes: res.bytes, filename: fname, summary: res.changes.join(" · ")});
    setMsg("Applied: " + res.changes.join(" · ") + " → downloaded.");
  }, [bytes, newVin, alsoWriteCe0, sec6Hex, fixImmo, baseName, donorMods]);

  const onJustFix = useCallback(() => {
    setMsg("");
    setErr("");
    const manual = sec6Hex.trim() ? parseHexBytes(sec6Hex) : null;
    if (sec6Hex.trim() && (!manual || manual.length !== 6)) {
      setErr("Manual SEC6 must be exactly 6 hex bytes.");
      return;
    }
    const secret = manual || (donor ? donor.sec6 : null);
    const res = applyGpec2aImmoFix(bytes, secret);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    const guard = checkSec6MatchesBcm(res.bytes, donorMods, !!manual);
    if (!guard.ok) {
      setErr(guard.error);
      return;
    }
    const fname = baseName + "_immoFix.bin";
    dl(res.bytes, fname);
    setPatched({bytes: res.bytes, filename: fname, summary: "IMMO marker + SEC6 " + res.sec6Hex});
    setMsg(
      "IMMO repaired (" +
        (manual ? "manual SEC6" : "from " + (donor?.source || "donor")) +
        "): marker FF FF FF AA + SEC6 " +
        res.sec6Hex +
        " → downloaded."
    );
  }, [bytes, sec6Hex, donor, baseName, donorMods]);

  const onPushBack = useCallback(() => {
    if (!patched || typeof onPatched !== "function") return;
    onPatched(patched.bytes, patched.filename);
    setPatched(null);
    setErr("");
    setMsg("Patched dump (" + patched.summary + ") added to workspace — re-analyzing in place.");
  }, [patched, onPatched]);

  if (!bytes || !analysis) return null;

  const a = analysis;
  const canonical = isCanonicalGpec2a(bytes);

  const headerBadges = [
    {text: a.family.code + " · " + a.family.confidence + " · " + a.family.score, color: C.a2},
  ];
  if (!canonical) headerBadges.push({text: "NON-CANONICAL SIZE — WRITES DISABLED", color: C.er, small: true});

  // ── Analysis MiniCards (preserved verbatim, incl. the IMMO pattern card that
  //    is the single source of the standalone marker hex text nodes). ──
  const analysisModel = {
    title: "ANALYSIS RESULT",
    icon: "📊",
    cards: [
      {title: "Family Detected", accent: C.a2, value: a.family.label, sub: "Code: " + a.family.code + " · Confidence: " + a.family.confidence + " · Score: " + a.family.score},
      {title: "EEPROM / Reading", accent: C.a4, value: a.eeprom.chip || "—", sub: a.eeprom.reading},
      {
        title: "State",
        accent: a.state.immoSync ? C.gn : C.wn,
        value: a.state.verdict,
        valueColor: a.state.immoSync ? C.gn : C.wn,
        sub: "Valid VINs: " + a.state.validVinCount + " · IMMO Sync: " + (a.state.immoSync ? "YES" : "NO"),
      },
      {
        title: "Real Estate / SEC6",
        accent: a.sec6?.populated ? C.gn : C.er,
        badge: a.sec6 ? {value: a.sec6.state, good: a.sec6.populated} : undefined,
        value: a.sec6 ? a.sec6.hex : "—",
        spaced: true,
        sub: "@ 0x3C8 · State: " + (a.sec6 ? a.sec6.state : "—"),
      },
      {
        title: "Current IMMO Pattern",
        accent: a.immo?.synced ? C.gn : C.wn,
        value: a.immo ? a.immo.currentHex : "—",
        spaced: true,
        extra: (
          <>
            <div style={{fontSize: 10, color: C.tm, marginTop: 6}}>Expected for family</div>
            <div style={{fontFamily: mono, fontWeight: 800, fontSize: 14, color: C.gn, letterSpacing: 2}}>
              {a.immo ? a.immo.expectedHex : "—"}
            </div>
          </>
        ),
      },
      {
        title: "Reasons / Notes (" + a.notes.length + ")",
        accent: C.a3,
        extra: (
          <div style={{display: "flex", flexDirection: "column", gap: 6}}>
            {a.notes.map((n, i) => (
              <div key={i} style={{fontSize: 10}}>
                <span style={{fontWeight: 800, color: n.tag === "WARNING" ? C.wn : C.a3, letterSpacing: 0.5}}>{n.tag}</span>
                <div style={{color: C.ts, marginTop: 1}}>{n.text}</div>
              </div>
            ))}
          </div>
        ),
      },
    ],
  };

  const checksumCard = (
    <Card style={{marginBottom: 14}}>
      <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>🧮 CHECKSUMS</div>
      {checksums.length === 0 ? (
        <div style={{fontSize: 11, color: C.tm, fontStyle: "italic"}}>No checksum candidates detected.</div>
      ) : (
        <div style={{overflowX: "auto"}}>
          <table style={{width: "100%", borderCollapse: "collapse", fontSize: 11}}>
            <thead>
              <tr style={{textAlign: "left", color: C.ts, borderBottom: "1px solid " + C.bd}}>
                <th style={{padding: "6px 8px"}}>Offset</th>
                <th style={{padding: "6px 8px"}}>Algorithm</th>
                <th style={{padding: "6px 8px"}}>Stored</th>
                <th style={{padding: "6px 8px"}}>Computed</th>
                <th style={{padding: "6px 8px"}}>Status</th>
                <th style={{padding: "6px 8px"}}></th>
              </tr>
            </thead>
            <tbody>
              {checksums.map((cs, i) => (
                <tr key={i} style={{borderBottom: "1px solid " + C.bd, fontFamily: mono}}>
                  <td style={{padding: "6px 8px"}}>{cs.offset}</td>
                  <td style={{padding: "6px 8px"}}>{cs.algorithm}</td>
                  <td style={{padding: "6px 8px"}}>{cs.stored}</td>
                  <td style={{padding: "6px 8px"}}>{cs.computed}</td>
                  <td style={{padding: "6px 8px"}}>
                    <StatBadge value={cs.status.toUpperCase()} good={cs.status === "valid"} />
                  </td>
                  <td style={{padding: "6px 8px"}}>
                    {cs.status === "broken" && canonical && (
                      <Btn
                        color={C.wn}
                        outline
                        onClick={() => {
                          try {
                            const fixed = fixChecksum(bytes, cs.offset, cs.algorithm, cs.coversStart);
                            dl(fixed, baseName + "_ck" + cs.offset.replace("0x", "") + ".bin");
                            setMsg("Recomputed " + cs.algorithm + " @ " + cs.offset + " → downloaded.");
                            setErr("");
                          } catch (e) {
                            setErr(String(e.message || e));
                          }
                        }}
                      >
                        Fix &amp; download
                      </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );

  const idsCard = (
    <Card style={{marginBottom: 14}}>
      <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>🧬 INTERNAL IDs / SIGNATURES</div>
      <div style={{overflowX: "auto"}}>
        <table style={{width: "100%", borderCollapse: "collapse", fontSize: 11}}>
          <tbody>
            {[
              ["ECU / OS", a.ids.ecu],
              ["Part Number", a.ids.partNumber],
              ["Serial", a.ids.serial],
              ["0x081F Family / String", a.ids.family081F],
              ["0x0825 Variant / Code", a.ids.variant0825],
              ["0x0FA1 Continental / Extra ID", a.ids.continental0FA1],
              ["0x081C DT23", a.ids.dt23_081C],
            ].map(([k, v], i) => (
              <tr key={i} style={{borderBottom: "1px solid " + C.bd}}>
                <td style={{padding: "6px 8px", color: C.ts, fontWeight: 700}}>{k}</td>
                <td style={{padding: "6px 8px", fontFamily: mono, fontWeight: 800, color: v ? C.tx : C.tm}}>
                  {v || "— none —"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );

  // ── Per-row security verdicts (SEC6 + IMMO marker). The marker hex is folded
  //    into a single descriptive cell so it does not duplicate the standalone
  //    marker text nodes rendered by the analysis IMMO card. ──
  const securityModel = a.sec6
    ? {
        title: "SECURITY / IMMO VERDICTS",
        icon: "🔐",
        columns: ["Field", "Value", "Verdict"],
        rows: [
          {
            cells: [
              {text: "SEC6 secret @ 0x3C8"},
              {text: a.sec6.hex, color: C.tx},
              {badge: {value: a.sec6.state, good: a.sec6.populated}},
            ],
          },
          ...(a.immo
            ? [
                {
                  cells: [
                    {text: "IMMO marker @ 0x3C4"},
                    {text: "current " + a.immo.currentHex + " / expected " + a.immo.expectedHex, muted: true},
                    {badge: {value: a.immo.synced ? "IMMO OK" : "NO IMMO", good: a.immo.synced}},
                  ],
                },
              ]
            : []),
        ],
      }
    : null;

  const vinModel = {
    title: "VINs BY OFFSET",
    icon: "🔑",
    columns: ["Slot", "Offset", "VIN", "State", "Format", "Check", "Raw"],
    rows: a.vinRows.map((r) => ({
      cells: [
        {text: r.slot, color: C.ts},
        {text: r.offsetHex},
        {text: r.vin || "—", bold: true},
        {badge: {value: r.state, good: r.state === "WIN_OK"}},
        {badge: {value: r.format, good: r.format === "OK"}},
        {badge: {value: r.check, good: r.check === "OK"}},
        {text: r.raw, muted: true},
      ],
    })),
  };

  const immoAlreadyOk = !!(a.immo?.synced);

  const editingModel = {
    title: "APPLY CHANGES & DOWNLOAD",
    icon: "✏️",
    hint: "Empty VIN = do not touch VIN. Empty SEC6 = do not touch SEC6. FIX IMMO stamps the GPEC2A marker FF FF FF AA @ 0x3C4.",
    fields: [
      {
        label: "New VIN (17 chars · no I/O/Q)",
        value: newVin,
        onChange: (e) => setNewVin(e.target.value.toUpperCase()),
        placeholder: consensusVin || "leave blank to keep VIN",
        maxLength: 17,
        testid: "gpec2a-vin-input",
        below: (
          <label style={{display: "flex", gap: 6, alignItems: "center", marginTop: 8, fontSize: 10, color: C.ts}}>
            <input type="checkbox" checked={alsoWriteCe0} onChange={(e) => setAlsoWriteCe0(e.target.checked)} />
            Also write VIN to 0x0CE0 (donor/backup slot — use with care)
          </label>
        ),
      },
      {
        label: "New SEC6 (6 hex bytes)",
        value: sec6Hex,
        onChange: (e) => setSec6Hex(e.target.value),
        placeholder: donorHex || "AA BB CC DD EE FF",
        testid: "gpec2a-sec6-input",
        below: donor ? (
          <div style={{marginTop: 6, fontSize: 10, color: C.ts}}>
            Donor secret available: <strong style={{fontFamily: mono}}>{donorHex}</strong> ({donor.detail})
            <button
              onClick={() => setSec6Hex(donorHex)}
              style={{marginLeft: 8, border: "none", background: C.a2 + "18", color: C.a2, fontWeight: 800, fontSize: 10, padding: "2px 8px", borderRadius: 6, cursor: "pointer"}}
            >
              use donor
            </button>
          </div>
        ) : (
          <div style={{marginTop: 6, fontSize: 10, color: C.tm, fontStyle: "italic"}}>
            No BCM / RFHUB donor loaded — enter SEC6 manually or load a donor in the BCM / RFHUB tab.
          </div>
        ),
      },
    ],
    controls: !immoAlreadyOk ? (
      <label style={{display: "flex", gap: 6, alignItems: "center", marginTop: 12, fontSize: 11, color: C.tx, fontWeight: 700}}>
        <input type="checkbox" checked={fixImmo} onChange={(e) => setFixImmo(e.target.checked)} />
        Apply automatic FIX IMMO (stamp FF FF FF AA marker)
      </label>
    ) : (
      <div style={{marginTop: 12, fontSize: 10, color: C.gn, fontWeight: 700}}>✓ IMMO already OK — marker not touched</div>
    ),
    primary: {label: "✅ APPLY CHANGES AND DOWNLOAD", color: C.gn, onClick: onApply, disabled: !canonical},
  };

  const justFixAndPushback = (
    <>
      {!immoAlreadyOk && (
        <Card style={{marginBottom: 14, borderLeft: "3px solid " + C.wn}}>
          <div style={{fontWeight: 800, fontSize: 11, color: C.wn, marginBottom: 4, letterSpacing: 2}}>🛠️ JUST FIX IT</div>
          <div style={{fontSize: 10, color: C.tm, marginBottom: 12}}>
            One-click immo repair: stamps FF FF FF AA + writes the SEC6 secret (manual entry above, else the loaded donor).
            Refuses on doubt — no secret, blank/virgin source, or non-canonical image.
          </div>
          <Btn color={C.wn} full onClick={onJustFix} disabled={!canonical || (!donor && !sec6Hex.trim())}>
            🛠️ ONLY FIX IMMO AND DOWNLOAD
          </Btn>
        </Card>
      )}

      {patched && typeof onPatched === "function" && (
        <Card style={{marginBottom: 14, borderLeft: "3px solid " + C.gn}}>
          <div style={{fontWeight: 800, fontSize: 11, color: C.gn, marginBottom: 4, letterSpacing: 2}}>📥 SAVE BACK TO WORKSPACE</div>
          <div style={{fontSize: 10, color: C.tm, marginBottom: 12}}>
            Add the patched bytes ({patched.summary}) into the shared workspace as a new GPEC2A dump and re-analyze it
            here in place — no manual reload through the Dumps / ECM inspector. The download above is still saved to disk.
          </div>
          <Btn color={C.gn} full onClick={onPushBack} data-testid="gpec2a-pushback-btn">
            📥 ADD PATCHED DUMP TO WORKSPACE &amp; RE-ANALYZE
          </Btn>
        </Card>
      )}
    </>
  );

  // ── Quick-status summary card ──
  // Shows the 3 most critical status items at a glance before the full analysis
  const vinOk = a.vinRows.some(r => r.state === 'WIN_OK');
  const vinAllOk = a.vinRows.filter(r => r.vin).every(r => r.state === 'WIN_OK');
  const sec6Ok = !!(a.sec6 && a.sec6.populated);
  const immoOk = !!(a.immo && a.immo.synced);
  const overallReady = vinOk && sec6Ok && immoOk;
  const overallBorderColor = overallReady ? C.gn : (!vinOk || !sec6Ok) ? C.er : C.wn;

  const quickStatusCard = (
    <div
      data-testid="gpec2a-quick-status"
      style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))',
        gap: 8, marginBottom: 14, padding: '10px 12px', borderRadius: 10,
        border: `2px solid ${overallBorderColor}44`,
        background: overallBorderColor + '08',
      }}
    >
      {/* VIN status */}
      <div style={{padding: '8px 10px', borderRadius: 7, background: C.c1 || '#fff', border: `1px solid ${vinOk ? C.gn : C.er}44`}}>
        <div style={{fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 4}}>VIN</div>
        <div style={{fontFamily: mono, fontSize: 11, fontWeight: 800, color: vinOk ? C.gn : C.er}}>
          {consensusVin || '—'}
        </div>
        <div style={{fontSize: 9, marginTop: 3, color: vinOk ? C.gn : C.er, fontWeight: 700}}>
          {vinAllOk ? '✓ ALL SLOTS OK' : vinOk ? '⚠ SOME SLOTS OK' : '✗ NO VALID VIN'}
        </div>
      </div>
      {/* SEC6 status */}
      <div style={{padding: '8px 10px', borderRadius: 7, background: C.c1 || '#fff', border: `1px solid ${sec6Ok ? C.gn : C.er}44`}}>
        <div style={{fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 4}}>SEC6 @ 0x3C8</div>
        <div style={{fontFamily: mono, fontSize: 11, fontWeight: 800, color: sec6Ok ? C.gn : C.er}}>
          {a.sec6 ? a.sec6.hex : '—'}
        </div>
        <div style={{fontSize: 9, marginTop: 3, color: sec6Ok ? C.gn : C.er, fontWeight: 700}}>
          {sec6Ok ? '✓ POPULATED' : '✗ BLANK / VIRGIN'}
        </div>
      </div>
      {/* IMMO marker status */}
      <div style={{padding: '8px 10px', borderRadius: 7, background: C.c1 || '#fff', border: `1px solid ${immoOk ? C.gn : C.wn}44`}}>
        <div style={{fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 4}}>IMMO MARKER @ 0x3C4</div>
        <div style={{fontFamily: mono, fontSize: 11, fontWeight: 800, color: immoOk ? C.gn : C.wn}}>
          {a.immo ? a.immo.currentHex : '—'}
        </div>
        <div style={{fontSize: 9, marginTop: 3, color: immoOk ? C.gn : C.wn, fontWeight: 700}}>
          {immoOk ? '✓ IMMO SYNC' : '✗ NOT SYNCED'}
        </div>
      </div>
      {/* Overall verdict */}
      <div style={{padding: '8px 10px', borderRadius: 7, background: overallBorderColor + '14', border: `1px solid ${overallBorderColor}55`}}>
        <div style={{fontSize: 9, fontWeight: 800, color: C.ts, letterSpacing: 1, marginBottom: 4}}>OVERALL</div>
        <div style={{fontSize: 14, fontWeight: 800, color: overallBorderColor}}>
          {overallReady ? '✅ READY' : (!vinOk || !sec6Ok) ? '⛔ NOT READY' : '⚠ NEEDS FIX'}
        </div>
        <div style={{fontSize: 9, marginTop: 3, color: overallBorderColor, fontWeight: 700}}>
          {overallReady ? 'VIN + SEC6 + IMMO OK' : !vinOk ? 'VIN missing' : !sec6Ok ? 'SEC6 blank' : 'IMMO not synced'}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {quickStatusCard}
      <ImmoChecksumPanel
        testid="gpec2a-immo-panel"
        title="PCM GPEC2A IMMO ANALYZER"
        subtitle="OFFLINE DUMP · ANALYZE · VIN / SEC6 EDIT · ONE-CLICK IMMO FIX"
        accent={C.sr}
        headerBadges={headerBadges}
        analysis={analysisModel}
        afterAnalysis={checksumCard}
        vinSection={vinModel}
        afterVin={idsCard}
        securitySection={securityModel}
        editing={editingModel}
        extraAfterEditing={justFixAndPushback}
        status={{testid: "gpec2a-immo-status", msg, err}}
      />
    </>
  );
}
