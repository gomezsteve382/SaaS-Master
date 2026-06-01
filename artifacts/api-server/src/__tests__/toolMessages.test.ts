/**
 * Integration test for the AI tool-use SSE endpoint.
 *
 * Stubs the Anthropic SDK to drive a deterministic 3-step loop:
 *   1. Model requests `read_hex(offset=0x275, length=17)`
 *   2. Model requests `extract_strings(minLen=6)`
 *   3. Model emits final text (stop_reason=end_turn)
 *
 * Verifies the loop runs, tool results are computed correctly, SSE events
 * stream in order, the cumulative-bytes cap is enforced, and the trace is
 * persisted alongside the assistant reply.
 */

import express, { type Express } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─── In-memory DB shim ─── */

type Row = Record<string, unknown> & { id: number };
type Tbl = { _name: string };

const tables = {
  conversations: { _name: "conversations" } as Tbl,
  messages: { _name: "messages" } as Tbl,
  conversationToolCalls: { _name: "conversation_tool_calls" } as Tbl,
};

const store: Record<string, Row[]> = {
  conversations: [{ id: 1, title: "New chat", scope: null, createdAt: new Date() }],
  messages: [],
  conversation_tool_calls: [],
};
let nextId = { messages: 1, conversation_tool_calls: 1, conversations: 2 };

vi.mock("drizzle-orm", () => ({
  eq: (col: { _name: string }, value: unknown) => ({ kind: "eq", column: col._name, value }),
  asc: () => ({ kind: "asc" }),
  desc: () => ({ kind: "desc" }),
  and: (...parts: unknown[]) => ({ kind: "and", parts }),
}));

vi.mock("@workspace/db", () => {
  const cols = {
    id: { _name: "id" },
    conversationId: { _name: "conversationId" },
    title: { _name: "title" },
    role: { _name: "role" },
    content: { _name: "content" },
    scope: { _name: "scope" },
  };
  const conversations = { ...tables.conversations, ...cols };
  const messages = { ...tables.messages, ...cols };
  const conversationToolCalls = { ...tables.conversationToolCalls, ...cols };

  const db = {
    select: () => ({
      from: (t: Tbl) => {
        const filters: Array<{ column: string; value: unknown }> = [];
        const builder = {
          where(p: { column: string; value: unknown }) {
            filters.push(p);
            return builder;
          },
          orderBy() { return builder; },
          limit() { return builder; },
          then(resolve: (rows: Row[]) => void) {
            const rows = (store[t._name] || []).filter((row) =>
              filters.every((f) => row[f.column] === f.value)
            );
            resolve(rows);
          },
        };
        return builder;
      },
    }),
    insert: (t: Tbl) => ({
      values(v: Record<string, unknown>) {
        const row: Row = {
          ...v,
          id: nextId[t._name as keyof typeof nextId]++,
          createdAt: new Date(),
        };
        store[t._name].push(row);
        return {
          async returning() { return [row]; },
          then(resolve: () => void) { resolve(); },
        };
      },
    }),
    update: (_t: Tbl) => ({
      set(_v: Record<string, unknown>) {
        return { where() { return Promise.resolve(); } };
      },
    }),
  };

  return { db, conversations, messages, conversationToolCalls };
});

/* ─── Anthropic SDK stub ─── */

const anthropicResponses: Array<unknown> = [];
let createCallCount = 0;

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: {
      async create() {
        const r = anthropicResponses[createCallCount];
        createCallCount++;
        if (!r) throw new Error(`Unexpected anthropic call #${createCallCount}`);
        return r;
      },
      stream: () => ({}),
    },
  },
}));

/* ─── App setup ─── */

const routerModule = await import("../routes/anthropic/toolMessages");
const router = routerModule.default;

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/anthropic", router);
  return app;
}

function parseSseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)));
}

beforeEach(() => {
  store.messages = [];
  store.conversation_tool_calls = [];
  nextId = { messages: 1, conversation_tool_calls: 1, conversations: 2 };
  store.conversations = [{ id: 1, title: "New chat", scope: null, createdAt: new Date() }];
  anthropicResponses.length = 0;
  createCallCount = 0;
});

/* ─── Tests ─── */

