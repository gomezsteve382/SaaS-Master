import React, {useMemo, useState, useCallback} from "react";
import {C} from "../lib/constants.js";
import {isXc2268Rfhub, parseXc2268Image, patchXc2268Vin} from "../lib/xc2268Rfhub.js";
import {analyzeRfhubVin, patchRfhubVin, validateVin} from "../lib/rfhubVinPatcher.js";
import ImmoChecksumPanel, {runGatedExport} from "./ImmoChecksumPanel.jsx";

const hex = (arr) =>
  arr ? Array.from(arr).map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ") : "—";
const off = (n) => (n == null ? "—" : "0x" + n.toString(16).toUpperCase().padStart(4, "0"));
const be16 = (n) => (n == null ? "—" : "0x" + n.toString(16).toUpperCase().padStart(4, "0"));
const csFmt = (n) => (n == null ? "—" : "0x" + n.toString(16).toUpperCase().padStart(n > 0xFF ? 4 : 2, "0"));
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/* RFHUB IMMO / VIN workbench. The single shared ImmoChecksumPanel renders for
 * EVERY supported RFHUB generation so the RFHUB looks like the BCM workbench in
 * both the VIN Programmer RFHUB sub-tab and the standalone RFHUB inspector:
 *   - XC2268 internal-flash images  → XcRfhImmoSection (per-slot VIN edit +
 *     image-CRC refresh via patchXc2268Vin).
 *   - Gen1 (24C16 · 2 KB) / Gen2 (24C32 · 4 KB) EEPROM images →
 *     LegacyRfhImmoSection (per-slot VIN edit via the verified patchRfhubVin).
 * Non-canonical / unrecognised images render nothing (read-only fall-through to
 * the existing ModuleFieldsPanel / IdentityCard view). Every export runs through
 * the shared checkExportSafety() gate; SEC16 pairing stays on the RoutineControl
 * key-prog flow (surfaced read-only here).
 *
 * This default export is a thin dispatcher: it calls a single hook (the XC2268
 * detection) and then delegates to one of two child components, each of which
 * owns its own hooks. Keeping the hook count in this component constant avoids
 * a rules-of-hooks violation when the loaded image type changes between renders. */
export default function RfhubImmoSection({mod, onPatched = null}) {
  const bytes = mod?.data || null;
  const isXc = useMemo(() => (bytes ? isXc2268Rfhub(bytes) : false), [bytes]);
  if (!bytes) return null;
  if (isXc) return <XcRfhImmoSection mod={mod} onPatched={onPatched} />;
  return <LegacyRfhImmoSection mod={mod} onPatched={onPatched} />;
}

