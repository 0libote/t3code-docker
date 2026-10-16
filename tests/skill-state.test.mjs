import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { createSkillsService } from "../docker/setup/skills.mjs";
import { configSnapshot } from "../docker/setup/skills/state.mjs";
import { writeCodexSkillConfig } from "../docker/setup/skills/codex.mjs";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skill-state-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const put = async (relative, content = "---\nname: review\ndescription: Review changes\n---\nLocal instructions.\n") => {
    const file = path.join(home, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file;
  };
  const file = await put(".codex/skills/review/SKILL.md");
  const config = await put(".codex/config.toml", '# Keep this comment\nmodel = "fixture"\n');
  const entries = [{ path: file, name: "review", description: "Review changes", scope: "user", enabled: true }];
  const writes = [];
  const options = { home, env: {}, getHarness: async () => ({ runnable: true, executable: "/managed/codex" }),
    nativeCodex: async () => ({ skills: structuredClone(entries), errors: [] }),
    nativeCodexWrite: async (input) => { writes.push(input); entries.find((row) => row.path === input.path).enabled = input.enabled; await fs.appendFile(config, "# native write\n"); return { effectiveEnabled: input.enabled }; },
  };
  const service = createSkillsService(options);
  const row = async (instance = service) => (await instance.list("codex", { refresh: true })).skills.find((skill) => skill.path === file);
  return { home, put, file, config, entries, writes, options, service, row };
}

test("native availability changes only the selected provider path, verifies state and invalidates cached inventory", async (t) => {
  const f = await fixture(t);
  const other = await f.put(".agents/skills/review/SKILL.md");
  f.entries.push({ ...f.entries[0], path: other });
  const original = await fs.readFile(f.file, "utf8");
  const initial = await f.row(); assert.equal(initial.canToggle, true);
  const disabled = await f.service.setState("codex", initial.id, initial.stateRevision, false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.inventory.skills.find((row) => row.id === initial.id).state, "disabled");
  assert.equal(disabled.inventory.skills.find((row) => row.path === other).state, "enabled");
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].executable, "/managed/codex"); assert.equal(f.writes[0].path, f.file);
  const fresh = await f.row(); assert.equal(fresh.state, "disabled"); assert.notEqual(fresh.stateRevision, initial.stateRevision);
  await f.service.setState("codex", fresh.id, fresh.stateRevision, true);
  assert.equal((await f.row()).state, "enabled");
  assert.equal(await fs.readFile(f.file, "utf8"), original);
  assert.ok(!(JSON.stringify(disabled).includes('model =')));
});

test("native controls are independent of Markdown ownership and exclude system/admin/plugin/unverified entries", async (t) => {
  const f = await fixture(t);
  const shared = await f.put(".agents/skills/shared/SKILL.md");
  const system = await f.put(".codex/skills/.system/builtin/SKILL.md");
  const plugin = await f.put(".codex/plugins/demo/skills/plugin/SKILL.md");
  await f.put(".codex/skills/unverified/SKILL.md");
  f.entries.push({ ...f.entries[0], path: shared, name: "shared" }, { ...f.entries[0], path: system, scope: "system" },
    { ...f.entries[0], path: plugin, pluginId: "demo" }, { ...f.entries[0], path: "/etc/fixture/SKILL.md", scope: "admin" });
  const listed = await f.service.list("codex");
  const sharedRow = listed.skills.find((row) => row.path === shared);
  assert.equal(sharedRow.canEdit, false); assert.equal(sharedRow.canToggle, true);
  await f.service.setState("codex", sharedRow.id, sharedRow.stateRevision, false);
  for (const row of listed.skills.filter((row) => ![shared, f.file].includes(row.path))) {
    assert.equal(row.canToggle, false); assert.equal(row.stateRevision, null);
    await assert.rejects(f.service.setState("codex", row.id, "a".repeat(64), false), { code: "unsupported" });
  }
  assert.equal(f.writes.length, 1);
});

test("stale settings, availability and retargeted links reject writes and require explicit revisions", async (t) => {
  const f = await fixture(t);
  let initial = await f.row();
  for (const revision of [null, "bad"]) await assert.rejects(f.service.setState("codex", initial.id, revision, false), { code: "conflict" });
  await fs.appendFile(f.config, '# An unrelated external setting change\n');
  await assert.rejects(f.service.setState("codex", initial.id, initial.stateRevision, false), { code: "conflict" });
  initial = await f.row(); f.entries[0].enabled = false;
  await assert.rejects(f.service.setState("codex", initial.id, initial.stateRevision, true), { code: "conflict" });
  initial = await f.row();
  const target = await f.put("other/SKILL.md"); await fs.unlink(f.file); await fs.symlink(target, f.file);
  await assert.rejects(f.service.setState("codex", initial.id, initial.stateRevision, true), { code: "conflict" });
  await assert.rejects(f.service.setState("codex", initial.id, initial.stateRevision, "false"), { code: "invalid" });
  await assert.rejects(f.service.setState("claude", initial.id, initial.stateRevision, true), { code: "unsupported" });
  await assert.rejects(f.service.setState("codex", "/arbitrary/path", initial.stateRevision, true), { code: "invalid" });
  await assert.rejects(f.service.setState("codex", "0".repeat(32), initial.stateRevision, true), { code: "missing" });
  assert.equal(f.writes.length, 0);
});

