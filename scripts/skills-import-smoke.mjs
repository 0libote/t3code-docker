#!/usr/bin/env node
// Import/update/remove through the actual managed provider, without a model turn.
// Usage: node scripts/skills-import-smoke.mjs claude|codex|opencode /absolute/executable
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { createSkillsService } = await import(process.env.T3_SKILLS_MODULE || new URL("../docker/setup/skills.mjs", import.meta.url));
const [provider, executable] = process.argv.slice(2);
if (!["claude", "codex", "opencode"].includes(provider) || !path.isAbsolute(executable || "")) throw new Error("Pass claude|codex|opencode and an absolute executable path.");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skills-import-native-"));
try {
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"), XDG_STATE_HOME: path.join(home, ".local/state"), XDG_CACHE_HOME: path.join(home, ".cache") };
  for (const key of Object.keys(env)) if (/TOKEN|API_KEY|OPENCODE_CONFIG|OPENCODE_PERMISSION/.test(key)) delete env[key];
  const source = path.join(home, "source"), published = path.join(source, "skills/import-check"), adapter = path.join(source, ".openclaw/skills/import-check");
  await fs.mkdir(path.join(published, "scripts"), { recursive: true }); await fs.mkdir(adapter, { recursive: true });
  const markdown = (version) => `---\nname: import-check\ndescription: Disposable native import fixture\n---\nVersion ${version}.\n`;
  const writeSource = async (version) => {
    await fs.writeFile(path.join(published, "SKILL.md"), markdown(version));
    await fs.writeFile(path.join(published, "scripts/check.sh"), "#!/bin/sh\nexit " + version + "\n", { mode: 0o700 });
    await fs.writeFile(path.join(adapter, "SKILL.md"), markdown(version) + "Agent-specific variant.\n");
  };
  await writeSource(1);
  const options = { home, env, getHarness: async (id) => id === provider ? { runnable: true, executable } : null };
  let service = createSkillsService(options);
  const importSkill = async (replace = false) => {
    const preview = await service.previewSource(source), plan = await service.planImport(preview.previewId, ["import-check"], [provider]);
    assert.equal(plan.canInstall, true, JSON.stringify(plan.destinations));
    const result = await service.installImport(preview.previewId, plan.planId, replace);
    assert.equal(result.results[0].status, "installed", JSON.stringify(result.results));
    await service.discardImport(preview.previewId);
    return result.results[0].directory;
  };
  const directory = await importSkill();
  const inventory = async () => {
    const result = await service.list(provider, { refresh: true });
    assert.equal(result.coverage, provider === "codex" ? "native" : "policy", result.nativeError);
    const row = result.skills.find((row) => row.path === path.join(directory, "SKILL.md")); assert.ok(row, JSON.stringify(result.warnings)); return row;
  };
  let row = await inventory();
  if (provider === "codex") await service.setState(provider, row.id, row.stateRevision, false);
  else await service.setState(provider, row.id, row.stateRevision, undefined, provider === "claude" ? "off" : "deny");
  const jsonc = path.join(home, ".config/opencode/opencode.jsonc");
  const config = provider === "opencode" && await fs.stat(jsonc).then(() => true, () => false) ? jsonc
    : path.join(home, provider === "codex" ? ".codex/config.toml" : provider === "claude" ? ".claude/settings.json" : ".config/opencode/opencode.json");
  const savedConfig = await fs.readFile(config, "utf8");
  await fs.writeFile(path.join(directory, "obsolete.md"), "Remove this on update.");
  await writeSource(2); await importSkill(true);
  assert.equal(await fs.readFile(path.join(directory, "SKILL.md"), "utf8"), markdown(2));
  assert.equal(await fs.readFile(path.join(directory, "scripts/check.sh"), "utf8"), "#!/bin/sh\nexit 2\n");
  await assert.rejects(fs.stat(path.join(directory, "obsolete.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(config, "utf8"), savedConfig, "Import updates preserve native policies byte for byte");
  service = createSkillsService(options); row = await inventory();
  assert.equal(row.state, provider === "codex" ? "disabled" : provider === "claude" ? "off" : "deny");
  const detail = await service.read(provider, row.id); assert.equal(detail.canRemove, true);
  await service.remove(provider, row.id, detail.revision, detail.removalRevision);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  assert.equal((await service.list(provider, { refresh: true })).skills.some((skill) => skill.path === row.path), false);
  assert.equal(await fs.readFile(config, "utf8"), savedConfig);
  console.log(provider + ": native import, policy preservation, complete update, restart discovery and removal passed.");
} finally { await fs.rm(home, { recursive: true, force: true }); }