/* ── XC2268 internal-flash image (unchanged behaviour) ─────────────────────── */
function XcRfhImmoSection({mod, onPatched = null}) {
  const bytes = mod?.data || null;
  const baseName = (mod?.filename || "rfhub.bin").replace(/\.[^.]+$/, "");

  const parsed = useMemo(() => (bytes ? parseXc2268Image(bytes) : null), [bytes]);

  const [newVin, setNewVin] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const writable = !!parsed && parsed.sizeSupported && parsed.variantSupported;

  const onApply = useCallback(() => {
    setMsg("");
    setErr("");
    const vin = newVin.trim().toUpperCase();
    if (!VIN_RE.test(vin)) {
      setErr("Enter a full 17-character VIN (A-HJ-NPR-Z0-9) before applying.");
      return;
    }
    const res = patchXc2268Vin(bytes, vin);
    if (!res.ok) {
      setErr(res.reason || "XC2268 VIN write refused.");
      return;
    }
    const fname = baseName + "_vin.bin";
    const gate = runGatedExport({
      bytes: res.bytes,
      filename: fname,
      role: "RFH",
      crossModule: true,
      selfChecks: ["vin"],
      successMsg:
        "RFHUB re-stamped: VIN " + vin + " across all XC2268 slots + image CRC refreshed → downloaded (passed safety gate).",
    });
    if (!gate.ok) {
      setErr(gate.message);
      return;
    }
    setMsg(gate.message);
    if (typeof onPatched === "function") onPatched(res.bytes, fname);
  }, [bytes, newVin, baseName, onPatched]);

  if (!bytes || !parsed) return null;

  const img = parsed.imageChecksum;
  const headerBadges = [
    {text: "XC2268 · " + (parsed.variantLabel || "0x" + parsed.variantByte.toString(16).toUpperCase()), color: C.a2},
  ];
  if (!parsed.sizeSupported) headerBadges.push({text: "SIZE UNSUPPORTED — READ ONLY", color: C.er, small: true});
  else if (!parsed.variantSupported) headerBadges.push({text: "VARIANT UNSUPPORTED — READ ONLY", color: C.er, small: true});

  const analysisModel = {
    title: "RFHUB ANALYSIS",
    icon: "📊",
    cards: [
      {
        title: "Variant",
        accent: parsed.variantSupported ? C.gn : C.er,
        badge: {value: parsed.variantSupported ? "OK" : "UNSUPPORTED", good: parsed.variantSupported},
        value: parsed.variantLabel || "0x" + parsed.variantByte.toString(16).toUpperCase().padStart(2, "0"),
        sub: "Tag @ 0x0020",
      },
      {
        title: "Image Size",
        accent: parsed.sizeSupported ? C.gn : C.er,
        badge: {value: parsed.sizeSupported ? "OK" : parsed.sizeKnown ? "PENDING" : "BAD", good: parsed.sizeSupported},
        value: parsed.size.toLocaleString() + " B",
        sub: "XC2268 internal flash",
      },
      {
        title: "VIN Consensus",
        accent: parsed.vinAllSlotsMatch ? C.gn : C.wn,
        value: parsed.vin || "—",
        sub: parsed.vinAllSlotsMatch ? "All slots agree" : "Slots differ / partial",
      },
      {
        title: "Image CRC",
        accent: img.ok ? C.gn : C.wn,
        badge: {value: img.ok ? "OK" : "STALE", good: img.ok},
        value: be16(img.stored),
        sub: "Calc " + be16(img.calc),
      },
    ],
  };

  const vinModel = {
    title: "VINs BY OFFSET",
    icon: "🔑",
    columns: ["Slot", "Offset", "VIN", "Stored CRC", "Calc CRC", "Verdict"],
    rows: parsed.vinSlots.map((s, i) => ({
      cells: [
        {text: "VIN " + (i + 1), color: C.ts},
        {text: off(s.offset)},
        {text: s.vin || "—", bold: true},
        {text: be16(s.csStored)},
        {text: be16(s.csCalc)},
        {badge: {value: s.vin ? (s.csOk ? "CRC OK" : "CRC BAD") : "EMPTY", good: !!s.vin && s.csOk}},
      ],
    })),
    empty: "No XC2268 VIN slots present.",
  };

  // Derive a human-readable offset-confirmation note for the SEC16 section.
  // A real 2019+ Ram dump with populated slots will show "CRC OK" on both
  // rows — that is the on-vehicle confirmation that 0x1100 / 0x1120 are
  // correct. Virgin / blank dumps show "BLANK" (normal state before key-prog).
  const sec16VerificationNote = parsed.sec16Blank
    ? "Both slots blank (virgin / never key-programmed) — load a dump from a paired vehicle to verify offset ground-truth."
    : parsed.sec16Slots.every((s) => s.csOk)
    ? "✓ Both slots populated with valid CRC — offsets 0x1100 / 0x1120 confirmed for this dump."
    : "⚠ One or more slots have a CRC mismatch — image may be partially edited or the offset layout differs.";

  const securityModel = {
    title: "SEC16 MIRROR SLOTS / VERDICTS",
    icon: "🔐",
    columns: ["Slot", "Offset", "Bytes", "Stored CRC", "Verdict"],
    rows: parsed.sec16Slots.map((s, i) => ({
      cells: [
        {text: "SEC16 " + (i + 1), color: C.ts},
        {text: off(s.offset)},
        {text: s.blank ? "— blank / virgin —" : hex(s.raw), muted: true},
        {text: be16(s.csStored)},
        {badge: {value: s.blank ? "BLANK" : s.csOk ? "CRC OK" : "CRC BAD", good: s.blank ? false : s.csOk}},
      ],
    })),
    empty: "No XC2268 SEC16 mirror slots present.",
  };

  const editingModel = {
    title: "APPLY CHANGES & DOWNLOAD",
    icon: "✏️",
    hint: writable
      ? "Re-stamps the new VIN into every XC2268 VIN slot (per-slot CRC16/CCITT + trailing image checksum recomputed). SEC16 pairing stays on the RoutineControl key-prog flow."
      : "Size or variant is outside the covered set — this image is read-only. See the banners / badges above.",
    fields: [
      {
        label: "New VIN (17 chars · no I/O/Q)",
        value: newVin,
        onChange: (e) => setNewVin(e.target.value.toUpperCase()),
        placeholder: parsed.vin || "leave blank to keep VIN",
        maxLength: 17,
        testid: "rfhub-immo-vin-input",
        disabled: !writable,
      },
    ],
    primary: {
      label: "✅ APPLY CHANGES AND DOWNLOAD",
      color: C.gn,
      onClick: onApply,
      disabled: !writable,
      testid: "rfhub-immo-apply-btn",
    },
  };

  const sec16NoteEl = (
    <div
      data-testid="rfhub-immo-sec16-verification-note"
      style={{
        fontSize: 10,
        color: parsed.sec16Blank ? C.tm : parsed.sec16Slots.every((s) => s.csOk) ? C.gn : C.wn,
        marginTop: 6,
        fontStyle: "italic",
      }}
    >
      {sec16VerificationNote}
    </div>
  );

  return (
    <ImmoChecksumPanel
      testid="rfhub-immo-panel"
      title="RFHUB IMMO / VIN WORKBENCH"
      subtitle="XC2268 IMAGE · ANALYZE · PER-SLOT VIN EDIT · SAFETY-GATED EXPORT"
      accent={C.sr}
      headerBadges={headerBadges}
      analysis={analysisModel}
      vinSection={vinModel}
      securitySection={securityModel}
      afterSecurity={sec16NoteEl}
      editing={editingModel}
      status={{testid: "rfhub-immo-status", msg, err}}
    />
  );
}

