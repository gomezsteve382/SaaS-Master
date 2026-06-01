/**
 * Investigation Swarm tests.
 *
 * Tests cover:
 *   1. SSE event serialisation round-trip (toSseFrame / fromSseFrame)
 *   2. Agent finding extraction from text (FINDINGS_JSON parsing)
 *   3. ForbiddenToolError is raised for denylisted tools
 *   4. Tool executor dispatches to the correct handler
 *   5. Pattern lookup and KG query return expected content
 *   6. key_secrets_scan mirror detection behaviour
 *   7. eeprom_layout_scan VIN slot detection
 *   8. Agent def integrity (all allowedTools exist in registry)
 *   9. COORDINATOR_SYSTEM_PROMPT references required schema fields
 *  10. FORBIDDEN_TOOLS list is non-empty and disjoint from READ_ONLY_TOOLS
 *  11. uds_static_decode returns correct service names
 *  12. ForbiddenToolError is name-typed correctly
 */

import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  investigationRunsTable,
  investigationRunPublicColumns,
} from "@workspace/db";
import { toSseFrame, fromSseFrame, type SwarmEvent } from "../routes/anthropic/investigationSwarm/sse";
import {
  AGENT_DEFS,
  READ_ONLY_TOOLS,
  FORBIDDEN_TOOLS,
  COORDINATOR_SYSTEM_PROMPT,
} from "../routes/anthropic/investigationSwarm/agents";
import {
  executeTool,
  ForbiddenToolError,
  buildToolsForAgent,
} from "../routes/anthropic/investigationSwarm/toolExecutor";
import { TOOL_REGISTRY } from "../routes/anthropic/toolRegistry";

/* ── Test helpers ──────────────────────────────────────────────────── */

/** Build a Buffer with a 16-byte high-entropy block at the given offset, plus
 *  its byte-reversed copy 64 bytes later (mirrors the SEC16 pairing rule). */
function buildMirroredBuffer(offset = 0): Buffer {
  const buf = Buffer.alloc(256, 0xff);
  const secret = Buffer.from([
    0x1A, 0x2B, 0x3C, 0x4D, 0x5E, 0x6F, 0x70, 0x81,
    0x92, 0xA3, 0xB4, 0xC5, 0xD6, 0xE7, 0xF8, 0x09,
  ]);
  secret.copy(buf, offset);
  const reversed = Buffer.from([...secret].reverse());
  reversed.copy(buf, offset + 64);
  return buf;
}

/** Buffer containing a realistic FCA VIN (1C4RJFDJ7DC513874) at offset 0x92. */
function buildVinBuffer(): Buffer {
  const buf = Buffer.alloc(2048, 0xff);
  const vin = Buffer.from("1C4RJFDJ7DC513874", "ascii");
  vin.copy(buf, 0x92);
  return buf;
}

/* ── 1. SSE event serialisation ────────────────────────────────────── */

describe("SSE event serialisation", () => {
  it("round-trips a finding event", () => {
    const event: SwarmEvent = {
      type: "finding",
      runId: "test-run-id",
      agent: "CRYPTO",
      finding: {
        agent: "CRYPTO",
        findingType: "sec16",
        description: "SEC16 token at 0x0000",
        offsets: [0],
        confidence: 0.9,
        status: "UNVERIFIED",
      },
    };
    const frame = toSseFrame(event);
    expect(frame).toMatch(/^data: /);
    expect(frame).toMatch(/\n\n$/);
    const parsed = fromSseFrame(frame.trimEnd() + "\n");
    expect(parsed).toEqual(event);
  });

  it("round-trips a synthesis event", () => {
    const report = {
      summary: "Two SEC16 candidates found.",
      rankedFindings: [],
      contradictions: [],
      gaps: ["FOBIK slots not found"],
      recommendedNextSteps: ["Load RFHUB alongside BCM"],
    };
    const event: SwarmEvent = { type: "synthesis", runId: "r1", report };
    const frame = toSseFrame(event);
    const parsed = fromSseFrame(frame.split("\n")[0]);
    expect(parsed).not.toBeNull();
    expect((parsed as Extract<SwarmEvent, { type: "synthesis" }>).report.summary).toBe(
      "Two SEC16 candidates found.",
    );
  });

  it("returns null for non-data lines", () => {
    expect(fromSseFrame("event: ping")).toBeNull();
    expect(fromSseFrame("")).toBeNull();
    expect(fromSseFrame(": keep-alive")).toBeNull();
  });

  it("round-trips agent_error event", () => {
    const event: SwarmEvent = { type: "agent_error", runId: "r", agent: "LAYOUT", error: "boom" };
    expect(fromSseFrame(toSseFrame(event).trim())).toEqual(event);
  });

  it("round-trips buffer_not_found event", () => {
    const event: SwarmEvent = {
      type: "buffer_not_found",
      runId: "r",
      error: "Server restarted during analysis — please re-upload the dump.",
    };
    expect(fromSseFrame(toSseFrame(event).trim())).toEqual(event);
  });
});