test("concurrent native changes serialize across service instances sharing a settings file", async (t) => {
  const f = await fixture(t);
  const second = createSkillsService(f.options), initial = await f.row();
  const results = await Promise.allSettled([f.service.setState("codex", initial.id, initial.stateRevision, false), second.setState("codex", initial.id, initial.stateRevision, false)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "conflict");
  assert.equal(f.writes.length, 1);
});

test("failed or unverified native writes clear old state and never report success", async (t) => {
  const f = await fixture(t);
  let failList = false;
  for (const mode of ["unsupported", "malformed", "not-applied", "failed-verification"]) {
    const service = createSkillsService({ ...f.options,
      nativeCodex: async () => { if (failList) throw new Error("Discovery unavailable"); return f.options.nativeCodex(); },
      nativeCodexWrite: async (input) => {
        if (mode === "unsupported") throw new Error("This version cannot write settings");
        if (mode === "malformed") return {};
        if (mode === "failed-verification") { await f.options.nativeCodexWrite(input); failList = true; }
        return { effectiveEnabled: false };
      },
    });
    const initial = await f.row(service);
    await assert.rejects(service.setState("codex", initial.id, initial.stateRevision, false), /cannot write|did not confirm|could not be verified/);
    const after = await service.list("codex");
    assert.equal(after.coverage, failList ? "files" : "native");
  }
});

test("settings races during discovery disable controls while preserving native inventory", async (t) => {
  const f = await fixture(t);
  const service = createSkillsService({ ...f.options, nativeCodex: async () => {
    await fs.appendFile(f.config, "# concurrent change\n"); return f.options.nativeCodex();
  } });
  const listed = await service.list("codex");
  assert.equal(listed.coverage, "native"); assert.equal(listed.skills[0].canToggle, false);
  assert.match(listed.warnings.join(" "), /settings changed/);
});

test("settings changed after fresh discovery are checked again before the native write", async (t) => {
  const f = await fixture(t);
  let harnessCalls = 0;
  const service = createSkillsService({ ...f.options, getHarness: async () => {
    // Initial inventory, mutation inventory, then writer executable resolution.
    if (++harnessCalls === 3) await fs.appendFile(f.config, "# external write immediately before mutation\n");
    return f.options.getHarness();
  } });
  const initial = await f.row(service);
  await assert.rejects(service.setState("codex", initial.id, initial.stateRevision, false), { code: "conflict" });
  assert.equal(f.writes.length, 0);
});

test("native settings snapshots bound reads, reject FIFOs/dangling links and retain discovery when settings are unsafe", async (t) => {
  const f = await fixture(t);
  assert.match(await configSnapshot(path.join(f.home, "missing"), fs), /^[a-f0-9]{64}$/);
  const linked = path.join(f.home, "dangling"); await fs.symlink("missing", linked);
  await assert.rejects(configSnapshot(linked, fs), /could not be checked/);
  await fs.writeFile(f.config, "x".repeat(1024 * 1024 + 1));
  await assert.rejects(configSnapshot(f.config, { ...fs, open: () => assert.fail("oversized settings opened") }), /1 MiB/);
  const listed = await f.service.list("codex");
  assert.equal(listed.coverage, "native"); assert.equal(listed.skills[0].canToggle, false);
  const notRegular = { ...fs, stat: async () => ({ isFile: () => false }) };
  await assert.rejects(configSnapshot(f.config, notRegular), /regular file/);
});

test("native settings RPC only writes the selected path and validates native acknowledgements", async (t) => {
  const f = await fixture(t);
  const executable = await f.put("fake-codex", `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
 else if(m.method==='initialized') {}
 else if(m.method==='skills/config/write') {
  fs.writeFileSync(process.env.CAPTURE, JSON.stringify(m.params));
  const result=JSON.parse(process.env.RESULT);
  process.stdout.write(JSON.stringify(result.request ? {id:99,method:'exec/approval'} : result.error ? {id:m.id,error:{code:-32601}} : {id:m.id,result})+'\\n');
 } else process.exit(10);
});
`);
  await fs.chmod(executable, 0o700);
  const capture = path.join(f.home, "request.json");
  const call = (result) => writeCodexSkillConfig({ executable, home: f.home, path: f.file, enabled: false, env: { ...process.env, CAPTURE: capture, RESULT: JSON.stringify(result) } });
  assert.deepEqual(await call({ effectiveEnabled: false }), { effectiveEnabled: false });
  assert.deepEqual(JSON.parse(await fs.readFile(capture, "utf8")), { path: f.file, enabled: false });
  for (const result of [{}, { effectiveEnabled: true }, { effectiveEnabled: "false" }, { error: true }, { request: true }]) {
    await assert.rejects(call(result), /did not confirm|could not save|unexpected action/);
  }
});
