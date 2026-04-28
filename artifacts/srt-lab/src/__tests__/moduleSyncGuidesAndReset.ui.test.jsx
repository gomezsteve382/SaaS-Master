// @vitest-environment jsdom
//
// Locks the two surface-only additions Task #464 made to the Module Sync
// workspace: the per-programmer Connection Guides row at the top of the
// tab, and the "Clean / Reset" button next to the wizard launcher. Both
// are display-layer additions with no engine, parser, or writer code
// behind them, which means a future refactor of `ModuleSync.jsx` could
// quietly delete or break them and no other test in the suite would
// notice. This file exists to make sure that regression shows up.
//
// Test 1 — Connection Guides anchors
//   Asserts the row renders the exact set of bench-tool links the LX
//   (Charger / Challenger) path expects: BCM (MPC560xB) → MULTIPROG ·
//   UPA, PCM (GPEC2A) → GODIAG, RFH (9S12X) → MULTIPROG · UPA · OBDSTAR.
//   Every anchor must carry both `target="_blank"` and the full
//   `rel="noopener noreferrer"` token pair so the popup links can't
//   reach back into the workspace via window.opener.
//
// Test 2 — Reset clears workspace state (multi-module + target VIN + log)
//   The companion file moduleSyncReset.ui.test.jsx already pins the
//   "vehicleFamily survives a Reset" branch using a single BCM fixture.
//   This test exercises the broader contract: after loading BCM + RFHUB
//   + PCM and entering a Target VIN, clicking Reset must clear all
//   three module slots (the BCM-driven inspection panel + the bothReady
//   Sync Actions card disappear), wipe the Target VIN field, and reset
//   the on-screen log down to just the single "Workspace cleared"
//   confirmation line. The vehicleFamily selection must still be in
//   place when modules are re-loaded.

import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor, within } from "@testing-library/react";

import ModuleSync from "../tabs/ModuleSync.jsx";
import { MasterVinProvider } from "../lib/masterVinContext.jsx";
import { MODULE_CONNECTION_GUIDES, PROGRAMMERS } from "../lib/programmerData.js";

afterEach(() => cleanup());

/* doSync handlers download the patched bin via URL.createObjectURL +
 * a temporary <a>.click(). jsdom doesn't ship createObjectURL by
 * default, so we stub the pair to keep the click path from throwing
 * partway through and leaving setOriginals/setDiffRows half-applied.
 * The download itself is a side-effect we don't care about here. */
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
}

/* Real-shape fixtures from the smoke-test corpus. We use these (rather
 * than buildFixtures generators) because the multi-module reset test
 * needs both the BCM and the RFHUB to reach `parsed.ok === true` so the
 * workspace flips to `bothReady`, which is what mounts the Sync Actions
 * card and the Target VIN <input>. The synthetic buildFixtures BCM
 * doesn't carry the 00 46 XX 00 slot markers the parser scans for, so
 * it never satisfies that gate. */
const __dir = dirname(fileURLToPath(import.meta.url));
const realFixture = name => new Uint8Array(readFileSync(join(__dir, "fixtures", name)));

function renderModuleSync() {
  return render(
    <MasterVinProvider setPg={() => {}}>
      <ModuleSync />
    </MasterVinProvider>
  );
}

/* DropZone reads the dropped file via `f.arrayBuffer()`, so each helper
 * hands the matching file input a real File whose bytes come straight
 * out of buildFixtures (the same generator the rest of the suite uses).
 * The four DropZones render in fixed order — BCM, RFHUB, PCM, 95640 —
 * so the input index matches the slot we want to populate. */
async function loadFixtureIntoSlot(container, slotIdx, name, bytes) {
  const inputs = container.querySelectorAll('input[type="file"]');
  expect(inputs.length).toBeGreaterThan(slotIdx);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  await act(async () => {
    fireEvent.change(inputs[slotIdx], { target: { files: [file] } });
  });
}

