#!/usr/bin/env node
// Run only against a disposable console: this saves global instructions.
// node scripts/context-api-audit.mjs http://127.0.0.1:23780/__setup/ dev
import assert from "node:assert/strict";
const base = (process.argv[2] || "http://127.0.0.1:23780/__setup/").replace(/\/$/, "");
const key = process.argv[3] || "dev";
async function api(body, extraHeaders = {}) {
  const response = await fetch(base + "/context/agents-md", {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-t3-setup-key": key, "content-type": "application/json", ...extraHeaders },
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
assert.equal(saved.data.reconcile.linked.length + saved.data.reconcile.skipped.length, 3);
assert.equal((await api()).data.content, content);
// Both creation and updates are guarded: an absent-file revision becomes stale.
const current = await api();
const updated = await api({ content: content + "\n", revision: current.data.revision });
assert.equal(updated.status, 200);
assert.equal((await api({ content: "# Stale draft", revision: current.data.revision })).status, 409);
const restored = await api({ content, revision: updated.data.revision });
assert.equal(restored.status, 200);
assert.equal((await api({ content: "" })).status, 400);
assert.equal((await api({ content: "# Cross-origin" }, { "sec-fetch-site": "cross-site" })).status, 403);
assert.equal((await api()).data.content, content);
console.log("PASS Context API: authentication, guarded saves, link reporting, invalid writes and cross-site rejection");
