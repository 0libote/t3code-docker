#!/usr/bin/env node
// Run only against a disposable console: this saves global instructions.
// node scripts/context-api-audit.mjs http://127.0.0.1:23780/__setup/ dev
import assert from "node:assert/strict";
const base = (process.argv[2] || "http://127.0.0.1:23780/__setup/").replace(/\/$/, "");
const key = process.argv[3] || "dev";
async function api(body) {
  const response = await fetch(base + "/context/agents-md", {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-t3-setup-key": key, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, data: await response.json() };
}
assert.equal((await fetch(base + "/context/agents-md")).status, 401);
const original = await api();
assert.equal(original.status, 200);
const content = original.data.content || "# Context API audit\n";
const saved = await api({ content, revision: original.data.revision });
assert.equal(saved.status, 200, JSON.stringify(saved.data));
assert.ok(Array.isArray(saved.data.reconcile.linked));
assert.ok(Array.isArray(saved.data.reconcile.skipped));
assert.equal((await api()).data.content, content);
console.log("PASS Context API: authenticated save, provider link reporting and readback");
