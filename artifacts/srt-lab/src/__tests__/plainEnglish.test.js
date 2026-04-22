import { describe, it, expect } from "vitest";
import {
  pickRecommendedFix,
  translateIssue,
  statusBanner,
  extractVins,
} from "../lib/plainEnglish.jsx";

const fullActions = [
  { id: "full-sync", label: "Full sync", enabled: true, description: "Re-pair all" },
  { id: "sec16-only", label: "SEC16 only", enabled: true, description: "Token only" },
  { id: "rfh-to-bcm", label: "RFH→BCM", enabled: true },
  { id: "bcm-sec16-to-rfh", label: "BCM SEC16→RFH", enabled: true },
];

describe("translateIssue", () => {
  it("translates VIN MISMATCH into plain English with VIN term", () => {
    const r = translateIssue("BCM/RFHUB VIN MISMATCH");
    expect(r.term).toBe("VIN");
    expect(r.plain.toLowerCase()).toContain("different cars");
  });

  it("translates SEC16 mismatch into plain English with SEC16 term", () => {
    const r = translateIssue("BCM SEC16 MISMATCH vs RFHUB");
    expect(r.term).toBe("SEC16");
    expect(r.plain.toLowerCase()).toContain("immobilizer token");
  });

  it("translates PCM SEC6 / IMMO_DAMAGED into engine-key guidance", () => {
    const r = translateIssue("PCM SEC6 INVALID");
    expect(r.term).toBe("SEC6");
    expect(r.plain.toLowerCase()).toContain("engine computer");
  });

  it("translates BLANK security area into virgin guidance", () => {
    const r = translateIssue("RFHUB SLOT 1 BLANK");
    expect(r.term).toBe("VIRGIN");
    expect(r.plain.toLowerCase()).toContain("erased");
  });

  it("falls back to the raw string with no term when nothing matches", () => {
    const r = translateIssue("SOMETHING ENTIRELY UNKNOWN");
    expect(r.term).toBeNull();
    expect(r.plain).toBe("SOMETHING ENTIRELY UNKNOWN");
  });

  it("treats null/empty input safely", () => {
    expect(translateIssue("")).toEqual({ plain: "", term: null });
    expect(translateIssue(null)).toEqual({ plain: null, term: null });
  });
});

describe("pickRecommendedFix", () => {
  it("returns null when there are no issues or warnings", () => {
    const r = pickRecommendedFix({
      issues: [], warnings: [], stepActions: fullActions, modules: ["BCM"],
    });
    expect(r).toBeNull();
  });

  it("picks full-sync for VIN mismatch and surfaces the master VIN from RFHUB", () => {
    const r = pickRecommendedFix({
      issues: ["BCM/RFHUB VIN MISMATCH"],
      stepActions: fullActions,
      modules: ["BCM", "RFHUB", "PCM"],
      hexSnippets: [
        "BCM VIN @0x1234: 1C3CDFCT0FD123456",
        "RFHUB VIN @0x0010: 1C3CDFCT0FD999999",
      ],
    });
    expect(r).not.toBeNull();
    expect(r.actionId).toBe("full-sync");
    expect(r.targetVin).toBe("1C3CDFCT0FD999999");
    expect(r.modulesAffected).toEqual(expect.arrayContaining(["BCM", "RFHUB", "PCM"]));
    expect(r.plan.join(" ")).toMatch(/stamp the same vin/i);
  });

  it("picks sec16-only when only SEC16 is mismatched and full-sync isn't enabled", () => {
    const actions = fullActions.map(a => a.id === "full-sync" ? { ...a, enabled: false } : a);
    const r = pickRecommendedFix({
      issues: ["BCM SEC16 MISMATCH"],
      stepActions: actions,
      modules: ["BCM", "PCM"],
    });
    expect(r.actionId).toBe("sec16-only");
    expect(r.modulesAffected).toEqual(expect.arrayContaining(["BCM", "PCM"]));
  });

  it("picks bcm-sec16-to-rfh when BCM SEC16 is good but RFHUB needs the token", () => {
    const r = pickRecommendedFix({
      issues: ["BCM SEC16 OK, RFHUB BLANK — BCM SEC16 → RFHUB SYNC NEEDED"],
      stepActions: fullActions,
      modules: ["BCM", "RFHUB"],
    });
    expect(r.actionId).toBe("bcm-sec16-to-rfh");
    expect(r.modulesAffected).toEqual(["RFHUB"]);
  });

  it("falls back to the first enabled action when nothing matches the heuristics", () => {
    const r = pickRecommendedFix({
      warnings: ["BCM PN MISMATCH"],
      stepActions: [{ id: "noop", label: "Just look", enabled: true, description: "Inspect" }],
      modules: ["BCM"],
    });
    expect(r.actionId).toBe("noop");
    expect(r.title).toMatch(/recommended fix/i);
  });

  it("returns null when the heuristic doesn't match and no actions are enabled", () => {
    const r = pickRecommendedFix({
      warnings: ["BCM PN MISMATCH"],
      stepActions: [{ id: "x", label: "x", enabled: false }],
      modules: ["BCM"],
    });
    expect(r).toBeNull();
  });
});

describe("statusBanner", () => {
  it("returns the empty 'drop modules' banner when no modules loaded", () => {
    const b = statusBanner({ modules: [] });
    expect(b.tone).toBe("neutral");
    expect(b.headline.toLowerCase()).toContain("drop module");
  });

  it("returns an error banner for VIN mismatch", () => {
    const b = statusBanner({ issues: ["BCM/RFHUB VIN MISMATCH"], modules: ["BCM", "RFHUB"] });
    expect(b.tone).toBe("error");
    expect(b.headline.toLowerCase()).toContain("won't start");
  });

  it("returns an error banner for SEC16 mismatch", () => {
    const b = statusBanner({ issues: ["BCM SEC16 MISMATCH"], modules: ["BCM", "RFHUB"] });
    expect(b.tone).toBe("error");
    expect(b.headline.toLowerCase()).toContain("immobilizer");
  });

  it("returns an error banner with a count when issues are not VIN/SEC16", () => {
    const b = statusBanner({ issues: ["95640 MISMATCH", "GPEC2A KEY"], modules: ["BCM"] });
    expect(b.tone).toBe("error");
    expect(b.headline).toMatch(/2 security issues/);
  });

  it("returns a warning banner when only warnings are present", () => {
    const b = statusBanner({ warnings: ["BCM PN MISMATCH"], modules: ["BCM"] });
    expect(b.tone).toBe("warning");
  });

  it("returns the OK banner when everything passes", () => {
    const b = statusBanner({ modules: ["BCM", "RFHUB"] });
    expect(b.tone).toBe("ok");
    expect(b.headline.toLowerCase()).toContain("ready to flash");
  });
});

describe("extractVins", () => {
  it("pulls BCM/RFHUB/PCM VINs from labelled hex snippets", () => {
    const v = extractVins([
      "BCM VIN @0x1234: 1C3CDFCT0FD123456",
      "RFHUB VIN @0x0010: 1C3CDFCT0FD999999",
      "PCM VIN: 1C3CDFCT0FD000001",
      "irrelevant line",
    ]);
    expect(v).toEqual({
      BCM:   "1C3CDFCT0FD123456",
      RFHUB: "1C3CDFCT0FD999999",
      PCM:   "1C3CDFCT0FD000001",
    });
  });
});
