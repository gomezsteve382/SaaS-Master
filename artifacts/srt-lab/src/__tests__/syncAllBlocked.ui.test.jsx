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

/* A BCM that exposes a REAL resolvable SEC16 (not just the flat 0x40C9 slice):
 * the cases above keep the BCM in a flat-only / virgin state, where
 * bcmHasSec16 is false and the "SEC16 Sync Only" action stays DISABLED. The
 * sec16-only leg of the wrong-size PCM guard can only be exercised when that
 * button is ENABLED — i.e. sec16SyncOk = bcmHasSec16 && rfhHasSec16 is true.
 *
 * bcmHasSec16 (ModuleSync engParseBcm) requires at least one Gen2 SEC16 split
 * record (0x81A0/C0/E0) or a populated inactive-bank mirror — makeBcm writes
 * neither. This helper stamps the three canonical split records AFTER makeBcm
 * (overwriting its IMMO-key fill at 0x81a4/c4/e4) in the exact 7+9 byte layout
 * engParseBcm and resolveBcmSec16 both decode:
 *
 *   +0..+1   FF FF                 (record header)
 *   +2..+7   00 00 00 00 00 00     (zero pad)
 *   +8       idx (0x01 / 0x02)
 *   +9..+15  SEC16[0:7]            (prefix, 7 bytes)
 *   +16..+19 04 04 00 14           (separator)
 *   +20..+28 SEC16[7:16]           (suffix, 9 bytes)
 *   +29      trailer
 *
 * The stored SEC16 is reverse(RFH secret); crossValidate compares
 * reverse(resolved BCM SEC16) to the RFH secret, so the pair reconciles (no
 * VIN / secret MISMATCH) and the loaded PCM is the only outstanding issue.
 * The flat 0x40C9 slice is set to RFH_SECRET (== reverse(resolved)) so the
 * "flat 0x40C9 STALE" advisory stays silent and the PCM SEC6 step is the only
 * one carrying a sec16-only action. */
const SEC16_SPLIT_OFFS = [0x81a0, 0x81c0, 0x81e0];
const SEC16_SPLIT_IDX = [0x01, 0x02, 0x01];
function bcmWithSplitSec16({ sec16, ...opts } = {}) {
  const buf = bcmFixture(opts);
  for (let s = 0; s < SEC16_SPLIT_OFFS.length; s++) {
    const off = SEC16_SPLIT_OFFS[s];
    buf[off] = 0xff;
    buf[off + 1] = 0xff;
    for (let j = 2; j < 8; j++) buf[off + j] = 0x00;
    buf[off + 8] = SEC16_SPLIT_IDX[s];
    for (let k = 0; k < 7; k++) buf[off + 9 + k] = sec16[k];
    buf[off + 16] = 0x04;
    buf[off + 17] = 0x04;
    buf[off + 18] = 0x00;
    buf[off + 19] = 0x14;
    for (let k = 0; k < 9; k++) buf[off + 20 + k] = sec16[7 + k];
    buf[off + 29] = 0x00;
  }
  return buf;
}

/* A Gen2 RFHUB whose two SEC16 mirror slots disagree. makeRfhubGen2 writes the
 * same 16 secret bytes into slot 1 (0x050E) and slot 2 (0x0522); flipping a
 * byte in slot 2's raw region makes the slots differ.
 *
 * This is the lever that surfaces a "SEC16 Sync Only" wizard step for a
 * wrong-size PCM. A 6 KB GPEC2A parses as type=UNKNOWN (parseModule only
 * recognizes canonical 4 KB / 8 KB GPEC2A), so crossValidate produces NO
 * "PCM SEC6 / IMMO_DAMAGED" issue for it — and therefore no PCM SEC6 step.
 * The SEC16-only action lives on TWO issueToStep cards: the PCM SEC6 step
 * (unreachable here) and the "SEC16 Security Token Mismatch" step
 * (MismatchWizard ~94, actions ['sec16-only', 'bcm-sec16-to-rfh']). A slot 1/2
 * mismatch makes parseModule report sec16valid=false, which crossValidate
 * emits as the warning "RFHUB SEC16: Slot 1/2 MISMATCH or unreadable" — and the
 * Advanced flow turns warnings into step cards too (MismatchWizard ~1982), so
 * that warning becomes the SEC16 step carrying the sec16-only action.
 *
 * Corrupting slot 2 (not slot 1) is deliberate: engParseRfh derives
 * sec16.virgin from slot 1 ALONE (rfh sec16.virgin = slot1.every(0xFF),
 * ModuleSync ~555), so slot 1 stays intact → rfhHasSec16 stays true →
 * sec16SyncOk (bcmHasSec16 && rfhHasSec16) stays true → the "SEC16 Sync Only"
 * button is ENABLED and the click reaches doSync('sec16-only'). Slot 1 also
 * stays the RFH vehicle secret crossValidate compares against the BCM, so the
 * pair still reconciles (no secret-mismatch issue cluttering the steps). */
