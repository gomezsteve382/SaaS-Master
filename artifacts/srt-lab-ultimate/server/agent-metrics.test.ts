import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = "http://localhost:3000";

describe("Agent Metrics API", () => {
  const testAnalysisId = "test-metrics-" + Date.now();

  it("GET /api/metrics/:analysisId returns empty array for unknown ID", async () => {
    const res = await fetch(`${BASE_URL}/api/metrics/nonexistent-id-xyz`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  it("GET /api/metrics/:analysisId returns metrics for known analysis", async () => {
    const res = await fetch(`${BASE_URL}/api/metrics/JzAwd7Eakart`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(5);
    // Verify structure
    const metric = data[0];
    expect(metric).toHaveProperty("agentId");
    expect(metric).toHaveProperty("codename");
    expect(metric).toHaveProperty("specialty");
    expect(metric).toHaveProperty("durationMs");
    expect(metric).toHaveProperty("toolCallCount");
    expect(metric).toHaveProperty("iterations");
    expect(metric).toHaveProperty("findingsCount");
    expect(metric).toHaveProperty("accuracyScore");
  });

  it("GET /api/metrics/summary/all returns performance and accuracy", async () => {
    const res = await fetch(`${BASE_URL}/api/metrics/summary/all`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("performance");
    expect(data).toHaveProperty("accuracy");
    expect(Array.isArray(data.performance)).toBe(true);
    expect(data.performance.length).toBeGreaterThan(0);
    // Verify performance structure
    const perf = data.performance[0];
    expect(perf).toHaveProperty("agentId");
    expect(perf).toHaveProperty("codename");
    expect(perf).toHaveProperty("totalRuns");
    expect(perf).toHaveProperty("avgDurationMs");
    expect(perf).toHaveProperty("avgToolCalls");
    expect(perf).toHaveProperty("avgAccuracy");
  });
});

describe("Finding Ratings API", () => {
  const testAnalysisId = "test-rating-" + Date.now();

  it("POST /api/ratings validates required fields", async () => {
    const res = await fetch(`${BASE_URL}/api/ratings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisId: "test" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  it("POST /api/ratings saves a rating successfully", async () => {
    const res = await fetch(`${BASE_URL}/api/ratings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        analysisId: testAnalysisId,
        agentId: "ghost",
        findingIndex: 0,
        findingCategory: "algorithm",
        rating: "up",
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("GET /api/ratings/:analysisId retrieves saved ratings", async () => {
    const res = await fetch(`${BASE_URL}/api/ratings/${testAnalysisId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(1);
    expect(data[0].agentId).toBe("ghost");
    expect(data[0].rating).toBe("up");
    expect(data[0].findingCategory).toBe("algorithm");
  });

  it("POST /api/ratings upserts (replaces existing rating)", async () => {
    // Change rating from up to down
    const res = await fetch(`${BASE_URL}/api/ratings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        analysisId: testAnalysisId,
        agentId: "ghost",
        findingIndex: 0,
        findingCategory: "algorithm",
        rating: "down",
      }),
    });
    expect(res.status).toBe(200);

    // Verify it was replaced
    const getRes = await fetch(`${BASE_URL}/api/ratings/${testAnalysisId}`);
    const data = await getRes.json();
    expect(data.length).toBe(1);
    expect(data[0].rating).toBe("down");
  });

  it("GET /api/ratings/:analysisId returns empty for unknown ID", async () => {
    const res = await fetch(`${BASE_URL}/api/ratings/nonexistent-xyz`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });
});
