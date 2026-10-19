import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSkillsService } from "../docker/setup/skills.mjs";
import { ORIGIN_FILE } from "../docker/setup/skills/origins.mjs";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skill-updates-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let pause = null;
  let guide = "Original guide", executable = false, failure = false, removed = false, calls = 0;
  const source = "https://github.com/example/skills/tree/main/skills/review";
  const content = "---\nname: review\ndescription: Review changes\n---\nInstructions\n";
  const resolveSource = async (value) => {
    assert.equal(value, source); calls++;
    if (pause) await pause;
    if (failure) throw Error("Repository unavailable");
    return { source, sourceType: "git", warnings: [], skills: removed ? [] : [{ name: "review", description: "Review changes", content, files: [
      { name: "SKILL.md", data: Buffer.from(content), mode: 0o600 },
      { name: "references/guide.md", data: Buffer.from(guide), mode: executable ? 0o700 : 0o600 },
    ] }] };
  };
  const options = { home, env: {}, resolveSource };
  const service = createSkillsService(options);
  const install = async (replace = false) => {
    const preview = await service.previewSource(source);
    const plan = await service.planImport(preview.previewId, ["review"], ["claude"]);
    return service.installImport(preview.previewId, plan.planId, replace);
  };
  await install();
  const row = async () => (await service.list("claude", { refresh: true })).skills[0];
  return { home, service, options, source, install, row, pause: (promise) => { pause = promise; }, calls: () => calls,
    change: () => { guide = "New upstream guide"; }, chmod: () => { executable = true; }, fail: () => { failure = true; }, remove: () => { removed = true; } };
}

test("repository origins survive restarts; checks detect supporting-file updates without writing skills", async (t) => {
  const f = await fixture(t), row = await f.row(), calls = f.calls();
  assert.equal(row.origin.source, f.source);
  const restarted = createSkillsService(f.options);
  assert.equal((await restarted.list("claude")).skills[0].origin.source, f.source);
  assert.equal(f.calls(), calls, "inventory never contacts the repository");
  assert.equal((await f.service.checkUpdate("claude", row.id)).update.status, "current");
  const local = path.join(path.dirname(row.path), "references/guide.md");
  await fs.writeFile(local, "Local edits");
  assert.equal((await f.service.checkUpdate("claude", row.id)).update.status, "current", "local changes do not masquerade as upstream updates");
  f.change();
  assert.equal((await f.service.checkUpdate("claude", row.id)).update.status, "available");
  assert.equal((await f.row()).update.status, "available");
  assert.equal(await fs.readFile(local, "utf8"), "Local edits");
  await assert.rejects(f.install(), /Confirm replacement/);
  assert.equal((await f.install(true)).results[0].status, "installed");
  assert.equal((await f.row()).update, undefined, "the old check does not attach to the new snapshot");
  assert.equal((await f.service.checkUpdate("claude", row.id)).update.status, "current");
  assert.equal(await fs.readFile(local, "utf8"), "New upstream guide");
});

test("file executability changes count as updates; unavailable and removed sources report errors", async (t) => {
  const f = await fixture(t), row = await f.row();
  f.chmod(); assert.equal((await f.service.checkUpdate("claude", row.id)).update.status, "available");
  f.remove(); assert.match((await f.service.checkUpdate("claude", row.id)).update.error, /renamed or removed/);
  f.fail(); assert.match((await f.service.checkUpdate("claude", row.id)).update.error, /Repository unavailable/);
});

test("untracked, malformed and linked provenance cannot trigger repository checks", async (t) => {
  const f = await fixture(t), row = await f.row();
  const file = path.join(path.dirname(row.path), ORIGIN_FILE), calls = f.calls();
  await fs.writeFile(file, JSON.stringify({ version: 1, source: "/etc", name: "review", fingerprint: "a".repeat(64) }));
  assert.equal((await f.row()).origin, undefined);
  await assert.rejects(f.service.checkUpdate("claude", row.id), /no tracked repository/);
  await fs.rm(file); await fs.symlink("/etc/passwd", file);
  assert.equal((await f.row()).origin, undefined);
  assert.equal(f.calls(), calls);
});


test("concurrent checks share a fetch and discard results for a removed installation", { timeout: 3000 }, async (t) => {
  const f = await fixture(t), row = await f.row(), before = f.calls();
  let release;
  f.pause(new Promise((resolve) => { release = resolve; }));
  const first = f.service.checkUpdate("claude", row.id);
  const second = f.service.checkUpdate("claude", row.id);
  // Both reads share the inventory; wait until the source fetch starts.
  while (f.calls() === before) await new Promise((resolve) => setTimeout(resolve, 5));
  await fs.rm(path.join(path.dirname(row.path), ORIGIN_FILE));
  release();
  const results = await Promise.allSettled([first, second]);
  assert.equal(f.calls(), before + 1);
  assert.ok(results.every((entry) => entry.status === "rejected"));
  assert.equal((await f.row()).update, undefined);
});


test("source-supplied tracking metadata cannot impersonate a repository install", async (t) => {
  const f = await fixture(t), row = await f.row();
  const local = createSkillsService({ home: f.home, env: {} });
  const preview = await local.previewSource(path.dirname(row.path));
  const plan = await local.planImport(preview.previewId, ["review"], ["cursor"]);
  const result = await local.installImport(preview.previewId, plan.planId);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].error, /reserved skill tracking metadata/);
  assert.equal((await local.list("cursor")).skills.filter((skill) => skill.source === "Provider").length, 0);
});
