import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { createSkillsService } from "../docker/setup/skills.mjs";
import { parseSettings, userPolicy } from "../docker/setup/skills/policies.mjs";
import { inspectClaudeSkills, inspectOpenCodeSkills } from "../docker/setup/skills/native.mjs";

async function fixture(t, provider = "claude", major = 2, content = '{\n "env": {"FIXTURE": "preserved"}\n}\n', io = fs) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skill-policies-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, provider === "claude" ? ".claude" : ".config/opencode"), file = path.join(root, "skills/review/SKILL.md");
  const config = path.join(root, provider === "claude" ? "settings.json" : "opencode.jsonc");
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "---\nname: review\ndescription: Review changes\n---\nFixture.\n");
  if (content !== null) await fs.writeFile(config, content);
  let failNative = false, agentOverride = false, calls = 0;
  const options = { home, env: {}, io, getHarness: async () => ({ runnable: true, executable: "/managed/fixture" }),
    inspectClaude: async () => { calls++; if (failNative) throw new Error("Native discovery unavailable"); const cfg = await fs.readFile(config, "utf8").then(parseSettings, () => ({})); return { version: "2.1.302", commands: cfg.skillOverrides?.review === "off" ? [] : ["review"] }; },
    inspectOpenCode: async () => { calls++; if (failNative) throw new Error("Native discovery unavailable"); return { major, version: major + ".19.3", skills: [{ path: file, id: "review", name: "review" }], agent: { permissions: [{ action: "skill", resource: "review", effect: agentOverride ? "deny" : "allow" }] } }; },
  };
  const service = createSkillsService(options), row = async (instance = service) => (await instance.list(provider, { refresh: true })).skills.find((row) => row.path === file);
  const set = async (state, current) => { current ||= await row(); return service.setState(provider, current.id, current.stateRevision, undefined, state); };
  return { home, root, file, config, options, service, row, set, failNative: () => { failNative = true; }, overrideAgent: () => { agentOverride = true; }, calls: () => calls };
}

test("Claude retains all four native states and preserves unrelated settings, modes and settings links", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.home, "settings-target.json"); await fs.rename(f.config, target); await fs.symlink(target, f.config); await fs.chmod(target, 0o640);
  let row = await f.row(); assert.equal(row.state, "on"); assert.equal(row.canSetState, true); assert.equal(row.canToggle, false);
  assert.deepEqual(row.stateOptions.map((option) => option.value), ["on", "name-only", "user-invocable-only", "off"]);
  for (const state of ["name-only", "user-invocable-only", "off", "on"]) {
    const result = await f.set(state, row); row = result.inventory.skills[0];
    assert.equal(row.state, state); assert.equal(parseSettings(await fs.readFile(target, "utf8")).skillOverrides.review, state);
    assert.equal(parseSettings(await fs.readFile(target, "utf8")).env.FIXTURE, "preserved");
  }
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640); assert.ok((await fs.lstat(f.config)).isSymbolicLink());
});

test("OpenCode V1 adds an exact name rule after wildcards and preserves existing richer permissions", async (t) => {
  for (const permission of ["ask", { skill: "deny", bash: "ask" }, { skill: { review: "allow", "*": "ask", other: "deny" }, bash: { "git *": "allow", "*": "deny" } }]) {
    const f = await fixture(t, "opencode", 1, JSON.stringify({ permission }));
    const initial = await f.row(); assert.equal(initial.canSetState, true);
    await f.set("deny", initial);
    const cfg = parseSettings(await fs.readFile(f.config, "utf8"));
    assert.equal(userPolicy("opencode", cfg, 1, "review"), "deny");
    assert.equal(Object.keys(cfg.permission.skill).at(-1), "review");
    if (typeof permission === "string") assert.equal(cfg.permission['*'], permission);
    else { assert.deepEqual(cfg.permission.bash, permission.bash); if (typeof permission.skill === "string") assert.equal(cfg.permission.skill['*'], permission.skill); }
  }
});

