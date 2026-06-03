// @vitest-environment jsdom
//
// CharRfhubKeyDiffPanel — before/after key-add self-check UI.
//
// Mirrors the assertions in src/lib/__tests__/charRfhubKeyDiff.test.js against
// the rendered panel: a clean single key-add is surfaced as verified, while a
// companion-region change, a master-secret change, and a removed key are each
// flagged. Synthetic-but-faithful fixtures are built from the same primitives
// the harness suite uses (no fabricated "real" pair).

import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import CharRfhubKeyDiffPanel from "../components/CharRfhubKeyDiffPanel.jsx";
import {
  CHAR_KEYTABLE_BASE,
  CHAR_KEYTABLE_STRIDE,
  CHAR_MASTER_OFFSET,
  keyIdToRevUid,
  addCharKey,
} from "../lib/charRfhubKeyTable.js";

const REF_KEYS = [
  { keyId: "0077A29B", idx: 0x48 },
  { keyId: "CC62209F", idx: 0x0f },
  { keyId: "09A6629F", idx: 0x4c },
  { keyId: "91654F9E", idx: 0x19 },
  { keyId: "197E6C9E", idx: 0x5b },
  { keyId: "C47D6C9E", idx: 0xb0 },
];

function writeSlot(buf, slotIdx, rec6) {
  const off = CHAR_KEYTABLE_BASE + slotIdx * CHAR_KEYTABLE_STRIDE;
  for (let k = 0; k < 6; k++) { buf[off + k] = rec6[k]; buf[off + 8 + k] = rec6[k]; }
  buf[off + 6] = 0xff; buf[off + 7] = 0xff;
  buf[off + 14] = 0xff; buf[off + 15] = 0xff;
}

function buildRef() {
  const buf = new Uint8Array(4096).fill(0x00);
  for (let i = 0; i < 16; i++) buf[CHAR_MASTER_OFFSET + i] = 0xa0 + i;
  writeSlot(buf, 0, [0x5a, 0x5a, 0x5a, 0x5a, 0x95, 0x00]);
  writeSlot(buf, 1, [0x5a, 0x5a, 0x5a, 0x5a, 0x95, 0x00]);
  REF_KEYS.forEach((k, i) => {
    const rev = keyIdToRevUid(k.keyId);
    writeSlot(buf, 2 + i, [rev[0], rev[1], rev[2], rev[3], k.idx, 0x01]);
  });
  const slot8 = CHAR_KEYTABLE_BASE + 7 * CHAR_KEYTABLE_STRIDE;
  buf[slot8 + 14] = 0x00; buf[slot8 + 15] = 0x6c;
  return buf;
}

// FileReader in jsdom: load a Uint8Array into the panel's <input type=file>.
function loadFile(input, bytes, name) {
  const file = new File([bytes], name, { type: "application/octet-stream" });
  // jsdom File.arrayBuffer exists; FileReader.readAsArrayBuffer uses it.
  fireEvent.change(input, { target: { files: [file] } });
}

afterEach(() => cleanup());

async function renderAndLoad(before, after) {
  render(<CharRfhubKeyDiffPanel defaultOpen />);
  loadFile(screen.getByTestId("char-key-diff-before-input"), before, "before.bin");
  loadFile(screen.getByTestId("char-key-diff-after-input"), after, "after.bin");
  await waitFor(() => expect(screen.getByTestId("char-key-diff-overall")).toBeTruthy(), { timeout: 4000 });
}

describe("CharRfhubKeyDiffPanel — clean single key-add", () => {
  it("surfaces a verified single key-add with matching slot and no companion region", async () => {
    const before = buildRef();
    const after = addCharKey(before, { keyId: "BCD2EB9B" }).bytes;
    await renderAndLoad(before, after);

    expect(screen.getByTestId("char-key-diff-overall").textContent).toMatch(/MATCHES A REAL SINGLE KEY-ADD/);
    expect(screen.getByTestId("char-key-diff-single").textContent).toMatch(/YES/);
    expect(screen.getByTestId("char-key-diff-slot").textContent).toMatch(/YES/);
    expect(screen.getByTestId("char-key-diff-master").textContent).toMatch(/YES/);
    expect(screen.getByTestId("char-key-diff-companion").textContent).toMatch(/YES/);
    expect(screen.getByTestId("char-key-diff-added").textContent).toMatch(/BCD2EB9B/);
  });
});

describe("CharRfhubKeyDiffPanel — companion-table candidate", () => {
  it("flags a changed run outside the key table", async () => {
    const before = buildRef();
    const after = addCharKey(before, { keyId: "BCD2EB9B" }).bytes.slice();
    after[0x0400] ^= 0xff;
    after[0x0401] ^= 0xff;
    await renderAndLoad(before, after);

    expect(screen.getByTestId("char-key-diff-overall").textContent).toMatch(/REVIEW/);
    expect(screen.getByTestId("char-key-diff-companion").textContent).toMatch(/NO/);
    expect(screen.getByTestId("char-key-diff-companion-row-0")).toBeTruthy();
  });
});

describe("CharRfhubKeyDiffPanel — full re-key (master change)", () => {
  it("flags a master-secret change and refuses to call it a single add", async () => {
    const before = buildRef();
    const after = addCharKey(before, { keyId: "BCD2EB9B" }).bytes.slice();
    after[CHAR_MASTER_OFFSET] ^= 0xff;
    await renderAndLoad(before, after);

    expect(screen.getByTestId("char-key-diff-overall").textContent).toMatch(/REVIEW/);
    expect(screen.getByTestId("char-key-diff-master").textContent).toMatch(/NO/);
    expect(screen.getByTestId("char-key-diff-single").textContent).toMatch(/NO/);
  });
});

describe("CharRfhubKeyDiffPanel — removed key", () => {
  it("reports a key present in before but missing in after", async () => {
    const before = buildRef();
    const after = before.slice();
    writeSlot(after, 7, [0x5a, 0x5a, 0x5a, 0x5a, 0x95, 0x00]);
    const slot8 = CHAR_KEYTABLE_BASE + 7 * CHAR_KEYTABLE_STRIDE;
    after[slot8 + 14] = 0x00; after[slot8 + 15] = 0x6c;
    await renderAndLoad(before, after);

    expect(screen.getByTestId("char-key-diff-removed").textContent).toMatch(/C47D6C9E/);
    expect(screen.getByTestId("char-key-diff-single").textContent).toMatch(/NO/);
  });
});

describe("CharRfhubKeyDiffPanel — input gate", () => {
  it("shows an error when a file is not a Charger key table", async () => {
    render(<CharRfhubKeyDiffPanel defaultOpen />);
    loadFile(screen.getByTestId("char-key-diff-before-input"), buildRef(), "before.bin");
    loadFile(screen.getByTestId("char-key-diff-after-input"), new Uint8Array(2048), "after.bin");
    await waitFor(() => expect(screen.getByTestId("char-key-diff-error")).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByTestId("char-key-diff-error").textContent).toMatch(/after:/);
  });
});