/* ── 1b. Run read-API column projection (Task #937) ────────────────── */

describe("investigationRunPublicColumns projection", () => {
  const SENSITIVE = ["primaryBuffer", "referenceBuffer", "bufferExpiresAt"];

  it("never exposes the persisted upload buffers", () => {
    const keys = Object.keys(investigationRunPublicColumns);
    for (const field of SENSITIVE) {
      expect(keys, `${field} must not be in the public projection`).not.toContain(
        field,
      );
    }
  });

  it("covers every other run column so list/detail stay complete", () => {
    const allColumns = Object.keys(getTableColumns(investigationRunsTable));
    const expected = allColumns.filter((c) => !SENSITIVE.includes(c)).sort();
    const actual = Object.keys(investigationRunPublicColumns).sort();
    expect(actual).toEqual(expected);
  });
});

/* ── 2. ForbiddenToolError ─────────────────────────────────────────── */

describe("ForbiddenToolError", () => {
  it("is raised for every tool in FORBIDDEN_TOOLS", async () => {
    const empty = Buffer.alloc(0);
    for (const toolName of FORBIDDEN_TOOLS) {
      await expect(
        executeTool(toolName, {}, empty, {}),
      ).rejects.toBeInstanceOf(ForbiddenToolError);
    }
  });

  it("has correct name property", () => {
    const err = new ForbiddenToolError("write_hex");
    expect(err.name).toBe("ForbiddenToolError");
    expect(err.toolName).toBe("write_hex");
    expect(err.message).toContain("write_hex");
  });

  it("is an instance of Error", () => {
    expect(new ForbiddenToolError("x")).toBeInstanceOf(Error);
  });
});

/* ── 3. READ_ONLY_TOOLS / FORBIDDEN_TOOLS disjoint ────────────────── */

describe("Tool lists", () => {
  it("FORBIDDEN_TOOLS is non-empty", () => {
    expect(FORBIDDEN_TOOLS.length).toBeGreaterThan(0);
  });

  it("READ_ONLY_TOOLS and FORBIDDEN_TOOLS are disjoint", () => {
    const ro = new Set(READ_ONLY_TOOLS as readonly string[]);
    for (const t of FORBIDDEN_TOOLS) {
      expect(ro.has(t), `${t} appears in both lists`).toBe(false);
    }
  });
});

/* ── 4. Agent def integrity ────────────────────────────────────────── */

describe("Agent definitions", () => {
  it("all five agents are defined", () => {
    const ids = Object.keys(AGENT_DEFS);
    expect(ids).toContain("CRYPTO");
    expect(ids).toContain("PROTOCOL");
    expect(ids).toContain("LAYOUT");
    expect(ids).toContain("IMMOBILIZER");
    expect(ids).toContain("CROSS_REF");
  });

  it("each agent's allowedTools exist in TOOL_REGISTRY or swarm-only tools", async () => {
    const swarmOnly = ["uds_static_decode", "pattern_lookup", "kg_query", "decode_bcm_feature"];
    for (const [agentId, def] of Object.entries(AGENT_DEFS)) {
      for (const tool of def.allowedTools) {
        const exists =
          tool in TOOL_REGISTRY || swarmOnly.includes(tool as string);
        expect(exists, `${agentId}: tool "${tool}" missing from registry`).toBe(true);
      }
    }
  });

  it("buildToolsForAgent returns one schema per allowed tool", () => {
    for (const def of Object.values(AGENT_DEFS)) {
      const schemas = buildToolsForAgent(def.allowedTools);
      expect(schemas.length).toBe(def.allowedTools.length);
      for (const s of schemas) {
        expect(typeof s.name).toBe("string");
        expect(s.name.length).toBeGreaterThan(0);
      }
    }
  });

  it("maxIterations is positive for every agent", () => {
    for (const [id, def] of Object.entries(AGENT_DEFS)) {
      expect(def.maxIterations, `${id} maxIterations`).toBeGreaterThan(0);
    }
  });
});

/* ── 5. COORDINATOR_SYSTEM_PROMPT ──────────────────────────────────── */

