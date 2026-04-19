/* UI test for the DTC plain-English overlay (Task #143).
 *
 * Mounts the same DtcDetailPanel that UdsTab and AdcmTab render
 * for each DTC, using react-dom/server.renderToString so we can
 * stay in vitest's "node" environment (no jsdom needed).
 *
 * Covers the acceptance criteria from the task:
 *   - a known mock UDS response decodes into human-readable text
 *   - an unknown code renders the "(unknown)" fallback
 *   - status-byte decoding picks up "test failed", "pending",
 *     and "confirmed" bits in the rendered output
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  parseDtcResponse,
  buildDtcDetail,
  formatDtcLogLine,
} from "../dtc.js";
import DtcDetailPanel from "../DtcDetailPanel.jsx";

/* End-to-end fixture: the bytes the bridge engine would hand back
 * for a 0x19 0x02 0x08 request — SID echo, sub-fn, avail-mask,
 * then two DTCs with realistic status bytes. */
const FIXTURE_RESPONSE = new Uint8Array([
  0x59, 0x02, 0x08,
  0x03, 0x01, 0x00, 0x09,    /* P0301 + FTB 00, test-failed + confirmed */
  0xc1, 0x40, 0x00, 0x04,    /* U0140 + FTB 00, pending                 */
]);

const FAULT_TABLE = {
  P0301: "Cylinder 1 misfire detected",
};

describe("DTC overlay end-to-end (parse → buildDetail → render)", () => {
  const entries = parseDtcResponse(FIXTURE_RESPONSE);
  const known = buildDtcDetail(entries[0], { tx: 0x7e0, rx: 0x7e8 }, FAULT_TABLE);
  const unknown = buildDtcDetail(entries[1], { tx: 0x7e0, rx: 0x7e8 }, FAULT_TABLE);

  it("parses two DTCs from the fixture response", () => {
    expect(entries).toHaveLength(2);
    expect(entries[0].code).toBe("P030100");
    expect(entries[1].code).toBe("U014000");
  });

  it("renders the description text for a known code", () => {
    const html = renderToString(<DtcDetailPanel detail={known} />);
    expect(html).toContain("P030100");
    expect(html).toContain("Cylinder 1 misfire detected");
    /* Module CAN ID surfaces in the panel. */
    expect(html).toContain("TX 0x7E0");
    expect(html).toContain("RX 0x7E8");
    /* Copy-code button is present and uses the testid contract. */
    expect(html).toContain('data-testid="uds-dtc-copy"');
  });

  it("renders the (unknown) fallback when the fault table has no entry", () => {
    const html = renderToString(<DtcDetailPanel detail={unknown} />);
    expect(html).toContain("U014000");
    /* The exact fallback string the panel emits — pinned so a
       silent rewording later trips this test. */
    expect(html).toContain("no description in fault table");
  });

  it("highlights the test-failed, confirmed, and pending status bits", () => {
    /* known entry has 0x09 = test-failed + confirmed.
       unknown entry has 0x04 = pending. */
    const knownHtml = renderToString(<DtcDetailPanel detail={known} />);
    const unknownHtml = renderToString(<DtcDetailPanel detail={unknown} />);

    /* The "■" filled marker is rendered next to active bits and
       gets the green color #00E676. The "□" marker is rendered
       next to inactive bits in #555. We assert by looking at the
       per-bit testid + the marker character. */
    const isOn = (html, key) => {
      const m = html.match(new RegExp('data-testid="uds-dtc-bit-' + key + '"[^>]*>([^<]*)<'));
      return m ? m[1].trim().startsWith("■") : false;
    };

    expect(isOn(knownHtml, "testFailed")).toBe(true);
    expect(isOn(knownHtml, "confirmed")).toBe(true);
    expect(isOn(knownHtml, "pending")).toBe(false);

    expect(isOn(unknownHtml, "pending")).toBe(true);
    expect(isOn(unknownHtml, "confirmed")).toBe(false);
    expect(isOn(unknownHtml, "testFailed")).toBe(false);

    /* Status bytes also surface in the panel header. */
    expect(knownHtml).toContain("0x09");
    expect(unknownHtml).toContain("0x04");
  });

  it("the log-line formatter shipped to the same surfaces matches", () => {
    /* Belt-and-braces: the string AdcmTab and UdsTab push into
       their log views also includes the description for known
       codes and falls back gracefully for unknown codes. */
    const knownLine = formatDtcLogLine(entries[0], FAULT_TABLE);
    expect(knownLine).toContain("Cylinder 1 misfire detected");
    expect(knownLine).toContain("confirmed");

    const unknownLine = formatDtcLogLine(entries[1], FAULT_TABLE);
    expect(unknownLine).toContain("(unknown)");
    expect(unknownLine).toContain("pending");
  });
});
