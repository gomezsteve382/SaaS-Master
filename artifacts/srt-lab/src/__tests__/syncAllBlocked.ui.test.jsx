// @vitest-environment jsdom
//
// Task #1026 — Module Sync "SYNC ALL" pre-download safety gate, driven through
// the REAL component (not just the checkExportSafety unit).
//
// The brick this guards against: a "Sync all" run that ships an RFH whose
// SEC16 secret does not reconcile with the BCM it pairs with, labels both
// files _SYNCED, and reports success. Flashing a mismatched immobilizer pair
// locks the car. The tab accumulates every outgoing file, runs
// checkExportSafety over the whole set, and either flushes all of them or
// refuses the entire sync.
//
// This suite renders ModuleSync, loads synthetic BCM + RFH fixtures through
// the real DropZone file inputs, clicks the visible "SYNC ALL" button, and
// asserts the two endpoints of that gate:
//
//   1. NON-RECONCILABLE pair (BCM flat secret whose reverse != RFH SEC16):
//      no _SYNCED download fires AND the BLOCKED / MISMATCH log surfaces.
//   2. RECONCILABLE pair (BCM flat secret == reverse(RFH SEC16)):
//      both BCM_SYNCED and RFH_SYNCED files are exported.
//
// Driving the actual button (rather than checkExportSafety directly) locks the
// wiring: a future refactor that drops the gate, mislabels the files, or stops
// accumulating before the gate runs will break this test.
//
// Task #1032 — the THIRD leg: "SYNC ALL — BCM + RFH + PCM" also writes PCM SEC6
// (= reverse(BCM)[0:6]) and exports a PCM_SYNCED file. Two cases are added:
//
//   3. RECONCILABLE TRIO (BCM + RFH + GPEC2A loaded through DropZone [0]/[1]/[2]):
//      the PCM SEC6 import path runs ("PCM SEC6: ... written" logged) and a
//      third PCM_SYNCED file ships alongside BCM_SYNCED / RFH_SYNCED.
//
//   4. VIRGIN GPEC2A → SEC6 write refused.
//      Task #1036 RESOLVED the earlier drift: executeSync('sync-all') now DOES
//      refuse a virgin / blank GPEC2A. A canonical-size GPEC2A whose SEC6 secret
//      slot is unpopulated (classifyPcmSec6 !populated) disables the SYNC ALL
//      button (preview gating) and halts the writer before any byte is written
//      — the same "PCM SEC6 is prefix of shared secret" refuse-on-doubt guard
//      runKeyProgPatch enforces, now wired into the simpler SYNC ALL flow.
//      Case 4a asserts the rendered SYNC ALL refusal (button disabled + blocked
//      help text, no download); Case 4b keeps the unit assertion that
//      runKeyProgPatch refuses the same virgin GPEC2A but accepts a populated,
//      matching one — proving the two flows are now consistent.

import React from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";

import ModuleSync from "../tabs/ModuleSync.jsx";
import { MasterVinProvider } from "../lib/masterVinContext.jsx";
import { makeBcm, makeRfhubGen2, makeGpec2a } from "../lib/__fixtures__/buildFixtures.js";
import { runKeyProgPatch } from "../lib/keyProgWizard.js";

// RFHUB Gen2 default SEC16 secret (buildFixtures makeRfhubGen2).
const RFH_SECRET = [
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
];

// crossValidate compares reverse(resolved BCM SEC16) against the RFH secret, so
// a BCM whose flat slice == reverse(RFH secret) reconciles; the makeBcm default
// flat slice does not.
const RFH_SECRET_REVERSED = new Uint8Array([...RFH_SECRET].reverse());

