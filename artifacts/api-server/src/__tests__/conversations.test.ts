// Route tests for the persistent saved-conversations endpoints.
//
// Exercises the four surfaces behind the "saved chats" feature:
//   • POST   /api/anthropic/conversations            — create (201 + 400 no title)
//   • GET    /api/anthropic/conversations            — list (newest-first, scope filter)
//   • POST   /api/anthropic/conversations/:id/messages — SSE stream, with the
//       optional moduleContext body field feeding the SRT system prompt;
//       asserts content deltas + terminal done, message persistence, the
//       400 (no content) / 400 (bad id) / 404 (missing conv) paths, and a
//       mid-stream throw surfaced as a data:{error} frame
//   • DELETE /api/anthropic/conversations/:id        — 204 + 404
//
// conversations.ts imports `db` + tables from @workspace/db and `anthropic`
// from @workspace/integrations-anthropic-ai (both top-level static imports),
// plus drizzle-orm helpers. We mock all three: the db with a small multi-table
// in-memory shim (modeled on sessions.test.ts / keyHistory.test.ts) and a
// controllable Anthropic stub (modeled on generalChat.test.ts).

import express, { type Express, type Request } from "express";
import request from "supertest";
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── In-memory multi-table store ──────────────────────────────────────────
type Anyrow = Record<string, unknown>;
const stores: Record<string, Anyrow[]> = {
  conversations: [],
  messages: [],
  conversationToolCalls: [],
  patternLibrary: [],
};
const counters: Record<string, number> = {
  conversations: 0,
  messages: 0,
  conversationToolCalls: 0,
  patternLibrary: 0,
};
let seq = 0;

type Cond = {
  kind: string;
  column?: string;
  value?: unknown;
  conds?: Cond[];
};

function rowMatches(row: Anyrow, cond: Cond | undefined): boolean {
  if (!cond) return true;
  if (cond.kind === "eq") return row[cond.column as string] === cond.value;
  if (cond.kind === "ilike") {
    const v = row[cond.column as string];
    if (typeof v !== "string") return false;
    const needle = String(cond.value ?? "")
      .replace(/%/g, "")
      .toLowerCase();
    return v.toLowerCase().includes(needle);
  }
  if (cond.kind === "or") return (cond.conds ?? []).some((c) => rowMatches(row, c));
  return true;
}

// ── drizzle-orm mock ─────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: (col: { _name: string }, value: unknown): Cond => ({
    kind: "eq",
    column: col._name,
    value,
  }),
  asc: (col: { _name: string }): Cond => ({ kind: "asc", column: col._name }),
  desc: (col: { _name: string }): Cond => ({ kind: "desc", column: col._name }),
  or: (...conds: Cond[]): Cond => ({ kind: "or", conds }),
  ilike: (col: { _name: string }, value: unknown): Cond => ({
    kind: "ilike",
    column: col._name,
    value,
  }),
  sql: (..._args: unknown[]) => ({ kind: "sql" }),
}));