function rfhWithSlotMismatch(opts = {}) {
  const buf = makeRfhubGen2(opts);
  // Slot 2 raw lives at 0x0522..0x0531; flip one byte to a distinct, non-blank
  // value (not 0xFF / 0x00) so the slot stays "populated" but differs from
  // slot 1 → sec16valid=false, slot0 not blank → "Slot 1/2 MISMATCH".
  buf[0x0522] = buf[0x0522] ^ 0x55 || 0x55;
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
  // jsdom doesn't implement scrollIntoView; the Advanced-flow wizard's chat
  // panel calls it on mount (Task #1045 case).
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
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

  // ── Task #1045: wrong-size PCM blocks the WIZARD's SEC16-only sync ────────
  // The THIRD programmatic entry point into the wrong-size PCM guard. Task #1039
  // proved the guard fires on the wizard's "Full 3-Module Sync" step
  // (onAction('full-sync') → doSync('sync-all')); this proves it ALSO fires on
  // the "SEC16 Sync Only" step.
  //
  // Why this matters: writesPcm = sync-all || full-sync || sec16-only
  // (ModuleSync.jsx ~2776), so a SEC16-only sync ALSO writes a PCM SEC6 file
  // when a PCM is loaded. If the size guard only covered full-sync, a tech who
  // picked the lighter "SEC16 Sync Only" fix against a wrong-size PCM would
  // still ship a PCM file the bench programmer rejects. The guard must refuse
  // sec16-only on the same terms.
  //
  // Reaching sec16-only deterministically: the SimpleFlow recommended/scenario
  // path collapses to full-sync whenever BCM+RFH parse OK (bothReady → full-sync
  // enabled → Scenario B), so the simple "FIX IT" button can't surface
  // sec16-only here. The Advanced flow's per-issue step cards do, BUT the PCM
  // SEC6 step is NOT reachable with a wrong-size PCM: a 6 KB GPEC2A parses as
  // type=UNKNOWN (parseModule only recognizes canonical 4 KB / 8 KB GPEC2A), so
  // crossValidate emits no "PCM SEC6 / IMMO_DAMAGED" issue for it. The
  // sec16-only action lives on a SECOND issueToStep card too — the "SEC16
  // Security Token Mismatch" step (MismatchWizard ~94, actions ['sec16-only',
  // 'bcm-sec16-to-rfh']). We surface that card via an RFHUB whose two SEC16
  // mirror slots disagree (rfhWithSlotMismatch): crossValidate reports
  // "RFHUB SEC16: Slot 1/2 MISMATCH" as a warning, and the Advanced flow turns
  // warnings into step cards (MismatchWizard ~1982). onAction('sec16-only')
  // maps straight to doSync('sec16-only') (ModuleSync ~4444). The button is
  // only ENABLED when sec16SyncOk is true, which is why the BCM here carries
  // real Gen2 SEC16 split records (bcmWithSplitSec16) instead of the flat-only
  // fixture the other cases use.
  it("BLOCKS the wizard's SEC16-only sync (programmatic sec16-only) when the PCM is a non-canonical size (6 KB): size-guard log fires, no _SYNCED ships", async () => {
    const { container } = renderModuleSync();
    // BCM: real split SEC16 = reverse(RFH secret) → sec16SyncOk true AND the
    // BCM/RFH pair reconciles. Flat 0x40C9 = RFH_SECRET (== reverse(resolved))
    // suppresses the "flat STALE" advisory.
    await loadInto(
      container,
      0,
      bcmWithSplitSec16({
        sec16: RFH_SECRET_REVERSED,
        flatSecret: new Uint8Array(RFH_SECRET),
      }),
      "bcm-fixture.bin"
    );
    // RFHUB with mismatched SEC16 slots → "RFHUB SEC16: Slot 1/2 MISMATCH"
    // warning → SEC16 step card (carrying the sec16-only action). Slot 1 stays
    // intact, so rfhHasSec16 (→ sec16SyncOk) stays true and the BCM/RFH secret
    // still reconciles.
    await loadInto(container, 1, rfhWithSlotMismatch(), "rfh-fixture.bin");
    // 6 KB GPEC2A: above the 4 KB floor (parses, not "too small") but neither
    // 4 KB nor 8 KB → pcmHasNonCanonicalSize true → the doSync size guard fires
    // because writesPcm = sync-all || full-sync || sec16-only.
    await loadInto(container, 2, makeGpec2a({ size: 6144, pcmSec6Damaged: true }), "pcm-fixture.bin");

    // SYNC ALL mounts but is DISABLED (button-path size guard) — confirm so we
    // know we're exercising the OTHER entry point (the wizard's sec16-only step).
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /SYNC ALL/i });
      expect(btn.disabled).toBe(true);
    });

    // Open the guided Mismatch Wizard, then switch to the Advanced flow whose
    // per-issue step cards expose the dedicated "SEC16 Sync Only" action.
    await act(async () => {
      fireEvent.click(screen.getByTestId("open-wizard-btn-toolbar"));
    });
    await act(async () => {
      const toggle = screen.getByTestId("wizard-advanced-toggle").querySelector('input[type="checkbox"]');
      fireEvent.click(toggle);
    });
    // Advanced flow opens on the issue summary — start the step walkthrough.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /START WIZARD/i }));
    });

    // Walk the step cards until the SEC16 mismatch step (the one carrying the
    // "SEC16 Sync Only" action) is on screen. It must be ENABLED — proving
    // sec16SyncOk and that the click can actually reach doSync('sec16-only').
    let sec16Btn = null;
    for (let i = 0; i < 12; i++) {
      sec16Btn = screen.queryByRole("button", { name: /SEC16 Sync Only/i });
      if (sec16Btn) break;
      const next = screen.queryByRole("button", { name: /Next Step/i });
      if (!next) break;
      await act(async () => {
        fireEvent.click(next);
      });
    }
    expect(sec16Btn).toBeTruthy();
    expect(sec16Btn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(sec16Btn);
    });

    // The executeSync size guard — reached via doSync('sec16-only') — must fire,
    // naming the offending 6 KB size. This is the contract the task asserts.
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
});