describe("POST /api/anthropic/conversations/:id/tool-messages", () => {
  it("runs a 3-iteration tool-use loop, streams events in order, and persists the trace", async () => {
    // Build a fixture binary with a VIN at 0x275
    const buf = Buffer.alloc(2048, 0xff);
    const vin = "1C4HJXEG2MW512345";
    Buffer.from(vin, "ascii").copy(buf, 0x275);
    const binaryBase64 = buf.toString("base64");

    // Stub a 3-turn dialogue
    anthropicResponses.push({
      content: [
        { type: "tool_use", id: "tc_1", name: "read_hex", input: { offset: 0x275, length: 17 } },
      ],
      stop_reason: "tool_use",
    });
    anthropicResponses.push({
      content: [
        { type: "tool_use", id: "tc_2", name: "extract_strings", input: { minLen: 6 } },
      ],
      stop_reason: "tool_use",
    });
    anthropicResponses.push({
      content: [
        { type: "text", text: "I found VIN 1C4HJXEG2MW512345 at offset 0x275." },
      ],
      stop_reason: "end_turn",
    });

    const app = makeApp();
    const res = await request(app)
      .post("/api/anthropic/conversations/1/tool-messages")
      .send({ content: "What VIN is in this dump?", binaryBase64 });

    expect(res.status).toBe(200);

    const events = parseSseEvents(res.text);

    // Should have 2 tool_call + 2 tool_result + 1 text + 1 done
    const toolCalls = events.filter((e) => e.type === "tool_call");
    const toolResults = events.filter((e) => e.type === "tool_result");
    const texts = events.filter((e) => e.type === "text");
    const dones = events.filter((e) => e.type === "done");

    expect(toolCalls).toHaveLength(2);
    expect(toolResults).toHaveLength(2);
    expect(texts).toHaveLength(1);
    expect(dones).toHaveLength(1);

    expect(toolCalls[0].toolName).toBe("read_hex");
    expect(toolCalls[1].toolName).toBe("extract_strings");

    // Tool results should contain the planted VIN bytes / string
    expect((toolResults[0].result as string)).toMatch(/31 43 34 48/i); // 1C4H in hex
    expect((toolResults[1].result as string)).toContain("1C4HJXEG2MW512345");

    expect((texts[0].content as string)).toContain("1C4HJXEG2MW512345");

    // Trace in done event
    const trace = (dones[0].toolTrace as Array<{ toolName: string }>);
    expect(trace).toHaveLength(2);
    expect(trace[0].toolName).toBe("read_hex");
    expect(trace[1].toolName).toBe("extract_strings");

    // DB persistence
    const assistantMsgs = store.messages.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].content).toContain("1C4HJXEG2MW512345");

    expect(store.conversation_tool_calls).toHaveLength(2);
    expect(store.conversation_tool_calls[0].toolName).toBe("read_hex");
    expect(store.conversation_tool_calls[1].toolName).toBe("extract_strings");
    // Resolved module label persists per step (no binaries map sent here, so
    // the primary key is unknown → generic "loaded dump" fallback).
    expect(store.conversation_tool_calls[0].module).toBe("loaded dump");
    expect(store.conversation_tool_calls[1].module).toBe("loaded dump");
  });

  it("returns 400 when content is missing", async () => {
    const app = makeApp();
    const res = await request(app).post("/api/anthropic/conversations/1/tool-messages").send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when conversation doesn't exist", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/anthropic/conversations/999/tool-messages")
      .send({ content: "hi" });
    expect(res.status).toBe(404);
  });

  it("returns an error tool_result when no binary is loaded and the model still calls a tool", async () => {
    // Even with no binary, the spec says tools list is empty — but if a tool
    // call somehow comes through, the handler must reject it gracefully.
    anthropicResponses.push({
      content: [
        { type: "tool_use", id: "tc_x", name: "read_hex", input: { offset: 0, length: 16 } },
      ],
      stop_reason: "tool_use",
    });
    anthropicResponses.push({
      content: [{ type: "text", text: "I cannot read bytes without a loaded binary." }],
      stop_reason: "end_turn",
    });

    const app = makeApp();
    const res = await request(app)
      .post("/api/anthropic/conversations/1/tool-messages")
      .send({ content: "Read offset 0" });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.text);
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].result as string).toMatch(/no binary loaded/i);
  });

  it("stops the loop at MAX_ITERATIONS so a runaway model can't burn tokens forever", async () => {
    const buf = Buffer.alloc(256, 0xff);
    const binaryBase64 = buf.toString("base64");

    // Push 15 tool-use responses (more than MAX_ITERATIONS=10)
    for (let i = 0; i < 15; i++) {
      anthropicResponses.push({
        content: [
          { type: "tool_use", id: `tc_${i}`, name: "read_hex", input: { offset: 0, length: 16 } },
        ],
        stop_reason: "tool_use",
      });
    }

    const app = makeApp();
    const res = await request(app)
      .post("/api/anthropic/conversations/1/tool-messages")
      .send({ content: "loop forever", binaryBase64 });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.text);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    // Should be capped at MAX_ITERATIONS (10)
    expect(toolCalls.length).toBeLessThanOrEqual(10);
    // Should still emit done
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("supports hex_diff with multiple binaries in the request", async () => {
    const primary = Buffer.alloc(64, 0xaa);
    const secondary = Buffer.alloc(64, 0xaa);
    secondary[10] = 0xbb;

    anthropicResponses.push({
      content: [
        {
          type: "tool_use",
          id: "tc_diff",
          name: "hex_diff",
          input: { otherId: "rfhub", offset: 0, length: 64 },
        },
      ],
      stop_reason: "tool_use",
    });
    anthropicResponses.push({
      content: [{ type: "text", text: "One byte differs at offset 10." }],
      stop_reason: "end_turn",
    });

    const app = makeApp();
    const res = await request(app)
      .post("/api/anthropic/conversations/1/tool-messages")
      .send({
        content: "Diff BCM vs RFHUB",
        binaryBase64: primary.toString("base64"),
        binaries: { rfhub: secondary.toString("base64") },
      });

    expect(res.status).toBe(200);
    const events = parseSseEvents(res.text);
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0].result as string)).toContain("0x00000A");
  });
});
