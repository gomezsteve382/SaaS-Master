import React, {useMemo, useState, useCallback} from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {
  analyzeGpec2aPcm,
  derivePcmSec6FromDonor,
  applyGpec2aChanges,
  applyGpec2aImmoFix,
  isCanonicalGpec2a,
} from "../lib/gpec2aPcmAnalyzer.js";
import {scanChecksums, fixChecksum} from "../lib/checksumScanner.js";

const dl = (d, n) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([d]));
  a.download = n;
  a.click();
  URL.revokeObjectURL(a.href);
};

const mono = "'JetBrains Mono'";

function parseHexBytes(s) {
  const cleaned = (s || "").replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  return out;
}

function StatBadge({value, good}) {
  const col = good ? C.gn : C.er;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 800,
        padding: "2px 8px",
        borderRadius: 6,
        background: col + "18",
        color: col,
        fontFamily: mono,
        letterSpacing: 0.4,
      }}
    >
      {value}
    </span>
  );
}

function MiniCard({title, accent = C.sr, children, badge}) {
  return (
    <div
      style={{
        background: C.c2,
        border: "1px solid " + C.bd,
        borderRadius: 12,
        padding: "12px 14px",
        borderLeft: "3px solid " + accent,
      }}
    >
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6}}>
        <div style={{fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1, textTransform: "uppercase"}}>
          {title}
        </div>
        {badge}
      </div>
      {children}
    </div>
  );
}

const labelStyle = {fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 4};
const inputStyle = {padding: "8px 10px", borderRadius: 8, border: "1.5px solid " + C.bd, background: C.cd, fontFamily: mono, fontSize: 12, color: C.tx, width: "100%", boxSizing: "border-box"};