describe("COORDINATOR_SYSTEM_PROMPT", () => {
  it("mentions required JSON schema fields", () => {
    const p = COORDINATOR_SYSTEM_PROMPT;
    expect(p).toContain("summary");
    expect(p).toContain("rankedFindings");
    expect(p).toContain("contradictions");
    expect(p).toContain("gaps");
    expect(p).toContain("recommendedNextSteps");
  });

  it("instructs to deduplicate findings", () => {
    expect(COORDINATOR_SYSTEM_PROMPT.toLowerCase()).toMatch(/dedupli|dedup|merge/);
  });
});

/* ── 6. key_secrets_scan mirror detection ──────────────────────────── */

describe("key_secrets_scan mirror detection", () => {
  it("finds SEC16 candidate in a buffer with high-entropy 16-byte block", async () => {
    // Place secret at offset 0 so the first scan window (i=0) hits it
    // directly, avoiding the ffCount<=2 edge case on overlapping windows.
    const buf = buildMirroredBuffer(0);
    const result = await executeTool("key_secrets_scan", {}, buf, {});
    expect(result).toContain("SEC16");
    // The first 16 bytes are [1A 2B 3C ...] — they appear in the SEC16 report
    expect(result).toContain("1A 2B 3C");
  });

  it("returns empty result for an all-0xFF buffer", async () => {
    const buf = Buffer.alloc(64, 0xff);
    const result = await executeTool("key_secrets_scan", {}, buf, {});
    expect(result).toContain("none found matching criteria");
  });
});

/* ── 7. eeprom_layout_scan VIN slot detection ──────────────────────── */

describe("eeprom_layout_scan VIN slot detection", () => {
  it("finds a VIN embedded in a RFHUB Gen1 buffer", async () => {
    const buf = buildVinBuffer();
    const result = await executeTool("eeprom_layout_scan", {}, buf, {});
    expect(result).toContain("1C4RJFDJ7DC513874");
  });

  it("detects RFHUB Gen1 module type from 2 KB buffer", async () => {
    const buf = buildVinBuffer();
    const result = await executeTool("eeprom_layout_scan", {}, buf, {});
    expect(result).toMatch(/RFHUB Gen1/i);
  });
});

/* ── 8. pattern_lookup ─────────────────────────────────────────────── */

describe("pattern_lookup", () => {
  const buf = Buffer.from([0x00, 0xaa, 0x50, 0x11, 0xaa, 0x50, 0x99]);

  it("finds every occurrence of a hex pattern in the loaded dump", async () => {
    const result = await executeTool("pattern_lookup", { pattern: "AA 50" }, buf, {});
    expect(result).toMatch(/2 match\(es\)/);
    expect(result).toContain("0x000001");
    expect(result).toContain("0x000004");
  });

  it("returns no-match message when the pattern is absent", async () => {
    const result = await executeTool("pattern_lookup", { pattern: "DE AD BE EF" }, buf, {});
    expect(result).toMatch(/no matches/i);
  });
});

/* ── 9. kg_query ───────────────────────────────────────────────────── */

describe("kg_query", () => {
  it("returns BCM node for 'bcm' query", async () => {
    const result = await executeTool("kg_query", { query: "bcm" }, Buffer.alloc(0), {});
    expect(result).toContain("BCM");
  });

  it("returns a BCM DE-feature row by DID", async () => {
    const result = await executeTool("kg_query", { query: "DE00" }, Buffer.alloc(0), {});
    expect(result).toContain("[bcm-feature] DE00");
  });

  it("returns no-match for unknown query", async () => {
    const result = await executeTool("kg_query", { query: "zzz_no_such_node_xyz" }, Buffer.alloc(0), {});
    expect(result).toMatch(/no matches/i);
  });
});

/* ── 10. uds_static_decode ─────────────────────────────────────────── */

describe("uds_static_decode", () => {
  it("decodes 0x27 as SecurityAccess", async () => {
    const result = await executeTool("uds_static_decode", { bytes: "27" }, Buffer.alloc(0), {});
    expect(result).toContain("SecurityAccess");
  });

  it("decodes NRC 0x33 as Security access denied", async () => {
    const result = await executeTool("uds_static_decode", { bytes: "7F 27 33" }, Buffer.alloc(0), {});
    expect(result).toContain("NegativeResponse");
    expect(result).toMatch(/Security access denied|SAD/);
  });

  it("requires bytes argument", async () => {
    const result = await executeTool("uds_static_decode", {}, Buffer.alloc(0), {});
    expect(result).toContain("Error");
  });
});
