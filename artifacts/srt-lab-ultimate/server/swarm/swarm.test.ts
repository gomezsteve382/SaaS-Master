import { describe, it, expect } from "vitest";
import {
  SPECIALIST_AGENTS,
  ALL_AGENTS,
  getAgentById,
  VENOM_SYSTEM_PROMPT,
} from "./agents.js";
import type { SwarmAgent } from "./agents.js";
import type { SwarmEvent } from "./coordinator.js";

// ─── Agent Definitions ─────────────────────────────────────────────────────

describe("Swarm Agent Definitions", () => {
  it("should have exactly 5 specialist agents", () => {
    expect(SPECIALIST_AGENTS).toHaveLength(5);
  });

  it("should have exactly 6 total agents (5 specialists + VENOM)", () => {
    expect(ALL_AGENTS).toHaveLength(6);
  });

  it("should include all expected agent codenames", () => {
    const codenames = ALL_AGENTS.map((a) => a.codename);
    expect(codenames).toContain("GHOST");
    expect(codenames).toContain("PHANTOM");
    expect(codenames).toContain("SPECTER");
    expect(codenames).toContain("WRAITH");
    expect(codenames).toContain("SHADE");
    expect(codenames).toContain("VENOM");
  });

  it("should have unique IDs for all agents", () => {
    const ids = ALL_AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("should have unique codenames for all agents", () => {
    const codenames = ALL_AGENTS.map((a) => a.codename);
    expect(new Set(codenames).size).toBe(codenames.length);
  });

  it("each specialist should have at least 1 tool", () => {
    for (const agent of SPECIALIST_AGENTS) {
      expect(agent.toolNames.length).toBeGreaterThan(0);
    }
  });

  it("VENOM should have no tools (synthesizer only)", () => {
    const venom = ALL_AGENTS.find((a) => a.id === "venom");
    expect(venom).toBeDefined();
    expect(venom!.toolNames).toHaveLength(0);
  });

  it("each agent should have a non-empty system prompt", () => {
    for (const agent of ALL_AGENTS) {
      expect(agent.systemPrompt.length).toBeGreaterThan(50);
    }
  });

  it("each agent should have a color and icon for UI", () => {
    for (const agent of ALL_AGENTS) {
      expect(agent.color).toBeTruthy();
      expect(agent.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(agent.icon).toBeTruthy();
    }
  });

  it("each specialist should have maxIterations > 0", () => {
    for (const agent of SPECIALIST_AGENTS) {
      expect(agent.maxIterations).toBeGreaterThan(0);
    }
  });

  it("each agent should have a specialty description", () => {
    for (const agent of ALL_AGENTS) {
      expect(agent.specialty.length).toBeGreaterThan(5);
    }
  });

  it("each agent should have years of experience >= 30", () => {
    for (const agent of ALL_AGENTS) {
      expect(agent.yearsExp).toBeGreaterThanOrEqual(30);
    }
  });
});

// ─── Agent Lookup ───────────────────────────────────────────────────────────

describe("getAgentById", () => {
  it("should find GHOST by id", () => {
    const ghost = getAgentById("ghost");
    expect(ghost).toBeDefined();
    expect(ghost!.codename).toBe("GHOST");
  });

  it("should find VENOM by id", () => {
    const venom = getAgentById("venom");
    expect(venom).toBeDefined();
    expect(venom!.codename).toBe("VENOM");
  });

  it("should return undefined for unknown id", () => {
    expect(getAgentById("nonexistent")).toBeUndefined();
  });
});

// ─── VENOM System Prompt ────────────────────────────────────────────────────

describe("VENOM System Prompt", () => {
  it("should reference all specialist codenames", () => {
    expect(VENOM_SYSTEM_PROMPT).toContain("GHOST");
    expect(VENOM_SYSTEM_PROMPT).toContain("PHANTOM");
    expect(VENOM_SYSTEM_PROMPT).toContain("SPECTER");
    expect(VENOM_SYSTEM_PROMPT).toContain("WRAITH");
    expect(VENOM_SYSTEM_PROMPT).toContain("SHADE");
  });

  it("should mention synthesis/cross-reference", () => {
    const lower = VENOM_SYSTEM_PROMPT.toLowerCase();
    const hasSynthesis = lower.includes("synth") || lower.includes("cross-reference") || lower.includes("merge");
    expect(hasSynthesis).toBe(true);
  });
});

// ─── SwarmEvent Type Check ──────────────────────────────────────────────────

describe("SwarmEvent type", () => {
  it("should accept valid agent_start event", () => {
    const event: SwarmEvent = {
      type: "agent_start",
      agentId: "ghost",
      codename: "GHOST",
      message: "GHOST deploying",
    };
    expect(event.type).toBe("agent_start");
  });

  it("should accept valid swarm_complete event", () => {
    const event: SwarmEvent = {
      type: "swarm_complete",
      totalToolCalls: 42,
      durationMs: 30000,
      message: "Swarm complete",
    };
    expect(event.type).toBe("swarm_complete");
  });

  it("should accept valid agent_tool_end event with all fields", () => {
    const event: SwarmEvent = {
      type: "agent_tool_end",
      agentId: "phantom",
      codename: "PHANTOM",
      iteration: 3,
      toolName: "read_hex",
      args: { offset: 0 },
      result: "some hex data",
      durationMs: 150,
    };
    expect(event.toolName).toBe("read_hex");
    expect(event.durationMs).toBe(150);
  });
});

// ─── Agent Tool Subsets ─────────────────────────────────────────────────────

describe("Agent tool subsets", () => {
  const VALID_TOOLS = [
    "file_identify",
    "read_hex",
    "extract_strings",
    "pe_info",
    "elf_info",
    "disassemble",
    "pyinstaller_extract",
    "search_patterns",
    "eeprom_layout_parse",
    // Extended tools used by specialist agents
    "archive_extract",
    "checksum_brute",
    "crc_verify",
    "scan_key_material",
    "base64_blob_finder",
    "binary_slice",
    "find_references",
    "struct_unpack",
    "srec_ihex_parse",
    "pe_exports_deep",
    "section_permissions",
    "import_xref",
    "string_xref",
    "pe_overlay",
    "dll_dependency_tree",
    "resource_extractor",
    "hex_diff",
    // SWF analysis tool
    "swf_extract",
  ];

  it("each specialist should only reference valid tools", () => {
    for (const agent of SPECIALIST_AGENTS) {
      for (const toolName of agent.toolNames) {
        expect(VALID_TOOLS).toContain(toolName);
      }
    }
  });

  it("GHOST should have crypto-relevant tools", () => {
    const ghost = getAgentById("ghost")!;
    expect(ghost.toolNames).toContain("search_patterns");
    expect(ghost.toolNames).toContain("extract_strings");
  });

  it("PHANTOM should have protocol-relevant tools", () => {
    const phantom = getAgentById("phantom")!;
    expect(phantom.toolNames).toContain("search_patterns");
    expect(phantom.toolNames).toContain("extract_strings");
  });

  it("SPECTER should have decompilation tools", () => {
    const specter = getAgentById("specter")!;
    expect(specter.toolNames).toContain("pyinstaller_extract");
    expect(specter.toolNames).toContain("disassemble");
  });
});
