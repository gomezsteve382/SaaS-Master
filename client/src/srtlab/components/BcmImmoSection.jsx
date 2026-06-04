import React, {useMemo, useState, useCallback} from "react";
import {C} from "../lib/constants.js";
import {parseMpc5606bBcm, applyMpc5606bBcm} from "../lib/mpc5606bBcm.js";
import ImmoChecksumPanel, {runGatedExport} from "./ImmoChecksumPanel.jsx";

const hex = (bytes) =>
  bytes ? Array.from(bytes).map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ") : "—";
const off = (n) => (n == null ? "—" : "0x" + n.toString(16).toUpperCase().padStart(4, "0"));
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/* BCM (MPC5606B-class) inspect → validate → edit ImmoVIN section. Renders the
 * shared ImmoChecksumPanel driven by parseMpc5606bBcm. VIN editing is enabled
 * for any non-LOCKED dump; SEC16 editing only for FULL-mode dumps. Every export
 * runs through the shared checkExportSafety() gate before download. */
export default function BcmImmoSection({mod, onPatched = null}) {
  const bytes = mod?.data || null;
  const baseName = (mod?.filename || "bcm.bin").replace(/\.[^.]+$/, "");

  const parsed = useMemo(() => (bytes ? parseMpc5606bBcm(bytes) : null), [bytes]);

  const [newVin, setNewVin] = useState("");
  const [sec16Hex, setSec16Hex] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const locked = !parsed || parsed.mode === "LOCKED";
  const full = parsed?.mode === "FULL";

  const onApply = useCallback(() => {
    setMsg("");
    setErr("");
    if (!parsed || !parsed.ok) {
      setErr("BCM dump did not parse — nothing to write.");
      return;
    }
    const vin = newVin.trim().toUpperCase();
    if (!VIN_RE.test(vin)) {
      setErr("Enter a full 17-character VIN (A-HJ-NPR-Z0-9) before applying.");
      return;
    }
    const wantSec16 = sec16Hex.trim() !== "";
    if (wantSec16) {
      const clean = sec16Hex.replace(/\s+/g, "");
      if (!/^[0-9A-Fa-f]{32}$/.test(clean)) {
        setErr("SEC16 must be exactly 32 hex characters (16 bytes) in BCM order.");
        return;
      }
      if (!full) {
        setErr("SEC16 can only be written on a FULL-mode dump. Leave it blank for a VIN-only re-stamp.");
        return;
      }
    }
    let res;
    try {
      res = applyMpc5606bBcm(bytes, parsed, {newVin: vin, newSec16Hex: wantSec16 ? sec16Hex : undefined});
    } catch (e) {
      setErr(String(e?.message || e));
      return;
    }
    const fname = baseName + (wantSec16 ? "_vin_sec16.bin" : "_vin.bin");
    const gate = runGatedExport({
      bytes: res.bytes,
      filename: fname,
      role: "BCM",
      crossModule: true,
      selfChecks: wantSec16 ? ["vin", "partials", "sec16"] : ["vin", "partials"],
      successMsg:
        "BCM re-stamped: VIN " +
        vin +
        " across " +
        res.updatedSlots.length +
        " slot(s)" +
        (wantSec16 ? " + SEC16 " + res.sec16.bcmSec16Hex : "") +
        " → downloaded (passed safety gate).",
    });
    if (!gate.ok) {
      setErr(gate.message);
      return;
    }
    setMsg(gate.message);
    if (typeof onPatched === "function") onPatched(res.bytes, fname);
  }, [bytes, parsed, newVin, sec16Hex, full, baseName, onPatched]);

  if (!bytes || !parsed) return null;

  const sec16 = parsed.sec16;
  const modeColor = parsed.mode === "FULL" ? C.gn : parsed.mode === "VIN_ONLY" ? C.wn : C.er;

  const headerBadges = [{text: "MODE · " + parsed.mode, color: modeColor}];
  if (!parsed.sizeOk) headerBadges.push({text: "NON-CANONICAL SIZE", color: C.er, small: true});

  const analysisModel = {
    title: "BCM ANALYSIS",
    icon: "📊",
    cards: [
      {
        title: "Write Mode",
        accent: modeColor,
        value: parsed.mode,
        valueColor: modeColor,
        sub: parsed.reasons[0] || "",
      },
      {
        title: "Image Size",
        accent: parsed.sizeOk ? C.gn : C.er,
        badge: {value: parsed.sizeOk ? "OK" : "BAD", good: parsed.sizeOk},
        value: parsed.size.toLocaleString() + " B",
        sub: "MPC5606B DFLASH dump",
      },
      {
        title: "VIN Slots",
        accent: parsed.validSlots.length > 0 ? C.gn : C.er,
        value: parsed.validSlots.length + " / " + parsed.slots.length + " verified",
        sub: "Dominant VIN: " + (parsed.dominantVin || "—"),
      },
      {
        title: "SEC16 Secret",
        accent: sec16.bytes && !sec16.blank ? C.gn : C.er,
        badge: {value: sec16.blank ? "BLANK" : "SET", good: !sec16.blank},
        value: sec16.blank ? "— blank —" : hex(sec16.bytes),
        sub: sec16.source ? sec16.source + " @ " + off(sec16.offset) : "no SEC16 record found",
      },
    ],
  };

  const vinModel = {
    title: "VINs BY OFFSET",
    icon: "🔑",
    columns: ["Zone / Layout", "Offset", "VIN", "CRC"],
    rows: parsed.slots.map((s) => ({
      cells: [
        {text: s.zone + " · " + s.layout, color: C.ts},
        {text: off(s.vinOffset)},
        {text: s.vin, bold: true},
        {badge: {value: s.crcOk ? "CRC OK" : "CRC BAD", good: s.crcOk}},
      ],
    })),
    empty: "No printable VIN slot found in any canonical or alternate base.",
  };

  const candKeys = ["split", "mirror1", "mirror2", "flat"];
  const secRows = candKeys
    .map((k) => ({k, c: sec16.candidates?.[k]}))
    .filter((x) => x.c)
    .map(({k, c}) => ({
      cells: [
        {text: k},
        {text: off(c.offset)},
        {text: hex(c.bytes), muted: true},
        {badge: {value: c.blank ? "BLANK" : "SET", good: !c.blank}},
      ],
    }));
  const securityModel = {
    title: "SEC16 RECORDS / VERDICTS",
    icon: "🔐",
    columns: ["Source", "Offset", "Bytes (BCM order)", "Verdict"],
    rows: secRows,
    empty: "No SEC16 record locations present in this image.",
  };

  const editingModel = {
    title: "APPLY CHANGES & DOWNLOAD",
    icon: "✏️",
    hint: locked
      ? "Dump is LOCKED — no verifiable VIN anchor, so writes are disabled. Resolve the reasons above first."
      : "Re-stamps the new VIN across every verified slot (CRC recomputed). SEC16 editing is " +
        (full ? "enabled (FULL mode)." : "disabled until the dump resolves a SEC16 secret (FULL mode)."),
    fields: [
      {
        label: "New VIN (17 chars · no I/O/Q)",
        value: newVin,
        onChange: (e) => setNewVin(e.target.value.toUpperCase()),
        placeholder: parsed.dominantVin || "leave blank to keep VIN",
        maxLength: 17,
        testid: "bcm-immo-vin-input",
        disabled: locked,
      },
      {
        label: "New SEC16 (32 hex · BCM order · FULL only)",
        value: sec16Hex,
        onChange: (e) => setSec16Hex(e.target.value),
        placeholder: full ? hex(sec16.bytes) : "FULL-mode dumps only",
        testid: "bcm-immo-sec16-input",
        disabled: !full,
      },
    ],
    primary: {
      label: "✅ APPLY CHANGES AND DOWNLOAD",
      color: C.gn,
      onClick: onApply,
      disabled: locked,
      testid: "bcm-immo-apply-btn",
    },
  };

  return (
    <ImmoChecksumPanel
      testid="bcm-immo-panel"
      title="BCM IMMO / VIN WORKBENCH"
      subtitle="OFFLINE DUMP · ANALYZE · PER-SLOT VIN + SEC16 EDIT · SAFETY-GATED EXPORT"
      accent={C.sr}
      headerBadges={headerBadges}
      analysis={analysisModel}
      vinSection={vinModel}
      securitySection={securityModel}
      editing={editingModel}
      status={{testid: "bcm-immo-status", msg, err}}
    />
  );
}
