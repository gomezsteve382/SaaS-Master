// @vitest-environment jsdom
//
// Component tests for the simplified wizard view (SimpleFlow) and the
// session-persistent Advanced toggle in MismatchWizard.

import React from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import MismatchWizard from "../components/MismatchWizard.jsx";

const fullActions = [
  { id: "full-sync", label: "Full sync", enabled: true, description: "Re-pair all" },
  { id: "sec16-only", label: "SEC16 only", enabled: true, description: "Token only" },
  { id: "rfh-to-bcm", label: "RFH→BCM", enabled: true, description: "Copy RFH VIN" },
  { id: "bcm-sec16-to-rfh", label: "BCM SEC16→RFH", enabled: true, description: "Copy BCM SEC16" },
];

beforeEach(() => {
  try { window.sessionStorage.clear(); } catch {}
  try { window.localStorage.clear(); } catch {}
  // jsdom doesn't implement scrollIntoView; the chat panel calls it on mount
  // when the wizard is in advanced mode.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  // Stub fetch so the chat panel's hydration call doesn't blow up in jsdom.
  globalThis.fetch = vi.fn(() => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ id: "stub", messages: [] }),
  }));
});

afterEach(() => { cleanup(); });

describe("SimpleFlow rendering (Advanced off)", () => {
  it("shows the named scenario card and a Confirm button when issues are present", () => {
    render(
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
        sessionKey="test-vin"
      />
    );

    // Header is in "GUIDED FIX" mode by default (advanced off).
    expect(screen.getByText(/GUIDED FIX/i)).toBeTruthy();

    // BCM+RFHUB+PCM with a VIN mismatch matches the "pair-all-three" scenario.
    expect(screen.getByTestId("scenario-card")).toBeTruthy();
    expect(screen.getByText(/Pair BCM \+ RFHUB \+ Engine computer/i)).toBeTruthy();
    expect(screen.getAllByText(/1C3CDFCT0FD999999/).length).toBeGreaterThan(0);

    // The 1-click confirm button is rendered and enabled.
    const fixBtn = screen.getByTestId("simple-fix-btn");
    expect(fixBtn).toBeTruthy();
    expect(fixBtn.textContent).toMatch(/FIX IT/);
    expect(fixBtn.disabled).toBe(false);
  });

  it("shows the 'modules paired' all-good state when there are no issues or warnings", () => {
    render(
      <MismatchWizard
        issues={[]}
        warnings={[]}
        modules={["BCM", "RFHUB"]}
        hexSnippets={[]}
        stepActions={fullActions}
        onAction={() => []}
        onClose={() => {}}
        sessionKey="test-ok"
      />
    );

    expect(screen.getByText(/Modules paired/i)).toBeTruthy();
    expect(screen.queryByTestId("simple-fix-btn")).toBeNull();
    // The all-good state surfaces a single DONE button.
    expect(screen.getByRole("button", { name: /^DONE$/ })).toBeTruthy();
  });

  it("invokes onAction with the recommended action id when FIX IT is clicked", async () => {
    const onAction = vi.fn(() => [{ name: "BCM.bin" }]);
    const user = userEvent.setup();

    render(
      <MismatchWizard
        issues={["BCM SEC16 MISMATCH"]}
        warnings={[]}
        modules={["BCM", "RFHUB"]}
        hexSnippets={[]}
        stepActions={fullActions}
        onAction={onAction}
        onClose={() => {}}
        sessionKey="test-click"
      />
    );

    await user.click(screen.getByTestId("simple-fix-btn"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0]).toBe("sec16-only");
  });
});

describe("Advanced toggle persistence", () => {
  it("flips the UI to advanced mode and writes '1' to sessionStorage", async () => {
    const user = userEvent.setup();

    render(
      <MismatchWizard
        issues={["BCM/RFHUB VIN MISMATCH"]}
        warnings={[]}
        modules={["BCM", "RFHUB"]}
        hexSnippets={[]}
        stepActions={fullActions}
        onAction={() => []}
        onClose={() => {}}
        sessionKey="persist-test"
      />
    );

    // Starts off — guided/simple view is showing.
    expect(screen.getByText(/GUIDED FIX/i)).toBeTruthy();
    expect(screen.getByTestId("simple-fix-btn")).toBeTruthy();

    const toggle = screen.getByTestId("wizard-advanced-toggle").querySelector("input");
    expect(toggle.checked).toBe(false);

    await user.click(toggle);

    // Advanced mode now visible — header switches to "ISSUE SUMMARY".
    expect(screen.getByText(/ISSUE SUMMARY/i)).toBeTruthy();
    expect(screen.queryByTestId("simple-fix-btn")).toBeNull();

    // Persisted to sessionStorage with the per-scope key.
    expect(window.sessionStorage.getItem("srt-advanced:wizard:persist-test")).toBe("1");
  });

  it("restores the advanced view on remount when sessionStorage already has '1'", () => {
    window.sessionStorage.setItem("srt-advanced:wizard:persist-test", "1");

    render(
      <MismatchWizard
        issues={["BCM/RFHUB VIN MISMATCH"]}
        warnings={[]}
        modules={["BCM", "RFHUB"]}
        hexSnippets={[]}
        stepActions={fullActions}
        onAction={() => []}
        onClose={() => {}}
        sessionKey="persist-test"
      />
    );

    // Mounted directly into advanced mode.
    expect(screen.getByText(/ISSUE SUMMARY/i)).toBeTruthy();
    expect(screen.queryByText(/GUIDED FIX/i)).toBeNull();
    expect(screen.queryByTestId("simple-fix-btn")).toBeNull();
    const toggle = screen.getByTestId("wizard-advanced-toggle").querySelector("input");
    expect(toggle.checked).toBe(true);
  });

  it("scopes persistence per sessionKey (other scopes stay in simple mode)", () => {
    window.sessionStorage.setItem("srt-advanced:wizard:scope-a", "1");

    render(
      <MismatchWizard
        issues={["BCM/RFHUB VIN MISMATCH"]}
        warnings={[]}
        modules={["BCM", "RFHUB"]}
        hexSnippets={[]}
        stepActions={fullActions}
        onAction={() => []}
        onClose={() => {}}
        sessionKey="scope-b"
      />
    );

    expect(screen.getByText(/GUIDED FIX/i)).toBeTruthy();
    expect(screen.getByTestId("simple-fix-btn")).toBeTruthy();
  });

  it("toggling advanced back off persists '0' and restores the simple view", async () => {
    window.sessionStorage.setItem("srt-advanced:wizard:persist-test", "1");
    const user = userEvent.setup();

    render(
      <MismatchWizard
        issues={["BCM/RFHUB VIN MISMATCH"]}
        warnings={[]}
        modules={["BCM", "RFHUB"]}
        hexSnippets={[]}
        stepActions={fullActions}
        onAction={() => []}
        onClose={() => {}}
        sessionKey="persist-test"
      />
    );

    const toggle = screen.getByTestId("wizard-advanced-toggle").querySelector("input");
    expect(toggle.checked).toBe(true);

    await user.click(toggle);

    expect(screen.getByText(/GUIDED FIX/i)).toBeTruthy();
    expect(screen.getByTestId("simple-fix-btn")).toBeTruthy();
    expect(window.sessionStorage.getItem("srt-advanced:wizard:persist-test")).toBe("0");
  });
});
