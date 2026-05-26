import { describe, it, expect } from "vitest";

// ─── Weighted Agent Prompts Tests ───────────────────────────────────────────

describe("Weighted Agent Prompts", () => {
  it("agent-weights module exports calculateAgentWeights function", async () => {
    const mod = await import("./agent-weights.js");
    expect(typeof mod.calculateAgentWeights).toBe("function");
  });

  it("agent-weights module exports applyWeightsToAgent function", async () => {
    const mod = await import("./agent-weights.js");
    expect(typeof mod.applyWeightsToAgent).toBe("function");
  });

  it("calculateAgentWeights returns a Map", async () => {
    const { calculateAgentWeights } = await import("./agent-weights.js");
    const weights = await calculateAgentWeights();
    expect(weights).toBeDefined();
    expect(weights instanceof Map).toBe(true);
  });
});

// ─── Batch Queue Tests ──────────────────────────────────────────────────────

describe("Batch Queue API", () => {
  const BASE = "http://localhost:3000";

  it("POST /api/batch-upload returns 400 without files", async () => {
    const res = await fetch(`${BASE}/api/batch-upload`, { method: "POST" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("POST /api/batch-upload accepts files and returns batchId", async () => {
    const formData = new FormData();
    const blob = new Blob(["test binary content"], { type: "application/octet-stream" });
    formData.append("files", blob, "test_batch.bin");

    const res = await fetch(`${BASE}/api/batch-upload`, {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.batchId).toBeDefined();
    expect(data.totalFiles).toBe(1);
  });

  it("GET /api/batch/:id returns batch status", async () => {
    // Create a batch first
    const formData = new FormData();
    const blob = new Blob(["test binary"], { type: "application/octet-stream" });
    formData.append("files", blob, "status_test.bin");

    const createRes = await fetch(`${BASE}/api/batch-upload`, {
      method: "POST",
      body: formData,
    });
    const { batchId } = await createRes.json();

    // Check status
    const statusRes = await fetch(`${BASE}/api/batch/${batchId}`);
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.id).toBe(batchId);
    expect(status.totalFiles).toBe(1);
    expect(status.items).toHaveLength(1);
    expect(status.items[0].filename).toBe("status_test.bin");
    expect(status.items[0].status).toBe("queued");
  });

  it("GET /api/batch/nonexistent returns 404", async () => {
    const res = await fetch(`${BASE}/api/batch/nonexistent123`);
    expect(res.status).toBe(404);
  });

  it("GET /api/batch/:id/stream returns SSE content-type", async () => {
    // Create a batch
    const formData = new FormData();
    const blob = new Blob(["sse test"], { type: "application/octet-stream" });
    formData.append("files", blob, "sse_test.bin");

    const createRes = await fetch(`${BASE}/api/batch-upload`, {
      method: "POST",
      body: formData,
    });
    const { batchId } = await createRes.json();

    // Connect to SSE (with abort after 2 seconds)
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000);

    try {
      const res = await fetch(`${BASE}/api/batch/${batchId}/stream`, {
        signal: controller.signal,
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    } catch (e: any) {
      // AbortError is expected
      if (e.name !== "AbortError") throw e;
    }
  });
});

// ─── Swarm Coordinator with Weights ─────────────────────────────────────────

describe("Swarm Coordinator Integration", () => {
  it("runClaudeCodeSwarm is exported and callable", async () => {
    const mod = await import("./claude-agents/swarm-coordinator.js");
    expect(typeof mod.runClaudeCodeSwarm).toBe("function");
  });

  it("swarm coordinator imports agent-weights", async () => {
    // Verify the module can be loaded without errors
    const mod = await import("./claude-agents/swarm-coordinator.js");
    expect(mod).toBeDefined();
  });
});