/* makeBcm() writes the 17-char VIN as raw ASCII at the four canonical bases
 * 0x5320/0x5340/0x5360/0x5380, but two parsers read those slots differently:
 *
 *  - engParseBcm (the inspector that sets bcm.parsed.ok, gating the "SYNC ALL"
 *    card) only recognizes a VIN slot prefixed by a `00 46 <slotType> 00`
 *    header (slotType ∈ BCM_SLOT_TYPES). makeBcm writes no header, so no VIN
 *    parses and the action card never mounts.
 *  - checkExportSafety (the pre-download gate) reparses via parseModule, which
 *    reads each canonical slot directly and validates a CRC-16 at base+17.
 *    makeBcm writes no CRC, so the gate rejects every raw slot with
 *    "VIN slot ... checksum INVALID".
 *
 * Injecting the 4-byte header before ALL FOUR bases makes engParseBcm discover
 * all four slots, so engWriteBcmVin (run by SYNC ALL) restamps each one with a
 * valid CRC — satisfying the gate's VIN self-check. The absence of split/mirror
 * records keeps the BCM in the flat-only state the scenarios depend on
 * (sec16SyncOk false → SEC16 is never rewritten from the RFH, so the resolved
 * flat slice at 0x40C9 is what crossValidate compares).
 *
 * The flat secret must be written AFTER makeBcm: makeBcm's `vehicleSecret`
 * option fills 0x40C9 first, but its subsequent IMMO-record fill at 0x40C0
 * (record length 24) overwrites 0x40C9..0x40D8 entirely, so the option never
 * survives into the resolved flat. Stamping `flatSecret` here lands the bytes
 * the gate actually reads. */
function bcmFixture({ flatSecret = null, ...opts } = {}) {
  const buf = makeBcm({ size: 65536, ...opts });
  for (const base of [0x5320, 0x5340, 0x5360, 0x5380]) {
    const hdr = base - 4;
    buf[hdr] = 0x00;
    buf[hdr + 1] = 0x46;
    buf[hdr + 2] = 0x46;
    buf[hdr + 3] = 0x00;
  }
  if (flatSecret) {
    for (let i = 0; i < 16; i++) buf[0x40c9 + i] = flatSecret[i];
  }
  return buf;
}

let clickSpy;

