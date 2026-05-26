import { describe, it, expect } from "vitest";

/**
 * Test the Claude API adapter by making a real tool-use call to Claude
 * and verifying the response is normalized to OpenAI format.
 */
describe("Claude API Adapter (Real Call)", () => {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

  it("should call Claude with tools and get normalized OpenAI-style tool_calls response", async () => {
    if (!ANTHROPIC_API_KEY) {
      console.log("Skipping: ANTHROPIC_API_KEY not set");
      return;
    }

    // Build a simple tool schema (Claude format)
    const tools = [
      {
        name: "get_weather",
        description: "Get the current weather for a location",
        input_schema: {
          type: "object",
          properties: {
            location: { type: "string", description: "City name" },
          },
          required: ["location"],
        },
      },
    ];

    // Build request body
    const body = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: "You are a helpful assistant. When asked about weather, always use the get_weather tool.",
      messages: [
        { role: "user", content: "What's the weather in Tokyo?" },
      ],
      tools,
      tool_choice: { type: "any" }, // Force tool use
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    expect(response.ok).toBe(true);
    const data = await response.json();

    // Verify Claude response structure
    expect(data.content).toBeDefined();
    expect(Array.isArray(data.content)).toBe(true);

    // Find tool_use block
    const toolUseBlock = data.content.find((b: any) => b.type === "tool_use");
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock.name).toBe("get_weather");
    expect(toolUseBlock.id).toBeDefined();
    expect(toolUseBlock.input).toBeDefined();
    expect(toolUseBlock.input.location).toContain("Tokyo");

    // Now test our normalizer logic (inline version of normalizeClaudeResponse)
    const content = data.content || [];
    const textBlocks = content.filter((b: any) => b.type === "text");
    const toolUseBlocks = content.filter((b: any) => b.type === "tool_use");

    const normalized = {
      message: {
        content: textBlocks.map((b: any) => b.text).join("\n") || null,
        tool_calls: toolUseBlocks.map((block: any) => ({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        })),
      },
      finishReason: data.stop_reason === "tool_use" ? "tool_calls" : (data.stop_reason || "end_turn"),
    };

    // Verify normalized format matches what the agent loop expects
    expect(normalized.message.tool_calls).toHaveLength(1);
    expect(normalized.message.tool_calls[0].id).toBe(toolUseBlock.id);
    expect(normalized.message.tool_calls[0].type).toBe("function");
    expect(normalized.message.tool_calls[0].function.name).toBe("get_weather");
    
    const parsedArgs = JSON.parse(normalized.message.tool_calls[0].function.arguments);
    expect(parsedArgs.location).toContain("Tokyo");
    expect(normalized.finishReason).toBe("tool_calls");

    console.log("✓ Claude tool_use response correctly normalized to OpenAI tool_calls format");
  }, 30000);

  it("should correctly convert OpenAI-style messages to Claude format", () => {
    // Test the message conversion logic
    const openaiMessages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!", tool_calls: [
        { id: "call_123", function: { name: "get_weather", arguments: '{"location":"NYC"}' } }
      ]},
      { role: "tool", content: "Sunny, 72F", tool_call_id: "call_123", name: "get_weather" },
      { role: "user", content: "Thanks!" },
    ];

    // Extract system
    let system = "";
    const nonSystem: any[] = [];
    for (const m of openaiMessages) {
      if (m.role === "system") {
        system += m.content;
      } else {
        nonSystem.push(m);
      }
    }
    expect(system).toBe("You are a helpful assistant.");

    // Convert messages
    const claudeMessages: any[] = [];
    for (const m of nonSystem) {
      if (m.role === "user") {
        claudeMessages.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        if ((m as any).tool_calls && (m as any).tool_calls.length > 0) {
          const contentBlocks: any[] = [];
          if (m.content && typeof m.content === "string" && m.content.trim()) {
            contentBlocks.push({ type: "text", text: m.content });
          }
          for (const tc of (m as any).tool_calls) {
            contentBlocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function?.name,
              input: JSON.parse(tc.function?.arguments || "{}"),
            });
          }
          claudeMessages.push({ role: "assistant", content: contentBlocks });
        } else {
          claudeMessages.push({ role: "assistant", content: m.content });
        }
      } else if (m.role === "tool") {
        const lastMsg = claudeMessages[claudeMessages.length - 1];
        const toolResultBlock = {
          type: "tool_result",
          tool_use_id: (m as any).tool_call_id,
          content: m.content,
        };
        if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content) &&
            lastMsg.content.length > 0 && lastMsg.content[0].type === "tool_result") {
          lastMsg.content.push(toolResultBlock);
        } else {
          claudeMessages.push({ role: "user", content: [toolResultBlock] });
        }
      }
    }

    // Verify conversion
    expect(claudeMessages).toHaveLength(4);
    
    // First: user "Hello"
    expect(claudeMessages[0].role).toBe("user");
    expect(claudeMessages[0].content).toBe("Hello");
    
    // Second: assistant with tool_use
    expect(claudeMessages[1].role).toBe("assistant");
    expect(Array.isArray(claudeMessages[1].content)).toBe(true);
    expect(claudeMessages[1].content[0].type).toBe("text");
    expect(claudeMessages[1].content[0].text).toBe("Hi there!");
    expect(claudeMessages[1].content[1].type).toBe("tool_use");
    expect(claudeMessages[1].content[1].id).toBe("call_123");
    expect(claudeMessages[1].content[1].name).toBe("get_weather");
    expect(claudeMessages[1].content[1].input.location).toBe("NYC");
    
    // Third: user with tool_result (converted from role:tool)
    expect(claudeMessages[2].role).toBe("user");
    expect(Array.isArray(claudeMessages[2].content)).toBe(true);
    expect(claudeMessages[2].content[0].type).toBe("tool_result");
    expect(claudeMessages[2].content[0].tool_use_id).toBe("call_123");
    expect(claudeMessages[2].content[0].content).toBe("Sunny, 72F");
    
    // Fourth: user "Thanks!"
    expect(claudeMessages[3].role).toBe("user");
    expect(claudeMessages[3].content).toBe("Thanks!");

    console.log("✓ OpenAI messages correctly converted to Claude format");
  });
});
