import React, { useMemo, useState } from "react";
import { C } from "../lib/constants.js";
import {
  SAMPLE_FIXTURES,
  loadFixtureAsFile,
  loadFixtureBytes,
} from "../lib/sampleFixtures.js";
/* Task #504 — generated at dev/build start by
 * `scripts/check-attached-asset-extensions.mjs`. Lists files in
 * `attached_assets/` whose contents do not match their extension (e.g. the
 * Task #497 BCM dumps that arrived with a `.zip` suffix and sat unused
 * for months). Shown as a banner above the catalog so a developer or
 * agent reviewing project state spots the misnamed uploads without
 * having to grep. */
import attachedAssetMismatches from "../lib/attachedAssetMismatches.generated.json";

const KIND_LABEL = {
  BCM: "BCM D-FLASH",
  "95640": "95640 EXT EEPROM",
  GPEC_EXT: "GPEC2A EXT EEPROM",
  GPEC_INT: "GPEC2A INT FLASH",
  RFH_EEE: "RFHUB EEE",
  RFH_PFLASH: "RFHUB P-FLASH",
  SMARTBOX: "SmartBox EEE",
};

const KIND_COLOR = {
  BCM: "#FF6D00",
  "95640": "#AA00FF",
  GPEC_EXT: "#00BFA5",
  GPEC_INT: "#00897B",
  RFH_EEE: "#2979FF",
  RFH_PFLASH: "#1565C0",
  SMARTBOX: "#9E9E9E",
};

/* Where each fixture kind feels "at home". Preview loads the fixture into
 * the workspace's shared file list and switches to the matching tab so the
 * user can immediately see it parsed. */
const KIND_TAB = {
  BCM: "bcm",
  "95640": "dumps",
  GPEC_EXT: "ecm",
  GPEC_INT: "ecm",
  RFH_EEE: "rfhub",
  RFH_PFLASH: "rfhub",
  SMARTBOX: "dumps",
};

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n % (1024 * 1024) ? 1 : 0) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(n % 1024 ? 1 : 0) + " KB";
  return n + " B";
}

