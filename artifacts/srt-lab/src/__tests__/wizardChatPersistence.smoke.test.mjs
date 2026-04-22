/**
 * Smoke test for the wizard "Continue Last Session" persistence flow.
 *
 * Exercises the conversations REST API the way the persistent ChatPanel does:
 *   • POST /anthropic/conversations  with scope → row tagged with that scope
 *   • GET  /anthropic/conversations?scope=…    → only matching rows
 *   • GET  /anthropic/conversations/:id        → conversation + messages
 *   • DELETE /anthropic/conversations/:id      → removes it
 *
 * SSE streaming is NOT covered here because it depends on the live Anthropic
 * integration; it is exercised manually + by browser e2e.
 *
 * Skips gracefully if the api-server isn't reachable on localhost:8080.
 */
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.SRT_API_BASE || "http://127.0.0.1:8080/api/anthropic";

let serverUp = false;
try {
  const r = await fetch(`${BASE.replace(/\/anthropic$/, "")}/healthz`);
  serverUp = r.ok;
} catch {
  serverUp = false;
}

if (!serverUp) {
  test("wizard chat persistence (skipped — api-server not reachable on 8080)", () => {
    assert.ok(true);
  });
} else {
  const SCOPE_A = `test-scope-a-${Date.now()}`;
  const SCOPE_B = `test-scope-b-${Date.now()}`;

  test("scope-tagged conversations are filtered by ?scope=", async () => {
    const a = await fetch(`${BASE}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New chat", scope: SCOPE_A }),
    });
    assert.equal(a.status, 201, `create A: ${a.status}`);
    const aJson = await a.json();
    assert.equal(aJson.scope, SCOPE_A);
    assert.equal(aJson.title, "New chat");

    const b = await fetch(`${BASE}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New chat", scope: SCOPE_B }),
    });
    assert.equal(b.status, 201);
    const bJson = await b.json();

    /* Filtered list: only A */
    const listed = await fetch(`${BASE}/conversations?scope=${encodeURIComponent(SCOPE_A)}`).then(r => r.json());
    const ids = listed.map(r => r.id);
    assert.ok(ids.includes(aJson.id), "scope-A list must include conversation A");
    assert.ok(!ids.includes(bJson.id), "scope-A list must NOT include conversation B");

    /* GET /:id returns conversation + empty messages array */
    const getRes = await fetch(`${BASE}/conversations/${aJson.id}`).then(r => r.json());
    assert.equal(getRes.id, aJson.id);
    assert.equal(getRes.scope, SCOPE_A);
    assert.ok(Array.isArray(getRes.messages));
    assert.equal(getRes.messages.length, 0);

    /* Cleanup */
    const delA = await fetch(`${BASE}/conversations/${aJson.id}`, { method: "DELETE" });
    assert.equal(delA.status, 204);
    await fetch(`${BASE}/conversations/${bJson.id}`, { method: "DELETE" });

    /* GET after delete → 404 */
    const after = await fetch(`${BASE}/conversations/${aJson.id}`);
    assert.equal(after.status, 404);
  });

  test("POST /conversations rejects empty title with 400", async () => {
    const res = await fetch(`${BASE}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test("GET /conversations/:id with bogus id → 404", async () => {
    const res = await fetch(`${BASE}/conversations/999999999`);
    assert.equal(res.status, 404);
  });
}
