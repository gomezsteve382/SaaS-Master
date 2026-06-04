import React, { useState, useCallback, useRef } from "react";
import { C } from "../lib/constants.js";
import { Card, Tag, Btn } from "../lib/ui.jsx";
import {
  patchGpec2aFile,
  detectGeneration,
  isAlreadyUnlocked,
  PATTERNS_AVAILABLE,
  UNLOCK_FLAG_OFFSET,
  UNLOCK_FLAG_BYTE,
} from "../lib/gpec2aUnlocker.js";

const offHex = (n) => "0x" + n.toString(16).toUpperCase().padStart(5, "0");
const byteHex = (b) => "0x" + b.toString(16).toUpperCase().padStart(2, "0");

function dl(data, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function StatusBadge({ status }) {
  const cfg = {
    unlocked:        { bg: C.gn + "20", color: C.gn,  border: C.gn + "40",  label: "✓ UNLOCKED"      },
    already_unlocked:{ bg: C.a3 + "20", color: C.a3,  border: C.a3 + "40",  label: "✓ ALREADY UNLOCKED" },
    offset_only:     { bg: C.wn + "20", color: C.wn,  border: C.wn + "40",  label: "⚠ OFFSET FLAG ONLY" },
    pattern_not_found:{ bg: C.er+"20",  color: C.er,  border: C.er + "40",  label: "✗ PATTERN NOT FOUND" },
    PATTERN_MISSING: { bg: "#4A148C20", color: "#CE93D8", border: "#4A148C60", label: "⛔ PATTERN MISSING (see note)" },
    locked:          { bg: C.er + "15", color: C.er,  border: C.er + "30",  label: "🔒 LOCKED"         },
  }[status] || { bg: C.c2, color: C.ts, border: C.bd, label: status };

  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "4px 12px", borderRadius: 8, fontSize: 11, fontWeight: 900,
      letterSpacing: 0.8, background: cfg.bg, color: cfg.color,
      border: `1px solid ${cfg.border}`,
    }}>
      {cfg.label}
    </span>
  );
}

function GenBadge({ generation }) {
  if (!generation || generation === "PATTERN_MISSING") return null;
  const is2018plus = generation === "NEW 2018+ FILE FLASH";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "3px 10px", borderRadius: 6, fontSize: 10, fontWeight: 800,
      letterSpacing: 0.5, marginLeft: 8,
      background: is2018plus ? C.a3 + "20" : C.a1 + "20",
      color: is2018plus ? C.a3 : C.a1,
      border: `1px solid ${is2018plus ? C.a3 + "40" : C.a1 + "40"}`,
    }}>
      {generation}
    </span>
  );
}