export default function SampleLibraryTab({ onPreview }) {
  const [kind, setKind] = useState("ALL");
  const [role, setRole] = useState("ALL");
  const [vin, setVin] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const kinds = useMemo(
    () => Array.from(new Set(SAMPLE_FIXTURES.map(f => f.kind))).sort(),
    []
  );
  const roles = useMemo(
    () => Array.from(new Set(SAMPLE_FIXTURES.map(f => f.role))).sort(),
    []
  );

  const filtered = useMemo(() => {
    const q = vin.trim().toUpperCase();
    return SAMPLE_FIXTURES.filter(f => {
      if (kind !== "ALL" && f.kind !== kind) return false;
      if (role !== "ALL" && f.role !== role) return false;
      if (q) {
        const hay = ((f.vin || "") + " " + (f.pair || "") + " " + f.file).toUpperCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [kind, role, vin]);

  async function doPreview(f) {
    setBusy(f.file); setErr(""); setMsg("");
    try {
      const file = await loadFixtureAsFile(f.file);
      // The workspace `loadF` (Task #376) returns a structured result so
      // we can surface the same "this isn't a full <module> dump" feedback
      // inline whenever a fragment fixture is selected from the catalog,
      // instead of silently switching tabs to an empty workspace.
      const result = onPreview ? await onPreview(file, KIND_TAB[f.kind] || "dumps", f) : null;
      if (result && result.rejected && result.rejected.length) {
        const r = result.rejected[0];
        setErr(
          "⛔ This isn't a full " + r.type + " dump — " + r.name +
          " is " + r.size.toLocaleString() + " bytes (need " +
          r.min.toLocaleString() + " bytes, " + r.label +
          "). The fixture was not loaded into the workspace."
        );
      } else {
        setMsg("Loaded " + f.file + " into " + (KIND_LABEL[f.kind] || f.kind) + " workspace");
      }
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy("");
    }
  }

  async function doDownload(f) {
    setBusy(f.file); setErr(""); setMsg("");
    try {
      const bytes = await loadFixtureBytes(f.file);
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = f.file;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy("");
    }
  }

  const sty = {
    wrap: { display: "flex", flexDirection: "column", gap: 14 },
    head: { background: C.cd, border: "1.5px solid " + C.bd, borderRadius: 16, padding: 18 },
    title: { fontSize: 11, fontWeight: 800, color: C.ts, letterSpacing: 2, marginBottom: 4 },
    sub: { fontSize: 12, color: C.ts, lineHeight: 1.5 },
    filters: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginTop: 14 },
    field: { display: "flex", flexDirection: "column", gap: 4 },
    flabel: { fontSize: 9, fontWeight: 800, color: C.tm, letterSpacing: 1.5, textTransform: "uppercase" },
    select: {
      padding: "8px 10px", borderRadius: 8, border: "1px solid " + C.bd,
      background: "#fff", fontFamily: "'JetBrains Mono'", fontSize: 12, color: C.tx,
    },
    counter: { fontSize: 10, color: C.tm, fontWeight: 700, letterSpacing: 1, marginTop: 10 },
    table: { background: C.cd, border: "1.5px solid " + C.bd, borderRadius: 16, overflow: "hidden" },
    rowsHead: {
      display: "grid",
      gridTemplateColumns: "120px 130px 1fr 90px 90px 220px",
      gap: 10, padding: "10px 14px",
      background: C.c2, borderBottom: "1px solid " + C.bd,
      fontSize: 9, fontWeight: 800, color: C.tm, letterSpacing: 1.5, textTransform: "uppercase",
    },
    row: {
      display: "grid",
      gridTemplateColumns: "120px 130px 1fr 90px 90px 220px",
      gap: 10, padding: "12px 14px", alignItems: "center",
      borderBottom: "1px solid " + C.bd, fontSize: 11,
    },
    pill: (k) => ({
      display: "inline-block", padding: "3px 8px", borderRadius: 6,
      background: (KIND_COLOR[k] || C.tm) + "1A",
      color: KIND_COLOR[k] || C.tm, fontWeight: 800, fontSize: 9,
      letterSpacing: 1, textTransform: "uppercase",
    }),
    mono: { fontFamily: "'JetBrains Mono'", fontSize: 10, color: C.tx },
    notes: { color: C.ts, fontSize: 10, marginTop: 3, lineHeight: 1.4 },
    btn: (primary) => ({
      padding: "6px 10px", borderRadius: 6, cursor: "pointer",
      fontWeight: 800, fontSize: 10, letterSpacing: 1, fontFamily: "'Nunito'",
      background: primary ? C.sr : C.c2,
      color: primary ? "#fff" : C.tx,
      border: primary ? "none" : "1px solid " + C.bd,
    }),
    actions: { display: "flex", gap: 6, justifyContent: "flex-end" },
    empty: { padding: 24, textAlign: "center", color: C.tm, fontSize: 12 },
    note: { fontSize: 11, fontWeight: 700, padding: "8px 12px", borderRadius: 8 },
  };

  const mismatches = (attachedAssetMismatches && attachedAssetMismatches.mismatches) || [];

  return (
    <div style={sty.wrap}>
      {mismatches.length > 0 && (
        <div
          style={{
            background: C.er + "1A",
            border: "1.5px solid " + C.er,
            borderRadius: 16,
            padding: 16,
            color: C.er,
            fontSize: 12,
            lineHeight: 1.5,
          }}
          data-testid="attached-asset-mismatch-banner"
        >
          <div style={{ fontWeight: 800, letterSpacing: 1.5, fontSize: 11, marginBottom: 6 }}>
            ⚠ {mismatches.length} MISNAMED UPLOAD{mismatches.length === 1 ? "" : "S"} IN attached_assets/
          </div>
          <div style={{ color: C.tx, marginBottom: 8 }}>
            These files were uploaded with the wrong extension — their contents
            don't match what the name says, so the dump tools can't pick them up
            (same class of bug as Task #497). Rescue / rename them by content
            before they go unused.
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, color: C.tx, fontFamily: "'JetBrains Mono'", fontSize: 11 }}>
            {mismatches.map((m) => (
              <li key={m.file} style={{ marginBottom: 4 }}>
                <span style={{ fontWeight: 800 }}>{m.file}</span>
                <span style={{ color: C.tm }}>
                  {" "}— {m.size.toLocaleString()} B, claimed {m.claimedKind}
                </span>
                <div style={{ color: C.ts, marginTop: 2 }}>{m.hint}</div>
              </li>
            ))}
          </ul>
          <div style={{ color: C.tm, marginTop: 8, fontSize: 10 }}>
            Detection runs at dev / build start (see <code>pnpm --filter @workspace/srt-lab assets:check</code>).
          </div>
        </div>
      )}
      <div style={sty.head}>
        <div style={sty.title}>📚 SAMPLE LIBRARY</div>
        <div style={sty.sub}>
          Browse the catalog of {SAMPLE_FIXTURES.length} real ECU dumps that ship
          with SRT Lab. Filter by module kind, role, or VIN — then preview the
          dump in its matching tab or download the raw <code>.bin</code> for
          your own tools.
        </div>
        <div style={sty.filters}>
          <div style={sty.field}>
            <div style={sty.flabel}>Module kind</div>
            <select style={sty.select} value={kind} onChange={e => setKind(e.target.value)}>
              <option value="ALL">All kinds</option>
              {kinds.map(k => <option key={k} value={k}>{KIND_LABEL[k] || k}</option>)}
            </select>
          </div>
          <div style={sty.field}>
            <div style={sty.flabel}>Role</div>
            <select style={sty.select} value={role} onChange={e => setRole(e.target.value)}>
              <option value="ALL">All roles</option>
              {roles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div style={sty.field}>
            <div style={sty.flabel}>VIN / pair / filename</div>
            <input
              style={sty.select}
              value={vin}
              onChange={e => setVin(e.target.value)}
              placeholder="e.g. 1C4RJFDJ7DC513874 or trackhawk-1"
            />
          </div>
        </div>
        <div style={sty.counter}>
          Showing {filtered.length} of {SAMPLE_FIXTURES.length} fixtures
        </div>
        {err && <div style={{ ...sty.note, background: C.er + "1A", color: C.er, marginTop: 10 }}>✗ {err}</div>}
        {msg && <div style={{ ...sty.note, background: C.gn + "1A", color: C.gn, marginTop: 10 }}>✓ {msg}</div>}
      </div>

      <div style={sty.table}>
        <div style={sty.rowsHead}>
          <div>Kind</div>
          <div>Role</div>
          <div>File · Notes</div>
          <div>Size</div>
          <div>VIN / Pair</div>
          <div style={{ textAlign: "right" }}>Actions</div>
        </div>
        {filtered.length === 0 && <div style={sty.empty}>No fixtures match those filters.</div>}
        {filtered.map(f => (
          <div key={f.file} style={sty.row}>
            <div><span style={sty.pill(f.kind)}>{KIND_LABEL[f.kind] || f.kind}</span></div>
            <div style={{ ...sty.mono, fontWeight: 800 }}>{f.role}</div>
            <div>
              <div style={sty.mono}>{f.file}</div>
              <div style={sty.notes}>{f.notes}</div>
            </div>
            <div style={sty.mono}>{fmtSize(f.size)}</div>
            <div style={sty.mono}>
              {f.vin || <span style={{ color: C.tm }}>(no VIN)</span>}
              {f.pair && <div style={{ color: C.tm, marginTop: 2 }}>↔ {f.pair}</div>}
            </div>
            <div style={sty.actions}>
              <button
                style={sty.btn(true)}
                disabled={!!busy}
                onClick={() => doPreview(f)}
                title={"Load this fixture into the " + (KIND_LABEL[f.kind] || f.kind) + " workspace"}
              >
                {busy === f.file ? "…" : "▶ PREVIEW"}
              </button>
              <button
                style={sty.btn(false)}
                disabled={!!busy}
                onClick={() => doDownload(f)}
                title="Download the raw .bin"
              >
                ⬇ .BIN
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