// ── @workspace/db mock ───────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const mkTable = (storeName: string, names: string[]) => {
    const t: Record<string, unknown> = { __store: storeName };
    for (const n of names) t[n] = { _name: n };
    return t;
  };
  const conversations = mkTable("conversations", [
    "id",
    "title",
    "scope",
    "createdAt",
  ]);
  const messages = mkTable("messages", [
    "id",
    "conversationId",
    "role",
    "content",
    "createdAt",
  ]);
  const conversationToolCalls = mkTable("conversationToolCalls", [
    "id",
    "conversationId",
    "messageId",
    "toolName",
    "toolArgs",
    "resultPreview",
    "bytesReturned",
    "durationMs",
    "createdAt",
  ]);
  const patternLibraryTable = mkTable("patternLibrary", [
    "id",
    "category",
    "label",
    "signatureBytes",
    "confidence",
    "sourceAnalysisIds",
    "notes",
  ]);

  const storeOf = (t: { __store: string }) => stores[t.__store];
  const bumpId = (t: { __store: string }) => ++counters[t.__store];

  const db = {
    select: () => ({
      from: (t: { __store: string }) => {
        const store = storeOf(t);
        const conds: Cond[] = [];
        let order: Cond | null = null;
        let lim = Infinity;
        const builder: {
          where: (c: Cond) => typeof builder;
          orderBy: (o: Cond) => typeof builder;
          limit: (n: number) => typeof builder;
          then: (
            resolve: (rows: Anyrow[]) => void,
            reject?: (e: unknown) => void,
          ) => void;
        } = {
          where(c) {
            conds.push(c);
            return builder;
          },
          orderBy(o) {
            order = o;
            return builder;
          },
          limit(n) {
            lim = n;
            return builder;
          },
          then(resolve, reject) {
            try {
              let rows = store.filter((r) => conds.every((c) => rowMatches(r, c)));
              if (order) {
                const col = order.column as string;
                const dir = order.kind === "desc" ? -1 : 1;
                rows = [...rows].sort((a, b) => {
                  const va = a[col];
                  const vb = b[col];
                  if (va instanceof Date && vb instanceof Date) {
                    return (va.getTime() - vb.getTime()) * dir;
                  }
                  if (typeof va === "number" && typeof vb === "number") {
                    return (va - vb) * dir;
                  }
                  return 0;
                });
              }
              resolve(rows.slice(0, lim));
            } catch (e) {
              reject?.(e);
            }
          },
        };
        return builder;
      },
    }),
    insert: (t: { __store: string }) => ({
      values(v: Anyrow) {
        const store = storeOf(t);
        const row: Anyrow = { ...v };
        if (row.id == null) row.id = bumpId(t);
        if (row.createdAt == null) row.createdAt = new Date(Date.now() + ++seq);
        store.push(row);
        return {
          returning() {
            return Promise.resolve([row]);
          },
          then(resolve: (v: unknown) => void) {
            resolve(undefined);
          },
        };
      },
    }),
    update: (t: { __store: string }) => ({
      set(vals: Anyrow) {
        return {
          where(c: Cond) {
            const store = storeOf(t);
            for (const r of store) if (rowMatches(r, c)) Object.assign(r, vals);
            return Promise.resolve();
          },
        };
      },
    }),
    delete: (t: { __store: string }) => ({
      where(c: Cond) {
        const store = storeOf(t);
        const removed: Anyrow[] = [];
        for (let i = store.length - 1; i >= 0; i--) {
          if (rowMatches(store[i]!, c)) {
            removed.unshift(store[i]!);
            store.splice(i, 1);
          }
        }
        return {
          returning() {
            return Promise.resolve(removed);
          },
          then(resolve: (v: unknown) => void) {
            resolve(removed);
          },
        };
      },
    }),
    execute: (_q: unknown) => Promise.resolve(),
  };

  return {
    db,
    conversations,
    messages,
    conversationToolCalls,
    patternLibraryTable,
  };
});

// ── Anthropic mock ───────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let anthropicImpl: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lastCreateParams: any = null;

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  get anthropic() {
    return anthropicImpl;
  },
}));

// A fake Anthropic client whose messages.create() returns a single text block,
// matching the route's non-streaming tool-loop usage. Captures call params.
function fakeAnthropic(text: string) {
  return {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (params: any) => {
        lastCreateParams = params;
        return { content: [{ type: "text", text }] };
      },
    },
  };
}

