// Route tests for the AI Co-pilot's general-chat endpoint.
//
// Exercises POST /api/anthropic/general-chat:
//   • 503 when the Anthropic integration is unconfigured (mod.anthropic null)
//   • 400 when the messages array is missing / not an array
//   • 400 when the first message isn't from the user
//   • 200 text/event-stream with `data: {content}` deltas + terminal
//     `data: {done:true}` when Anthropic is wired up
//   • a mid-stream throw is surfaced to the client as a `data: {error}` frame
//
// The route does `await import("@workspace/integrations-anthropic-ai")` and
// reads `mod.anthropic`, so we mock that module with a controllable impl —
// mirroring how sessions.test.ts mocks @workspace/db.

import express, { type Express, type Request } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Controllable Anthropic stub. Tests flip `anthropicImpl` to null (unconfigured)
// or to a fake client whose messages.stream() returns an async iterable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let anthropicImpl: any = null;

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  get anthropic() {
    return anthropicImpl;
  },
}));

const routerModule = await import("../routes/anthropic/generalChat");
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

// Build a fake Anthropic client whose .messages.stream() yields the given
// text deltas (interleaved with a non-text event that must be ignored) as an
// async iterable. Records whether abort() was called.
function fakeAnthropic(textChunks: string[]) {
  const state = { aborted: false };
  return {
    state,
    messages: {
      stream() {
        return {
          abort() {
            state.aborted = true;
          },
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
          abort() {},
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

beforeEach(() => {
  anthropicImpl = null;
});

describe("POST /api/anthropic/general-chat — unconfigured", () => {
  it("returns 503 with an error when the integration is not configured", async () => {
    anthropicImpl = null;
    const r = await request(makeApp())
      .post("/api/anthropic/general-chat")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/unavailable/i);
  });
});

describe("POST /api/anthropic/general-chat — validation", () => {
  beforeEach(() => {
    anthropicImpl = fakeAnthropic(["should not stream"]);
  });

  it("rejects a missing messages array with 400", async () => {
    const r = await request(makeApp())
      .post("/api/anthropic/general-chat")
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/messages/i);
  });

  it("rejects a non-array messages field with 400", async () => {
    const r = await request(makeApp())
      .post("/api/anthropic/general-chat")
      .send({ messages: "not an array" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/messages/i);
  });

  it("rejects when the first message isn't from the user with 400", async () => {
    const r = await request(makeApp())
      .post("/api/anthropic/general-chat")
      .send({ messages: [{ role: "assistant", content: "hello" }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/first message/i);
  });

  it("rejects an empty messages array with 400", async () => {
    const r = await request(makeApp())
      .post("/api/anthropic/general-chat")
      .send({ messages: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/first message/i);
  });
});

describe("POST /api/anthropic/general-chat — streaming", () => {
  it("emits SSE content deltas and a terminal done frame", async () => {
    anthropicImpl = fakeAnthropic(["Hello ", "world"]);
    const r = await request(makeApp())
      .post("/api/anthropic/general-chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/event-stream/);

    const frames = parseSseFrames(r.text);
    // Non-text events (message_start) must NOT produce a frame.
    const contents = frames
      .filter((f) => typeof f.content === "string")
      .map((f) => f.content);
    expect(contents).toEqual(["Hello ", "world"]);
    // Terminal done frame closes the stream.
    expect(frames.at(-1)).toEqual({ done: true });
  });

  it("surfaces a mid-stream failure as a data:{error} frame", async () => {
    anthropicImpl = throwingAnthropic("partial ", "model exploded");
    const r = await request(makeApp())
      .post("/api/anthropic/general-chat")
      .send({ messages: [{ role: "user", content: "hi" }] });

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
