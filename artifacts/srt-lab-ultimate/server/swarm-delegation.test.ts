/**
 * Vitest integration tests for the GCP swarm delegation endpoint.
 * Tests that:
 *  1. GCP_SWARM_URL and SWARM_DELEGATE_SECRET env vars are set
 *  2. The /api/run-swarm-delegated endpoint on GCP accepts valid requests
 *  3. The endpoint rejects requests with wrong secret
 */
import { describe, it, expect } from "vitest";

const GCP_URL = process.env.GCP_SWARM_URL || "http://35.237.198.125:3001";
const SWARM_SECRET = process.env.SWARM_DELEGATE_SECRET || "";
const BASE_URL = "http://localhost:3000";

describe("GCP Swarm Delegation", () => {
  it("GCP_SWARM_URL env var is set", () => {
    expect(process.env.GCP_SWARM_URL).toBeTruthy();
    expect(process.env.GCP_SWARM_URL).toContain("35.237.198.125");
  });

  it("SWARM_DELEGATE_SECRET env var is set", () => {
    expect(process.env.SWARM_DELEGATE_SECRET).toBeTruthy();
    expect((process.env.SWARM_DELEGATE_SECRET || "").length).toBeGreaterThan(8);
  });

  it("delegation endpoint accepts valid request with correct secret", async () => {
    const res = await fetch(`${GCP_URL}/api/run-swarm-delegated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-swarm-secret": SWARM_SECRET,
      },
      body: JSON.stringify({
        analysisId: `test-${Date.now()}`,
        s3Key: "test/nonexistent-key.bin",
        filename: "test.bin",
        fileSize: 100,
        binaryId: "test-binary-id",
        userId: "test-user-id",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    // Should accept the job immediately (200) even if the swarm will fail in background
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.analysisId).toBeTruthy();
  });

  it("delegation endpoint rejects requests with wrong secret", async () => {
    const res = await fetch(`${GCP_URL}/api/run-swarm-delegated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-swarm-secret": "wrong-secret-12345",
      },
      body: JSON.stringify({
        analysisId: "test-reject",
        s3Key: "test/key",
        filename: "test.bin",
        fileSize: 100,
        binaryId: "bin",
        userId: "user",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(401);
  });

  it("delegation endpoint rejects requests with missing required fields", async () => {
    const res = await fetch(`${GCP_URL}/api/run-swarm-delegated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-swarm-secret": SWARM_SECRET,
      },
      body: JSON.stringify({ analysisId: "test-missing" }), // missing s3Key, filename
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(400);
  });
});
