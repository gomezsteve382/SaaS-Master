import React, { useState, useMemo } from "react";
import { C } from "./constants.js";
import { getFixturesByKinds, loadFixtureAsFile, loadFixtureBytes, describeFixture } from "./sampleFixtures.js";

/* "Try a sample" picker — drops alongside file dropzones to let users
 * smoke-test a tab using one of the catalogued real ECU fixtures.
 *
 * Props:
 *   kinds        — array of fixture kinds to list (e.g. ["BCM"])
 *   acceptSizes  — optional Set/array of byte counts; non-matching are filtered out
 *   onFile(f)    — if provided, called with a synthetic File (for tabs that
 *                  read via FileReader)
 *   onBytes(b,n) — if provided, called with (Uint8Array, filename)
 *   label        — header text (default "Try a sample")
 *   compact      — render as a single inline row
 */
export default function SamplePicker({
  kinds, acceptSizes, onFile, onBytes,
  label = "📦 Try a sample dump",
  compact = false,
}) {
  const fixtures = useMemo(() => {
    let list = getFixturesByKinds(Array.isArray(kinds) ? kinds : [kinds]);
    if (acceptSizes) {
      const ok = new Set(Array.from(acceptSizes));
      list = list.filter(f => ok.has(f.size));
    }
    return list;
  }, [kinds, acceptSizes]);
  const [sel, setSel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (!fixtures.length) return null;

  const onChange = async e => {
    const filename = e.target.value;
    setSel(filename);
    if (!filename) return;
    setBusy(true); setErr("");
    try {
      if (onFile) {
        const f = await loadFixtureAsFile(filename);
        onFile(f);
      } else if (onBytes) {
        const b = await loadFixtureBytes(filename);
        onBytes(b, filename);
      }
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy(false);
    }
  };

  const sty = {
    container: {
      marginTop: 8, padding: compact ? "6px 10px" : "8px 12px",
      borderRadius: 8, background: C.c2, border: "1px dashed " + C.bd,
      display: "flex", flexDirection: compact ? "row" : "column", gap: 6, alignItems: compact ? "center" : "stretch",
    },
    label: {
      fontSize: 10, fontWeight: 800, color: C.tm, letterSpacing: 1,
      textTransform: "uppercase",
    },
    select: {
      flex: 1, padding: "6px 8px", borderRadius: 6, border: "1px solid " + C.bd,
      background: "#fff", fontFamily: "'JetBrains Mono'", fontSize: 11, color: C.tx,
      cursor: busy ? "wait" : "pointer", minWidth: 0,
    },
  };

  return (
    <div style={sty.container} title="Pre-loaded real ECU dumps from the test fixtures catalog">
      <div style={sty.label}>{label}{busy ? " · loading…" : ""}</div>
      <select data-sample-picker="1" value={sel} onChange={onChange} disabled={busy} style={sty.select}>
        <option value="">— choose one of {fixtures.length} sample{fixtures.length === 1 ? "" : "s"} —</option>
        {fixtures.map(f => (
          <option key={f.file} value={f.file} title={describeFixture(f)}>
            {describeFixture(f)}
          </option>
        ))}
      </select>
      {err && <div style={{ fontSize: 10, color: C.er, fontWeight: 700 }}>✗ {err}</div>}
    </div>
  );
}