/* Read the two SEC16 mirror slots out of a Gen1/Gen2 RFHUB EEPROM image. The
 * offsets mirror engParseRfh (the cross-module source of truth) — this is a
 * read-only display; no writer depends on it. */
function readRfhSec16(bytes) {
  if (!bytes) return null;
  const aeq = (a, b) => {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const gen2Hdr = bytes[0x0500] === 0xAA && bytes[0x0501] === 0x55 && bytes[0x0502] === 0x31 && bytes[0x0503] === 0x01;
  if (gen2Hdr && bytes.length >= 0x0532) {
    const s1 = bytes.slice(0x050E, 0x051E);
    const s2 = bytes.slice(0x0522, 0x0532);
    return {format: "gen2", slot1: s1, slot2: s2, offsets: [0x050E, 0x0522], match: aeq(s1, s2), virgin: s1.every((b) => b === 0xFF)};
  }
  if (bytes.length >= 0x024C) {
    const s1 = bytes.slice(0x0226, 0x0236);
    const s2 = bytes.slice(0x023A, 0x024A);
    return {format: "gen1", slot1: s1, slot2: s2, offsets: [0x0226, 0x023A], match: aeq(s1, s2), virgin: s1.every((b) => b === 0xFF)};
  }
  return null;
}

/* ── Gen1 (24C16 · 2 KB) / Gen2 (24C32 · 4 KB) EEPROM image ─────────────────── */
function LegacyRfhImmoSection({mod, onPatched = null}) {
  const bytes = mod?.data || null;
  const baseName = (mod?.filename || "rfhub.bin").replace(/\.[^.]+$/, "");

  const analysis = useMemo(() => (bytes ? analyzeRfhubVin(bytes) : null), [bytes]);
  const sec16 = useMemo(() => (bytes ? readRfhSec16(bytes) : null), [bytes]);

  const [newVin, setNewVin] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const gen = analysis?.generation || null;
  const supported = gen === "gen1" || gen === "gen2";
  const contentWarn = analysis?.contentWarn || null;
  const writable = supported && !contentWarn;

  const onApply = useCallback(() => {
    setMsg("");
    setErr("");
    const vin = newVin.trim().toUpperCase();
    if (!VIN_RE.test(vin)) {
      setErr("Enter a full 17-character VIN (A-HJ-NPR-Z0-9) before applying.");
      return;
    }
    try {
      validateVin(vin);
    } catch (e) {
      setErr(String(e?.message || e));
      return;
    }
    let patched;
    try {
      patched = patchRfhubVin(bytes, vin);
    } catch (e) {
      setErr(String(e?.message || e));
      return;
    }
    const active = analysis?.slots.filter((s) => !s.blank).length ?? 0;
    const fname = baseName + "_vin.bin";
    const gate = runGatedExport({
      bytes: patched,
      filename: fname,
      role: "RFH",
      crossModule: true,
      selfChecks: ["vin"],
      successMsg:
        "RFHUB re-stamped: VIN " + vin + " across " + active + " slot(s) → downloaded (passed safety gate).",
    });
    if (!gate.ok) {
      setErr(gate.message);
      return;
    }
    setMsg(gate.message);
    if (typeof onPatched === "function") onPatched(patched, fname);
  }, [bytes, newVin, baseName, analysis, onPatched]);

  if (!bytes || !supported) return null;

  const genColor = gen === "gen2" ? C.a2 : C.a4;
  const sizeOk = bytes.length === 2048 || bytes.length === 4096;
  const activeSlots = analysis.slots.filter((s) => !s.blank);
  const vins = activeSlots.map((s) => s.vin).filter(Boolean);
  const vinConsensus = vins.length > 0 && vins.every((v) => v === vins[0]);
  const dominantVin = vins[0] || null;

  const headerBadges = [{text: analysis.mcuLabel, color: genColor}];
  if (!sizeOk) headerBadges.push({text: "NON-CANONICAL SIZE", color: C.er, small: true});
  if (contentWarn) headerBadges.push({text: "CONTENT WARN — READ ONLY", color: C.wn, small: true});

  const analysisModel = {
    title: "RFHUB ANALYSIS",
    icon: "📊",
    cards: [
      {
        title: "Generation",
        accent: genColor,
        value: gen === "gen2" ? "GEN2" : "GEN1",
        valueColor: genColor,
        sub: analysis.mcuLabel,
      },
      {
        title: "Image Size",
        accent: sizeOk ? C.gn : C.er,
        badge: {value: sizeOk ? "OK" : "BAD", good: sizeOk},
        value: bytes.length.toLocaleString() + " B",
        sub: "Yazaki FCM EEPROM",
      },
      {
        title: "VIN Consensus",
        accent: vinConsensus ? C.gn : vins.length ? C.wn : C.er,
        value: dominantVin || "—",
        sub: vins.length === 0 ? "No VIN slots populated" : vinConsensus ? "All slots agree" : "Slots differ / partial",
      },
      {
        title: "SEC16 Secret",
        accent: sec16 && !sec16.virgin ? C.gn : C.er,
        badge: {value: sec16 ? (sec16.virgin ? "BLANK" : "SET") : "N/A", good: !!sec16 && !sec16.virgin},
        value: sec16 ? (sec16.virgin ? "— blank —" : hex(sec16.slot1)) : "—",
        sub: sec16 ? sec16.format + " @ " + off(sec16.offsets[0]) : "no SEC16 slots",
      },
    ],
  };

  const vinModel = {
    title: "VINs BY OFFSET",
    icon: "🔑",
    columns: ["Slot", "Offset", "VIN", "Stored CS", "Calc CS", "Verdict"],
    rows: analysis.slots.map((s) => ({
      cells: [
        {text: "Slot " + s.slotNum, color: C.ts},
        {text: off(s.offset)},
        {text: s.vin || (s.blank ? "— blank —" : "—"), bold: true},
        {text: csFmt(s.storedCs)},
        {text: csFmt(s.computedCs)},
        {badge: {value: s.blank ? "EMPTY" : s.crcOk ? "CS OK" : "CS BAD", good: !s.blank && !!s.crcOk}},
      ],
    })),
    empty: "No RFHUB VIN slots present.",
  };

  const secRows = sec16
    ? [
        {raw: sec16.slot1, offset: sec16.offsets[0], n: 1},
        {raw: sec16.slot2, offset: sec16.offsets[1], n: 2},
      ].map(({raw, offset: o, n}) => {
        const blank = Array.from(raw).every((b) => b === 0xFF || b === 0x00);
        return {
          cells: [
            {text: "SEC16 " + n, color: C.ts},
            {text: off(o)},
            {text: blank ? "— blank / virgin —" : hex(raw), muted: true},
            {badge: {value: blank ? "BLANK" : sec16.match ? "MATCH" : "MISMATCH", good: !blank && sec16.match}},
          ],
        };
      })
    : [];
  const securityModel = {
    title: "SEC16 MIRROR SLOTS / VERDICTS",
    icon: "🔐",
    columns: ["Slot", "Offset", "Bytes", "Verdict"],
    rows: secRows,
    empty: "No SEC16 mirror slots present in this image.",
  };

  const editingModel = {
    title: "APPLY CHANGES & DOWNLOAD",
    icon: "✏️",
    hint: writable
      ? "Re-stamps the new VIN into every RFHUB VIN slot (per-slot checksum recomputed via the verified patchRfhubVin writer). SEC16 pairing stays on the RoutineControl key-prog flow."
      : contentWarn
      ? "RFHUB structural markers were not found — this image is read-only here. Use the Offline VIN Patcher's explicit bench override below if you are sure this is a real RFHUB dump."
      : "Non-canonical RFHUB image — read only.",
    fields: [
      {
        label: "New VIN (17 chars · no I/O/Q)",
        value: newVin,
        onChange: (e) => setNewVin(e.target.value.toUpperCase()),
        placeholder: dominantVin || "leave blank to keep VIN",
        maxLength: 17,
        testid: "rfhub-immo-vin-input",
        disabled: !writable,
      },
    ],
    primary: {
      label: "✅ APPLY CHANGES AND DOWNLOAD",
      color: C.gn,
      onClick: onApply,
      disabled: !writable,
      testid: "rfhub-immo-apply-btn",
    },
  };

  return (
    <ImmoChecksumPanel
      testid="rfhub-immo-panel"
      title="RFHUB IMMO / VIN WORKBENCH"
      subtitle="GEN1 / GEN2 EEPROM · ANALYZE · PER-SLOT VIN EDIT · SAFETY-GATED EXPORT"
      accent={C.sr}
      headerBadges={headerBadges}
      analysis={analysisModel}
      vinSection={vinModel}
      securitySection={securityModel}
      editing={editingModel}
      status={{testid: "rfhub-immo-status", msg, err}}
    />
  );
}
