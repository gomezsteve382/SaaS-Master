/* SmartBoxTab — read-only Dodge Journey "SmartBox" immobilizer EEE analyzer.
 *
 * Self-contained: this tab has its OWN file upload and does NOT route through
 * the workspace parseModule auto-detect. The SmartBox EEE shares the 24C32
 * layout (part-number block + reversed-VIN slots at 0xEA5/0xEB9/0xECD/0xEE1)
 * with RFHUB Gen2 dumps, so wiring it into auto-detect would steal real RFHUB
 * captures. Drop a 4 KB SmartBox dump here to read out VIN + immo-relevant
 * identifier fields.
 *
 * READ-ONLY. Every label is reverse-engineered from a corpus of staged Journey
 * SmartBox dumps and is BENCH-UNCONFIRMED — there is intentionally no apply /
 * patch / download path. The 2-byte VIN checksum trailer is surfaced raw (its
 * algorithm is unconfirmed); nothing is recomputed.
 */
import React, { useState, useCallback, useRef } from "react";
import { C } from "../lib/constants.js";
import { Card, Tag, Btn } from "../lib/ui.jsx";
import {
  analyzeSmartBox,
  SMARTBOX_SIZE,
  SMARTBOX_VIN_OFFSETS,
} from "../lib/smartBoxAnalyzer.js";

const mono = "'JetBrains Mono', monospace";

function Field({ label, children, mono: m }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0" }}>
      <div style={{ minWidth: 150, color: C.ts, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontFamily: m ? mono : "inherit", fontWeight: 600, wordBreak: "break-all" }}>{children}</div>
    </div>
  );
}

export default function SmartBoxTab() {
  const [report, setReport] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const onFile = useCallback(async (file) => {
    if (!file) return;
    setError(null);
    setReport(null);
    setFileName(file.name);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (buf.length !== SMARTBOX_SIZE) {
        setError(
          `Expected a ${SMARTBOX_SIZE}-byte (4 KB) SmartBox EEE dump, got ${buf.length} bytes. ` +
            `Re-dump the external 24C32 EEPROM at the right read length.`
        );
        // Still analyze so the user sees what was parsed, but flag size.
      }
      setReport(analyzeSmartBox(buf));
    } catch (e) {
      setError(`Could not read file: ${e?.message || e}`);
    }
  }, []);

  const onInput = useCallback(
    (e) => {
      const f = e.target.files && e.target.files[0];
      onFile(f);
    },
    [onFile]
  );

  const stateColor = (s) =>
    s === "PROGRAMMED" ? C.gn : s === "VIN MISMATCH" ? C.er : C.ts;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontFamily: "'Righteous', cursive" }}>📦 SmartBox Immo Analyzer</h2>
          <Tag c={C.ts}>READ-ONLY</Tag>
          <Tag c={C.ts}>BENCH-UNCONFIRMED</Tag>
        </div>
        <p style={{ color: C.ts, fontSize: 13, lineHeight: 1.5, marginBottom: 0 }}>
          Decodes a 4&nbsp;KB Dodge Journey <b>SmartBox</b> immobilizer EEE dump (Freescale
          MC9S12XEG384 + external 24C32). Extracts the byte-reversed VIN from its 4 mirror
          slots plus FCA part-number / serial identifiers. Labels are reverse-engineered
          from staged dumps and unverified against a bench — there is no write path. The
          SmartBox shares its EEPROM layout with RFHUB&nbsp;Gen2, so this tab has its own
          upload rather than relying on module auto-detect.
        </p>
      </Card>

      <Card>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            ref={inputRef}
            type="file"
            accept=".bin"
            onChange={onInput}
            data-testid="smartbox-file-input"
            style={{ display: "none" }}
          />
          <Btn onClick={() => inputRef.current && inputRef.current.click()} data-testid="smartbox-upload-btn">
            Upload SmartBox .bin
          </Btn>
          {fileName && (
            <span style={{ fontFamily: mono, fontSize: 13, color: C.ts }}>{fileName}</span>
          )}
        </div>
        {error && (
          <div
            data-testid="smartbox-error"
            style={{
              marginTop: 10,
              padding: "8px 12px",
              borderRadius: 8,
              background: "rgba(211,47,47,0.10)",
              color: C.er,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}
      </Card>

      {report && report.ok && (
        <>
          <Card data-testid="smartbox-summary">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>Summary</h3>
              <Tag c={stateColor(report.state)}>{report.state}</Tag>
              <Tag c={report.confidence >= 80 ? C.gn : C.ts}>confidence {report.confidence}%</Tag>
            </div>
            <Field label="Consensus VIN" mono>
              {report.consensusVin || <span style={{ color: C.ts }}>— none —</span>}
            </Field>
            <Field label="VIN mirrors">
              {report.validVinCount}/4 valid · {report.vinConsistent ? "consistent" : "MISMATCH"}
            </Field>
            <Field label="Chip / size" mono>
              {report.chip} · {report.sizeLabel}
            </Field>
            <Field label="VIN checksum">
              <span style={{ color: C.ts, fontSize: 12 }}>{report.vinChecksum.note}</span>
              {" "}
              {report.vinChecksum.trailerMirrorsConsistent ? "(mirrors consistent)" : "(mirrors differ)"}
            </Field>
          </Card>

          <Card>
            <h3 style={{ marginTop: 0 }}>VIN records</h3>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: C.ts, borderBottom: `1px solid ${C.bd}` }}>
                    <th style={{ padding: "4px 8px" }}>#</th>
                    <th style={{ padding: "4px 8px" }}>Offset</th>
                    <th style={{ padding: "4px 8px" }}>Marker</th>
                    <th style={{ padding: "4px 8px" }}>VIN (decoded)</th>
                    <th style={{ padding: "4px 8px" }}>Trailer</th>
                  </tr>
                </thead>
                <tbody>
                  {report.vinRecords.map((rec) => (
                    <tr key={rec.index} style={{ borderBottom: `1px solid ${C.bd}`, fontFamily: mono }}>
                      <td style={{ padding: "4px 8px" }}>{rec.index}</td>
                      <td style={{ padding: "4px 8px" }}>{rec.offsetHex}</td>
                      <td style={{ padding: "4px 8px", color: rec.markerOk ? C.gn : C.er }}>
                        {rec.marker == null ? "—" : "0x" + rec.marker.toString(16).toUpperCase().padStart(2, "0")}
                      </td>
                      <td style={{ padding: "4px 8px", color: rec.valid ? C.tx : C.ts }}>
                        {rec.vin || "— invalid —"}
                      </td>
                      <td style={{ padding: "4px 8px" }}>
                        {rec.trailerHex || "—"}{" "}
                        <span style={{ color: C.ts, fontSize: 11 }}>{rec.trailerState}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <h3 style={{ marginTop: 0 }}>
              Identifier strings{" "}
              <span style={{ color: C.ts, fontWeight: 400, fontSize: 12 }}>
                (part numbers / serials · part block near {report.partNumberOffsetHex})
              </span>
            </h3>
            {report.identifiers.length === 0 ? (
              <div style={{ color: C.ts }}>— none —</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {report.identifiers.map((s, i) => (
                  <div key={i} style={{ display: "flex", gap: 12, fontFamily: mono, fontSize: 13 }}>
                    <span style={{ color: C.ts, minWidth: 72 }}>{s.offsetHex}</span>
                    <span style={{ wordBreak: "break-all" }}>{s.text}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
