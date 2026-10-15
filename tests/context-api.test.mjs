// Check the actual authenticated HTTP boundary in a disposable agent home.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("global instruction API validates writes and leaves existing provider files untouched", { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-context-api-"));
  const home = path.join(root, "home"), codex = path.join(home, ".codex"), config = path.join(home, ".config");
  await fs.mkdir(codex, { recursive: true });
  await fs.writeFile(path.join(codex, "AGENTS.md"), "# User-owned Codex instructions");
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../docker/setup/server.mjs", import.meta.url))], { env: {
    ...process.env, HOME: home, T3CODE_HOME: path.join(home, ".t3"), T3_WORKSPACE: path.join(root, "workspace"),
    CODEX_HOME: codex, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), XDG_CONFIG_HOME: config,
    MISE_DATA_DIR: path.join(home, ".local/share/mise"), MISE_STATE_DIR: path.join(home, ".local/state/mise"),
    MISE_CONFIG_DIR: path.join(config, "mise"), T3_SETUP_PORT: String(port), T3_SETUP_KEY: "fixture-key",
    T3_SETUP_KEY_SOURCE: "env", T3_INFRA_LAUNCHER: "/bin/false", T3CODE_PORT: "1",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/hello")).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(ready, logs);
  const api = (body, headers = {}) => fetch(base + "/context/agents-md", { method: body === undefined ? "GET" : "POST",
    headers: { "x-t3-setup-key": "fixture-key", "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await fetch(base + "/context/agents-md")).status, 401);
  assert.equal((await (await api()).json()).present, false);
  assert.equal((await api({ content: "# Ignore" }, { "sec-fetch-site": "cross-site" })).status, 403);
  const save = await api({ content: "# Shared instructions\n" });
  assert.equal(save.status, 200);
  const result = await save.json();
  assert.equal(result.reconcile.skipped[0].provider, "codex");
  assert.equal(result.reconcile.linked.length, 2);
  for (const target of [".claude/CLAUDE.md", ".config/opencode/AGENTS.md"]) assert.equal(await fs.readFile(path.join(home, target), "utf8"), "# Shared instructions\n");
  assert.equal(await fs.readFile(path.join(codex, "AGENTS.md"), "utf8"), "# User-owned Codex instructions");
  for (const content of ["", "x".repeat(65537)]) assert.equal((await api({ content })).status, 400);
  assert.equal((await (await api()).json()).content, "# Shared instructions\n");
});
