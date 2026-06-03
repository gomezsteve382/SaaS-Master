// @vitest-environment jsdom
//
// CharRfhubKeyAdderPanel — Offline Key Adder banner state.
//
// The Adder shows a permanent "EXPERIMENTAL — NOT BENCH-VERIFIED" caveat until a
// clean before/after single key-add is saved in the sibling self-check panel for
// this layout; once one exists the caveat is replaced by a green "BENCH-VERIFIED"
// banner. These tests render the panel and lock that flip in:
//   1. a saved verification -> verified banner shows, experimental banner gone,
//   2. no verification      -> experimental banner shows, verified banner gone,
//   3. same-session reactivity: saving a verification (which fires
//      KEY_ADD_VERIFY_EVENT) flips the banner without a remount.
//
// fetch is stubbed offline so refreshVerificationsFromServer deterministically
// falls back to the localStorage cache (the canonical state for this UI).

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";

import CharRfhubKeyAdderPanel from "../components/CharRfhubKeyAdderPanel.jsx";
import {
  CHAR_MPC_8SLOT_LAYOUT,
  KEY_ADD_VERIFY_KEY,
  KEY_ADD_VERIFY_MIGRATED_PREFIX,
  saveVerification,
} from "../lib/charKeyAddVerification.js";

function cleanDiff(over = {}) {
  return {
    ok: true,
    isSingleKeyAdd: true,
    addedSlotMatchesRule: true,
    masterChanged: false,
    expectedSlotIdx: 4,
    beforeKeyCount: 5,
    afterKeyCount: 6,
    companionRegions: [],
    addedKeys: [{ keyId: "BCD2EB9B", slot: 5, slotIdx: 4 }],
    removedKeys: [],
    ...over,
  };
}

beforeEach(() => {
  globalThis.localStorage?.removeItem(KEY_ADD_VERIFY_KEY);
  globalThis.localStorage?.removeItem(`${KEY_ADD_VERIFY_MIGRATED_PREFIX}${CHAR_MPC_8SLOT_LAYOUT}`);
  // Offline: GET/POST reject so the panel falls back to the local cache.
  globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CharRfhubKeyAdderPanel — bench-verified banner", () => {
  it("shows the verified banner (and hides the experimental one) when a verification is saved", async () => {
    saveVerification(cleanDiff(), { beforeName: "b.bin", afterName: "a.bin" });

    render(<CharRfhubKeyAdderPanel defaultOpen />);

    const verified = await screen.findByTestId("char-key-adder-verified-banner");
    expect(verified.textContent).toMatch(/BENCH-VERIFIED/);
    // The confirming pair details from the saved record are surfaced.
    expect(verified.textContent).toMatch(/BCD2EB9B/);
    expect(screen.queryByTestId("char-key-adder-experimental-banner")).toBeNull();
  });

  it("shows the experimental banner (and no verified one) when no verification exists", async () => {
    render(<CharRfhubKeyAdderPanel defaultOpen />);

    const experimental = await screen.findByTestId("char-key-adder-experimental-banner");
    expect(experimental.textContent).toMatch(/EXPERIMENTAL — NOT BENCH-VERIFIED/);
    expect(screen.queryByTestId("char-key-adder-verified-banner")).toBeNull();
  });

  it("flips to the verified banner in the same session when a verification is saved (no remount)", async () => {
    render(<CharRfhubKeyAdderPanel defaultOpen />);

    // Starts experimental.
    expect(await screen.findByTestId("char-key-adder-experimental-banner")).toBeTruthy();
    expect(screen.queryByTestId("char-key-adder-verified-banner")).toBeNull();

    // Saving dispatches KEY_ADD_VERIFY_EVENT, which the mounted panel listens for.
    act(() => {
      saveVerification(cleanDiff(), { beforeName: "b.bin", afterName: "a.bin" });
    });

    await waitFor(() => expect(screen.getByTestId("char-key-adder-verified-banner")).toBeTruthy());
    expect(screen.queryByTestId("char-key-adder-experimental-banner")).toBeNull();
  });
});
