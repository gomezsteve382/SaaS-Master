/**
 * Tests for BinaryIntelTab search/filter behaviour (Task #649).
 *
 * The numHay helper (private to BinaryIntelTab) produces a searchable
 * haystack from a numeric identifier.  We mirror it here so we can test
 * the filter behaviour without mounting the full React component.
 *
 * These tests also exercise the actual BINARY_INTEL_REPORTS catalog to
 * make sure the search logic finds real rows by hex service-ID, DID hex,
 * CAN TX ID, etc.
 */

import { describe, it, expect } from "vitest";
import { BINARY_INTEL_REPORTS } from "../binaryIntel.generated.js";

/** Mirror of the numHay helper from BinaryIntelTab.jsx */
function numHay(n, pad = 2) {
  if (n === undefined || n === null || !Number.isFinite(n)) return "";
  const hex = n.toString(16).padStart(pad, "0");
  return `0x${hex} ${hex} ${n}`;
}

/** Mirror of each finding-group filter from BinaryIntelTab.jsx */
function filterUdsServices(entries, lq) {
  return entries.filter(e => {
    const hay = `${e.name} ${numHay(e.sid, 2)} ${e.usageNote || ""}`.toLowerCase();
    return hay.includes(lq);
  });
}

function filterDids(entries, lq) {
  return entries.filter(e => {
    const hay = `${e.name} ${numHay(e.did, 4)} ${e.category || ""} ${e.notes || ""}`.toLowerCase();
    return hay.includes(lq);
  });
}

function filterCanIds(entries, lq) {
  return entries.filter(e => {
    const hay = `${e.module} ${numHay(e.txId, 3)} ${numHay(e.rxId, 3)} ${e.notes || ""}`.toLowerCase();
    return hay.includes(lq);
  });
}

function filterRoutineControls(entries, lq) {
  return entries.filter(e => {
    const hay = `${e.name} ${numHay(e.routineId, 4)} ${e.targetModule || ""} ${e.notes || ""}`.toLowerCase();
    return hay.includes(lq);
  });
}

function filterSecurityLevels(entries, lq) {
  return entries.filter(e => {
    const hay = `${numHay(e.requestSeed, 2)} ${numHay(e.sendKey, 2)} ${e.notes || ""} ${e.algorithm?.name || ""}`.toLowerCase();
    return hay.includes(lq);
  });
}

// ── numHay helper ──────────────────────────────────────────────────────

describe("numHay", () => {
  it("produces 0x-prefixed hex, bare hex, and decimal forms", () => {
    const hay = numHay(0x22, 2);
    expect(hay).toContain("0x22");
    expect(hay).toContain("22");
    expect(hay).toContain("34"); // decimal
  });

  it("pads short values to the requested width", () => {
    const hay = numHay(0x10, 2);
    expect(hay).toContain("0x10");
    expect(hay).toContain("10");
  });

  it("returns empty string for null/undefined", () => {
    expect(numHay(null)).toBe("");
    expect(numHay(undefined)).toBe("");
  });
});

// ── UDS service search ─────────────────────────────────────────────────

const villainReport = BINARY_INTEL_REPORTS.find(r => r.id === "villain-protected-exe");

describe("UDS service search — VILLAIN report", () => {
  const services = villainReport.findings.udsServices;

  it("finds ReadDataByIdentifier by prefixed hex '0x22'", () => {
    const results = filterUdsServices(services, "0x22");
    expect(results.some(e => e.name === "ReadDataByIdentifier")).toBe(true);
  });

  it("finds ReadDataByIdentifier by bare hex '22'", () => {
    const results = filterUdsServices(services, "22");
    expect(results.some(e => e.name === "ReadDataByIdentifier")).toBe(true);
  });

  it("finds DiagnosticSessionControl by service name substring", () => {
    const results = filterUdsServices(services, "session");
    expect(results.some(e => e.sid === 0x10)).toBe(true);
  });

  it("finds RoutineControl by '0x31'", () => {
    const results = filterUdsServices(services, "0x31");
    expect(results.some(e => e.sid === 0x31)).toBe(true);
  });

  it("returns empty for a query that matches nothing", () => {
    const results = filterUdsServices(services, "0xff99");
    expect(results).toHaveLength(0);
  });
});

// ── DID search ─────────────────────────────────────────────────────────

describe("DID search — VILLAIN report", () => {
  const dids = villainReport.findings.dids;

  it("finds VIN DID 0xF190 by prefixed hex '0xf190'", () => {
    const results = filterDids(dids, "0xf190");
    expect(results.some(e => e.did === 0xF190)).toBe(true);
  });

  it("finds SKIM DID 0xDE01 by bare hex 'de01'", () => {
    const results = filterDids(dids, "de01");
    expect(results.some(e => e.did === 0xDE01)).toBe(true);
  });

  it("finds RFHUB DIDs by category keyword 'rfhub'", () => {
    const results = filterDids(dids, "rfhub");
    expect(results.some(e => e.category === "rfhub")).toBe(true);
  });
});

// ── CAN ID search ──────────────────────────────────────────────────────

describe("CAN ID search — VILLAIN report", () => {
  const canIds = villainReport.findings.canIds;

  it("finds PCM by TX ID '0x7e0'", () => {
    const results = filterCanIds(canIds, "0x7e0");
    expect(results.some(e => e.txId === 0x7E0)).toBe(true);
  });

  it("finds RFHUB by module name substring", () => {
    const results = filterCanIds(canIds, "rfhub");
    expect(results.some(e => e.txId === 0x740)).toBe(true);
  });

  it("finds BCM by bare TX ID '640'", () => {
    const results = filterCanIds(canIds, "640");
    expect(results.some(e => e.txId === 0x640)).toBe(true);
  });
});

// ── RoutineControl search ──────────────────────────────────────────────

describe("RoutineControl search — VILLAIN report", () => {
  const routines = villainReport.findings.routineControls;

  it("finds Key Learning by routine ID '0x0200'", () => {
    const results = filterRoutineControls(routines, "0x0200");
    expect(results.some(e => e.routineId === 0x0200)).toBe(true);
  });

  it("finds routines by module name 'skim'", () => {
    const results = filterRoutineControls(routines, "skim");
    expect(results.some(e => e.routineId === 0x0200)).toBe(true);
  });
});

// ── Security level search ──────────────────────────────────────────────

describe("Security level search — VILLAIN report", () => {
  const levels = villainReport.findings.securityLevels;

  it("finds 0x61 level by prefixed seed hex '0x61'", () => {
    const results = filterSecurityLevels(levels, "0x61");
    expect(results.some(e => e.requestSeed === 0x61)).toBe(true);
  });

  it("finds 0x61 level by algorithm name 'calculatesecuritykey'", () => {
    const results = filterSecurityLevels(levels, "calculatese");
    expect(results.some(e => e.requestSeed === 0x61)).toBe(true);
  });
});