function throwingAnthropic(message: string) {
  return {
    messages: {
      create: async () => {
        throw new Error(message);
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

const routerModule = await import("../routes/anthropic/conversations");
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

async function createConversation(
  app: Express,
  body: Record<string, unknown>,
) {
  return request(app).post("/api/anthropic/conversations").send(body);
}

const MODULE_CONTEXT = {
  modules: ["BCM", "RFHUB"],
  issues: ["SEC16 MISMATCH between BCM and RFHUB"],
  warnings: [],
  hexSnippets: [],
  wizard: { totalSteps: 1, currentStepIndex: 0, completedSteps: [] },
};

beforeEach(() => {
  for (const k of Object.keys(stores)) stores[k]!.length = 0;
  for (const k of Object.keys(counters)) counters[k] = 0;
  seq = 0;
  anthropicImpl = null;
  lastCreateParams = null;
});

describe("POST /api/anthropic/conversations — create", () => {
  it("creates a conversation and returns 201 with an id", async () => {
    const r = await createConversation(makeApp(), {
      title: "Charger BCM sync",
      scope: "wizard:bcm",
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      id: 1,
      title: "Charger BCM sync",
      scope: "wizard:bcm",
    });
    expect(stores.conversations).toHaveLength(1);
  });

  it("defaults scope to null when omitted", async () => {
    const r = await createConversation(makeApp(), { title: "no scope" });
    expect(r.status).toBe(201);
    expect(r.body.scope).toBeNull();
  });

  it("rejects a missing title with 400", async () => {
    const r = await createConversation(makeApp(), { scope: "x" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/title/i);
    expect(stores.conversations).toHaveLength(0);
  });
});

describe("GET /api/anthropic/conversations — list", () => {
  it("returns conversations newest-first and filters by scope", async () => {
    const app = makeApp();
    await createConversation(app, { title: "first", scope: "a" });
    await createConversation(app, { title: "second", scope: "b" });
    await createConversation(app, { title: "third", scope: "a" });

    const all = await request(app).get("/api/anthropic/conversations");
    expect(all.status).toBe(200);
    expect(all.body.map((c: { title: string }) => c.title)).toEqual([
      "third",
      "second",
      "first",
    ]);

    const scoped = await request(app)
      .get("/api/anthropic/conversations")
      .query({ scope: "a" });
    expect(scoped.body.map((c: { title: string }) => c.title)).toEqual([
      "third",
      "first",
    ]);
  });
});

describe("POST /api/anthropic/conversations/:id/messages — streaming", () => {
  it("streams content + done, persists the assistant reply, and accepts moduleContext", async () => {
    anthropicImpl = fakeAnthropic("Run the SEC16 sync next.");
    const app = makeApp();
    const created = await createConversation(app, {
      title: "New chat",
      scope: "wizard:bcm",
    });
    const id = created.body.id;

    const r = await request(app)
      .post(`/api/anthropic/conversations/${id}/messages`)
      .send({ content: "what's wrong?", moduleContext: MODULE_CONTEXT });

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/event-stream/);
    const frames = parseSseFrames(r.text);
    const contents = frames
      .filter((f) => typeof f.content === "string")
      .map((f) => f.content);
    expect(contents).toEqual(["Run the SEC16 sync next."]);
    expect(frames.at(-1)).toEqual({ done: true });

    // The module context fed the system prompt.
    expect(lastCreateParams.system).toMatch(/Current Module Context/);
    expect(lastCreateParams.system).toMatch(
      /SEC16 MISMATCH between BCM and RFHUB/,
    );

    // Both the user message and the assistant reply were persisted in order.
    const msgs = await request(app).get(
      `/api/anthropic/conversations/${id}/messages`,
    );
    expect(
      msgs.body.map((m: { role: string; content: string }) => [
        m.role,
        m.content,
      ]),
    ).toEqual([
      ["user", "what's wrong?"],
      ["assistant", "Run the SEC16 sync next."],
    ]);
  });

  it("auto-titles a placeholder conversation from the first user message", async () => {
    anthropicImpl = fakeAnthropic("ack");
    const app = makeApp();
    const created = await createConversation(app, {
      title: "New chat",
      scope: "wizard:bcm",
    });
    const id = created.body.id;

    await request(app)
      .post(`/api/anthropic/conversations/${id}/messages`)
      .send({ content: "BCM won't accept the VIN" });

    const list = await request(app).get("/api/anthropic/conversations");
    expect(list.body[0].title).toBe("[wizard:bcm] BCM won't accept the VIN");
  });

  it("returns 400 when content is missing", async () => {
    anthropicImpl = fakeAnthropic("x");
    const app = makeApp();
    const created = await createConversation(app, { title: "t" });
    const r = await request(app)
      .post(`/api/anthropic/conversations/${created.body.id}/messages`)
      .send({ moduleContext: MODULE_CONTEXT });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/content/i);
  });

  it("returns 400 for a non-numeric conversation id", async () => {
    anthropicImpl = fakeAnthropic("x");
    const r = await request(makeApp())
      .post("/api/anthropic/conversations/not-a-number/messages")
      .send({ content: "hi" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid id/i);
  });

  it("returns 404 for a missing conversation", async () => {
    anthropicImpl = fakeAnthropic("x");
    const r = await request(makeApp())
      .post("/api/anthropic/conversations/9999/messages")
      .send({ content: "hi" });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/i);
  });

  it("surfaces a mid-stream failure as a data:{error} frame", async () => {
    anthropicImpl = throwingAnthropic("model exploded");
    const app = makeApp();
    const created = await createConversation(app, { title: "t" });
    const r = await request(app)
      .post(`/api/anthropic/conversations/${created.body.id}/messages`)
      .send({ content: "hi" });

    expect(r.status).toBe(200);
    const frames = parseSseFrames(r.text);
    const errFrame = frames.find((f) => typeof f.error === "string");
    expect(errFrame?.error).toMatch(/model exploded/);
    expect(frames.some((f) => f.done === true)).toBe(false);
  });
});

describe("GET /api/anthropic/conversations/:id — resume with tool traces", () => {
  // Seed helpers push straight into the in-memory stores so we can control
  // message ordering and the messageId → tool-call association the route's
  // trace join depends on (no API surface creates tool-call rows directly).
  function seedConversation(row: Anyrow): number {
    const id = (row.id as number | undefined) ?? ++counters.conversations;
    stores.conversations.push({
      createdAt: new Date(Date.now() + ++seq),
      ...row,
      id,
    });
    return id;
  }
  function seedMessage(row: Anyrow): number {
    const id = (row.id as number | undefined) ?? ++counters.messages;
    stores.messages.push({
      createdAt: new Date(Date.now() + ++seq),
      ...row,
      id,
    });
    return id;
  }
  function seedToolCall(row: Anyrow): number {
    const id = (row.id as number | undefined) ?? ++counters.conversationToolCalls;
    stores.conversationToolCalls.push({
      createdAt: new Date(Date.now() + ++seq),
      ...row,
      id,
    });
    return id;
  }

  it("returns 400 for a non-numeric id", async () => {
    const r = await request(makeApp()).get(
      "/api/anthropic/conversations/not-a-number",
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid id/i);
  });

  it("returns 404 for a missing conversation", async () => {
    const r = await request(makeApp()).get("/api/anthropic/conversations/9999");
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/i);
  });

  it("returns the conversation with messages in created order and tool traces on the right message", async () => {
    const convId = seedConversation({ title: "resume me", scope: "wizard:bcm" });

    // Seed messages out of insertion order to prove the route sorts by createdAt.
    const msg2 = seedMessage({
      conversationId: convId,
      role: "assistant",
      content: "second",
      createdAt: new Date(2000),
    });
    const msg1 = seedMessage({
      conversationId: convId,
      role: "user",
      content: "first",
      createdAt: new Date(1000),
    });

    // Two tool calls attached to the assistant message…
    seedToolCall({
      conversationId: convId,
      messageId: msg2,
      toolName: "pattern_library_lookup",
      toolArgs: JSON.stringify({ query: "SEC16" }),
      resultPreview: "Found 2 patterns",
      bytesReturned: 128,
      durationMs: 42,
      createdAt: new Date(3000),
    });
    seedToolCall({
      conversationId: convId,
      messageId: msg2,
      toolName: "pattern_library_lookup",
      toolArgs: JSON.stringify({ query: "VIN" }),
      resultPreview: "Found 1 pattern",
      bytesReturned: 64,
      durationMs: 17,
      createdAt: new Date(3500),
    });
    // …and one orphan with no messageId, which must be dropped.
    seedToolCall({
      conversationId: convId,
      messageId: null,
      toolName: "pattern_library_lookup",
      toolArgs: JSON.stringify({ query: "orphan" }),
      resultPreview: "mid-stream failure",
      bytesReturned: 0,
      durationMs: 5,
      createdAt: new Date(3700),
    });

    const r = await request(makeApp()).get(
      `/api/anthropic/conversations/${convId}`,
    );

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: convId,
      title: "resume me",
      scope: "wizard:bcm",
    });

    // Messages come back oldest-first regardless of insertion order.
    expect(
      r.body.messages.map((m: { id: number; content: string }) => [
        m.id,
        m.content,
      ]),
    ).toEqual([
      [msg1, "first"],
      [msg2, "second"],
    ]);

    // The user message carries no trace.
    const userMsg = r.body.messages.find(
      (m: { id: number }) => m.id === msg1,
    );
    expect(userMsg.toolTrace).toBeUndefined();

    // The assistant message carries both traces, in created order, with parsed args.
    const assistantMsg = r.body.messages.find(
      (m: { id: number }) => m.id === msg2,
    );
    expect(assistantMsg.toolTrace).toEqual([
      {
        toolName: "pattern_library_lookup",
        args: { query: "SEC16" },
        resultPreview: "Found 2 patterns",
        bytesReturned: 128,
        durationMs: 42,
      },
      {
        toolName: "pattern_library_lookup",
        args: { query: "VIN" },
        resultPreview: "Found 1 pattern",
        bytesReturned: 64,
        durationMs: 17,
      },
    ]);

    // The orphan tool call (messageId null) never surfaces.
    const allPreviews = r.body.messages
      .flatMap((m: { toolTrace?: Array<{ resultPreview: string }> }) =>
        m.toolTrace ?? [],
      )
      .map((t: { resultPreview: string }) => t.resultPreview);
    expect(allPreviews).not.toContain("mid-stream failure");
  });

  it("returns the conversation with an empty messages array when none exist", async () => {
    const convId = seedConversation({ title: "fresh", scope: null });
    const r = await request(makeApp()).get(
      `/api/anthropic/conversations/${convId}`,
    );
    expect(r.status).toBe(200);
    expect(r.body.messages).toEqual([]);
  });
});

describe("DELETE /api/anthropic/conversations/:id", () => {
  it("deletes a conversation and returns 204", async () => {
    const app = makeApp();
    const created = await createConversation(app, { title: "doomed" });
    const del = await request(app).delete(
      `/api/anthropic/conversations/${created.body.id}`,
    );
    expect(del.status).toBe(204);
    const list = await request(app).get("/api/anthropic/conversations");
    expect(list.body).toHaveLength(0);
  });

  it("returns 404 deleting a non-existent conversation", async () => {
    const del = await request(makeApp()).delete(
      "/api/anthropic/conversations/4242",
    );
    expect(del.status).toBe(404);
    expect(del.body.error).toMatch(/not found/i);
  });

  it("returns 400 deleting with a non-numeric id", async () => {
    const del = await request(makeApp()).delete(
      "/api/anthropic/conversations/nope",
    );
    expect(del.status).toBe(400);
    expect(del.body.error).toMatch(/invalid id/i);
  });
});