export default function Gpec2aImmoPanel({mod, donorMods = []}) {
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
    dl(res.bytes, baseName + "_patched.bin");
    setMsg("Applied: " + res.changes.join(" · ") + " → downloaded.");
  }, [bytes, newVin, alsoWriteCe0, sec6Hex, fixImmo, baseName]);

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
    dl(res.bytes, baseName + "_immoFix.bin");
    setMsg(
      "IMMO repaired (" +
        (manual ? "manual SEC6" : "from " + (donor?.source || "donor")) +
        "): marker FF FF FF AA + SEC6 " +
        res.sec6Hex +
        " → downloaded."
    );
  }, [bytes, sec6Hex, donor, baseName]);

  if (!bytes || !analysis) return null;

  const a = analysis;
  const canonical = isCanonicalGpec2a(bytes);

  return (
    <div data-testid="gpec2a-immo-panel" style={{marginTop: 16}}>
      <Card style={{marginBottom: 14, borderTop: "3px solid " + C.sr}}>
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8}}>
          <div>
            <div style={{fontFamily: "'Righteous'", fontSize: 18, color: C.sr, letterSpacing: 1}}>
              PCM GPEC2A IMMO ANALYZER
            </div>
            <div style={{fontSize: 10, color: C.tm, letterSpacing: 1, fontWeight: 700}}>
              OFFLINE DUMP · ANALYZE · VIN / SEC6 EDIT · ONE-CLICK IMMO FIX
            </div>
          </div>
          <div style={{display: "flex", gap: 8, alignItems: "center"}}>
            <span style={{fontSize: 11, fontWeight: 800, padding: "4px 10px", borderRadius: 8, background: C.a2 + "18", color: C.a2, fontFamily: mono}}>
              {a.family.code} · {a.family.confidence} · {a.family.score}
            </span>
            {!canonical && (
              <span style={{fontSize: 10, fontWeight: 800, padding: "4px 10px", borderRadius: 8, background: C.er + "18", color: C.er}}>
                NON-CANONICAL SIZE — WRITES DISABLED
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* ── 1) Analysis cards ── */}
      <Card style={{marginBottom: 14}}>
        <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 12, letterSpacing: 2}}>📊 ANALYSIS RESULT</div>
        <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10}}>
          <MiniCard title="Family Detected" accent={C.a2}>
            <div style={{fontFamily: mono, fontWeight: 800, fontSize: 13, color: C.tx}}>{a.family.label}</div>
            <div style={{fontSize: 10, color: C.tm, marginTop: 3}}>
              Code: {a.family.code} · Confidence: {a.family.confidence} · Score: {a.family.score}
            </div>
          </MiniCard>

          <MiniCard title="EEPROM / Reading" accent={C.a4}>
            <div style={{fontFamily: mono, fontWeight: 800, fontSize: 13, color: C.tx}}>{a.eeprom.chip || "—"}</div>
            <div style={{fontSize: 10, color: C.tm, marginTop: 3}}>{a.eeprom.reading}</div>
          </MiniCard>

          <MiniCard title="State" accent={a.state.immoSync ? C.gn : C.wn}>
            <div style={{fontFamily: mono, fontWeight: 800, fontSize: 12, color: a.state.immoSync ? C.gn : C.wn}}>
              {a.state.verdict}
            </div>
            <div style={{fontSize: 10, color: C.tm, marginTop: 3}}>
              Valid VINs: {a.state.validVinCount} · IMMO Sync: {a.state.immoSync ? "YES" : "NO"}
            </div>
          </MiniCard>

          <MiniCard
            title="Real Estate / SEC6"
            accent={a.sec6?.populated ? C.gn : C.er}
            badge={a.sec6 && <StatBadge value={a.sec6.state} good={a.sec6.populated} />}
          >
            <div style={{fontFamily: mono, fontWeight: 800, fontSize: 13, color: C.tx, letterSpacing: 1}}>
              {a.sec6 ? a.sec6.hex : "—"}
            </div>
            <div style={{fontSize: 10, color: C.tm, marginTop: 3}}>@ 0x3C8 · State: {a.sec6 ? a.sec6.state : "—"}</div>
          </MiniCard>

          <MiniCard title="Current IMMO Pattern" accent={a.immo?.synced ? C.gn : C.wn}>
            <div style={{fontFamily: mono, fontWeight: 800, fontSize: 14, color: C.tx, letterSpacing: 2}}>
              {a.immo ? a.immo.currentHex : "—"}
            </div>
            <div style={{fontSize: 10, color: C.tm, marginTop: 6}}>Expected for family</div>
            <div style={{fontFamily: mono, fontWeight: 800, fontSize: 14, color: C.gn, letterSpacing: 2}}>
              {a.immo ? a.immo.expectedHex : "—"}
            </div>
          </MiniCard>

          <MiniCard title={"Reasons / Notes (" + a.notes.length + ")"} accent={C.a3}>
            <div style={{display: "flex", flexDirection: "column", gap: 6}}>
              {a.notes.map((n, i) => (
                <div key={i} style={{fontSize: 10}}>
                  <span style={{fontWeight: 800, color: n.tag === "WARNING" ? C.wn : C.a3, letterSpacing: 0.5}}>{n.tag}</span>
                  <div style={{color: C.ts, marginTop: 1}}>{n.text}</div>
                </div>
              ))}
            </div>
          </MiniCard>
        </div>
      </Card>

      {/* ── Checksum panel ── */}
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
                              const patched = fixChecksum(bytes, cs.offset, cs.algorithm, cs.coversStart);
                              dl(patched, baseName + "_ck" + cs.offset.replace("0x", "") + ".bin");
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

      {/* ── VINs by offset ── */}
      <Card style={{marginBottom: 14}}>
        <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 10, letterSpacing: 2}}>🔑 VINs BY OFFSET</div>
        <div style={{overflowX: "auto"}}>
          <table style={{width: "100%", borderCollapse: "collapse", fontSize: 11}}>
            <thead>
              <tr style={{textAlign: "left", color: C.ts, borderBottom: "1px solid " + C.bd}}>
                <th style={{padding: "6px 8px"}}>Slot</th>
                <th style={{padding: "6px 8px"}}>Offset</th>
                <th style={{padding: "6px 8px"}}>VIN</th>
                <th style={{padding: "6px 8px"}}>State</th>
                <th style={{padding: "6px 8px"}}>Format</th>
                <th style={{padding: "6px 8px"}}>Check</th>
                <th style={{padding: "6px 8px"}}>Raw</th>
              </tr>
            </thead>
            <tbody>
              {a.vinRows.map((r, i) => (
                <tr key={i} style={{borderBottom: "1px solid " + C.bd, fontFamily: mono}}>
                  <td style={{padding: "6px 8px", color: C.ts}}>{r.slot}</td>
                  <td style={{padding: "6px 8px"}}>{r.offsetHex}</td>
                  <td style={{padding: "6px 8px", fontWeight: 800, color: C.tx}}>{r.vin || "—"}</td>
                  <td style={{padding: "6px 8px"}}>
                    <StatBadge value={r.state} good={r.state === "WIN_OK"} />
                  </td>
                  <td style={{padding: "6px 8px"}}>
                    <StatBadge value={r.format} good={r.format === "OK"} />
                  </td>
                  <td style={{padding: "6px 8px"}}>
                    <StatBadge value={r.check} good={r.check === "OK"} />
                  </td>
                  <td style={{padding: "6px 8px", color: C.tm, fontSize: 10}}>{r.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ── Internal IDs / Signatures ── */}
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

      {/* ── Apply changes ── */}
      <Card style={{marginBottom: 14}}>
        <div style={{fontWeight: 800, fontSize: 11, color: C.sr, marginBottom: 4, letterSpacing: 2}}>✏️ APPLY CHANGES &amp; DOWNLOAD</div>
        <div style={{fontSize: 10, color: C.tm, marginBottom: 12}}>
          Empty VIN = do not touch VIN. Empty SEC6 = do not touch SEC6. FIX IMMO stamps the GPEC2A marker FF FF FF AA @ 0x3C4.
        </div>
        <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 12}}>
          <div>
            <div style={labelStyle}>New VIN (17 chars · no I/O/Q)</div>
            <input
              value={newVin}
              onChange={(e) => setNewVin(e.target.value.toUpperCase())}
              placeholder={consensusVin || "leave blank to keep VIN"}
              maxLength={17}
              style={inputStyle}
              data-testid="gpec2a-vin-input"
            />
            <label style={{display: "flex", gap: 6, alignItems: "center", marginTop: 8, fontSize: 10, color: C.ts}}>
              <input type="checkbox" checked={alsoWriteCe0} onChange={(e) => setAlsoWriteCe0(e.target.checked)} />
              Also write VIN to 0x0CE0 (donor/backup slot — use with care)
            </label>
          </div>
          <div>
            <div style={labelStyle}>New SEC6 (6 hex bytes)</div>
            <input
              value={sec6Hex}
              onChange={(e) => setSec6Hex(e.target.value)}
              placeholder={donorHex || "AA BB CC DD EE FF"}
              style={inputStyle}
              data-testid="gpec2a-sec6-input"
            />
            {donor ? (
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
            )}
          </div>
        </div>
        <label style={{display: "flex", gap: 6, alignItems: "center", marginTop: 12, fontSize: 11, color: C.tx, fontWeight: 700}}>
          <input type="checkbox" checked={fixImmo} onChange={(e) => setFixImmo(e.target.checked)} />
          Apply automatic FIX IMMO (stamp FF FF FF AA marker)
        </label>
        <div style={{marginTop: 12}}>
          <Btn color={C.gn} full onClick={onApply} disabled={!canonical}>
            ✅ APPLY CHANGES AND DOWNLOAD
          </Btn>
        </div>
      </Card>

      {/* ── Just FIX IT ── */}
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

      {(msg || err) && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 11,
            fontWeight: 700,
            background: err ? C.er + "12" : C.gn + "12",
            border: "1px solid " + (err ? C.er + "40" : C.gn + "40"),
            color: err ? C.er : C.gn,
          }}
          data-testid="gpec2a-immo-status"
        >
          {err || msg}
        </div>
      )}
    </div>
  );
}
