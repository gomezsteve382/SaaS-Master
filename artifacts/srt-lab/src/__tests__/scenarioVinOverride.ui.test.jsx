// @vitest-environment jsdom
//
// Tests for the inline master-VIN editor on the SimpleFlow scenario card.

import React from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import MismatchWizard from "../components/MismatchWizard.jsx";

const fullActions = [
  { id: "full-sync", label: "Full sync", enabled: true, description: "Re-pair all" },
  { id: "sec16-only", label: "SEC16 only", enabled: true, description: "Token only" },
  { id: "rfh-to-bcm", label: "RFH→BCM", enabled: true, description: "Copy RFH VIN" },
  { id: "bcm-to-rfh", label: "BCM→RFH", enabled: true, description: "Copy BCM VIN" },
  { id: "bcm-sec16-to-rfh", label: "BCM SEC16→RFH", enabled: true, description: "Copy BCM SEC16" },
];

beforeEach(() => {
  try { window.sessionStorage.clear(); } catch {}
  try { window.localStorage.clear(); } catch {}
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  globalThis.fetch = vi.fn(() => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve({ id: "stub", messages: [] }),
  }));
});
afterEach(() => { cleanup(); });

const renderScenario = (extra = {}) => render(
  <MismatchWizard
    issues={["BCM/RFHUB VIN MISMATCH"]}
    warnings={[]}
    modules={["BCM", "RFHUB", "PCM"]}
    hexSnippets={[
      "BCM VIN @0x1234: 1C3CDFCT0FD123456",
      "RFHUB VIN @0x0010: 1C3CDFCT0FD999999",
    ]}
    stepActions={fullActions}
    onAction={() => [{ name: "BCM.bin" }]}
    onClose={() => {}}
    sessionKey="vin-override-test"
    {...extra}
  />
);

describe("Scenario card master-VIN inline editor", () => {
  it("renders the auto-picked VIN as a clickable badge with a pencil affordance", () => {
    renderScenario();
    const editBtn = screen.getByTestId("scenario-vin-edit-btn");
    expect(editBtn).toBeTruthy();
    expect(editBtn.textContent).toMatch(/1C3CDFCT0FD999999/);
    expect(editBtn.textContent).toMatch(/✎/);
    expect(screen.queryByTestId("scenario-vin-custom-badge")).toBeNull();
  });

  it("opens an inline editor when the badge is clicked and validates 17-char VINs", async () => {
    const user = userEvent.setup();
    renderScenario();
    await user.click(screen.getByTestId("scenario-vin-edit-btn"));
    const input = screen.getByTestId("scenario-vin-input");
    expect(input).toBeTruthy();
    const saveBtn = screen.getByTestId("scenario-vin-save-btn");
    // Save is disabled with the prefilled valid VIN unchanged? It's the same
    // as scenario.targetVin, which is valid → save is enabled.
    expect(saveBtn.disabled).toBe(false);

    // Type something invalid.
    await user.clear(input);
    await user.type(input, "NOTAVIN");
    expect(screen.getByTestId("scenario-vin-save-btn").disabled).toBe(true);

    // Then a valid one.
    await user.clear(input);
    await user.type(input, "2C4RDGCG0FR111222");
    expect(screen.getByTestId("scenario-vin-save-btn").disabled).toBe(false);
  });

  it("shows the 'custom VIN' badge after saving an override, and resets cleanly", async () => {
    const user = userEvent.setup();
    renderScenario();
    await user.click(screen.getByTestId("scenario-vin-edit-btn"));
    const input = screen.getByTestId("scenario-vin-input");
    await user.clear(input);
    await user.type(input, "2C4RDGCG0FR111222");
    await user.click(screen.getByTestId("scenario-vin-save-btn"));

    expect(screen.getByTestId("scenario-vin-custom-badge")).toBeTruthy();
    const badge = screen.getByTestId("scenario-vin-edit-btn");
    expect(badge.textContent).toMatch(/2C4RDGCG0FR111222/);

    await user.click(screen.getByTestId("scenario-vin-reset-btn"));
    expect(screen.queryByTestId("scenario-vin-custom-badge")).toBeNull();
    expect(screen.getByTestId("scenario-vin-edit-btn").textContent).toMatch(/1C3CDFCT0FD999999/);
  });

  it("passes the overridden VIN to onAction when Confirm is clicked", async () => {
    const onAction = vi.fn(() => [{ name: "BCM.bin" }]);
    const user = userEvent.setup();
    render(
      <MismatchWizard
        issues={["BCM/RFHUB VIN MISMATCH"]}
        warnings={[]}
        modules={["BCM", "RFHUB", "PCM"]}
        hexSnippets={["RFHUB VIN @0x0010: 1C3CDFCT0FD999999"]}
        stepActions={fullActions}
        onAction={onAction}
        onClose={() => {}}
        sessionKey="vin-override-confirm"
      />
    );

    await user.click(screen.getByTestId("scenario-vin-edit-btn"));
    const input = screen.getByTestId("scenario-vin-input");
    await user.clear(input);
    await user.type(input, "2C4RDGCG0FR111222");
    await user.click(screen.getByTestId("scenario-vin-save-btn"));
    await user.click(screen.getByTestId("simple-fix-btn"));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][2]).toEqual({ vinOverride: "2C4RDGCG0FR111222" });
  });

  it("does not include vinOverride when the user keeps the auto-picked VIN", async () => {
    const onAction = vi.fn(() => [{ name: "BCM.bin" }]);
    const user = userEvent.setup();
    render(
      <MismatchWizard
        issues={["BCM/RFHUB VIN MISMATCH"]}
        warnings={[]}
        modules={["BCM", "RFHUB", "PCM"]}
        hexSnippets={["RFHUB VIN @0x0010: 1C3CDFCT0FD999999"]}
        stepActions={fullActions}
        onAction={onAction}
        onClose={() => {}}
        sessionKey="vin-override-default"
      />
    );

    await user.click(screen.getByTestId("simple-fix-btn"));
    expect(onAction).toHaveBeenCalledTimes(1);
    // Third arg is undefined when no override.
    expect(onAction.mock.calls[0][2]).toBeUndefined();
  });
});
