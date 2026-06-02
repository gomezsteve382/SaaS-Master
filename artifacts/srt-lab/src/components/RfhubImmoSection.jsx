import React, {useMemo, useState, useCallback} from "react";
import {C} from "../lib/constants.js";
import {isXc2268Rfhub, parseXc2268Image, patchXc2268Vin} from "../lib/xc2268Rfhub.js";
import ImmoChecksumPanel, {runGatedExport} from "./ImmoChecksumPanel.jsx";

const hex = (arr) =>
  arr ? Array.from(arr).map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ") : "—";
const off = (n) => (n == null ? "—" : "0x" + n.toString(16).toUpperCase().padStart(4, "0"));
const be16 = (n) => (n == null ? "—" : "0x" + n.toString(16).toUpperCase().padStart(4, "0"));
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/* RFHUB (XC2268-class) inspect → validate → edit ImmoVIN section. Only renders
 * for XC2268 internal-flash images — legacy RFHUB dumps keep their existing
 * read-only ModuleFieldsPanel / IdentityCard view. VIN editing re-stamps every
 * VIN slot CRC + the trailing image checksum via patchXc2268Vin; SEC16 mirror
 * slots are surfaced read-only (pairing stays on the RoutineControl key-prog
 * flow). Exports run through the shared checkExportSafety() gate. */
export default function RfhubImmoSection({mod, onPatched = null}) {
  const bytes = mod?.data || null;
  const baseName = (mod?.filename || "rfhub.bin").replace(/\.[^.]+$/, "");

  const isXc = useMemo(() => (bytes ? isXc2268Rfhub(bytes) : false), [bytes]);
  const parsed = useMemo(() => (bytes && isXc ? parseXc2268Image(bytes) : null), [bytes, isXc]);

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

  if (!bytes || !isXc || !parsed) return null;

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
