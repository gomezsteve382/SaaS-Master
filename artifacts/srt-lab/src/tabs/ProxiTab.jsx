/* ProxiTab — read-only BCM proxi / feature-config decoder.
 *
 * First-cut, intentionally read-only. Two input modes:
 *
 *   1. UPLOAD a BCM .bin dump → we read 16 bytes at file offset 0x2023
 *      (the canonical BCM proxi slot — same offset BenchTab's "Read BCM
 *      Proxi" button uses) and decode against BODY_PN_CONFIG.
 *
 *   2. PASTE hex bytes for any DID response payload — either the 0x2023
 *      proxi (16 bytes) or one of the DEnn family DIDs (DE00..DE0C). We
 *      strip a leading "62 DD DD" UDS positive-response header if present,
 *      so the tech can paste either the raw payload or the full UDS frame.
 *
 * Output is a categorized, searchable feature matrix sourced from two
 * places:
 *   - BODY_PN_CONFIG (existing alfaobdData.generated.js, 233 BCM rows)
 *   - DE_FEATURE_CATALOG (new bcmFeatureCatalog.generated.js, 155 rows
 *     extracted from the user's BCMConfiguration.tsx).
 *
 * NO WRITE BUTTON. The encoder + UDS programmer ship in a follow-up
 * once the labels here have been ground-truthed against a real bench
 * dump for this user's platform. The banner at the top makes that
 * stance explicit so nobody mistakes this tab for a programming tool.
 */
import React, { useState, useMemo, useCallback, useRef } from "react";
import { C } from "../lib/constants.js";
import { Card, Tag, Btn } from "../lib/ui.jsx";
import {
  decodeProxi2023,
  decodeDeDid,
  deCatalogRows,
  countByCategory,
  groupByRequest,
  CATEGORY_DEFS,
  DE_DIDS,
} from "../lib/proxiDecoder.js";

const PROXI_OFFSET = 0x2023;
const PROXI_LENGTH = 16;

/* Parse a hex string (any common formatting) into a Uint8Array. Strips
 * 0x prefixes, separators, and an optional leading "62 DD DD" UDS
 * positive-response header so the user can paste either the raw payload
 * or the full UDS reply. Returns { bytes, stripped } where stripped is
 * the DID hex if a header was removed, else null. */
function parseHex(input, expectedDid = null) {
  if (!input) return { bytes: new Uint8Array(0), stripped: null, error: null };
  const cleaned = input
    .replace(/0x/gi, "")
    .replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length % 2 !== 0) {
    return { bytes: new Uint8Array(0), stripped: null, error: "Hex string has an odd number of nibbles." };
  }
  const raw = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = parseInt(cleaned.substr(i * 2, 2), 16);
  }
  // Strip "62 DD DD" UDS positive-response header (Read DID by ID)
  if (raw.length >= 3 && raw[0] === 0x62) {
    const did = ((raw[1] << 8) | raw[2]).toString(16).toUpperCase().padStart(4, "0");
    if (!expectedDid || did === expectedDid.toUpperCase()) {
      return { bytes: raw.slice(3), stripped: did, error: null };
    }
  }
  return { bytes: raw, stripped: null, error: null };
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