test("OpenCode V2 preserves rule order/comments and reports an agent override separately from user policy", async (t) => {
  const f = await fixture(t, "opencode", 2, '{"permissions":[\n // Preserve wildcard rule\n {"action":"skill","resource":"*","effect":"ask"},\n {"action":"shell","resource":"git *","effect":"deny"}\n]}');
  f.overrideAgent(); let row = await f.row(); assert.equal(row.state, "ask");
  let result = await f.set("allow", row); row = result.inventory.skills[0];
  assert.equal(row.state, "allow"); assert.equal(row.effectiveStateText, "Build agent: Denied");
  let cfg = parseSettings(await fs.readFile(f.config, "utf8"));
  assert.deepEqual(cfg.permissions.slice(0, 2), [{ action: "skill", resource: "*", effect: "ask" }, { action: "shell", resource: "git *", effect: "deny" }]);
  assert.equal(cfg.permissions.length, 3); assert.match(await fs.readFile(f.config, "utf8"), /Preserve wildcard rule/);
  await f.set("deny", row); cfg = parseSettings(await fs.readFile(f.config, "utf8"));
  assert.equal(cfg.permissions.length, 3, "subsequent exact-rule edits do not accumulate duplicate rules");
  assert.equal(cfg.permissions[2].effect, "deny");
});

test("native policies create missing settings, reject stale/concurrent changes and require known states", async (t) => {
  const f = await fixture(t, "claude", 2, null), row = await f.row();
  const results = await Promise.allSettled([f.set("off", row), f.set("name-only", row)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "conflict");
  assert.equal((await fs.stat(f.config)).mode & 0o777, 0o600);
  const fresh = await f.row(); await fs.appendFile(f.config, "\n \n");
  await assert.rejects(f.set("on", fresh), { code: "conflict" });
  await assert.rejects(f.set("bogus", fresh), { code: "invalid" });
});

test("OpenCode V2 writes the selected native ID when a linked installation has a different directory name", async (t) => {
  const f = await fixture(t, "opencode", 2, '{}');
  const service = createSkillsService({ ...f.options, inspectOpenCode: async () => ({ major: 2, version: "2.0.31",
    skills: [{ path: f.file, id: "canonical-id", name: "review" }], agent: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
  }) });
  const row = await f.row(service); assert.equal(row.policyKey, "canonical-id");
  await service.setState("opencode", row.id, row.stateRevision, undefined, "deny");
  assert.deepEqual(parseSettings(await fs.readFile(f.config, "utf8")).permissions, [{ action: "skill", resource: "canonical-id", effect: "deny" }]);
});

test("malformed, duplicate-key and unknown native policy shapes stay read-only without rewriting settings", async (t) => {
  for (const [provider, content] of [["claude", '{ // Not supported by Claude\n "skillOverrides": {"review": "off"}}'], ["claude", '{"skillOverrides": []}'], ["claude", '{"skillOverrides":{"review":"unknown"}}'], ["claude", '{"skillOverrides":{},"skillOverrides":{}}'], ["claude", '{bad'], ["opencode", '{"permissions": {"skill":"deny"}}']]) {
    const f = await fixture(t, provider, 2, content), row = await f.row();
    assert.ok(!row.canSetState); assert.equal(await fs.readFile(f.config, "utf8"), content);
    await assert.rejects(f.set(provider === "claude" ? "off" : "deny", row), { code: "unsupported" });
    assert.equal(await fs.readFile(f.config, "utf8"), content);
  }
});

test("a failed native verification retains committed settings and reports uncertainty", async (t) => {
  let f;
  const io = { ...fs, rename: async (...args) => { await fs.rename(...args); if (path.basename(args[0]).startsWith(".t3-skill-policy-")) f.failNative(); } };
  f = await fixture(t, "claude", 2, '{}', io);
  await assert.rejects(f.set("off"), /may have been saved/);
  assert.equal(parseSettings(await fs.readFile(f.config, "utf8")).skillOverrides.review, "off");
  const after = await f.service.list("claude"); assert.equal(after.coverage, "files"); assert.ok(after.nativeError); assert.ok(!after.skills[0].canSetState);
});

test("policy publication failures preserve existing config and clean temporary files", async (t) => {
  const io = { ...fs, rename: async (from, to) => { if (path.basename(from).startsWith(".t3-skill-policy-")) throw Object.assign(new Error("Write denied"), { code: "EACCES" }); return fs.rename(from, to); } };
  const f = await fixture(t, "claude", 2, '{"env":{"KEEP":"yes"}}', io);
  await assert.rejects(f.set("off"), { code: "EACCES" });
  assert.equal(await fs.readFile(f.config, "utf8"), '{"env":{"KEEP":"yes"}}');
  assert.ok(!(await fs.readdir(f.root)).some((name) => name.startsWith(".t3-skill-policy-")));
});

test("Claude metadata protocol sends only initialization and bounds an unresponsive provider", async (t) => {
  const f = await fixture(t), executable = path.join(f.home, "fake-claude"), capture = path.join(f.home, "request.json");
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);fs.writeFileSync(process.env.CAPTURE,line);
process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{claude_code_version:'2.1.302',commands:[{name:'review'}]}}})+'\\n');
});`); await fs.chmod(executable, 0o700);
  const result = await inspectClaudeSkills({ executable, home: f.home, env: { ...process.env, CAPTURE: capture } });
  assert.deepEqual(result.commands, ["review"]);
  assert.deepEqual(JSON.parse(await fs.readFile(capture, "utf8")).request, { subtype: "initialize" });
  await fs.writeFile(executable, '#!/usr/bin/env node\nsetInterval(()=>{},1000);\n');
  await assert.rejects(inspectClaudeSkills({ executable, home: f.home, env: process.env, timeoutMs: 50 }), /timed out/);
});

test("OpenCode V1 metadata commands serialize access to shared provider initialization", async (t) => {
  const f = await fixture(t, "opencode"), executable = path.join(f.home, "fake-opencode");
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.19.2'); process.exit(0); }
const lock = path.join(process.env.HOME, 'metadata-initializing');
try { fs.writeFileSync(lock, args.join(' '), {flag:'wx'}); }
catch { process.stderr.write('Concurrent provider initialization'); process.exit(1); }
setTimeout(() => {
 const result = args[1] === 'skill' ? [] : args[1] === 'config' ? {} : {permission:[{permission:'skill',pattern:'*',action:'ask'}]};
 fs.unlinkSync(lock); console.log(JSON.stringify(result));
}, 30);
`); await fs.chmod(executable, 0o700);
  const result = await inspectOpenCodeSkills({ executable, home: f.home, env: { ...process.env, HOME: f.home } });
  assert.equal(result.version, "1.19.2");
  assert.deepEqual(result.agent.permissions, [{ action: "skill", resource: "*", effect: "ask" }]);
  await assert.rejects(fs.stat(path.join(f.home, "metadata-initializing")), { code: "ENOENT" });
});

