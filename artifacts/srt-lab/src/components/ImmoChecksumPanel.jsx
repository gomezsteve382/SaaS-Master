import React from "react";
import {Card, Btn} from "../lib/ui.jsx";
import {C} from "../lib/constants.js";
import {checkExportSafety, formatBlockingMessage} from "../lib/exportSafetyGate.js";

/* ────────────────────────────────────────────────────────────────────────────
 * ImmoChecksumPanel — the shared "ImmoVIN" inspect → validate → edit layout
 * surfaced inside the BCM, ECM and RFHUB main tabs.
 *
 * It renders the three stacked sections the user's reference layout asks for,
 * driven entirely by a normalized model produced by a per-module adapter:
 *
 *   1. header           — module title + subtitle + status badges
 *   2. analysis         — summary MiniCards (family / size / VIN slot / sec slot)
 *   3. vinSection       — every VIN copy as its own row with a per-row verdict
 *   4. securitySection  — SEC16 main / inverted / mirror (or SEC6 + IMMO) rows,
 *                          each with its own checksum / marker verdict
 *   5. editing          — VIN + secret editing slots (only the fields the
 *                          detected security supports are enabled) + APPLY AND
 *                          DOWNLOAD, gated through the shared export-safety gate
 *
 * The component is presentational + controlled: all input state, handlers and
 * status lives in the per-module wrapper that builds the model. The common
 * download path is centralised in runGatedExport() so every emitted file goes
 * through the same checkExportSafety() gate.
 * ────────────────────────────────────────────────────────────────────────── */

const mono = "'JetBrains Mono'";

export const dl = (d, n) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([d]));
  a.download = n;
  a.click();
  URL.revokeObjectURL(a.href);
};

export function parseHexBytes(s) {
  const cleaned = (s || "").replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  return out;
}

/* Centralised, gated download. Runs the outgoing bytes through
 * checkExportSafety() and only writes the file when the verdict is clean.
 * Returns {ok, message} — message is a success line or the blocking report. */
export function runGatedExport({
  bytes,
  filename,
  role = "OUTGOING",
  context = [],
  crossModule = true,
  selfChecks = ["vin", "partials", "sec16"],
  successMsg,
  download = dl,
}) {
  if (!bytes || !(bytes instanceof Uint8Array) || bytes.length === 0) {
    return {ok: false, message: "Nothing to export — patched buffer is empty."};
  }
  const verdict = checkExportSafety({
    outgoing: [{role, name: filename, bytes}],
    context,
    crossModule,
    selfChecks,
  });
  if (!verdict.ok) {
    return {ok: false, message: formatBlockingMessage(verdict), verdict};
  }
  download(bytes, filename);
  return {ok: true, message: successMsg || "Exported " + filename + " (passed safety gate).", verdict};
}

