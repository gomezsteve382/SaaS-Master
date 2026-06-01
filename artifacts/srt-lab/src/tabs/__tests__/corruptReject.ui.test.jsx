// @vitest-environment jsdom
//
// Verifies that every module-loading tab rejects a corrupt-fill capture
// before it can reach module state or MasterVinContext.  The corrupt
// fixture (0x55 repeated, 131 072 B) triggers `detectCorruptFill`'s
// single-byte-fill path — the same class of failure as the OBDSTAR6
// incident (canonical incident documented in detectCorruptFill.test.js).
//
// Per-tab assertions:
//   1. The plain-language "tool read error" message becomes visible.
//   2. No module identity card (OS / PN / SERIAL) is rendered — the tab
//      never progressed past the guard into state.
//
// Tabs covered: BenchTab, SecurityTab, Gpec2aTab, BcmTab, RfhubTab,
//               EcmTab, AdcmTab.

import React from "react";
import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import BenchTab    from "../BenchTab.jsx";
import SecurityTab from "../SecurityTab.jsx";
import Gpec2aTab   from "../Gpec2aTab.jsx";
import BcmTab      from "../BcmTab.jsx";
import RfhubTab    from "../RfhubTab.jsx";
import EcmTab      from "../EcmTab.jsx";
import AdcmTab     from "../AdcmTab.jsx";
import { MasterVinProvider, MasterVinContext } from "../../lib/masterVinContext.jsx";
import { parseModule } from "../../lib/parseModule.js";

// ─── Corrupt fixture ──────────────────────────────────────────────────────────
//
// 131 072 bytes (128 KB) of 0x55 — the OBDSTAR single-byte tool-error pattern.
// Large enough to clear every tab's minimum-size guard, small enough that the
// corrupt fill check fires immediately without needing a real module header.
const CORRUPT = new Uint8Array(131072).fill(0x55);

