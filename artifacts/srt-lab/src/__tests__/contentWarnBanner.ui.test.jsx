// @vitest-environment jsdom
//
// Locks the visual surfacing of the "doesn't look like a BCM" content
// warning. ModuleFieldsPanel is the embedded inspector used inside
// BcmTab; whenever a 64 KB / 128 KB capture parses as BCM but lacks
// any BCM-defining content, the banner must appear above the regular
// field rows so the user sees the hint before trusting any field
// values.

import React from "react";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import ModuleFieldsPanel from "../components/ModuleFieldsPanel.jsx";
import { parseModule } from "../lib/parseModule.js";
import { makeBcm } from "../lib/__fixtures__/buildFixtures.js";

afterEach(() => cleanup());

describe("ContentWarnBanner — UI surfacing", () => {
  it("renders the banner for a 64 KB BCM-shaped buffer with no BCM content", () => {
    const blank = new Uint8Array(65536).fill(0xff);
    const mod = parseModule(blank, "renamed.bin");
    expect(mod.type).toBe("BCM");
    expect(mod.contentWarn).not.toBeNull();

    render(<ModuleFieldsPanel mod={mod} onSyncImmo={() => {}} />);

    const heading = screen.getByText(/DOESN'T LOOK LIKE A BCM/);
    expect(heading).toBeTruthy();
    expect(heading.textContent).toMatch(/65,536/);
    expect(screen.getByText(/oversized GPEC2A capture/i)).toBeTruthy();
    expect(screen.getByText(/oversized 95640 capture/i)).toBeTruthy();
  });

  it("does NOT render the banner for a populated real BCM", () => {
    const mod = parseModule(makeBcm({ size: 65536 }), "bcm.bin");
    expect(mod.contentWarn).toBeNull();
    render(<ModuleFieldsPanel mod={mod} onSyncImmo={() => {}} />);
    expect(screen.queryByTestId("content-warn-banner")).toBeNull();
  });
});