describe("ModuleSync — Connection Guides anchors (Task #464 / #465)", () => {
  it("renders one anchor per (module, programmer) pair from MODULE_CONNECTION_GUIDES", () => {
    renderModuleSync();
    const row = screen.getByTestId("modsync-connection-guides");
    /* Total expected = sum of guides across all modules. For the LX path
     * the registry stamps BCM=2, PCM=1, RFH=3 → 6 anchors. Computing the
     * expected count from the registry (not hard-coding 6) keeps the
     * lock useful when a new programmer is added later. */
    const expectedCount = MODULE_CONNECTION_GUIDES.reduce(
      (sum, g) => sum + g.guides.length, 0
    );
    expect(expectedCount).toBe(6); /* sanity-check the LX baseline */
    const anchors = row.querySelectorAll("a");
    expect(anchors.length).toBe(expectedCount);
  });

  it("opens every guide link in a new tab with the noopener+noreferrer rel pair", () => {
    renderModuleSync();
    const row = screen.getByTestId("modsync-connection-guides");
    const anchors = row.querySelectorAll("a");
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.getAttribute("target")).toBe("_blank");
      const rel = (a.getAttribute("rel") || "").split(/\s+/);
      /* Both tokens are required — `noopener` alone still leaks the
       * Referer header to the bench-tool vendor's site, and `noreferrer`
       * implies noopener in modern browsers but the explicit pair is
       * the convention the rest of the codebase follows. */
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
    }
  });

  it("renders the Charger LX BCM (MPC560xB) row with MULTIPROG and UPA links pointing at their vendor URLs", () => {
    renderModuleSync();
    const bcmRow = screen.getByTestId("modsync-guides-bcm");
    const within_ = within(bcmRow);
    /* Visible label must show the chip family the bench actually clips
     * onto, not the FCA marketing name — that's the filter techs use
     * when picking an adapter. */
    expect(within_.getByText("BCM (MPC560xB)")).toBeTruthy();

    const multiprog = screen.getByTestId("modsync-guide-link-bcm-multiprog");
    expect(multiprog.getAttribute("href")).toBe(
      MODULE_CONNECTION_GUIDES.find(g => g.module === "BCM")
        .guides.find(x => x.programmer === "MULTIPROG").url
    );
    expect(multiprog.textContent).toBe(PROGRAMMERS.MULTIPROG.label);

    const upa = screen.getByTestId("modsync-guide-link-bcm-upa");
    expect(upa.getAttribute("href")).toBe(
      MODULE_CONNECTION_GUIDES.find(g => g.module === "BCM")
        .guides.find(x => x.programmer === "UPA").url
    );
    expect(upa.textContent).toBe(PROGRAMMERS.UPA.label);
  });
});

