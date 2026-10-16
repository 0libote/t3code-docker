#!/usr/bin/env node
// Usage: node scripts/skills-native-smoke.mjs /absolute/path/to/codex
// No model calls. Both skill files and native settings live in a disposable home.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkillsService } from "../docker/setup/skills.mjs";

const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable)) throw new Error("Pass the absolute managed Codex executable path.");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skills-native-"));
try {
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, ".codex"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"), XDG_CACHE_HOME: path.join(home, ".cache") };
  const content = "---\nname: native-check\ndescription: Disposable native availability check\n---\nLocal fixture only.\n";
  const files = [".codex/skills/native-check/SKILL.md", ".agents/skills/native-shared/SKILL.md"].map((file) => path.join(home, file));
  for (const file of files) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  const config = path.join(env.CODEX_HOME, "config.toml");
  await fs.writeFile(config, '# Preserve this comment and unrelated settings\nmodel = "fixture-unused"\n');
  const service = createSkillsService({ home, env, getHarness: async () => ({ runnable: true, executable }) });
  let inventory = await service.list("codex");
  assert.equal(inventory.coverage, "native", inventory.nativeError);
  for (const file of files) {
    const row = inventory.skills.find((skill) => skill.path === file);
    assert.ok(row, file); assert.equal(row.canToggle, true, JSON.stringify(inventory.warnings));
    if (file === files[1]) assert.equal(row.canEdit, false, "Shared Markdown remains read-only");
    const disabled = await service.setState("codex", row.id, row.stateRevision, false);
    let fresh = disabled.inventory.skills.find((skill) => skill.id === row.id);
    assert.equal(fresh.state, "disabled");
    await assert.rejects(service.setState("codex", row.id, row.stateRevision, true), { code: "conflict" });
    const restarted = createSkillsService({ home, env, getHarness: async () => ({ runnable: true, executable }) });
    fresh = (await restarted.list("codex")).skills.find((skill) => skill.id === row.id);
    assert.equal(fresh.state, "disabled", "Native setting survives a fresh service and App Server process");
    const enabled = await restarted.setState("codex", row.id, fresh.stateRevision, true);
    inventory = enabled.inventory;
    assert.equal(inventory.skills.find((skill) => skill.id === row.id).state, "enabled");
    assert.equal(await fs.readFile(file, "utf8"), content);
  }
  const saved = await fs.readFile(config, "utf8");
  assert.match(saved, /# Preserve this comment and unrelated settings/); assert.match(saved, /model = "fixture-unused"/);
  console.log("Native Codex enable/disable, stale-state rejection, restart persistence, shared-file isolation and config preservation passed.");
} finally { await fs.rm(home, { recursive: true, force: true }); }
