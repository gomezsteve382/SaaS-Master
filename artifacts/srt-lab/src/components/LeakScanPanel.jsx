import React, { useCallback, useMemo, useState } from "react";
import { C } from "../lib/constants.js";
import { Card } from "../lib/ui.jsx";
import { scanBufferForDonorLeak, fmtOff, SUPPORTED_MODULE_TYPES }
  from "../lib/donorLeakScan.js";
import { useMasterVin } from "../lib/masterVinContext.jsx";

/* ============================================================================
 * LeakScanPanel — pre-share donor-VIN leak check (Task #447).
 *
 * Wraps the same `scanBufferForDonorLeak` the helper script uses on
 * committed `__fixtures__/realDumps/` `.bin` files (and that
 * `realDumps.helperLeakScan.test.js` enforces in CI). Lets a tech drop the
 * BCM / RFHUB / PCM `.bin` they're about to attach to a support ticket and
 * see, before they upload anywhere, whether their live VIN (or its last-6
 * serial) survived in the bytes.
 *
 * Skip-don't-fail when the user hasn't entered a Master VIN: show a clear
 * helper hint ("Enter your Master VIN above to enable the scan") and keep
 * the button disabled — never fire a scan with an empty/invalid VIN.
 *
 * Module-type pre-selection comes from the dropped filename (`BCM_…`,
 * `RFH_…`, `PCM_…` are how the export flows in `ModuleSync` name the
 * downloads); the user can override before scanning if the auto-detect
 * picks the wrong type.
 * ============================================================================ */

const VIN_RX = /^[A-HJ-NPR-Z0-9]{17}$/i;

// `SUPPORTED_MODULE_TYPES` is the union of every family the scrubber
// helper script supports — currently
// ['bcm','rfhub','rfhubg1','pcm','95640','sgw']; render with the labels
// users see elsewhere in the app (BCM / RFHUB / RFHUB G1 / PCM / 95640 /
// SGW). SGW (Task #450) has no documented VIN slots yet, so its scan is
// pure post-scrub leak detection — any donor VIN occurrence anywhere in
// an SGW buffer fires the guard.
const MODULE_TYPE_LABELS = {
  bcm: "BCM",
  rfhub: "RFHUB",
  rfhubg1: "RFHUB G1",
  pcm: "PCM",
  '95640': "95640",
  sgw: "SGW",
};

function moduleTypeFromFilename(name) {
  if (!name) return null;
  const u = String(name).toUpperCase();
  // Match the prefix ModuleSync uses on its `downloadBin` filenames; check
  // the more specific tokens first so a generic `RFH_…` doesn't shadow a
  // `RFH_G1_…` capture, and PCM before BCM/RFH so PCM-named bundles win.
  if (/(^|[^A-Z0-9])95640([^A-Z0-9]|$)/.test(u)) return "95640";
  if (/(^|[^A-Z])RFH(?:UB)?[_-]?G(?:EN)?1([^A-Z]|$)/.test(u)) return "rfhubg1";
  if (/(^|[^A-Z])PCM([^A-Z]|$)/.test(u)) return "pcm";
  if (/(^|[^A-Z])RFH(?:UB)?([^A-Z]|$)/.test(u)) return "rfhub";
  if (/(^|[^A-Z])BCM([^A-Z]|$)/.test(u)) return "bcm";
  return null;
}