export function StatBadge({value, good}) {
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

export function MiniCard({title, accent = C.sr, children, badge}) {
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

function renderCell(cell) {
  if (cell == null) return <span style={{color: C.tm}}>—</span>;
  if (typeof cell === "object" && cell.badge) {
    return <StatBadge value={cell.badge.value ?? cell.badge.label} good={cell.badge.good} />;
  }
  if (typeof cell === "object") {
    const {text, bold, color, muted} = cell;
    const val = text == null || text === "" ? "—" : text;
    return (
      <span
        style={{
          fontWeight: bold ? 800 : undefined,
          color: muted ? C.tm : color || C.tx,
          fontSize: muted ? 10 : undefined,
        }}
      >
        {val}
      </span>
    );
  }
  return <span>{cell}</span>;
}

function VerdictTable({columns, rows, empty, testidPrefix}) {
  if (!rows || rows.length === 0) {
    return <div style={{fontSize: 11, color: C.tm, fontStyle: "italic"}}>{empty || "Nothing detected."}</div>;
  }
  return (
    <div style={{overflowX: "auto"}}>
      <table style={{width: "100%", borderCollapse: "collapse", fontSize: 11}}>
        <thead>
          <tr style={{textAlign: "left", color: C.ts, borderBottom: "1px solid " + C.bd}}>
            {columns.map((c, i) => (
              <th key={i} style={{padding: "6px 8px"}}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              data-testid={testidPrefix ? testidPrefix + "-row-" + i : undefined}
              style={{borderBottom: "1px solid " + C.bd, fontFamily: mono}}
            >
              {r.cells.map((cell, j) => (
                <td key={j} style={{padding: "6px 8px"}}>{renderCell(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionCard({icon, title, accent = C.sr, children}) {
  return (
    <Card style={{marginBottom: 14}}>
      <div style={{fontWeight: 800, fontSize: 11, color: accent, marginBottom: 10, letterSpacing: 2}}>
        {icon ? icon + " " : ""}{title}
      </div>
      {children}
    </Card>
  );
}

export default function ImmoChecksumPanel({
  testid,
  title,
  subtitle,
  accent = C.sr,
  headerBadges = [],
  analysis = null,
  afterAnalysis = null,
  vinSection = null,
  afterVin = null,
  securitySection = null,
  afterSecurity = null,
  editing = null,
  extraAfterEditing = null,
  status = null,
}) {
  return (
    <div data-testid={testid} style={{marginTop: 16}}>
      <Card style={{marginBottom: 14, borderTop: "3px solid " + accent}}>
        <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8}}>
          <div>
            <div style={{fontFamily: "'Righteous'", fontSize: 18, color: accent, letterSpacing: 1}}>{title}</div>
            {subtitle && (
              <div style={{fontSize: 10, color: C.tm, letterSpacing: 1, fontWeight: 700}}>{subtitle}</div>
            )}
          </div>
          {headerBadges.length > 0 && (
            <div style={{display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap"}}>
              {headerBadges.map((b, i) => (
                <span
                  key={i}
                  style={{
                    fontSize: b.small ? 10 : 11,
                    fontWeight: 800,
                    padding: "4px 10px",
                    borderRadius: 8,
                    background: (b.color || C.a2) + "18",
                    color: b.color || C.a2,
                    fontFamily: mono,
                  }}
                >
                  {b.text}
                </span>
              ))}
            </div>
          )}
        </div>
      </Card>

      {analysis && analysis.cards && analysis.cards.length > 0 && (
        <SectionCard icon={analysis.icon || "📊"} title={analysis.title || "ANALYSIS RESULT"} accent={accent}>
          <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10}}>
            {analysis.cards.map((card, i) => (
              <MiniCard
                key={i}
                title={card.title}
                accent={card.accent || accent}
                badge={card.badge ? <StatBadge value={card.badge.value ?? card.badge.label} good={card.badge.good} /> : undefined}
              >
                {card.value != null && (
                  <div style={{fontFamily: mono, fontWeight: 800, fontSize: 13, color: card.valueColor || C.tx, letterSpacing: card.spaced ? 2 : undefined}}>
                    {card.value}
                  </div>
                )}
                {card.sub && <div style={{fontSize: 10, color: C.tm, marginTop: 3}}>{card.sub}</div>}
                {card.extra}
              </MiniCard>
            ))}
          </div>
        </SectionCard>
      )}

      {afterAnalysis}

      {vinSection && (
        <SectionCard icon={vinSection.icon || "🔑"} title={vinSection.title} accent={accent}>
          <VerdictTable
            columns={vinSection.columns}
            rows={vinSection.rows}
            empty={vinSection.empty}
            testidPrefix={vinSection.testidPrefix || "immo-vin"}
          />
        </SectionCard>
      )}

      {afterVin}

      {securitySection && (
        <SectionCard icon={securitySection.icon || "🔐"} title={securitySection.title} accent={accent}>
          <VerdictTable
            columns={securitySection.columns}
            rows={securitySection.rows}
            empty={securitySection.empty}
            testidPrefix={securitySection.testidPrefix || "immo-sec"}
          />
        </SectionCard>
      )}

      {afterSecurity}

      {editing && (
        <SectionCard icon={editing.icon || "✏️"} title={editing.title || "APPLY CHANGES & DOWNLOAD"} accent={accent}>
          {editing.hint && <div style={{fontSize: 10, color: C.tm, marginBottom: 12}}>{editing.hint}</div>}
          <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 12}}>
            {(editing.fields || []).map((f, i) => (
              <div key={i}>
                <div style={labelStyle}>{f.label}</div>
                <input
                  value={f.value}
                  onChange={f.onChange}
                  placeholder={f.placeholder}
                  maxLength={f.maxLength}
                  disabled={f.disabled}
                  data-testid={f.testid}
                  style={{...inputStyle, ...(f.disabled ? {background: "#EFECE6", color: C.tm} : {})}}
                />
                {f.below}
              </div>
            ))}
          </div>
          {editing.controls}
          {editing.banner}
          {editing.primary && (
            <div style={{marginTop: 12}}>
              <Btn
                color={editing.primary.color || C.gn}
                full={editing.primary.full !== false}
                onClick={editing.primary.onClick}
                disabled={editing.primary.disabled}
                data-testid={editing.primary.testid}
              >
                {editing.primary.label}
              </Btn>
            </div>
          )}
        </SectionCard>
      )}

      {extraAfterEditing}

      {status && (status.msg || status.err) && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 11,
            fontWeight: 700,
            whiteSpace: "pre-wrap",
            background: status.err ? C.er + "12" : C.gn + "12",
            border: "1px solid " + (status.err ? C.er + "40" : C.gn + "40"),
            color: status.err ? C.er : C.gn,
          }}
          data-testid={status.testid}
        >
          {status.err || status.msg}
        </div>
      )}
    </div>
  );
}
