import { describe, it, expect } from "vitest";

describe("GCP Swarm URL connectivity", () => {
  it("should reach the GCP swarm server with the correct secret", async () => {
    const gcpUrl = process.env.GCP_SWARM_URL || "http://35.237.198.125:3001";
    const secret = process.env.SWARM_DELEGATE_SECRET || "srt-swarm-delegate-2026";
    const res = await fetch(`${gcpUrl}/api/health`, {
      headers: { "x-swarm-secret": secret },
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(200);
  });
});