export default function ProxiTab() {
  // Two independent input modes — a single byte buffer per mode.
  const [proxi2023Bytes, setProxi2023Bytes] = useState(null); // Uint8Array | null
  const [proxi2023Source, setProxi2023Source] = useState(null); // human label
  const [deBytes, setDeBytes] = useState({});  // { "DE00": Uint8Array, ... }
  const [pasteHex, setPasteHex] = useState("");
  const [pasteTarget, setPasteTarget] = useState("0x2023");
  const [parseError, setParseError] = useState(null);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [expanded, setExpanded] = useState(() => new Set());
  const fileRef = useRef(null);

  // Decode whatever bytes we have. When nothing is loaded for a DID,
  // fall back to catalog rows (raw=null) so the UI still shows the
  // field map as a reference.
  const allRows = useMemo(() => {
    const rows = [];
    if (proxi2023Bytes) {
      rows.push(...decodeProxi2023(proxi2023Bytes));
    }
    for (const d of DE_DIDS) {
      const buf = deBytes[d.did];
      if (buf) {
        rows.push(...decodeDeDid(d.did, buf));
      }
    }
    if (rows.length === 0) {
      // catalog-only browse mode
      rows.push(...deCatalogRows());
    }
    return rows;
  }, [proxi2023Bytes, deBytes]);

  const categoryCounts = useMemo(() => countByCategory(allRows), [allRows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (activeCategory !== "all" && r.category !== activeCategory) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.groupName.toLowerCase().includes(q) ||
        r.request.toLowerCase().includes(q) ||
        (r.label && r.label.toLowerCase().includes(q))
      );
    });
  }, [allRows, search, activeCategory]);

  const grouped = useMemo(() => groupByRequest(filtered), [filtered]);

  const onFile = useCallback(async (e) => {
    setParseError(null);
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    if (buf.length < PROXI_OFFSET + PROXI_LENGTH) {
      setParseError(
        `File is only ${buf.length} bytes — too short to contain BCM proxi at offset 0x${PROXI_OFFSET.toString(16).toUpperCase()}.`,
      );
      return;
    }
    const slice = buf.slice(PROXI_OFFSET, PROXI_OFFSET + PROXI_LENGTH);
    setProxi2023Bytes(slice);
    setProxi2023Source(`${f.name} @ 0x${PROXI_OFFSET.toString(16).toUpperCase()}`);
  }, []);

  const onPasteApply = useCallback(() => {
    setParseError(null);
    const target = pasteTarget; // "0x2023" or "DE00"..."DE0C"
    const expectedDid = target === "0x2023" ? "2023" : target;
    const { bytes, error } = parseHex(pasteHex, expectedDid);
    if (error) { setParseError(error); return; }
    if (bytes.length === 0) { setParseError("No hex bytes parsed from input."); return; }
    if (target === "0x2023") {
      if (bytes.length < PROXI_LENGTH) {
        setParseError(`0x2023 proxi is ${PROXI_LENGTH} bytes — got ${bytes.length}.`);
        return;
      }
      setProxi2023Bytes(bytes.slice(0, PROXI_LENGTH));
      setProxi2023Source(`Pasted hex (${bytes.length} bytes)`);
    } else {
      setDeBytes((prev) => ({ ...prev, [target]: bytes }));
    }
    setPasteHex("");
  }, [pasteHex, pasteTarget]);

  const onClear = useCallback(() => {
    setProxi2023Bytes(null);
    setProxi2023Source(null);
    setDeBytes({});
    setParseError(null);
  }, []);

  const toggleGroup = useCallback((req) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(req)) n.delete(req);
      else n.add(req);
      return n;
    });
  }, []);

  const expandAll = () => setExpanded(new Set(grouped.keys()));
  const collapseAll = () => setExpanded(new Set());

  const hasAnyBytes = !!proxi2023Bytes || Object.keys(deBytes).length > 0;

  return (
    <div>
      {/* Read-only banner — the most important UI element on this tab */}
      <Card style={{ marginBottom: 16, background: "#FFF8E1", borderColor: "#F0C13B" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ fontSize: 24 }}>📋</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 900, fontSize: 13, color: "#7A5300", letterSpacing: 0.5 }}>
              READ-ONLY DECODER
            </div>
            <div style={{ fontSize: 12, color: "#7A5300", marginTop: 4, lineHeight: 1.5 }}>
              This tab decodes BCM proxi (0x2023) and the DEnn feature DID family (DE00–DE0C, 155
              fields curated from BCMConfiguration.tsx) using AlfaOBD's recovered field map. There
              is no write path here on purpose: the labels are best-effort and need to be
              ground-truthed against a known-good dump for your platform before any 0x2E lands on
              a live BCM. Use this to verify the field map first; the encoder + programmer ship in
              a follow-up.
            </div>
          </div>
        </div>
      </Card>

      {/* Input panel */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 12, color: C.tx }}>
          Load proxi data
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <Btn onClick={() => fileRef.current?.click()} color={C.a3} outline>
            📂 Upload BCM .bin
          </Btn>
          <input
            ref={fileRef}
            type="file"
            accept=".bin,.dump,.eep"
            style={{ display: "none" }}
            onChange={onFile}
          />
          <span style={{ fontSize: 11, color: C.tm }}>
            Reads 16 bytes @ offset 0x{PROXI_OFFSET.toString(16).toUpperCase()} (BCM proxi slot)
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
          <select
            value={pasteTarget}
            onChange={(e) => setPasteTarget(e.target.value)}
            style={{ padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${C.bd}`, fontSize: 12, fontFamily: "'Nunito'" }}
          >
            <option value="0x2023">0x2023 — BCM Proxi (16 bytes)</option>
            {DE_DIDS.map((d) => (
              <option key={d.did} value={d.did}>
                0x{d.did} — {d.groupName} ({d.count} fields)
              </option>
            ))}
          </select>
          <textarea
            value={pasteHex}
            onChange={(e) => setPasteHex(e.target.value)}
            placeholder="Paste hex (e.g. '62 20 23 11 22 33 ...' or '11 22 33 ...'). Spaces, 0x prefixes, and '62 DD DD' UDS headers are accepted."
            rows={2}
            style={{
              flex: "1 1 320px",
              minWidth: 240,
              padding: 8,
              borderRadius: 8,
              border: `1.5px solid ${C.bd}`,
              fontFamily: "monospace",
              fontSize: 11,
              resize: "vertical",
            }}
          />
          <Btn onClick={onPasteApply} color={C.a3} disabled={!pasteHex.trim()}>
            Decode
          </Btn>
        </div>

        {parseError && (
          <div style={{ color: C.er, fontSize: 12, marginTop: 8, fontWeight: 700 }}>
            ✗ {parseError}
          </div>
        )}

        {hasAnyBytes && (
          <div style={{ marginTop: 12, padding: 10, background: C.bg, borderRadius: 8, fontSize: 11, color: C.tm }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div>
                <strong>Loaded:</strong>{" "}
                {proxi2023Bytes && <Tag color={C.gn}>0x2023 ({proxi2023Source})</Tag>}
                {Object.keys(deBytes).map((d) => (
                  <Tag key={d} color={C.gn}>
                    0x{d} ({deBytes[d].length}B)
                  </Tag>
                ))}
              </div>
              <Btn onClick={onClear} color={C.tm} outline>
                Clear
              </Btn>
            </div>
            {proxi2023Bytes && (
              <div style={{ marginTop: 8, fontFamily: "monospace", fontSize: 10, color: C.tx, wordBreak: "break-all" }}>
                <strong>0x2023:</strong> {bytesToHex(proxi2023Bytes)}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Search + category filter row */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Search field name, group, request, or value..."
          style={{
            flex: "1 1 280px",
            minWidth: 200,
            padding: "10px 14px",
            borderRadius: 10,
            border: `1.5px solid ${C.bd}`,
            fontSize: 12,
            fontFamily: "'Nunito'",
          }}
        />
        <Btn onClick={expandAll} color={C.tm} outline>
          Expand all
        </Btn>
        <Btn onClick={collapseAll} color={C.tm} outline>
          Collapse all
        </Btn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 16, alignItems: "start" }}>
        {/* Category sidebar */}
        <div>
          <Card style={{ padding: 10, position: "sticky", top: 8 }}>
            <div style={{ fontWeight: 900, fontSize: 11, color: C.tm, padding: "4px 8px 8px", letterSpacing: 1 }}>
              CATEGORIES
            </div>
            <CategoryButton
              active={activeCategory === "all"}
              onClick={() => setActiveCategory("all")}
              label="All"
              count={allRows.length}
            />
            {CATEGORY_DEFS.map((c) => {
              const n = categoryCounts[c.id] || 0;
              if (n === 0) return null;
              return (
                <CategoryButton
                  key={c.id}
                  active={activeCategory === c.id}
                  onClick={() => setActiveCategory(c.id)}
                  label={c.label}
                  count={n}
                />
              );
            })}
          </Card>
        </div>

        {/* Decoded rows grouped by request */}
        <div>
          {grouped.size === 0 && (
            <Card style={{ textAlign: "center", padding: 32, color: C.tm, fontSize: 13 }}>
              No fields match the current filter.
            </Card>
          )}
          {Array.from(grouped.entries()).map(([req, rows]) => {
            const isOpen = expanded.has(req);
            const isLoaded = req === "2023" ? !!proxi2023Bytes : !!deBytes[req];
            return (
              <Card key={req} style={{ marginBottom: 10, padding: 0, overflow: "hidden" }}>
                <div
                  onClick={() => toggleGroup(req)}
                  style={{
                    padding: "12px 16px",
                    cursor: "pointer",
                    background: isOpen ? C.bg : "transparent",
                    borderBottom: isOpen ? `1px solid ${C.bd}` : "none",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span style={{ fontSize: 12, color: C.tm, width: 16 }}>{isOpen ? "▼" : "▶"}</span>
                  <span style={{ fontFamily: "monospace", fontWeight: 900, fontSize: 12, color: C.a3, minWidth: 64 }}>
                    0x{req}
                  </span>
                  <span style={{ fontWeight: 800, fontSize: 13, flex: 1 }}>{rows[0].groupName}</span>
                  <Tag color={C.tm}>{rows.length} fields</Tag>
                  {isLoaded ? <Tag color={C.gn}>decoded</Tag> : <Tag color={C.tm}>catalog</Tag>}
                </div>

                {isOpen && (
                  <div style={{ padding: "8px 16px 16px" }}>
                    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ color: C.tm, fontSize: 10, letterSpacing: 0.8, textAlign: "left" }}>
                          <th style={{ padding: "6px 4px", width: 70 }}>BIT</th>
                          <th style={{ padding: "6px 4px", width: 40 }}>LEN</th>
                          <th style={{ padding: "6px 4px" }}>FIELD</th>
                          <th style={{ padding: "6px 4px" }}>VALUE</th>
                          <th style={{ padding: "6px 4px", width: 100 }}>CATEGORY</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={`${r.request}-${r.bit}-${i}`} style={{ borderTop: `1px solid ${C.bd}33` }}>
                            <td style={{ padding: "6px 4px", fontFamily: "monospace", color: C.tm }}>{r.bit}</td>
                            <td style={{ padding: "6px 4px", fontFamily: "monospace", color: C.tm }}>{r.length}</td>
                            <td style={{ padding: "6px 4px", fontWeight: 700 }}>{r.name}</td>
                            <td style={{ padding: "6px 4px", fontFamily: "monospace" }}>
                              {r.raw === null ? (
                                <span style={{ color: C.tm }}>—</span>
                              ) : (
                                <span
                                  style={{
                                    color: r.label.startsWith("(unknown") || r.label.startsWith("(out")
                                      ? C.wn
                                      : C.tx,
                                  }}
                                >
                                  {r.label}
                                </span>
                              )}
                            </td>
                            <td style={{ padding: "6px 4px" }}>
                              <Tag color={C.tm}>{r.category}</Tag>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CategoryButton({ active, onClick, label, count }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        width: "100%",
        padding: "8px 10px",
        marginBottom: 2,
        border: "none",
        background: active ? C.a3 + "18" : "transparent",
        color: active ? C.a3 : C.tx,
        fontWeight: active ? 800 : 600,
        fontSize: 11,
        textAlign: "left",
        borderRadius: 6,
        cursor: "pointer",
        fontFamily: "'Nunito'",
        letterSpacing: 0.3,
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 10, color: active ? C.a3 : C.tm, fontWeight: 700 }}>{count}</span>
    </button>
  );
}