export default function Gpec2aUnlockTab() {
  const [fileName, setFileName] = useState(null);
  const [fileData, setFileData] = useState(null);
  const [result, setResult] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef();

  const loadFile = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const bytes = new Uint8Array(e.target.result);
      setFileName(file.name);
      setFileData(bytes);

      const generation = detectGeneration(bytes);
      const alreadyUnlocked = isAlreadyUnlocked(bytes);
      const flagSet = bytes.length > UNLOCK_FLAG_OFFSET && bytes[UNLOCK_FLAG_OFFSET] === UNLOCK_FLAG_BYTE;

      if (!PATTERNS_AVAILABLE) {
        setResult({
          generation,
          status: "PATTERN_MISSING",
          matchOffset: null,
          flagSet,
          alreadyUnlocked,
        });
      } else if (alreadyUnlocked) {
        setResult({
          generation,
          status: "already_unlocked",
          matchOffset: null,
          flagSet,
          alreadyUnlocked: true,
        });
      } else {
        setResult({
          generation,
          status: "locked",
          matchOffset: null,
          flagSet,
          alreadyUnlocked: false,
        });
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  }, [loadFile]);

  const handlePatch = useCallback(() => {
    if (!fileData) return;
    const r = patchGpec2aFile(fileData);
    setResult(r);
    if (r.status === "unlocked" || r.status === "offset_only") {
      const stem = (fileName || "gpec2a").replace(/\.bin$/i, "");
      dl(r.patched, stem + "_UNLOCKED.bin");
    }
  }, [fileData, fileName]);

  const fileSize = fileData ? fileData.length : null;
  const canPatch = PATTERNS_AVAILABLE && result && result.status === "locked";
  const showDownload = result && (result.status === "unlocked" || result.status === "offset_only");

  return (
    <div>
      <Card style={{
        background: "linear-gradient(135deg,#0D1B2A 0%,#1B2B4A 50%,#1A237E 100%)",
        color: "#fff", marginBottom: 18,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 32 }}>🔓</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Righteous'", fontSize: 22, letterSpacing: 2 }}>
              GPEC2A FILE UNLOCK
            </div>
            <div style={{ fontSize: 10, opacity: 0.65, letterSpacing: 3, fontWeight: 700 }}>
              CONTINENTAL FIRMWARE PATCHER · FILE-LEVEL · NO OBD REQUIRED
            </div>
          </div>
          <div style={{
            padding: "6px 14px", borderRadius: 8, fontSize: 10, fontWeight: 900,
            background: PATTERNS_AVAILABLE ? C.gn + "30" : "#FF6F0030",
            color: PATTERNS_AVAILABLE ? C.gn : "#FF6F00",
            border: `1px solid ${PATTERNS_AVAILABLE ? C.gn + "50" : "#FF6F0060"}`,
            letterSpacing: 1,
          }}>
            {PATTERNS_AVAILABLE ? "PATTERNS LOADED" : "PATTERNS PENDING"}
          </div>
        </div>
      </Card>

      {!PATTERNS_AVAILABLE && (
        <Card style={{
          marginBottom: 16, padding: "14px 18px",
          background: "#4A148C15", border: "2px solid #4A148C40",
        }}>
          <div style={{ fontSize: 13, fontWeight: 900, color: "#CE93D8", marginBottom: 8 }}>
            ⛔ Unlock patterns not yet recovered
          </div>
          <div style={{ fontSize: 11, color: C.ts, lineHeight: 1.7 }}>
            The 3 FieldRVA byte patterns from GPEC_Unlocker.exe (entries [04:0005], [04:0006],
            [04:0007]) are stored in a WinLicense-protected section and were not extractable
            from the static binary. The algorithm is fully implemented and ready to activate.
          </div>
          <div style={{ fontSize: 11, color: C.tm, marginTop: 8, lineHeight: 1.6 }}>
            <strong style={{ color: C.ts }}>To recover them:</strong>{" "}
            Diff a locked vs. unlocked GPEC2A full-flash pair — the single changed byte
            gives you <code style={{ fontFamily: "JetBrains Mono" }}>UNLOCK_TARGET_PATTERN</code>.
            Then open <code style={{ fontFamily: "JetBrains Mono" }}>src/lib/gpec2aUnlocker.js</code>,
            set <code style={{ fontFamily: "JetBrains Mono" }}>PATTERNS_AVAILABLE = true</code>, and
            fill in the three 4-byte arrays. See also{" "}
            <code style={{ fontFamily: "JetBrains Mono" }}>docs/GPEC2A_FILE_UNLOCK.md</code>.
          </div>
        </Card>
      )}

      <div
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onClick={() => inputRef.current.click()}
        style={{
          border: `2px dashed ${dragging ? "#5C6BC0" : "#5C6BC060"}`,
          borderRadius: 14, padding: "24px 20px", cursor: "pointer",
          textAlign: "center",
          background: dragging ? "#5C6BC010" : C.c2,
          transition: "all .2s", marginBottom: 16,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".bin,.BIN,.hex,.HEX"
          style={{ display: "none" }}
          onChange={(e) => e.target.files[0] && loadFile(e.target.files[0])}
        />
        <div style={{ fontSize: 28, marginBottom: 6 }}>📂</div>
        {fileName ? (
          <div>
            <div style={{ fontSize: 12, fontWeight: 900, color: "#5C6BC0", fontFamily: "JetBrains Mono" }}>
              {fileName}
            </div>
            <div style={{ fontSize: 10, color: C.tm, marginTop: 4 }}>
              {fileSize ? fileSize.toLocaleString() + " bytes" : ""}
              {fileSize && fileSize > UNLOCK_FLAG_OFFSET
                ? "  ·  flag offset in range"
                : fileSize
                  ? "  ·  file too small for offset flag (< 0x2FFFC)"
                  : ""}
            </div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.ts }}>
              Drop GPEC2A firmware .bin here, or click to browse
            </div>
            <div style={{ fontSize: 10, color: C.tm, marginTop: 4 }}>
              Full-flash files (&gt; 192 KB) · Continental GPEC2 / GPEC2A
            </div>
          </div>
        )}
      </div>

      {result && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 900, fontSize: 13, marginBottom: 14, color: C.tx }}>
            Analysis Result
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            <div style={{ padding: "12px 14px", borderRadius: 10, background: C.c2, border: `1px solid ${C.bd}` }}>
              <div style={{ fontSize: 9, fontWeight: 800, color: C.tm, letterSpacing: 1.5, marginBottom: 6 }}>
                STATUS
              </div>
              <StatusBadge status={result.status} />
            </div>
            <div style={{ padding: "12px 14px", borderRadius: 10, background: C.c2, border: `1px solid ${C.bd}` }}>
              <div style={{ fontSize: 9, fontWeight: 800, color: C.tm, letterSpacing: 1.5, marginBottom: 6 }}>
                GENERATION
              </div>
              {result.generation === "PATTERN_MISSING" ? (
                <span style={{ fontSize: 11, color: C.tm, fontStyle: "italic" }}>
                  Unknown (pattern missing)
                </span>
              ) : (
                <GenBadge generation={result.generation} />
              )}
            </div>
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 10, marginBottom: 14,
          }}>
            <InfoTile
              label="File Size"
              value={fileSize ? fileSize.toLocaleString() + " B" : "—"}
              mono
            />
            <InfoTile
              label={`Flag @ ${offHex(UNLOCK_FLAG_OFFSET)}`}
              value={
                fileData && fileData.length > UNLOCK_FLAG_OFFSET
                  ? byteHex(fileData[UNLOCK_FLAG_OFFSET])
                  : "N/A (file too small)"
              }
              mono
              highlight={result.flagSet ? C.gn : null}
            />
            <InfoTile
              label="Match Offset"
              value={result.matchOffset != null ? offHex(result.matchOffset) : "—"}
              mono
            />
          </div>

          {result.status === "already_unlocked" && (
            <div style={{
              padding: "10px 14px", borderRadius: 8, marginBottom: 10,
              background: C.a3 + "10", border: `1px solid ${C.a3 + "30"}`,
              fontSize: 11, color: C.a3, fontWeight: 700,
            }}>
              ✓ This file has already been unlocked — downloading it again would be a no-op.
              No changes were made.
            </div>
          )}

          {result.status === "offset_only" && (
            <div style={{
              padding: "10px 14px", borderRadius: 8, marginBottom: 10,
              background: C.wn + "10", border: `1px solid ${C.wn + "30"}`,
              fontSize: 11, color: C.wn, fontWeight: 700,
            }}>
              ⚠ The 4-byte pattern was NOT found in this file, but the offset flag at{" "}
              {offHex(UNLOCK_FLAG_OFFSET)} was set to {byteHex(UNLOCK_FLAG_BYTE)}.
              This may indicate a different firmware generation or a file that was already
              partially processed.
            </div>
          )}

          {result.status === "unlocked" && (
            <div style={{
              padding: "10px 14px", borderRadius: 8, marginBottom: 10,
              background: C.gn + "10", border: `1px solid ${C.gn + "30"}`,
              fontSize: 11, color: C.gn, fontWeight: 700,
            }}>
              ✓ Pattern found at {offHex(result.matchOffset)} — byte patched to 0xE8.
              {result.flagSet && ` Offset flag set to ${byteHex(UNLOCK_FLAG_BYTE)} at ${offHex(UNLOCK_FLAG_OFFSET)}.`}
              {" "}Patched file downloaded automatically.
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
            {canPatch && (
              <Btn onClick={handlePatch} color="#5C6BC0">
                🔓 UNLOCK &amp; DOWNLOAD
              </Btn>
            )}
            {showDownload && (
              <Btn
                onClick={() => {
                  const r = patchGpec2aFile(fileData);
                  const stem = (fileName || "gpec2a").replace(/\.bin$/i, "");
                  dl(r.patched, stem + "_UNLOCKED.bin");
                }}
                color={C.a3}
                outline
              >
                ⬇ DOWNLOAD PATCHED AGAIN
              </Btn>
            )}
            <Btn
              onClick={() => {
                setFileName(null);
                setFileData(null);
                setResult(null);
              }}
              color={C.tm}
              outline
            >
              CLEAR
            </Btn>
          </div>
        </Card>
      )}

      <Card style={{ padding: "14px 18px" }}>
        <div style={{ fontSize: 11, fontWeight: 900, color: C.ts, letterSpacing: 1.5, marginBottom: 10 }}>
          HOW IT WORKS
        </div>
        <div style={{ fontSize: 10, color: C.tm, lineHeight: 1.8 }}>
          <div>
            <strong style={{ color: C.ts }}>Algorithm</strong> — recovered from GPEC_Unlocker.exe .NET
            IL disassembly (WinLicense-cracked). The entire unlock is a small binary patch:
          </div>
          <ol style={{ margin: "8px 0 0 16px", padding: 0 }}>
            <li>Scan the full firmware blob for a fixed 4-byte signature.</li>
            <li>Overwrite the first matching byte with <code style={{ fontFamily: "JetBrains Mono" }}>0xE8</code>.</li>
            <li>
              If the file is longer than{" "}
              <code style={{ fontFamily: "JetBrains Mono" }}>{offHex(UNLOCK_FLAG_OFFSET)}</code>
              {" "}(196 604 bytes), set byte{" "}
              <code style={{ fontFamily: "JetBrains Mono" }}>{offHex(UNLOCK_FLAG_OFFSET)}</code>{" "}
              to <code style={{ fontFamily: "JetBrains Mono" }}>{byteHex(UNLOCK_FLAG_BYTE)}</code>.
            </li>
          </ol>
          <div style={{ marginTop: 8 }}>
            <strong style={{ color: C.ts }}>Generation detection</strong> — a separate 4-byte
            pattern flags &ldquo;2015-2018 FILE FLASH&rdquo;; its absence means &ldquo;NEW 2018+
            FILE FLASH&rdquo;.
          </div>
          <div style={{ marginTop: 8 }}>
            <strong style={{ color: C.ts }}>Already-unlocked check</strong> — if the byte immediately
            before an already-unlocked marker is <code style={{ fontFamily: "JetBrains Mono" }}>0xE8</code>,
            or if the offset flag byte is already <code style={{ fontFamily: "JetBrains Mono" }}>0x96</code>,
            the file is treated as already unlocked and no changes are made.
          </div>
          <div style={{ marginTop: 8 }}>
            <strong style={{ color: C.ts }}>Out of scope</strong> — seed/key (UDS 0x27), OBD
            connection, GPEC1/GPEC3 generations, the AES license key from the cracked EXE.
          </div>
        </div>
      </Card>

      {!result && (
        <div style={{ textAlign: "center", padding: "24px 0", color: C.tm, fontSize: 11 }}>
          Drop a GPEC2A full-flash firmware .bin above to begin
        </div>
      )}
    </div>
  );
}

function InfoTile({ label, value, mono, highlight }) {
  return (
    <div style={{
      padding: "10px 12px", borderRadius: 10,
      background: C.c2, border: `1px solid ${C.bd}`,
    }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: C.tm, letterSpacing: 1.5, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{
        fontFamily: mono ? "JetBrains Mono" : "Nunito",
        fontSize: 11, fontWeight: 800,
        color: highlight || C.tx,
      }}>
        {value}
      </div>
    </div>
  );
}