// ─── FileReader mock ──────────────────────────────────────────────────────────
//
// Replaces the global FileReader so that readAsArrayBuffer delivers `bytes`
// synchronously (via a microtask) without touching the real file system.
// Returns a restore function that must be called in afterEach.
function installFileReaderMock(bytes) {
  const Original = global.FileReader;
  function Mock() {
    const inst = {
      onload: null,
      readAsArrayBuffer() {
        Promise.resolve().then(() => {
          if (typeof inst.onload === "function") {
            inst.onload({ target: { result: bytes.buffer } });
          }
        });
      },
    };
    return inst;
  }
  global.FileReader = Mock;
  return () => { global.FileReader = Original; };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function wrap(children) {
  return render(
    <MasterVinProvider setPg={() => {}}>
      {children}
    </MasterVinProvider>
  );
}

function makeFile() {
  return new File([CORRUPT], "corrupt.bin", { type: "application/octet-stream" });
}

// Upload `file` to the first <input type="file"> found in `container`.
async function uploadToFirstInput(container, file) {
  const user = userEvent.setup();
  const input = container.querySelector('input[type="file"]');
  expect(input, "file input must exist").toBeTruthy();
  await user.upload(input, file);
}

// Upload `file` to the last <input type="file"> found in `container`.
// (AdcmTab inspector is the last of several inputs in the tab.)
async function uploadToLastInput(container, file) {
  const user = userEvent.setup();
  const inputs = container.querySelectorAll('input[type="file"]');
  expect(inputs.length, "at least one file input must exist").toBeGreaterThan(0);
  await user.upload(inputs[inputs.length - 1], file);
}

// Drop `bytes` onto the element identified by `queryText`.
// Matches the pattern used by securityTabPcmSec6Marker.ui.test.jsx.
async function dropOnElement(queryText, bytes) {
  const el = await screen.findByText(queryText);
  const file = new File([bytes.buffer], "corrupt.bin", {
    type: "application/octet-stream",
  });
  await act(async () => {
    fireEvent.drop(el, {
      dataTransfer: { files: [file], items: [], types: ["Files"] },
    });
    await new Promise(r => setTimeout(r, 80));
  });
}

// ─── Shared assertion helpers ─────────────────────────────────────────────────

async function assertCorruptMessageVisible() {
  await waitFor(
    () => expect(screen.getByText(/tool read error/i)).toBeTruthy(),
    { timeout: 3000 }
  );
}

function assertNoIdentityCard() {
  expect(screen.queryByText(/OS \/ PN \/ SERIAL/i)).toBeNull();
}

// ─── Global cleanup ───────────────────────────────────────────────────────────

beforeEach(() => {
  try { window.localStorage.clear(); } catch {}
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// BenchTab
// ─────────────────────────────────────────────────────────────────────────────
//
// BenchTab creates the file input programmatically (document.createElement)
// rather than via a static JSX element. We spy on createElement to capture
// the dynamic <input> element and its `onchange` handler, suppress the native
// click (which does nothing in jsdom), and then manually call the handler.
describe("BenchTab — corrupt file rejected", () => {
  it("logs the corrupt-capture error and adds no module to the bench list", async () => {
    const restore = installFileReaderMock(CORRUPT);

    // Capture the dynamic <input type="file"> created by the button handler.
    const capturedInputs = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag, ...args) => {
      const el = realCreate(tag, ...args);
      if (tag === "input") {
        el.click = vi.fn(); // suppress jsdom native file dialog
        capturedInputs.push(el);
      }
      return el;
    });

    render(<BenchTab />);

    // Click the "Load Module Files" button — this runs the onClick handler
    // which calls document.createElement('input') and sets el.onchange.
    const btn = screen.getByText(/Load Module Files/i);
    fireEvent.click(btn);

    // Find the captured input with a file-loading onchange handler.
    const dynInput = capturedInputs.find(el => typeof el.onchange === "function");
    expect(dynInput, "dynamic input with onchange must have been created").toBeTruthy();

    // Deliver the corrupt file via the captured handler.
    const file = makeFile();
    await act(async () => {
      dynInput.onchange({ target: { files: [file] } });
      await new Promise(r => setTimeout(r, 80));
    });

    // The error must appear in the BENCH LOG (rendered as `e.m` text).
    await assertCorruptMessageVisible();

    // No module was loaded — module-level info cards must be absent.
    expect(screen.queryByText(/VIN:/i)).toBeNull();
    expect(screen.queryByText(/OS \/ PN \/ SERIAL/i)).toBeNull();

    restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SecurityTab
// ─────────────────────────────────────────────────────────────────────────────
//
// SecurityTab's main drop zone wraps the "Drop Module Files" card. We fire
// the drop event on that headline element — React's synthetic event system
// bubbles it to the wrapper div carrying the actual onDrop handler.
// (Same approach as securityTabPcmSec6Marker.ui.test.jsx.)
describe("SecurityTab — corrupt file rejected", () => {
  it("shows the corrupt-capture error and loads no module into the overview", async () => {
    const restore = installFileReaderMock(CORRUPT);

    render(<SecurityTab />);

    await dropOnElement(/Drop Module Files/i, CORRUPT);

    // The corrupt error message must appear (rendered via setMsg in SecurityTab).
    await assertCorruptMessageVisible();

    // No cross-module overview should have populated.
    assertNoIdentityCard();
    expect(screen.queryByText(/SEC16/i)).toBeNull();

    restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gpec2aTab
// ─────────────────────────────────────────────────────────────────────────────
//
// Gpec2aTab has two static <input type="file" hidden> elements (Slot 1 and
// Slot 2). Uploading to the first one is sufficient to verify the guard.
describe("Gpec2aTab — corrupt file rejected", () => {
  it("shows the corrupt-capture error and adds no module for Slot 1", async () => {
    const restore = installFileReaderMock(CORRUPT);

    const { container } = wrap(<Gpec2aTab />);

    await uploadToFirstInput(container, makeFile());

    await assertCorruptMessageVisible();
    assertNoIdentityCard();

    restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BcmTab
// ─────────────────────────────────────────────────────────────────────────────
//
// BcmTab's dump inspector has a single <input type="file" hidden> that
// triggers onInspectFile, which calls corruptFillError and sets inspectMsg.
describe("BcmTab — corrupt file rejected", () => {
  it("shows the corrupt-capture error and does not render the BCM inspector panel", async () => {
    const restore = installFileReaderMock(CORRUPT);

    const { container } = wrap(<BcmTab />);

    await uploadToFirstInput(container, makeFile());

    await assertCorruptMessageVisible();
    assertNoIdentityCard();
    // No BCM-too-small card (a different branch) should appear.
    expect(container.querySelector('[data-testid="bcm-too-small-card"]')).toBeNull();

    restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RfhubTab
// ─────────────────────────────────────────────────────────────────────────────
//
// RfhubTab has a static <input type="file" hidden> for the dump inspector.
// onInspectFile runs moduleTooSmall → corruptFillError → sets inspectMsg.
describe("RfhubTab — corrupt file rejected", () => {
  it("shows the corrupt-capture error and does not render the RFHUB inspector panel", async () => {
    const restore = installFileReaderMock(CORRUPT);

    const { container } = wrap(<RfhubTab />);

    await uploadToFirstInput(container, makeFile());

    await assertCorruptMessageVisible();
    assertNoIdentityCard();
    // No rfh-too-small card should appear (a different rejection branch).
    expect(container.querySelector('[data-testid="rfh-too-small-card"]')).toBeNull();

    restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EcmTab
// ─────────────────────────────────────────────────────────────────────────────
//
// EcmTab's inline file picker (Task #783) uses a static <input type="file">.
// onInspectFile runs moduleTooSmall('GPEC2A') → corruptFillError → inspectMsg.
describe("EcmTab — corrupt file rejected", () => {
  it("shows the corrupt-capture error and does not render the ECM identity card", async () => {
    const restore = installFileReaderMock(CORRUPT);

    const { container } = wrap(<EcmTab />);

    await uploadToFirstInput(container, makeFile());

    await assertCorruptMessageVisible();
    assertNoIdentityCard();

    restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AdcmTab
// ─────────────────────────────────────────────────────────────────────────────
//
// AdcmTab's inline file picker is the last <input type="file"> in the tab
// (other inputs may be present for the connected bench controls). onInspectFile
// runs moduleTooSmall → corruptFillError → sets inspectMsg.
describe("AdcmTab — corrupt file rejected", () => {
  it("shows the corrupt-capture error and does not render the ADCM identity card", async () => {
    const restore = installFileReaderMock(CORRUPT);

    const { container } = wrap(<AdcmTab />);

    await uploadToLastInput(container, makeFile());

    await assertCorruptMessageVisible();
    assertNoIdentityCard();

    restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared-state (loadedDumps) corrupt buffer — Task #940
// ─────────────────────────────────────────────────────────────────────────────
//
// The upload-path guards above (onInspectFile / load / drop) only fire when a
// file is dropped *into the tab itself*.  A corrupt capture can still reach an
// inspector through the shared workspace store (MasterVinContext.loadedDumps)
// when it was loaded elsewhere (Dumps tab) and the tab auto-pulls it via
// getDumpsByType.  Task #931 only guarded the Dumps vault; Task #940 adds the
// badge + write block at every consumption point.
//
// These tests inject a corrupt dump straight into loadedDumps (bypassing the
// per-tab upload guard) and assert the tab renders its corruption banner and
// suppresses the analysis / identity panels.

// Harness: calls addDump(parsedCorruptMod) once on mount, then renders the tab.
function InjectAndRender({ type, child }) {
  const { addDump, loadedDumps } = React.useContext(MasterVinContext);
  const injected = React.useRef(false);
  React.useEffect(() => {
    if (injected.current) return;
    injected.current = true;
    const mod = parseModule(CORRUPT, "corrupt.bin", { forceType: type });
    addDump(mod, "Dumps tab");
  }, [addDump]);
  // Only mount the tab once the corrupt dump is actually in the store, so the
  // first render the tab sees already has the shared buffer.
  return loadedDumps.length > 0 ? child : null;
}

function wrapInjected(type, child) {
  return render(
    <MasterVinProvider setPg={() => {}}>
      <InjectAndRender type={type} child={child} />
    </MasterVinProvider>
  );
}

describe("Shared-state corrupt buffer — badged + blocked in inspectors", () => {
  it("BcmTab badges a corrupt loadedDumps buffer and hides the field panels", async () => {
    const { container } = wrapInjected("BCM", <BcmTab />);
    await waitFor(
      () => expect(container.querySelector('[data-testid="bcm-corrupt-fill-banner"]')).toBeTruthy(),
      { timeout: 3000 }
    );
    expect(screen.getByText(/Corrupt capture/i)).toBeTruthy();
    assertNoIdentityCard();
  });

  it("RfhubTab badges a corrupt loadedDumps buffer and hides the field panels", async () => {
    const { container } = wrapInjected("RFHUB", <RfhubTab />);
    await waitFor(
      () => expect(container.querySelector('[data-testid="rfhub-corrupt-fill-banner"]')).toBeTruthy(),
      { timeout: 3000 }
    );
    expect(screen.getByText(/Corrupt capture/i)).toBeTruthy();
    assertNoIdentityCard();
  });

  it("Gpec2aTab badges a corrupt loadedDumps buffer and hides the analysis panels", async () => {
    const { container } = wrapInjected("GPEC2A", <Gpec2aTab />);
    await waitFor(
      () => expect(container.querySelector('[data-testid="gpec2a-corrupt-fill-banner-1"]')).toBeTruthy(),
      { timeout: 3000 }
    );
    expect(screen.getByText(/Corrupt capture/i)).toBeTruthy();
    // The GPEC2A analysis card must not have rendered off the corrupt buffer.
    expect(screen.queryByText(/GPEC2A Analysis/i)).toBeNull();
  });
});
