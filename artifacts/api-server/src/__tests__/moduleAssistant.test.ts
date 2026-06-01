// Route tests for the Mismatch Wizard's module-specific AI assistant.
//
// Exercises POST /api/anthropic/module-assistant:
//   • 503 when the Anthropic integration is unconfigured (mod.anthropic null)
//   • 400 when messages or moduleContext is missing
//   • 400 when the first message isn't from the user (and on an empty array)
//   • 200 text/event-stream with `data: {content}` deltas + terminal
//     `data: {done:true}` when Anthropic is wired up, with the module
//     context fed into the system prompt
//   • a mid-stream throw is surfaced to the client as a `data: {error}` frame
//
// The route does `await import("@workspace/integrations-anthropic-ai")` and
// reads `mod.anthropic`, so we mock that module with a controllable impl —
// mirroring generalChat.test.ts exactly.

import express, { type Express, type Request } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Controllable Anthropic stub. Tests flip `anthropicImpl` to null (unconfigured)
// or to a fake client whose messages.stream() returns an async iterable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let anthropicImpl: any = null;

// Records the params passed to messages.stream() so we can assert the module
// context made it into the system prompt.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastStreamParams: any = null;

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  get anthropic() {
    return anthropicImpl;
  },
}));

const routerModule = await import("../routes/anthropic/moduleAssistant");
const router = routerModule.default;

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req: Request, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    };
    next();
  });
  app.use("/api/anthropic", router);
  return app;
}

// Build a fake Anthropic client whose .messages.stream() yields the given text
// deltas (interleaved with a non-text event that must be ignored) as an async
// iterable. Captures the call params in lastStreamParams.
function fakeAnthropic(textChunks: string[]) {
  return {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stream(params: any) {
        lastStreamParams = params;
        return {
          async *[Symbol.asyncIterator]() {
            // A non-text event the route must skip without emitting a frame.
            yield { type: "message_start" };
            for (const text of textChunks) {
              yield {
                type: "content_block_delta",
                delta: { type: "text_delta", text },
              };
            }
          },
        };
      },
    },
  };
}

// Build a client whose stream throws partway through, after emitting one delta,
// so the route's catch block writes a `data: {error}` frame on the open stream.
function throwingAnthropic(firstChunk: string, message: string) {
  return {
    messages: {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "content_block_delta",
              delta: { type: "text_delta", text: firstChunk },
            };
            throw new Error(message);
          },
        };
      },
    },
  };
}

function parseSseFrames(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
    .map((p) => JSON.parse(p));
}

const MODULE_CONTEXT = {
  modules: ["BCM", "RFHUB"],
  issues: ["SEC16 MISMATCH between BCM and RFHUB"],
  warnings: ["voltage low"],
  hexSnippets: ["AB CD EF"],
  wizard: {
    phase: "sync",
    currentStepIndex: 1,
    currentStepTitle: "Run SEC16 sync",
    totalSteps: 4,
    completedSteps: ["Load modules"],
    remainingSteps: ["Flash both"],
  },
};

beforeEach(() => {
  anthropicImpl = null;
  lastStreamParams = null;
});

describe("POST /api/anthropic/module-assistant — unconfigured", () => {
  it("returns 503 when the integration is not configured", async () => {
    anthropicImpl = null;
    const r = await request(makeApp())
      .post("/api/anthropic/module-assistant")
      .send({
        messages: [{ role: "user", content: "hi" }],
        moduleContext: MODULE_CONTEXT,
      });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/unavailable/i);
  });
});

describe("POST /api/anthropic/module-assistant — validation", () => {
  beforeEach(() => {
    anthropicImpl = fakeAnthropic(["should not stream"]);
  });

  it("rejects a missing messages array with 400", async () => {
    const r = await request(makeApp())
      .post("/api/anthropic/module-assistant")
      .send({ moduleContext: MODULE_CONTEXT });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/messages and moduleContext/i);
  });

  it("rejects a missing moduleContext with 400", async () => {
    const r = await request(makeApp())
      .post("/api/anthropic/module-assistant")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/messages and moduleContext/i);
  });

  it("rejects when the first message isn't from the user with 400", async () => {
    const r = await request(makeApp())
      .post("/api/anthropic/module-assistant")
      .send({
        messages: [{ role: "assistant", content: "hello" }],
        moduleContext: MODULE_CONTEXT,
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/first message/i);
  });

  it("rejects an empty messages array with 400", async () => {
    const r = await request(makeApp())
      .post("/api/anthropic/module-assistant")
      .send({ messages: [], moduleContext: MODULE_CONTEXT });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/first message/i);
  });
});

describe("POST /api/anthropic/module-assistant — streaming", () => {
  it("emits SSE content deltas and a terminal done frame", async () => {
    anthropicImpl = fakeAnthropic(["Check ", "the SEC16"]);
    const r = await request(makeApp())
      .post("/api/anthropic/module-assistant")
      .send({
        messages: [{ role: "user", content: "what's wrong?" }],
        moduleContext: MODULE_CONTEXT,
      });

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/event-stream/);

    const frames = parseSseFrames(r.text);
    const contents = frames
      .filter((f) => typeof f.content === "string")
      .map((f) => f.content);
    expect(contents).toEqual(["Check ", "the SEC16"]);
    expect(frames.at(-1)).toEqual({ done: true });
  });

  it("injects the module context into the system prompt", async () => {
    anthropicImpl = fakeAnthropic(["ok"]);
    await request(makeApp())
      .post("/api/anthropic/module-assistant")
      .send({
        messages: [{ role: "user", content: "diagnose" }],
        moduleContext: MODULE_CONTEXT,
      });

    expect(lastStreamParams).toBeTruthy();
    const system: string = lastStreamParams.system;
    // The SRT base prompt plus the rendered context block must both be present.
    expect(system).toMatch(/SRT Lab Module Assistant/);
    expect(system).toMatch(/Current Module Context/);
    expect(system).toMatch(/SEC16 MISMATCH between BCM and RFHUB/);
    expect(system).toMatch(/Run SEC16 sync/);
    // The chat messages are forwarded verbatim.
    expect(lastStreamParams.messages).toEqual([
      { role: "user", content: "diagnose" },
    ]);
  });

  it("surfaces a mid-stream failure as a data:{error} frame", async () => {
    anthropicImpl = throwingAnthropic("partial ", "model exploded");
    const r = await request(makeApp())
      .post("/api/anthropic/module-assistant")
      .send({
        messages: [{ role: "user", content: "hi" }],
        moduleContext: MODULE_CONTEXT,
      });

    // Headers were already sent before the throw, so the status is 200 and the
    // error rides the open SSE channel rather than a JSON body.
    expect(r.status).toBe(200);
    const frames = parseSseFrames(r.text);
    expect(frames.some((f) => f.content === "partial ")).toBe(true);
    const errFrame = frames.find((f) => typeof f.error === "string");
    expect(errFrame?.error).toMatch(/model exploded/);
    // No done frame after an error.
    expect(frames.some((f) => f.done === true)).toBe(false);
  });
});
