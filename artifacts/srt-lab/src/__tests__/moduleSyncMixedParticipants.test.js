// Unit tests for the per-action mixed-sync participant calculation
// used by ModuleSync.doSync to gate the override warning prompt.
// Verifies the architect-flagged bug fix: a loaded-but-unused module
// must not trigger a mixed-sync warning for actions that don't touch it.

import { describe, it, expect } from "vitest";
import {
  computeMixedSyncParticipants,
  MODSYNC_ACTION_PARTICIPANTS,
} from "../tabs/ModuleSync.jsx";

const slot = (loaded, override) => ({ loaded, override });

describe("computeMixedSyncParticipants", () => {
  it("only counts modules an action actually touches", () => {
    // BCM override + RFHUB override + PCM checked, but action is bcm-to-rfh
    // (BCM + RFHUB only). PCM must not appear.
    const r = computeMixedSyncParticipants("bcm-to-rfh", {
      BCM:   slot(true, true),
      RFHUB: slot(true, true),
      PCM:   slot(true, false),
    });
    expect(r.participants).toEqual(["BCM", "RFHUB"]);
    expect(r.checkedNames).toEqual([]);
    expect(r.overrideNames).toEqual(["BCM", "RFHUB"]);
  });

  it("does NOT report a mix for bcm-to-rfh when only PCM differs (architect-flagged regression)", () => {
    const r = computeMixedSyncParticipants("bcm-to-rfh", {
      BCM:   slot(true, false),
      RFHUB: slot(true, false),
      PCM:   slot(true, true), // override, but PCM is unused for this action
    });
    expect(r.overrideNames).toEqual([]);
    expect(r.checkedNames).toEqual(["BCM", "RFHUB"]);
    // Caller would NOT prompt because overrideNames is empty.
  });

  it("reports a mix for sync-all when participants split between override and checked", () => {
    const r = computeMixedSyncParticipants("sync-all", {
      BCM:   slot(true, true),
      RFHUB: slot(true, false),
      PCM:   slot(true, false),
    });
    expect(r.overrideNames).toEqual(["BCM"]);
    expect(r.checkedNames).toEqual(["RFHUB", "PCM"]);
  });

  it("ignores unloaded modules even when listed as participants", () => {
    const r = computeMixedSyncParticipants("sync-all", {
      BCM:   slot(true, true),
      RFHUB: slot(false, false), // not loaded
      PCM:   slot(true, false),
    });
    expect(r.participants).toEqual(["BCM", "PCM"]);
    expect(r.overrideNames).toEqual(["BCM"]);
    expect(r.checkedNames).toEqual(["PCM"]);
  });

  it("returns no participants for rekey-95640-from-rfh when RFHUB isn't loaded", () => {
    const r = computeMixedSyncParticipants("rekey-95640-from-rfh", {
      BCM:   slot(true, true),
      RFHUB: slot(false, false),
      PCM:   slot(true, true),
    });
    expect(r.participants).toEqual([]);
    expect(r.overrideNames).toEqual([]);
    expect(r.checkedNames).toEqual([]);
  });

  it("falls back to the full set for an unknown action id", () => {
    const r = computeMixedSyncParticipants("future-action", {
      BCM:   slot(true, true),
      RFHUB: slot(true, false),
      PCM:   slot(true, false),
    });
    expect(r.participants).toEqual(["BCM", "RFHUB", "PCM"]);
  });

  it("the participant map covers every action wired into the Module Sync tab", () => {
    const wiredActionIds = [
      "rfh-to-bcm", "bcm-to-rfh", "target-both", "bcm-sec16-to-rfh",
      "sec16-only", "sync-all", "full-sync", "rekey-95640-from-rfh",
    ];
    for (const id of wiredActionIds) {
      expect(MODSYNC_ACTION_PARTICIPANTS[id]).toBeDefined();
    }
  });
});
