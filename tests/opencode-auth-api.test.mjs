// Exercise the real setup routes with a CLI fixture that persists accounts.
import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-opencode-auth-"));
  let child = null;
  let closed = null;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const home = path.join(root, "home");
  const legacy = path.join(home, ".local/share/opencode/auth.json");
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  const stale = JSON.stringify({ anthropic: { type: "api", key: "stale-key" } });
  await fs.writeFile(legacy, stale);
  const bin = path.join(root, "opencode.mjs");
  await fs.writeFile(bin, `#!${process.execPath}
import { promises as fs } from 'node:fs';
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
await fs.appendFile(root + '/calls', JSON.stringify(args) + '\\n');
let accounts = JSON.parse(await fs.readFile(root + '/accounts', 'utf8'));
if (args.join(' ') === 'auth list --format json') {
  const facts = JSON.parse(await fs.readFile(root + '/facts', 'utf8'));
  if (facts.listFails) process.exit(1);
  const ids = [...new Set(accounts.map(a => a.integrationID))];
  console.log(JSON.stringify(ids.map(id => ({ id, connections: accounts.filter(a => a.integrationID === id).map(a => ({ type: 'credential', id: a.id, label: a.label })) }))));
} else if (args.join(' ') === 'auth import') {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const entries = JSON.parse(input);
  if (!entries.every(a => a.id && a.integrationID && a.value.type === 'key' && a.value.key)) process.exit(1);
  accounts.push(...entries.map(a => ({ ...a, active: false })));
} else if (args[0] === 'auth' && args[1] === 'switch') {
  if (!accounts.some(a => a.integrationID === args[2] && a.id === args[3])) process.exit(1);
  accounts = accounts.map(a => a.integrationID === args[2] ? { ...a, active: a.id === args[3] } : a);
} else if (args[0] === 'auth' && args[1] === 'logout') {
  accounts = accounts.filter(a => !(a.integrationID === args[2] && a.id === args[3]));
} else process.exit(1);
await fs.writeFile(root + '/accounts', JSON.stringify(accounts));
`, { mode: 0o700 });
  const facts = { runnable: true, executable: bin, installedVersion: "2.0.20" };
  const setFacts = (overrides = {}) => fs.writeFile(path.join(root, "facts"), JSON.stringify({ ...facts, ...overrides }));
  const accounts = [
    { id: "old-key", integrationID: "anthropic", label: "Old", value: { type: "key", key: "old" }, active: true },
    { id: "other-provider", integrationID: "openai", label: "Other", value: { type: "key", key: "other" }, active: true },
  ];
  await setFacts();
  await fs.writeFile(path.join(root, "accounts"), JSON.stringify(accounts));
  await fs.writeFile(path.join(root, "calls"), "");
  // Serve the catalogue refresh locally so these route tests need no network.
  const preload = path.join(root, "catalogue.mjs");
  await fs.writeFile(preload, `
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => String(input) === 'https://models.dev/api.json'
      ? Promise.resolve(Response.json({ anthropic: { name: 'Anthropic' } }))
      : original(input, init);
  `);
  const harness = path.join(root, "harness.mjs");
  await fs.writeFile(harness, `
    export * from ${JSON.stringify(new URL("../docker/harness/index.mjs", import.meta.url).href)};
    import { readFile } from 'node:fs/promises';
    export const createHarnessManager = () => ({
      resolve: async () => {
        const facts = JSON.parse(await readFile(${JSON.stringify(path.join(root, "facts"))}, 'utf8'));
        if (facts.resolveFails) throw new Error('mise unavailable');
        return facts;
      },
      status: async () => ({ harnesses: [], degraded: [] }),
      sourceControl: { status: async () => ({ sourceControl: [], degraded: [] }) },
      toolchains: { status: async () => ({ toolchains: [] }) },
      packages: { status: async () => ({ packages: [] }) },
      paths: { stateDir: ${JSON.stringify(root)} },
    });
  `);
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  let logs = "";
  child = spawn(process.execPath, ["--import", preload, fileURLToPath(new URL("../docker/setup/server.mjs", import.meta.url))], {
    cwd: root,
    env: { ...process.env, HOME: home, T3CODE_HOME: path.join(home, ".t3"), T3_WORKSPACE: root,
      T3_SETUP_PORT: String(port), T3CODE_PORT: "1", T3_SETUP_KEY: "fixture", T3_SETUP_KEY_SOURCE: "env",
      T3_HARNESS_MODULE: harness, T3_INFRA_LAUNCHER: "/bin/false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  closed = once(child, "close");
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* starting */ }
    await pause(20);
  }
  return {
    legacy, stale, accounts, setFacts,
    readAccounts: async () => JSON.parse(await fs.readFile(path.join(root, "accounts"), "utf8")),
    calls: async () => (await fs.readFile(path.join(root, "calls"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    request: async (route, body) => {
      const res = await fetch(base + route, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-t3-setup-key": "fixture", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
  };
}

test("OpenCode v2 setup saves, selects and removes database accounts", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/auth/apikey", { agent: "opencode", provider: "anthropic", key: "new-key" })).status, 200);
  const saved = await f.readAccounts();
  const added = saved.find(a => a.value.key === "new-key");
  assert.ok(added?.active, "the imported key becomes the selected account");
  assert.equal(saved.find(a => a.id === "old-key").active, false);
  assert.deepEqual((await f.request("/providers")).body.configured, ["anthropic", "openai"]);
  const removed = await f.request("/auth/apikey/remove", { agent: "opencode", provider: "anthropic" });
  assert.deepEqual(removed, { status: 200, body: { ok: true, removed: true } });
  assert.deepEqual(await f.readAccounts(), [f.accounts[1]], "all accounts for the provider are removed, others stay");
  assert.deepEqual((await f.request("/providers")).body.configured, ["openai"]);
  assert.equal(await fs.readFile(f.legacy, "utf8"), f.stale, "v2 never changes the migrated file");
  assert.ok((await f.calls()).every(args => !args.includes("new-key")), "keys never enter argv");
});

test("unavailable OpenCode stores reject writes and never fall back to a stale file", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const facts of [
    { runnable: false, inProgress: true },
    { runnable: false, installedVersion: "2.0.18" },
    { executable: null },
    { resolveFails: true },
    { installedVersion: null, listFails: true },
  ]) {
    await f.setFacts(facts);
    const removed = await f.request("/auth/apikey/remove", { agent: "opencode", provider: "anthropic" });
    assert.equal(removed.status, 400, JSON.stringify(facts));
    assert.match(removed.body.error, /OpenCode is unavailable/);
    const saved = await f.request("/auth/apikey", { agent: "opencode", provider: "anthropic", key: "new-key" });
    assert.equal(saved.status, 400, JSON.stringify(facts));
    assert.deepEqual((await f.request("/providers")).body.configured, []);
    assert.equal(await fs.readFile(f.legacy, "utf8"), f.stale);
    assert.deepEqual(await f.readAccounts(), f.accounts);
  }
  assert.ok((await f.calls()).every(args => args.join(" ") === "auth list --format json"), "failed resolution cannot run a credential mutation");
});

test("OpenCode v1 setup still saves and removes file credentials", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await f.setFacts({ installedVersion: "1.18.31" });
  assert.equal((await f.request("/auth/apikey", { agent: "opencode", provider: "openai", key: "new-key" })).status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(f.legacy, "utf8")), {
    anthropic: { type: "api", key: "stale-key" }, openai: { type: "api", key: "new-key" },
  });
  assert.deepEqual((await f.request("/providers")).body.configured, ["anthropic", "openai"]);
  assert.deepEqual(await f.request("/auth/apikey/remove", { agent: "opencode", provider: "anthropic" }), { status: 200, body: { ok: true, removed: true } });
  assert.deepEqual(JSON.parse(await fs.readFile(f.legacy, "utf8")), { openai: { type: "api", key: "new-key" } });
  assert.deepEqual(await f.calls(), [], "v1 never runs database commands");
});
