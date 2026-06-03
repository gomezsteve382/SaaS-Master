// Route tests for the Key Program tab's "read Key ID from photo" endpoint.
//
// Exercises POST /api/anthropic/key-photo:
//   • 503 when the Anthropic integration is unconfigured (mod.anthropic null)
//   • 400 when imageBase64 or a supported mediaType is missing
//   • 200 with a normalized { keyId, found, candidates, notes } when the model
//     returns strict JSON, including hex normalization + candidate de-duping
//   • found=false / empty keyId when the model can't read an ID
//   • a thrown model error is surfaced as a 500 JSON body
//
// The route does `await import("@workspace/integrations-anthropic-ai")` and
// reads `mod.anthropic`, so we mock that module with a controllable impl —
// mirroring moduleAssistant.test.ts.

import express, { type Express, type Request } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let anthropicImpl: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastCreateParams: any = null;

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  get anthropic() {
    return anthropicImpl;
  },
}));

const routerModule = await import("../routes/anthropic/keyPhoto");
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

// A fake Anthropic client whose messages.create() returns a single text block
// with the given body. Captures call params in lastCreateParams.
function fakeAnthropic(text: string) {
  return {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create(params: any) {
        lastCreateParams = params;
        return Promise.resolve({ content: [{ type: "text", text }] });
      },
    },
  };
}

function throwingAnthropic(message: string) {
  return {
    messages: {
      create() {
        return Promise.reject(new Error(message));
      },
    },
  };
}

const PNG_DATA_URL = "data:image/png;base64,AAAA";

beforeEach(() => {
  anthropicImpl = null;
  lastCreateParams = null;
});

describe("POST /api/anthropic/key-photo — unconfigured", () => {
  it("returns 503 when the integration is not configured", async () => {
    anthropicImpl = null;
    const r = await request(makeApp())
      .post("/api/anthropic/key-photo")
      .send({ imageBase64: PNG_DATA_URL, mediaType: "image/png" });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/unavailable/i);
  });
});

describe("POST /api/anthropic/key-photo — validation", () => {
  beforeEach(() => {
    anthropicImpl = fakeAnthropic('{"keyId":"BCD2EB9B","found":true}');
  });

  it("rejects a missing image with 400", async () => {
    const r = await request(makeApp())
      .post("/api/anthropic/key-photo")
      .send({ mediaType: "image/png" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/imageBase64/i);
  });

  it("rejects an unsupported mediaType with 400", async () => {
    const r = await request(makeApp())
      .post("/api/anthropic/key-photo")
      .send({ imageBase64: PNG_DATA_URL, mediaType: "application/pdf" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/mediaType/i);
  });
});

describe("POST /api/anthropic/key-photo — extraction", () => {
  it("normalizes the Key ID and strips the data: URL prefix before sending", async () => {
    anthropicImpl = fakeAnthropic(
      'Here you go: {"keyId":"bc d2-eb9b","found":true,"candidates":["0x11223344","BCD2EB9B"],"notes":"clear readout"}',
    );
    const r = await request(makeApp())
      .post("/api/anthropic/key-photo")
      .send({ imageBase64: PNG_DATA_URL, mediaType: "image/png" });

    expect(r.status).toBe(200);
    expect(r.body.keyId).toBe("BCD2EB9B");
    expect(r.body.found).toBe(true);
    // candidate equal to keyId is dropped; the other is normalized.
    expect(r.body.candidates).toEqual(["11223344"]);
    expect(r.body.notes).toBe("clear readout");

    // The base64 was sent without the data: prefix, with the right media type.
    const block = lastCreateParams.messages[0].content.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (b: any) => b.type === "image",
    );
    expect(block.source.data).toBe("AAAA");
    expect(block.source.media_type).toBe("image/png");
  });

  it("reports found=false and empty keyId when nothing is readable", async () => {
    anthropicImpl = fakeAnthropic('{"keyId":"","found":false,"notes":"too blurry"}');
    const r = await request(makeApp())
      .post("/api/anthropic/key-photo")
      .send({ imageBase64: PNG_DATA_URL, mediaType: "image/png" });

    expect(r.status).toBe(200);
    expect(r.body.keyId).toBe("");
    expect(r.body.found).toBe(false);
    expect(r.body.notes).toBe("too blurry");
  });

  it("drops a Key ID that is not exactly 8 hex chars", async () => {
    anthropicImpl = fakeAnthropic('{"keyId":"BCD2EB","found":true}');
    const r = await request(makeApp())
      .post("/api/anthropic/key-photo")
      .send({ imageBase64: PNG_DATA_URL, mediaType: "image/png" });

    expect(r.status).toBe(200);
    expect(r.body.keyId).toBe("");
    expect(r.body.found).toBe(false);
  });

  it("extracts the first valid JSON object from noisy multi-brace output", async () => {
    anthropicImpl = fakeAnthropic(
      'Thinking {about it}. ```json\n{"keyId":"DEADBEEF","found":true}\n``` and {trailing junk}',
    );
    const r = await request(makeApp())
      .post("/api/anthropic/key-photo")
      .send({ imageBase64: PNG_DATA_URL, mediaType: "image/png" });

    expect(r.status).toBe(200);
    expect(r.body.keyId).toBe("DEADBEEF");
    expect(r.body.found).toBe(true);
  });

  it("rejects an oversize image with 413", async () => {
    anthropicImpl = fakeAnthropic('{"keyId":"BCD2EB9B","found":true}');
    const huge = "data:image/png;base64," + "A".repeat(10 * 1024 * 1024 + 1);
    const r = await request(makeApp())
      .post("/api/anthropic/key-photo")
      .send({ imageBase64: huge, mediaType: "image/png" });
    // Either the route's own size cap or Express's JSON body limit rejects it.
    expect(r.status).toBe(413);
  });

  it("returns empty when no JSON object is present", async () => {
    anthropicImpl = fakeAnthropic("Sorry, I cannot read this image at all.");
    const r = await request(makeApp())
      .post("/api/anthropic/key-photo")
      .send({ imageBase64: PNG_DATA_URL, mediaType: "image/png" });
    expect(r.status).toBe(200);
    expect(r.body.keyId).toBe("");
    expect(r.body.found).toBe(false);
  });

  it("surfaces a model error as a 500 JSON body", async () => {
    anthropicImpl = throwingAnthropic("vision model exploded");
    const r = await request(makeApp())
      .post("/api/anthropic/key-photo")
      .send({ imageBase64: PNG_DATA_URL, mediaType: "image/png" });

    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/vision model exploded/);
  });
});
