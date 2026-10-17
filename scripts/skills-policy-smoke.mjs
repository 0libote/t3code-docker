#!/usr/bin/env node
// Usage: node scripts/skills-policy-smoke.mjs claude|opencode /absolute/executable
// Only native metadata handshakes/debug reads; no prompt, turn or model request.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { createSkillsService } = await import(process.env.T3_SKILLS_MODULE || new URL("../docker/setup/skills.mjs", import.meta.url));
const [provider, executable] = process.argv.slice(2);
if (!["claude", "opencode"].includes(provider) || !path.isAbsolute(executable || "")) throw new Error("Pass claude|opencode and an absolute executable path.");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skills-policy-"));
try {
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"), XDG_STATE_HOME: path.join(home, ".local/state"), XDG_CACHE_HOME: path.join(home, ".cache") };
  for (const key of Object.keys(env)) if (/TOKEN|API_KEY|OPENCODE_CONFIG|OPENCODE_PERMISSION/.test(key)) delete env[key];
  const root = path.join(home, provider === "claude" ? ".claude" : ".config/opencode");
  const file = path.join(root, "skills/native-check/SKILL.md"), config = path.join(root, provider === "claude" ? "settings.json" : "opencode.jsonc");
  const content = "---\nname: native-check\ndescription: Disposable native policy fixture\n---\nFixture.\n";
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  await fs.writeFile(config, provider === "claude" ? '{\n  "env": {"T3_SKILLS_FIXTURE": "keep"}\n}\n' : '{\n // Preserve this comment\n "username": "T3_SKILLS_FIXTURE"\n}\n'); await fs.chmod(config, 0o640);
  const options = { home, env, getHarness: async (id) => id === provider ? { runnable: true, executable } : null };
  let service = createSkillsService(options), inventory = await service.list(provider);
  assert.equal(inventory.coverage, "policy", inventory.nativeError);
  let row = inventory.skills.find((row) => row.path === file); assert.ok(row.canSetState, row.stateReadOnlyReason);
  const states = provider === "claude" ? ["name-only", "user-invocable-only", "off", "on"] : ["ask", "deny", "allow"];
  for (const state of states) {
    const result = await service.setState(provider, row.id, row.stateRevision, undefined, state);
    const old = row; row = result.inventory.skills.find((skill) => skill.id === row.id);
    assert.equal(row.state, state);
    if (provider === "claude") assert.match(row.effectiveStateText, state === "off" ? /hidden/ : /listed/);
    else assert.match(row.effectiveStateText, new RegExp(state === "ask" ? "Ask" : state === "deny" ? "Denied" : "Allowed"));
    await assert.rejects(service.setState(provider, row.id, old.stateRevision, undefined, states[0]), { code: "conflict" });
    service = createSkillsService(options); inventory = await service.list(provider);
    row = inventory.skills.find((skill) => skill.id === row.id); assert.equal(row.state, state, "Native user policy survives a fresh service and provider process");
  }
  if (provider === "opencode") assert.match(await fs.readFile(config, "utf8"), /Preserve this comment/);
  assert.match(await fs.readFile(config, "utf8"), /T3_SKILLS_FIXTURE/);
  assert.equal((await fs.stat(config)).mode & 0o777, 0o640);
  assert.equal(await fs.readFile(file, "utf8"), content);
  console.log(provider + " " + row.nativePolicyVersion + ": native states, user policy persistence, runtime availability, conflicts, comments and permissions passed.");
} finally { await fs.rm(home, { recursive: true, force: true }); }
