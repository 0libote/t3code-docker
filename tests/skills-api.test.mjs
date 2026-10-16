// The setup HTTP boundary, including reverse-proxy prefixes and arbitrary-path rejection.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("skill endpoints require authentication and only read discovered installations", { timeout: 20000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skills-api-"));
  const directory = path.join(home, ".claude/skills/one"); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  const markdown = "---\nname: one\ndescription: Local fixture\n---\nOriginal instructions.\n";
  await fs.writeFile(file, markdown);
  const other = path.join(home, "unrelated.md"); await fs.writeFile(other, "Not a skill");
  const reservation = createServer().listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../docker/setup/server.mjs", import.meta.url))], { env: {
    ...process.env, HOME: home, T3CODE_HOME: path.join(home, ".t3"), T3_WORKSPACE: path.join(home, "workspace"),
    CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"), XDG_CONFIG_HOME: path.join(home, ".config"),
    MISE_DATA_DIR: path.join(home, ".local/share/mise"), MISE_STATE_DIR: path.join(home, ".local/state/mise"), MISE_CONFIG_DIR: path.join(home, ".config/mise"),
    T3_SETUP_PORT: String(port), T3_SETUP_KEY: "skills-fixture-key", T3_SETUP_KEY_SOURCE: "env", T3_INFRA_LAUNCHER: "/bin/false", T3CODE_PORT: "1",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", (data) => { logs += data; }); child.stderr.on("data", (data) => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    await fs.rm(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`, base = origin + "/__setup";
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base + "/hello")).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(ready, logs);
  const get = (route) => fetch(base + route, { headers: { "x-t3-setup-key": "skills-fixture-key" } });
  const post = (route, body, headers = {}) => fetch(base + route, { method: "POST", headers: { "x-t3-setup-key": "skills-fixture-key", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + "/context/skills?provider=claude")).status, 401);
  assert.equal((await fetch(base + "/context/skills/read?provider=claude&id=" + "a".repeat(32))).status, 401);
  assert.equal((await get("/context/skills?provider=__proto__")).status, 400);
  assert.equal((await get("/context/skills")).status, 400);
  const result = await (await get("/context/skills?provider=claude")).json();
  assert.equal(result.coverage, "files"); assert.equal(result.skills.length, 1);
  const row = result.skills[0]; assert.equal(row.name, "one"); assert.ok(!("content" in row));
  const readPath = "/context/skills/read?provider=claude&id=" + row.id;
  assert.equal((await (await get(readPath + "&path=" + encodeURIComponent(other))).json()).content, markdown);
  assert.equal((await get("/context/skills/read?provider=claude&id=" + encodeURIComponent(other))).status, 400);
  assert.equal((await get("/context/skills/read?provider=claude&id=" + "0".repeat(32))).status, 404);
  const changed = markdown.replace("name: one", "name: changed"); await fs.writeFile(file, changed);
  assert.equal((await (await get("/context/skills?provider=claude")).json()).skills[0].name, "one");
  assert.equal((await (await get("/context/skills?provider=claude&refresh=1")).json()).skills[0].name, "changed");
  await fs.writeFile(file, "x".repeat(65537));
  assert.equal((await get(readPath)).status, 413);
  await fs.unlink(file); await fs.symlink(other, file);
  assert.equal((await get(readPath)).status, 409);
  assert.equal(await fs.readFile(other, "utf8"), "Not a skill");
  await fs.unlink(file); assert.equal((await get(readPath)).status, 404);
  const draft = "---\nname: local-new\ndescription: A local skill\n---\nUse the project conventions.\n";
  assert.equal((await fetch(base + "/context/skills/create", { method: "POST" })).status, 401);
  assert.equal((await post("/context/skills/create", { provider: "claude", slug: "local-new", content: draft }, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("/context/skills/create", { provider: "claude", slug: "../escape", content: draft })).status, 400);
  assert.equal((await post("/context/skills/create", { provider: "claude", slug: "local-new", content: draft })).status, 200);
  assert.equal((await post("/context/skills/create", { provider: "claude", slug: "local-new", content: draft })).status, 409);
  const added = (await (await get("/context/skills?provider=claude")).json()).skills.find((skill) => skill.name === "local-new");
  const detailPath = "/context/skills/read?provider=claude&id=" + added.id;
  let detail = await (await get(detailPath)).json();
  assert.equal(detail.canEdit, true); assert.ok(detail.revision); assert.ok(detail.removalRevision);
  const prefix = "---\nname: local-new\ndescription: A local skill\n---\n";
  const boundary = prefix + "\u0001".repeat(65536 - Buffer.byteLength(prefix));
  assert.equal((await post("/context/skills/save", { provider: "claude", id: added.id, revision: detail.revision, content: boundary })).status, 200);
  assert.equal((await (await get(detailPath)).json()).content, boundary);
  assert.equal((await post("/context/skills/save", { provider: "claude", id: added.id, revision: detail.revision, content: draft })).status, 409);
  detail = await (await get(detailPath)).json();
  assert.equal((await post("/context/skills/remove", { provider: "claude", id: added.id, revision: detail.revision })).status, 409);
  assert.equal((await post("/context/skills/remove", { provider: "claude", id: added.id, revision: detail.revision, removalRevision: detail.removalRevision })).status, 200);
  assert.equal((await get(detailPath)).status, 404);
  assert.equal((await post("/context/skills/create", null)).status, 400);
  const html = await (await fetch(base)).text();
  assert.ok(!html.includes(markdown), "skill contents are never inlined into the page");
});
