import { describe, it, expect } from "vitest";

describe("Claude API Key Validation", () => {
  it("should validate ANTHROPIC_API_KEY by calling Claude API", async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    expect(apiKey).toBeDefined();
    expect(apiKey).toMatch(/^sk-ant-/);

    // Make a simple API call to validate the key
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: "Say 'API key valid' in one word.",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBeDefined();
    expect(data.content.length).toBeGreaterThan(0);
    console.log("✓ Claude API key validated successfully");
  });
});
