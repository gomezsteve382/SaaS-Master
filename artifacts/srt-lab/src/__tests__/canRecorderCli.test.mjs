import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Smoke test for Task #617 CLI: assert the can-recorder defaults to the
// canonical lowercase /readmsg endpoint that the existing repo bridge
// (and bridgeClient.js) uses. A round-2 code review caught a `/readMsg`
// default that silently failed because HTTP paths are case-sensitive.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "..", "..", "..", "scripts", "src", "can-recorder.ts");

test("can-recorder CLI defaults --poll to the lowercase /readmsg path", () => {
  const src = readFileSync(CLI_PATH, "utf-8");
  const m = src.match(/pollPath:\s*['"]([^'"]+)['"]/);
  assert.ok(m, "could not find pollPath default in can-recorder.ts");
  assert.equal(m[1], "/readmsg",
    "CLI default must match the bridge endpoint (case-sensitive HTTP path).");
});

test("can-recorder CLI documents the lowercase /readmsg default", () => {
  const src = readFileSync(CLI_PATH, "utf-8");
  assert.ok(/\/readmsg/.test(src), "CLI source should mention /readmsg in its header comment");
  assert.ok(!/\/readMsg/.test(src), "CLI source must not reference the broken mixed-case /readMsg path");
});