test("OpenCode first-use JSONC creation is reloaded before returning policy state or a revision", async (t) => {
  const f = await fixture(t, "opencode", 1, null); let created = false;
  const service = createSkillsService({ ...f.options, inspectOpenCode: async () => {
    if (!created) { created = true; await fs.writeFile(f.config, '{"$schema":"https://opencode.ai/config.json","permission":{"skill":{"review":"deny"}}}'); }
    return f.options.inspectOpenCode();
  } });
  const row = await f.row(service); assert.equal(row.state, "deny"); assert.equal(row.canSetState, true); assert.equal(f.calls(), 2);
  const result = await service.setState("opencode", row.id, row.stateRevision, undefined, "ask");
  assert.equal(result.inventory.skills.find((entry) => entry.id === row.id).state, "ask");
  assert.equal(parseSettings(await fs.readFile(f.config, "utf8")).permission.skill.review, "ask");
  await assert.rejects(fs.stat(path.join(f.root, "opencode.json")), { code: "ENOENT" });
});

test("repeated native configuration source changes disable controls after one bounded reinspection", async (t) => {
  const f = await fixture(t, "opencode", 1, '{}'); let calls = 0;
  const service = createSkillsService({ ...f.options, inspectOpenCode: async () => {
    if (++calls === 1) await fs.unlink(f.config); else await fs.writeFile(f.config, '{"permission":"ask"}');
    return f.options.inspectOpenCode();
  } });
  const result = await service.list("opencode");
  assert.equal(calls, 2); assert.equal(result.coverage, "files"); assert.match(result.nativeError, /changed during discovery/);
  assert.ok(!result.skills[0].canSetState); assert.equal(await fs.readFile(f.config, "utf8"), '{"permission":"ask"}');
});
