import React, { useState, useMemo } from "react";
import { C } from "./constants.js";
import { SAMPLE_FIXTURES, getFixturesByKinds, loadFixtureAsFile, loadFixtureBytes, describeFixture } from "./sampleFixtures.js";

/* "Try a sample" picker — drops alongside file dropzones to let users
 * smoke-test a tab using one of the catalogued real ECU fixtures.
 *
 * Props:
 *   kinds          — array of fixture kinds to list (e.g. ["BCM"])
 *   acceptSizes    — optional Set/array of byte counts; non-matching are filtered out
 *   onFile(f)      — if provided, called with a synthetic File (for tabs that
 *                    read via FileReader)
 *   onBytes(b,n)   — if provided, called with (Uint8Array, filename)
 *   onLoaded(fix)  — optional callback fired after a successful load with the
 *                    fixture metadata (so a parent tab can capture `pair` and
 *                    propagate `suggestedPair` to sibling pickers)
 *   suggestedPair  — optional pair key (e.g. "trackhawk-1"). When set and a
 *                    fixture in the list shares that pair, a one-click
 *                    "Load matching pair" hint button is shown.
 *   label          — header text (default "Try a sample")
 *   compact        — render as a single inline row
 */
export default function SamplePicker({
  kinds, acceptSizes, onFile, onBytes, onLoaded,
  suggestedPair = null,
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

  // Find a fixture in this picker's visible list that shares the suggested
  // pair key with whatever was loaded elsewhere — and is not the one we
  // ourselves just loaded.
  const matchingPair = useMemo(() => {
    if (!suggestedPair) return null;
    return fixtures.find(f => f.pair === suggestedPair && f.file !== sel) || null;
  }, [suggestedPair, fixtures, sel]);

  if (!fixtures.length) return null;

  const loadFixture = async filename => {
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
      if (onLoaded) {
        const meta = SAMPLE_FIXTURES.find(f => f.file === filename) || null;
        if (meta) onLoaded(meta);
      }
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy(false);
    }
  };

  const onChange = async e => {
    const filename = e.target.value;
    setSel(filename);
    await loadFixture(filename);
  };

  const onLoadPair = async () => {
    if (!matchingPair) return;
    setSel(matchingPair.file);
    await loadFixture(matchingPair.file);
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
    pairBtn: {
      padding: "6px 10px", borderRadius: 6,
      border: "1.5px solid " + C.gn + "60",
      background: C.gn + "12", color: C.gn,
      fontSize: 10, fontWeight: 800, letterSpacing: .5,
      fontFamily: "'Nunito'", cursor: busy ? "wait" : "pointer",
      textAlign: "left", lineHeight: 1.3,
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
      {matchingPair && (
        <button
          type="button"
          data-sample-pair-suggest="1"
          data-pair-key={suggestedPair}
          onClick={onLoadPair}
          disabled={busy}
          style={sty.pairBtn}
          title={describeFixture(matchingPair)}
        >
          🔗 Load matching pair: {matchingPair.vin || matchingPair.role} · {matchingPair.kind}
        </button>
      )}
      {err && <div style={{ fontSize: 10, color: C.er, fontWeight: 700 }}>✗ {err}</div>}
    </div>
  );
}