beforeEach(() => {
  // jsdom implements neither URL.createObjectURL nor anchor downloads; stub the
  // blob plumbing and count anchor clicks as "a file hit disk".
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  // No PCM is loaded, so SYNC ALL never opens a confirm; stub defensively.
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderModuleSync() {
  return render(
    <MasterVinProvider setPg={() => {}}>
      <ModuleSync />
    </MasterVinProvider>
  );
}

/* Drop a fixture buffer into a DropZone file input. The DropZone reads the
 * file via f.arrayBuffer() asynchronously, so the change-event is flushed
 * inside act() and the microtask settle is awaited inside act() as well.
 *
 * The file inputs are looked up fresh by index on every call: loading the BCM
 * re-renders the tab (the inspection panel mounts), which replaces DOM nodes,
 * so a NodeList captured once goes stale and a change fired on the old RFH node
 * is silently dropped. Re-querying guarantees the live node. */
async function loadInto(container, index, bytes, name) {
  const inputs = container.querySelectorAll('input[type="file"]');
  expect(inputs.length).toBeGreaterThan(index);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  await act(async () => {
    fireEvent.change(inputs[index], { target: { files: [file] } });
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/* Load a BCM + RFH pair (DropZone order: [0]=BCM, [1]=RFH) and wait for the
 * "SYNC ALL" action button to mount (only renders once both are parsed). */
async function loadPair(container, { bcmBytes, rfhBytes }) {
  await loadInto(container, 0, bcmBytes, "bcm-fixture.bin");
  await loadInto(container, 1, rfhBytes, "rfh-fixture.bin");
  let btn;
  await waitFor(() => {
    btn = screen.getByRole("button", { name: /SYNC ALL/i });
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });
  return btn;
}

/* Load a BCM + RFH + PCM trio (DropZone order: [0]=BCM, [1]=RFH, [2]=PCM) and
 * wait for the "SYNC ALL" action button to mount. The PCM (GPEC2A) is the
 * optional third leg: when present, executeSync('sync-all') also patches its
 * VIN and writes PCM SEC6, then exports a PCM_SYNCED file. */
async function loadTrio(container, { bcmBytes, rfhBytes, pcmBytes }) {
  await loadInto(container, 0, bcmBytes, "bcm-fixture.bin");
  await loadInto(container, 1, rfhBytes, "rfh-fixture.bin");
  await loadInto(container, 2, pcmBytes, "pcm-fixture.bin");
  let btn;
  await waitFor(() => {
    btn = screen.getByRole("button", { name: /SYNC ALL/i });
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });
  return btn;
}

describe("ModuleSync — SYNC ALL pre-download safety gate (Task #1026)", () => {
  it("REFUSES a non-reconcilable BCM/RFH pair: no _SYNCED download, BLOCKED log surfaces", async () => {
    const { container } = renderModuleSync();
    // No flatSecret: the resolved flat at 0x40C9 is makeBcm's IMMO-record fill
    // pattern, whose reverse != RFH secret [01..10] → crossValidate MISMATCH.
    const syncBtn = await loadPair(container, {
      bcmBytes: bcmFixture(),
      rfhBytes: makeRfhubGen2(),
    });

    await act(async () => {
      fireEvent.click(syncBtn);
    });

    // The abort line is the contract: the whole set is refused, nothing written.
    await waitFor(() => {
      expect(
        screen.getByText(/Sync aborted — no files were written/i, { exact: false })
      ).toBeTruthy();
    });
    // The blocking reason must be the immobilizer-secret mismatch.
    expect(screen.queryAllByText(/MISMATCH/i, { exact: false }).length).toBeGreaterThan(0);

    // No _SYNCED file may have shipped — neither a logged download nor an
    // actual anchor click.
    expect(screen.queryByText(/^Downloaded:/i, { exact: false })).toBeNull();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("EXPORTS both BCM_SYNCED and RFH_SYNCED for a reconcilable pair (BCM secret = reverse(RFH secret))", async () => {
    const { container } = renderModuleSync();
    // BCM flat slice == reverse(RFH secret) → reverse(BCM) == RFH secret → MATCH.
    const syncBtn = await loadPair(container, {
      bcmBytes: bcmFixture({ flatSecret: RFH_SECRET_REVERSED }),
      rfhBytes: makeRfhubGen2(),
    });

    await act(async () => {
      fireEvent.click(syncBtn);
    });

    // Both modules must export, with the canonical _SYNCED names.
    await waitFor(() => {
      expect(
        screen.getByText(/^Downloaded: BCM_SYNCED/i, { exact: false })
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/^Downloaded: RFH_SYNCED/i, { exact: false })
    ).toBeTruthy();

    // Two files actually hit disk; the gate passed rather than aborting.
    expect(clickSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Sync aborted/i, { exact: false })).toBeNull();
    expect(
      screen.getByText(/safety gate PASSED/i, { exact: false })
    ).toBeTruthy();
  });

  // ── Task #1032: the third PCM SEC6 leg through the real DropZone ──────────
  it("EXPORTS a third PCM_SYNCED file (PCM SEC6 written) for a reconcilable BCM+RFH+GPEC2A trio", async () => {
    const { container } = renderModuleSync();
    // BCM flat slice == reverse(RFH secret) → reverse(BCM)[0:6] == RFH[0:6], so
    // the written PCM SEC6 reconciles with the BCM/RFH pair and the whole set
    // clears the gate. makeGpec2a() defaults to the same VIN as the BCM/RFH
    // fixtures, so VIN cross-checks also pass.
    const syncBtn = await loadTrio(container, {
      bcmBytes: bcmFixture({ flatSecret: RFH_SECRET_REVERSED }),
      rfhBytes: makeRfhubGen2(),
      pcmBytes: makeGpec2a(),
    });

    await act(async () => {
      fireEvent.click(syncBtn);
    });

    // The PCM SEC6 import/write path must run — this is the leg under test.
    await waitFor(() => {
      expect(
        screen.getByText(/PCM SEC6: .*written/i, { exact: false })
      ).toBeTruthy();
    });

    // All three modules export, with the canonical _SYNCED names.
    expect(
      screen.getByText(/^Downloaded: BCM_SYNCED/i, { exact: false })
    ).toBeTruthy();
    expect(
      screen.getByText(/^Downloaded: RFH_SYNCED/i, { exact: false })
    ).toBeTruthy();
    expect(
      screen.getByText(/^Downloaded: PCM_SYNCED/i, { exact: false })
    ).toBeTruthy();

    // Three files actually hit disk; the gate passed rather than aborting.
    expect(clickSpy).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Sync aborted/i, { exact: false })).toBeNull();
    expect(
      screen.getByText(/safety gate PASSED/i, { exact: false })
    ).toBeTruthy();
  });

  // ── Task #1033: wrong-size PCM blocks SYNC ALL before any write ───────────
  // The genuine virgin/wrong-file brick guard on the SYNC ALL path: when the
  // loaded GPEC2A/PCM dump is neither 4 KB nor 8 KB, the whole sync is refused
  // BEFORE anything is written. Flashing a wrong-sized PCM the bench programmer
  // would reject — or a truncated/over-read EXT EEPROM capture — is exactly the
  // file that bricks a car, so loading one must make shipping a _SYNCED set
  // impossible from this surface.
  //
  // DRIFT NOTE: the task framed this as "click SYNC ALL → the size-block reason
  // surfaces in the log" via the executeSync('sync-all') size guard
  // (ModuleSync.jsx ~2761). Driving the REAL component shows the protection
  // lands one layer earlier: a non-canonical PCM (pcmHasNonCanonicalSize)
  // DISABLES the SYNC ALL button (enabled = baseEnabled && !pcmSizeBlocked),
  // and ActionBtn wires a disabled button's onClick to undefined — so a direct
  // click can NEVER reach doSync/executeSync, and the 2761 log line is an
  // unreachable backstop for that button. The size-block reason instead
  // surfaces in the inline help panel under the action grid. The 2761 log guard
  // only fires for the programmatic re-entry the comment names (the
  // MismatchWizard "Full 3-Module Sync" step → doSync('sync-all')), not a
  // SYNC ALL click. This test therefore asserts the brick is blocked at its
  // real SYNC ALL home: the button is disabled, the size reason surfaces, and
  // crucially NO _SYNCED file can ship (clickSpy never fires) — the same
  // bottom-line guarantee the task asks for.
  it("BLOCKS SYNC ALL when the loaded PCM is a non-canonical size (6 KB): button disabled, size reason surfaces, no _SYNCED ships", async () => {
    const { container } = renderModuleSync();
    // BCM/RFH reconcile (so the PCM size — not a secret mismatch — is the only
    // reason SYNC ALL is held), and the PCM is a 6 KB GPEC2A: above the 4 KB
    // floor (so it parses, not "too small") but neither 4 KB nor 8 KB, so
    // pcmHasNonCanonicalSize is true and the size gate engages.
    await loadInto(container, 0, bcmFixture({ flatSecret: RFH_SECRET_REVERSED }), "bcm-fixture.bin");
    await loadInto(container, 1, makeRfhubGen2(), "rfh-fixture.bin");
    await loadInto(container, 2, makeGpec2a({ size: 6144 }), "pcm-fixture.bin");

    // The SYNC ALL button mounts but is DISABLED — the brick guard at the
    // button level. (loadTrio's "enabled" wait can't be used here precisely
    // because this PCM correctly disables it.)
    let syncBtn;
    await waitFor(() => {
      syncBtn = screen.getByRole("button", { name: /SYNC ALL/i });
      expect(syncBtn).toBeTruthy();
      expect(syncBtn.disabled).toBe(true);
    });

    // The size-block reason surfaces on the SYNC ALL surface (help panel),
    // naming the offending size and the two canonical chip sizes.
    const blockHelp = screen.getByTestId("modsync-pcm-size-blocked-help");
    expect(blockHelp.textContent).toMatch(/6144 bytes/i);
    expect(blockHelp.textContent).toMatch(/4 KB .*8 KB/i);

    // Clicking the disabled button is inert (onClick is undefined when
    // disabled) — proving the wrong-size file can't be pushed through here.
    await act(async () => {
      fireEvent.click(syncBtn);
    });

    // Nothing may ship — no _SYNCED download, no anchor click, no "gate PASSED".
    expect(screen.queryByText(/^Downloaded:/i, { exact: false })).toBeNull();
    expect(screen.queryByText(/safety gate PASSED/i, { exact: false })).toBeNull();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  // ── Task #1039: wrong-size PCM blocks the WIZARD's Full 3-Module Sync ─────
  // The SECOND entry point into sync-all. The button-disable guard (Task #1033
  // above) only protects a *click* on SYNC ALL — but the MismatchWizard's
  // "Full 3-Module Sync" step calls doSync('sync-all') PROGRAMMATICALLY
  // (onAction('full-sync') → doSync('sync-all')), bypassing the disabled button
  // entirely. On that path the executeSync('sync-all') size guard
  // (ModuleSync.jsx ~2777: "✗ sync-all blocked: loaded PCM is X B …") is the
  // ONLY thing standing between a wrong-size PCM and a bricked module. This test
  // drives the real wizard to that step and proves the guard fires.
  //
  // Setup: BCM + RFHUB reconcile (matching VIN + SEC16) so neither a VIN nor a
  // secret mismatch is the blocker — the PCM is the only problem. The PCM is a
  // 6 KB GPEC2A with a DAMAGED SEC6: the damaged SEC6 is an IMMO-class issue, so
  // the wizard recognizes the BCM+RFHUB+PCM scenario and offers the one-click
  // "Full 3-Module Sync" (scenario.actionId === 'full-sync'); the 6 KB size is
  // what the executeSync('sync-all') guard must refuse.
  it("BLOCKS the wizard's Full 3-Module Sync (programmatic sync-all) when the PCM is a non-canonical size (6 KB): size-guard log fires, no _SYNCED ships", async () => {
    const { container } = renderModuleSync();
    await loadInto(container, 0, bcmFixture({ flatSecret: RFH_SECRET_REVERSED }), "bcm-fixture.bin");
    await loadInto(container, 1, makeRfhubGen2(), "rfh-fixture.bin");
    await loadInto(container, 2, makeGpec2a({ size: 6144, pcmSec6Damaged: true }), "pcm-fixture.bin");

    // The SYNC ALL button is DISABLED (the button-path guard from Task #1033) —
    // confirm so we know the click path is closed and we're exercising the OTHER
    // entry point (the wizard's programmatic doSync('sync-all')).
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /SYNC ALL/i });
      expect(btn.disabled).toBe(true);
    });

    // Open the guided Mismatch Wizard (always-visible toolbar launcher).
    await act(async () => {
      fireEvent.click(screen.getByTestId("open-wizard-btn-toolbar"));
    });

    // The wizard recognizes the BCM+RFHUB+PCM IMMO-class problem (damaged PCM
    // SEC6) and offers a one-click fix wired to doSync('sync-all'). Trigger it.
    let fixBtn;
    await waitFor(() => {
      fixBtn = screen.getByTestId("simple-fix-btn");
      expect(fixBtn).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(fixBtn);
    });

    // The executeSync('sync-all') size guard — the ONLY guard on the wizard
    // path — must fire, naming the offending 6 KB size.
    await waitFor(() => {
      expect(
        screen.getByText(/blocked: loaded PCM is 6144 B/i, { exact: false })
      ).toBeTruthy();
    });

    // And crucially: NOTHING may ship. No _SYNCED download, no anchor click, no
    // "gate PASSED" — the wrong-size PCM was refused before any write.
    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Downloaded:/i, { exact: false })).toBeNull();
    expect(screen.queryByText(/safety gate PASSED/i, { exact: false })).toBeNull();
  });

  // ── Task #1032: virgin-GPEC2A SEC6 refusal at its real home ──────────────
  // Task #1036 — Case 4a: the rendered SYNC ALL flow now refuses a virgin /
  // blank GPEC2A. A reconcilable BCM/RFH pair + a canonical-size GPEC2A whose
  // SEC6 slot is blank (pcmSec6Damaged) must DISABLE the SYNC ALL button and
  // surface the blocked help text — and (defense-in-depth) the writer halts
  // before any file is downloaded even if a click somehow lands.
  it("SYNC ALL REFUSES a virgin GPEC2A: button disabled, blocked help shown, no download", async () => {
    const { container } = renderModuleSync();
    await loadInto(container, 0, bcmFixture({ flatSecret: RFH_SECRET_REVERSED }), "bcm-fixture.bin");
    await loadInto(container, 1, makeRfhubGen2(), "rfh-fixture.bin");
    // Virgin engine module: blank SEC6 slot (all-FF, no marker).
    await loadInto(container, 2, makeGpec2a({ pcmSec6Damaged: true }), "pcm-virgin.bin");

    // The SYNC ALL button mounts (BCM+RFH ready) but must be DISABLED because
    // the loaded engine module is blank.
    let btn;
    await waitFor(() => {
      btn = screen.getByRole("button", { name: /SYNC ALL/i });
      expect(btn).toBeTruthy();
      expect(btn.disabled).toBe(true);
    });

    // The refuse-on-doubt help text mirrors the disabled button (preview
    // gating === writer gating).
    expect(
      screen.getByTestId("modsync-pcm-virgin-blocked-help")
    ).toBeTruthy();

    // A disabled button can't fire doSync, so nothing was ever written.
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Downloaded:/i, { exact: false })).toBeNull();
  });

  // Case 4b — the wizard parity check that proves the two flows now agree:
  // runKeyProgPatch enforces "PCM SEC6 must be a prefix of the BCM-derived
  // shared secret", refusing a virgin GPEC2A and accepting a populated one.
  it("runKeyProgPatch REFUSES SEC6 against a virgin GPEC2A but accepts a populated, matching one", () => {
    // BCM stores the secret little-endian; RFHUB/PCM consume the big-endian
    // (reversed) form. PCM SEC6 = first 6 BE bytes of the shared secret.
    const SECRET_LE = new Uint8Array([
      0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44,
      0x55, 0x66, 0x77, 0x88, 0x99, 0x00, 0xff, 0xee,
    ]);
    const SECRET_BE = new Uint8Array([...SECRET_LE].reverse());
    const PCM_SEC6 = SECRET_BE.slice(0, 6);
    const VIN = "2C3CDXKT3FH796320";

    // BCM with derivable shared secret (Gen2 split records, no IMMO-record
    // clobber) and a matched Gen2 RFHUB.
    const bcm = {
      name: "bcm.bin",
      data: makeBcm({ vin: VIN, partialTail: VIN.slice(9), vehicleSecret: SECRET_LE, immoRecsCount: 0 }),
    };
    const rfh = { name: "rfh.bin", data: makeRfhubGen2({ vin: VIN, vehicleSecret: SECRET_BE }) };

    const findSec6Check = (res) =>
      (res.checks || []).find((c) => /PCM SEC6 is prefix of shared secret/i.test(c.label));

    // Virgin GPEC2A: SEC6 slot wiped (all-FF, no marker) → the prefix check
    // fails and the wizard refuses (ok=false). No paired PCM is produced.
    const virgin = runKeyProgPatch({
      bcm, rfh,
      pcm: { name: "pcm-virgin.bin", data: makeGpec2a({ vin: VIN, pcmSec6Damaged: true }) },
      vin: VIN,
    });
    const virginCheck = findSec6Check(virgin);
    expect(virginCheck).toBeTruthy();
    expect(virginCheck.pass).toBe(false);
    expect(virgin.ok).toBe(false);

    // Control: a populated GPEC2A whose SEC6 is the BCM secret's BE prefix
    // clears the same check — proving virginity is what blocks the write.
    const populated = runKeyProgPatch({
      bcm, rfh,
      pcm: { name: "pcm-paired.bin", data: makeGpec2a({ vin: VIN, pcmSec6Bytes: PCM_SEC6 }) },
      vin: VIN,
    });
    const populatedCheck = findSec6Check(populated);
    expect(populatedCheck).toBeTruthy();
    expect(populatedCheck.pass).toBe(true);
  });
});
