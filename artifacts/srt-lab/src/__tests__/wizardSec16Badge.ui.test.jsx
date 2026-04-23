// @vitest-environment jsdom
//
// UI tests for the Task #383 SEC16 provenance chip + virgin-BCM explainer
// rendered inside the Mismatch Wizard's Advanced step view (HexDiffCard
// and ActionResult). Guards against silent regressions of the testids
// `wizard-hexdiff-bcm-sec16-source-badge`,
// `wizard-actionresult-bcm-sec16-source-badge`,
// `wizard-hexdiff-bcm-virgin-explainer`, and
// `wizard-actionresult-bcm-virgin-explainer`.

import React from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import MismatchWizard from "../components/MismatchWizard.jsx";

const stepActions = [
  { id: "full-sync",  label: "Full sync",  enabled: true, description: "Re-pair all" },
  { id: "sec16-only", label: "SEC16 only", enabled: true, description: "Token only" },
  { id: "rfh-to-bcm", label: "RFH→BCM",    enabled: true, description: "Copy RFH VIN" },
  { id: "bcm-sec16-to-rfh", label: "BCM SEC16→RFHUB", enabled: true, description: "Copy BCM SEC16" },
];

/* Hex snippets crafted so HexDiffCard's `hexFilter: ['SEC16', ...]`
 * picks them up and parseSnippet labels them "RFHUB SEC16" / "BCM SEC16",
 * which is what triggers the inline source-badge render in both the
 * side-by-side diff path and the action-result diff path. */
const hexSnippets = [
  "RFHUB SEC16: AABBCCDDEEFF00112233445566778899",
  "BCM SEC16: 0011223344556677889900AABBCCDDEE",
];

/* Helper: render the wizard pre-mounted into Advanced mode and click
 * "START WIZARD" so the step card (and hex diff) is visible. */
async function renderInAdvancedSteps(props) {
  const sessionKey = props.sessionKey || "sec16-badge-test";
  window.sessionStorage.setItem(`srt-advanced:wizard:${sessionKey}`, "1");
  const user = userEvent.setup();
  const utils = render(
    <MismatchWizard
      issues={["BCM SEC16 MISMATCH"]}
      warnings={[]}
      modules={["BCM", "RFHUB", "PCM"]}
      hexSnippets={hexSnippets}
      stepActions={stepActions}
      onAction={() => []}
      onClose={() => {}}
      sessionKey={sessionKey}
      {...props}
    />
  );
  await user.click(screen.getByRole("button", { name: /START WIZARD/i }));
  return { ...utils, user };
}

beforeEach(() => {
  try { window.sessionStorage.clear(); } catch {}
  try { window.localStorage.clear(); } catch {}
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  globalThis.fetch = vi.fn(() => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ id: "stub", messages: [] }),
  }));
});

afterEach(() => { cleanup(); });

describe("MismatchWizard SEC16 source badge (HexDiffCard)", () => {
  it.each([
    ["split",   { source: "split",   offset: 0x81A0, blank: false }, /split @0x81A0/i],
    ["mirror1", { source: "mirror1", offset: 0xEB00, blank: false }, /mirror1 0xEB @0xEB00/i],
    ["mirror2", { source: "mirror2", offset: 0xCA00, blank: false }, /mirror2 0xCA @0xCA00/i],
    ["flat",    { source: "flat",    offset: 0x40C9, blank: false }, /flat @0x40C9 \(legacy\)/i],
  ])("renders the badge with the '%s' source label", async (_name, status, labelRe) => {
    await renderInAdvancedSteps({ bcmSec16Status: status });

    const badges = screen.getAllByTestId("wizard-hexdiff-bcm-sec16-source-badge");
    expect(badges.length).toBeGreaterThan(0);
    const badge = badges[0];
    expect(badge.textContent).toMatch(/SEC16/i);
    expect(badge.textContent).toMatch(labelRe);
    expect(badge.getAttribute("data-sec16-source")).toBe(status.source);
    expect(badge.getAttribute("data-sec16-blank")).toBe("0");
    /* Virgin explainer must NOT render for live SEC16 sources. */
    expect(screen.queryByTestId("wizard-hexdiff-bcm-virgin-explainer")).toBeNull();
  });

  it("renders the virgin-BCM explainer + BLANK chip when bcmSec16Status.blank is true", async () => {
    await renderInAdvancedSteps({
      bcmSec16Status: { source: "split", offset: 0x81A0, blank: true },
    });

    const explainers = screen.getAllByTestId("wizard-hexdiff-bcm-virgin-explainer");
    expect(explainers.length).toBeGreaterThan(0);
    expect(explainers[0].textContent).toMatch(/Virgin BCM/i);

    const badges = screen.getAllByTestId("wizard-hexdiff-bcm-sec16-source-badge");
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0].getAttribute("data-sec16-blank")).toBe("1");
    expect(badges[0].textContent).toMatch(/BLANK/);
  });

  it("renders no badge or explainer when bcmSec16Status is null", async () => {
    const { user } = await renderInAdvancedSteps({ bcmSec16Status: null });

    expect(screen.queryByTestId("wizard-hexdiff-bcm-sec16-source-badge")).toBeNull();
    expect(screen.queryByTestId("wizard-hexdiff-bcm-virgin-explainer")).toBeNull();

    /* Trigger ActionResult so the action-result diff card actually
     * mounts — otherwise the missing-badge assertion on it would be
     * vacuously true. */
    await user.click(screen.getByRole("button", { name: /SEC16 only/i }));

    expect(screen.queryByTestId("wizard-actionresult-bcm-sec16-source-badge")).toBeNull();
    expect(screen.queryByTestId("wizard-actionresult-bcm-virgin-explainer")).toBeNull();
  });
});

describe("MismatchWizard SEC16 source badge (ActionResult)", () => {
  it("renders the badge inside the action-result diff after applying SEC16 sync", async () => {
    const status = { source: "mirror2", offset: 0xCA00, blank: false };
    const { user } = await renderInAdvancedSteps({ bcmSec16Status: status });

    /* Trigger the in-card ActionResult by clicking the "SEC16 only"
     * action button (label comes from stepActions above). */
    await user.click(screen.getByRole("button", { name: /SEC16 only/i }));

    const badges = screen.getAllByTestId("wizard-actionresult-bcm-sec16-source-badge");
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0].textContent).toMatch(/mirror2 0xCA @0xCA00/i);
    expect(badges[0].getAttribute("data-sec16-source")).toBe("mirror2");
    expect(badges[0].getAttribute("data-sec16-blank")).toBe("0");
    expect(screen.queryByTestId("wizard-actionresult-bcm-virgin-explainer")).toBeNull();
  });

  it("renders the virgin explainer in the action-result diff when blank is true", async () => {
    const status = { source: "split", offset: 0x81A0, blank: true };
    const { user } = await renderInAdvancedSteps({ bcmSec16Status: status });

    await user.click(screen.getByRole("button", { name: /SEC16 only/i }));

    const explainers = screen.getAllByTestId("wizard-actionresult-bcm-virgin-explainer");
    expect(explainers.length).toBeGreaterThan(0);
    expect(explainers[0].textContent).toMatch(/Virgin BCM/i);

    const badges = screen.getAllByTestId("wizard-actionresult-bcm-sec16-source-badge");
    expect(badges[0].textContent).toMatch(/split @0x81A0/i);
    expect(badges[0].getAttribute("data-sec16-blank")).toBe("1");
  });
});