export default function LeakScanPanel({ defaultModuleType = null, ...props }) {
  const masterVin = useMasterVin();
  const ctxVin = (masterVin?.vin || "").toUpperCase();

  const [vinOverride, setVinOverride] = useState("");
  const [file, setFile] = useState(null);            // { name, bytes }
  const [moduleType, setModuleType] = useState(defaultModuleType);
  const [result, setResult] = useState(null);        // { state, leak?, error?, donorVin, moduleType, filename, byteCount }
  const [busy, setBusy] = useState(false);

  // Effective VIN: override (if entered + valid) → context VIN. Empty
  // string when neither is usable so downstream gating is single-check.
  const effectiveVin = useMemo(() => {
    const candidate = (vinOverride || ctxVin || "").toUpperCase();
    return VIN_RX.test(candidate) ? candidate : "";
  }, [vinOverride, ctxVin]);

  const handleFile = useCallback(async (f) => {
    if (!f) { setFile(null); return; }
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      setFile({ name: f.name, bytes: buf });
      // Auto-pick module type from filename only when the caller didn't
      // pin one (e.g. when this panel is used standalone on BackupsTab).
      if (!defaultModuleType) {
        const mt = moduleTypeFromFilename(f.name);
        if (mt) setModuleType(mt);
      }
      setResult(null);
    } catch (e) {
      setFile(null);
      setResult({ state: "error", error: "Could not read file: " + (e?.message || String(e)) });
    }
  }, [defaultModuleType]);

  const handleFileInput = useCallback((e) => {
    const f = e.target.files?.[0] || null;
    e.target.value = "";
    handleFile(f);
  }, [handleFile]);

  const handleScan = useCallback(() => {
    if (!file || !moduleType || !effectiveVin) return;
    setBusy(true);
    setResult(null);
    // Defer to next tick so the busy state paints before the (synchronous,
    // typically <50 ms even on 128 KB BCM) scan runs.
    setTimeout(() => {
      try {
        const leak = scanBufferForDonorLeak({
          buffer: file.bytes,
          donorVin: effectiveVin,
          moduleType,
        });
        setResult({
          state: leak ? "leak" : "clean",
          leak,
          donorVin: effectiveVin,
          moduleType,
          filename: file.name,
          byteCount: file.bytes.length,
        });
      } catch (e) {
        setResult({ state: "error", error: e?.message || String(e) });
      } finally {
        setBusy(false);
      }
    }, 0);
  }, [file, moduleType, effectiveVin]);

  const handleReset = useCallback(() => {
    setFile(null);
    setResult(null);
    setVinOverride("");
    if (!defaultModuleType) setModuleType(null);
  }, [defaultModuleType]);

  const canScan = !!file && !!moduleType && !!effectiveVin && !busy;
  const noVinHint =
    !ctxVin && !VIN_RX.test(vinOverride.toUpperCase())
      ? "Enter your Master VIN above (or paste one below) to enable the scan."
      : (vinOverride && !VIN_RX.test(vinOverride.toUpperCase()))
        ? "VIN override is not a valid 17-char VIN — falling back to the Master VIN."
        : null;

  return (
    <Card data-testid="leak-scan-panel" style={{ ...(props.style || {}) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <div style={{ fontSize: 22 }}>🛡️</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "'Righteous'", fontSize: 16, letterSpacing: 1 }}>
            Scan this backup for VIN leaks
          </div>
          <div style={{ fontSize: 11, color: C.ts, marginTop: 2 }}>
            Before sharing a BCM / RFHUB / PCM <code>.bin</code> with anyone, check that
            your live VIN was actually scrubbed. Same scanner CI runs on committed fixtures.
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr", marginTop: 8 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1.5, marginBottom: 4 }}>
            BACKUP FILE (.BIN)
          </div>
          <label
            data-testid="leak-scan-file-drop"
            style={{
              display: "block", padding: "10px 12px", border: "1.5px dashed " + C.bd,
              borderRadius: 8, background: C.c2, cursor: "pointer", fontSize: 12, color: C.ts,
              minHeight: 36,
            }}
          >
            {file
              ? <span style={{ fontFamily: "'JetBrains Mono'", color: C.tx }}>
                  {file.name} <span style={{ color: C.tm }}>({file.bytes.length.toLocaleString()} B)</span>
                </span>
              : <span>Click to choose a .bin file…</span>}
            <input
              type="file"
              accept=".bin,application/octet-stream"
              onChange={handleFileInput}
              style={{ display: "none" }}
              data-testid="leak-scan-file-input"
            />
          </label>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1.5, marginBottom: 4 }}>
            MODULE TYPE
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {SUPPORTED_MODULE_TYPES.map((mt) => {
              const active = moduleType === mt;
              return (
                <button
                  key={mt}
                  type="button"
                  onClick={() => setModuleType(mt)}
                  data-testid={`leak-scan-mt-${mt}`}
                  style={{
                    flex: 1, padding: "8px 10px", borderRadius: 8,
                    border: "1.5px solid " + (active ? C.a2 : C.bd),
                    background: active ? C.a2 + "18" : C.cd,
                    color: active ? C.a2 : C.tx,
                    fontWeight: 800, fontSize: 12, letterSpacing: 1, cursor: "pointer",
                  }}
                >
                  {MODULE_TYPE_LABELS[mt]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.ts, letterSpacing: 1.5, marginBottom: 4 }}>
          VIN TO SCAN FOR
          {ctxVin && !vinOverride && (
            <span style={{ marginLeft: 8, fontWeight: 700, color: C.tm, letterSpacing: 0 }}>
              (using Master VIN)
            </span>
          )}
        </div>
        <input
          value={vinOverride}
          onChange={(e) => setVinOverride(e.target.value.toUpperCase().replace(/\s/g, "").slice(0, 17))}
          placeholder={ctxVin || "17-char VIN…"}
          data-testid="leak-scan-vin"
          style={{
            width: "100%", boxSizing: "border-box", padding: "8px 10px",
            border: "1.5px solid " + C.bd, borderRadius: 8,
            fontFamily: "'JetBrains Mono'", fontSize: 13, letterSpacing: 1,
            background: C.cd,
          }}
        />
        {noVinHint && (
          <div style={{ marginTop: 6, fontSize: 11, color: C.wn }}>
            {noVinHint}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {/* Native buttons here (rather than the shared `Btn`) so we can pin
            `data-testid` for the UI smoke test — `Btn` does not forward
            arbitrary HTML attributes. */}
        <button
          type="button"
          onClick={handleScan}
          disabled={!canScan}
          data-testid="leak-scan-run"
          style={{
            padding: "10px 20px", borderRadius: 10, fontFamily: "'Nunito'",
            fontWeight: 800, fontSize: 12, border: "none", letterSpacing: 0.5,
            cursor: canScan ? "pointer" : "not-allowed",
            background: canScan ? C.a2 : "#E8E4DE",
            color: canScan ? "#fff" : C.tm,
          }}
        >
          {busy ? "Scanning…" : "🔍 Scan for VIN leaks"}
        </button>
        {(file || result) && (
          <button
            type="button"
            onClick={handleReset}
            data-testid="leak-scan-reset"
            style={{
              padding: "10px 20px", borderRadius: 10, fontFamily: "'Nunito'",
              fontWeight: 800, fontSize: 12, letterSpacing: 0.5,
              border: `2px solid ${C.tm}33`, background: "transparent",
              color: C.tm, cursor: "pointer",
            }}
          >
            Reset
          </button>
        )}
      </div>

      {result && (
        <div style={{ marginTop: 12 }}>
          {result.state === "clean" && (
            <div
              data-testid="leak-scan-result-clean"
              style={{
                padding: "10px 12px", borderRadius: 8,
                background: "#E8F5E9", border: "1.5px solid #00C85355",
                fontSize: 13, color: "#0A3D1A",
              }}
            >
              <b>✓ Clean — no leaks detected.</b>{" "}
              VIN <code>{result.donorVin}</code> (and its last-6 serial)
              do not appear in <code>{result.filename}</code> ({MODULE_TYPE_LABELS[result.moduleType]}, {result.byteCount.toLocaleString()} B)
              outside the documented VIN slot windows. Safe to share.
            </div>
          )}
          {result.state === "leak" && (
            <div
              data-testid="leak-scan-result-leak"
              style={{
                padding: "10px 12px", borderRadius: 8,
                background: "#FFEBEE", border: "1.5px solid " + C.er,
                fontSize: 13, color: "#7A0000",
              }}
            >
              <b>✗ Leak found at {fmtOff(result.leak.offset)} — {result.leak.kind}.</b>
              <div style={{ marginTop: 6, fontSize: 12, color: "#5A0000" }}>
                {result.leak.message}
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: C.tm }}>
                File: <code>{result.filename}</code> · {MODULE_TYPE_LABELS[result.moduleType]} · {result.byteCount.toLocaleString()} B ·
                VIN scanned for: <code>{result.donorVin}</code>
              </div>
            </div>
          )}
          {result.state === "error" && (
            <div
              data-testid="leak-scan-result-error"
              style={{
                padding: "10px 12px", borderRadius: 8,
                background: "#FFF8E1", border: "1.5px solid " + C.wn,
                fontSize: 13, color: "#5A3A00",
              }}
            >
              <b>⚠ Could not run scan:</b> {result.error}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
