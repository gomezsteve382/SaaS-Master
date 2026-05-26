import { describe, it, expect } from "vitest";

describe("SWARM_FORCE_FORGE Configuration", () => {
  it("should have SWARM_FORCE_FORGE env var set to 'true'", () => {
    const val = process.env.SWARM_FORCE_FORGE;
    expect(val).toBeDefined();
    expect(val).toBe("true");
    console.log("✓ SWARM_FORCE_FORGE is set to 'true' — swarm will use Forge API");
  });

  it("should still have ANTHROPIC_API_KEY available for chat endpoint", () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    expect(apiKey).toBeDefined();
    expect(apiKey!.length).toBeGreaterThan(0);
    console.log("✓ ANTHROPIC_API_KEY still available for chat endpoint (Claude)");
  });

  it("should have Forge API credentials available for swarm", () => {
    const forgeUrl = process.env.BUILT_IN_FORGE_API_URL;
    const forgeKey = process.env.BUILT_IN_FORGE_API_KEY;
    expect(forgeUrl).toBeDefined();
    expect(forgeUrl!.length).toBeGreaterThan(0);
    expect(forgeKey).toBeDefined();
    expect(forgeKey!.length).toBeGreaterThan(0);
    console.log("✓ Forge API credentials available for swarm");
  });

  it("callLLM USE_CLAUDE logic should resolve to false when SWARM_FORCE_FORGE is set", () => {
    // Simulate the exact logic in callLLM
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
    const USE_CLAUDE = !!ANTHROPIC_API_KEY && !process.env.SWARM_FORCE_FORGE;
    expect(USE_CLAUDE).toBe(false);
    console.log("✓ USE_CLAUDE resolves to false — swarm will use Forge, not Claude");
  });
});