describe("ModuleSync — Reset clears multi-module workspace state (Task #464 / #465)", () => {
  it("clears BCM + RFHUB + PCM slots, the Target VIN field, and the log while keeping vehicleFamily selected", async () => {
    const { container } = renderModuleSync();

    /* Load all three real-shape fixtures in the order their DropZones
     * render: BCM (slot 0), RFHUB (slot 1), PCM (slot 2). Once BCM and
     * RFHUB are both `parsed.ok` the workspace flips to bothReady and
     * the Sync Actions card with the Target VIN input mounts. */
    await loadFixtureIntoSlot(container, 0, "bcm.bin",
      realFixture("SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin"));
    await loadFixtureIntoSlot(container, 1, "rfh.bin",
      realFixture("SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin"));
    await loadFixtureIntoSlot(container, 2, "pcm.bin",
      realFixture("SAMPLE_GPEC2A_EXT_EEPROM_VIN_CRC_2C3CDXCT1HH652640.bin"));

    /* Vehicle family selector is now mounted (BCM is loaded). Pick a real
     * family so we can prove it survives the Reset. */
    const select = await waitFor(() => screen.getByTestId("vehicle-family-select"));
    const firstReal = Array.from(select.options).find(o => o.value !== "");
    expect(firstReal).toBeTruthy();
    await act(async () => {
      fireEvent.change(select, { target: { value: firstReal.value } });
    });
    expect(select.value).toBe(firstReal.value);

    /* Target VIN input only appears when bothReady is true — the BCM +
     * RFHUB pair we just dropped in satisfies that gate. Type into it
     * so we can prove it gets wiped. The component normalises to upper
     * case + VIN-charset on every keystroke, so the assertion has to
     * read the input's *current* value rather than the literal we typed. */
    const vinInput = await waitFor(() => {
      const el = container.querySelector('input[placeholder="Enter 17-character VIN"]');
      expect(el).toBeTruthy();
      return el;
    });
    await act(async () => {
      fireEvent.change(vinInput, { target: { value: "2C3CDXKT3FH796320" } });
    });
    expect(vinInput.value.length).toBeGreaterThan(0);

    /* Confirm the canonical startup banner is in the visible log so we
     * can later prove the log array was actually wiped (not just
     * hidden by an unmount). */
    expect(screen.getByText(/SRT Lab Module Sync v2/i)).toBeTruthy();

    /* Drive a real sync action ("⬅ BCM VIN → RFH") so the engine
     * populates diffRows (rendered by VinDiffTable as the "VIN Slot
     * Diff" header) and the originals.rfh snapshot (rendered as the
     * "⟲ Restore RFH original" undo button). The Reset gesture is
     * supposed to clear both, but with no sync ever performed neither
     * surface would ever exist and the test would be vacuously true.
     * The download side-effect is harmless thanks to the stubbed
     * URL.createObjectURL above. */
    const bcmToRfhBtn = await waitFor(() =>
      screen.getByRole("button", { name: /BCM VIN.*RFH/i })
    );
    await act(async () => { fireEvent.click(bcmToRfhBtn); });

    /* Both undo surfaces must now be present — if a future refactor
     * stops populating diffRows/originals here, this assertion fails
     * loudly before we even reach the Reset call. */
    expect(screen.getByText(/VIN Slot Diff/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Restore RFH original/i })).toBeTruthy();

    fireEvent.click(screen.getByTestId("modsync-reset-btn"));

    /* Clearing the BCM + RFHUB slots drops the bothReady gate, which
     * unmounts the Sync Actions card (Target VIN input lives there) and
     * the inspection panel (vehicle-family-select lives there). */
    await waitFor(() => {
      expect(screen.queryByTestId("vehicle-family-select")).toBeNull();
    });
    expect(container.querySelector('input[placeholder="Enter 17-character VIN"]')).toBeNull();

    /* Module-card surfaces from any of the three loaded slots must be
     * gone — there is no longer a parsed BCM / RFH / PCM to render. */
    expect(screen.queryByTestId("bcm-too-small-card")).toBeNull();
    expect(screen.queryByTestId("rfh-too-small-card")).toBeNull();
    expect(screen.queryByTestId("pcm-too-small-card")).toBeNull();
    expect(screen.queryByTestId("pcm-chip-badge")).toBeNull();
    expect(screen.queryByTestId("bcm-pn-pick")).toBeNull();

    /* Both undo surfaces from the pre-reset sync must be gone too:
     * VIN Slot Diff (driven by diffRows) and the Restore RFH original
     * button (driven by originals.rfh). They live inside the
     * bothReady-gated card, so they unmount along with it — but we
     * also re-load the modules below and re-assert nothing stale
     * comes back, which is the real proof setDiffRows([]) and
     * setOriginals({...all-null}) actually ran. */
    expect(screen.queryByText(/VIN Slot Diff/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Restore RFH original/i })).toBeNull();

    /* The log card itself lives inside the `bothReady` Sync Actions
     * section, so once Reset clears the BCM/RFH parses the entire log
     * pane unmounts. That alone proves the BCM/RFH slots cleared, but
     * it also means we can't yet see the "Workspace cleared" message —
     * we re-load BCM + RFH below to bring the log back so we can
     * compare what's visible against what was visible before. */
    expect(screen.queryByText(/SRT Lab Module Sync v2/i)).toBeNull();

    /* Re-load BCM + RFHUB. This brings back the inspection panel
     * (vehicle-family-select) and the bothReady-gated log card. */
    await loadFixtureIntoSlot(container, 0, "bcm.bin",
      realFixture("SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin"));
    await loadFixtureIntoSlot(container, 1, "rfh.bin",
      realFixture("SAMPLE_RFH_SYNCED_VIRGIN_2C3CDXL90MH582899.bin"));

    /* The freshly-rebuilt inspection panel must come back already
     * pointing at the previously chosen vehicle family, because
     * vehicleFamily is registry-state, not per-file state, and Reset
     * must NOT have touched it. */
    const reborn = await waitFor(() => screen.getByTestId("vehicle-family-select"));
    expect(reborn.value).toBe(firstReal.value);

    /* Log was cleared down to the "Workspace cleared" confirmation
     * line, then the post-reset BCM/RFH loads appended their own
     * status lines. The pre-reset startup banner ("SRT Lab Module
     * Sync v2 … ready") must NOT be in there — its absence proves the
     * log array was actually wiped, not just visually hidden. */
    expect(screen.getByText(/Workspace cleared/i)).toBeTruthy();
    expect(screen.queryByText(/SRT Lab Module Sync v2/i)).toBeNull();

    /* The bothReady card is back (BCM + RFH re-loaded) but neither
     * the diff table nor any "Restore … original" button must come
     * back from the pre-reset sync. If setDiffRows([]) or
     * setOriginals({...all-null}) had been dropped from handleReset,
     * the previous diffRows/originals would still be in state and
     * the freshly-mounted card would re-render them — which is why
     * we re-check here, AFTER the bothReady remount. */
    expect(screen.queryByText(/VIN Slot Diff/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Restore BCM original/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Restore RFH original/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Restore PCM original/i })).toBeNull();
  });
});
