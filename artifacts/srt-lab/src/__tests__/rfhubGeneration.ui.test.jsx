// @vitest-environment jsdom
//
// Pins the RFHUB hardware-generation read-out: when an RFHUB .bin is read,
// ModuleFieldsPanel (the shared RFHUB inspector) surfaces the parsed
// generation (parseModule's info.rfhGen) as a prominent badge in the
// "RFHUB Analysis" header — so a tech can tell Gen1 (24C16) from
// Gen2 (24C32) at a glance instead of inferring it from the file size.

import React from "react";
import { describe, it, afterEach, expect } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

import ModuleFieldsPanel from "../components/ModuleFieldsPanel.jsx";
import { parseModule } from "../lib/parseModule.js";
import { makeRfhubGen1, makeRfhubGen2 } from "../lib/__fixtures__/buildFixtures.js";

afterEach(() => cleanup());

function rfhMod(buf, filename) {
  const mod = parseModule(buf, filename);
  return { ...mod, data: buf, filename, size: buf.length };
}

describe("RFHUB generation badge", () => {
  it("labels a Gen2 (24C32) dump", () => {
    render(<ModuleFieldsPanel mod={rfhMod(makeRfhubGen2(), "rfh_gen2.bin")} />);
    const card = within(screen.getByText(/RFHUB Analysis/i).closest("div").parentElement);
    expect(card.getByText("Gen2 (24C32)")).toBeTruthy();
  });

  it("labels a Gen1 (24C16) dump", () => {
    render(<ModuleFieldsPanel mod={rfhMod(makeRfhubGen1(), "rfh_gen1.bin")} />);
    expect(screen.getByText("Gen1 (24C16)")).toBeTruthy();
  });
});
