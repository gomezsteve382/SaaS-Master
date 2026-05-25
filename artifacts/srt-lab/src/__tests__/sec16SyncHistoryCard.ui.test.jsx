// @vitest-environment jsdom
//
// Task #685 — UI smoke for the SEC16 sync history card.
//
// Locks the behaviour the task spec calls out:
//   1. With a valid VIN in master context, the card fetches the
//      VIN-filtered endpoint by default and shows actionId, target,
//      verified status, operator, and a relative timestamp.
//   2. Unchecking "Filter to current VIN" re-fetches against the
//      unfiltered endpoint.
//   3. The pure relativeTime helper produces stable, human-readable
//      output without mocking Date.

import React from "react";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { act, fireEvent, render, screen, cleanup, waitFor, within } from "@testing-library/react";

import Sec16SyncHistoryCard, { relativeTime } from "../components/Sec16SyncHistoryCard.jsx";
import { MasterVinContext } from "../lib/masterVinContext.jsx";

const VIN = "1C3CDXBT5HH123456";

function ctxValue(vin) {
  return {
    vin: vin || "",
    setVin: () => {},
    vinValid: !!vin && vin.length === 17,
    moduleStatus: { BCM: "pending", RFHUB: "pending", ECM: "pending", ADCM: "pending" },
    setModuleStatus: () => {}, updateStatus: () => {}, resetStatus: () => {},
    setPg: () => {},
    loadedDumps: [],
    addDump: () => null, replaceDump: () => null, removeDump: () => {},
    clearDumps: () => {}, getDumpsByType: () => [],
    jobId: null, setJobId: () => {}, hydrateFromJob: () => {},
  };
}

function jsonOk(body) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("relativeTime", () => {
  const now = Date.parse("2026-05-25T12:00:00Z");
  it("formats seconds, minutes, hours, days", () => {
    expect(relativeTime("2026-05-25T11:59:58Z", now)).toBe("just now");
    expect(relativeTime("2026-05-25T11:59:30Z", now)).toBe("30s ago");
    expect(relativeTime("2026-05-25T11:48:00Z", now)).toBe("12m ago");
    expect(relativeTime("2026-05-25T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-05-22T12:00:00Z", now)).toBe("3d ago");
  });
  it("handles bad input", () => {
    expect(relativeTime(null, now)).toBe("—");
    expect(relativeTime("not-a-date", now)).toBe("—");
  });
});

describe("Sec16SyncHistoryCard", () => {
  it("renders VIN-filtered events with actionId, target, verified and operator", async () => {
    const events = [
      {
        id: 1, vin: VIN, platform: "lx-ld",
        actionId: "rfh-bcm-sec16-sync", target: "BCM",
        recipeId: null, verified: "match", operator: "JD",
        notes: null, detail: null,
        createdAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      },
    ];
    const fetchSpy = vi.fn(async () => jsonOk({ events }));
    globalThis.fetch = fetchSpy;

    await act(async () => {
      render(
        <MasterVinContext.Provider value={ctxValue(VIN)}>
          <Sec16SyncHistoryCard />
        </MasterVinContext.Provider>,
      );
    });

    await waitFor(() => expect(screen.queryByTestId("sec16-history-row")).not.toBeNull());

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sec16-sync-events?vin=" + encodeURIComponent(VIN),
      expect.objectContaining({ method: "GET" }),
    );

    const row = screen.getByTestId("sec16-history-row");
    expect(within(row).getByTestId("sec16-history-verified").textContent).toBe("MATCH");
    expect(within(row).getByTestId("sec16-history-target").textContent).toBe("BCM");
    expect(within(row).getByTestId("sec16-history-action").textContent).toBe("rfh-bcm-sec16-sync");
    expect(within(row).getByTestId("sec16-history-operator").textContent).toBe("JD");
    expect(within(row).getByTestId("sec16-history-time").textContent).toBe("12m ago");
  });

  it("re-fetches the unfiltered endpoint when the VIN filter is unchecked", async () => {
    const fetchSpy = vi.fn(async () => jsonOk({ events: [] }));
    globalThis.fetch = fetchSpy;

    await act(async () => {
      render(
        <MasterVinContext.Provider value={ctxValue(VIN)}>
          <Sec16SyncHistoryCard />
        </MasterVinContext.Provider>,
      );
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByTestId("sec16-history-filter-toggle"));
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    expect(fetchSpy.mock.calls[1][0]).toBe("/api/sec16-sync-events");
  });

  it("shows an empty-state hint when no events exist", async () => {
    globalThis.fetch = vi.fn(async () => jsonOk({ events: [] }));
    await act(async () => {
      render(
        <MasterVinContext.Provider value={ctxValue("")}>
          <Sec16SyncHistoryCard />
        </MasterVinContext.Provider>,
      );
    });
    await waitFor(() => {
      const empty = screen.getByTestId("sec16-history-empty");
      expect(empty.textContent).toMatch(/no sec16 sync events/i);
    });
  });
});
