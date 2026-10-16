import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { createSkillsService } from "../docker/setup/skills.mjs";

const markdown = (name, body = "Use the project conventions.") => `---\nname: '${name}'\ndescription: >\n  A useful\n  local workflow.\n---\n${body}\n`;
async function fixture(t, io = fs) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skill-files-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const put = async (relative, content) => { const file = path.join(home, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return file; };
  const service = createSkillsService({ home, env: {}, io });
  const read = async (provider, name) => { const row = (await service.list(provider)).skills.find((skill) => skill.name === name); assert.ok(row, name); return service.read(provider, row.id); };
  return { home, put, service, read };
}

test("creation uses native user folders, validates Markdown and never overwrites an installation", async (t) => {
  const f = await fixture(t);
  for (const provider of ["claude", "codex", "opencode"]) {
    assert.equal((await f.service.list(provider)).canCreate, true);
    const result = await f.service.create(provider, "local-one", markdown("local-one"));
    assert.equal(await fs.readFile(result.path, "utf8"), markdown("local-one"));
    assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
    const row = (await f.service.list(provider)).skills.find((entry) => entry.path === result.path);
    const detail = await f.service.read(provider, row.id);
    assert.equal(detail.canEdit, true); assert.equal(detail.canRemove, true); assert.ok(detail.revision); assert.ok(detail.removalRevision);
    await assert.rejects(f.service.create(provider, "local-one", markdown("local-one", "Replacement")), { code: "conflict" });
    assert.equal(await fs.readFile(result.path, "utf8"), markdown("local-one"));
  }
  for (const slug of ["../escape", "UPPER", "a--b", "", "x".repeat(65)]) await assert.rejects(f.service.create("claude", slug, markdown(slug)), { code: "invalid" });
  await assert.rejects(f.service.create("claude", "different", markdown("name")), { code: "invalid" });
  await assert.rejects(f.service.create("claude", "new", "# No frontmatter"), { code: "invalid" });
  await assert.rejects(f.service.create("claude", "new", markdown("new", "é".repeat(32768))), { code: "too_large" });
  await assert.rejects(f.service.create("cursor", "new", markdown("new")), { code: "unsupported" });
});

test("edits preserve supporting files, permission bits and user symlink chains", async (t) => {
  const f = await fixture(t);
  const target = await f.put("external/source.md", markdown("linked")); await fs.chmod(target, 0o640);
  const link = await f.put(".claude/skills/linked/SKILL.md", "placeholder"); await fs.unlink(link);
  const middle = path.join(f.home, "external/middle.md"); await fs.symlink("source.md", middle);
  await fs.symlink(path.relative(path.dirname(link), middle), link);
  const script = await f.put(".claude/skills/linked/scripts/run.sh", "#!/bin/sh\necho check\n"); await fs.chmod(script, 0o755);
  const before = await f.read("claude", "linked");
  await f.service.save("claude", before.id, before.revision, markdown("linked", "Updated instructions."));
  assert.equal(await fs.readFile(target, "utf8"), markdown("linked", "Updated instructions."));
  assert.ok((await fs.lstat(link)).isSymbolicLink()); assert.equal(await fs.readlink(middle), "source.md");
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640); assert.equal((await fs.stat(script)).mode & 0o777, 0o755);
  assert.equal(await fs.readFile(script, "utf8"), "#!/bin/sh\necho check\n");
  await assert.rejects(f.service.save("claude", before.id, before.revision, markdown("linked", "Stale")), { code: "conflict" });
});

test("external changes and concurrent saves reject stale drafts", async (t) => {
  const f = await fixture(t);
  const file = await f.put(".claude/skills/one/SKILL.md", markdown("one"));
  const initial = await f.read("claude", "one"); await fs.writeFile(file, markdown("one", "External edit"));
  await assert.rejects(f.service.save("claude", initial.id, initial.revision, markdown("one", "Draft")), { code: "conflict" });
  const current = await f.read("claude", "one");
  const results = await Promise.allSettled([f.service.save("claude", current.id, current.revision, markdown("one", "A")), f.service.save("claude", current.id, current.revision, markdown("one", "B"))]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "conflict");
});

test("failed atomic publication preserves the existing file and clears its own temporary file", async (t) => {
  const io = { ...fs, rename: async () => { throw Object.assign(new Error("publication failed"), { code: "EIO" }); } };
  const f = await fixture(t, io); const file = await f.put(".claude/skills/one/SKILL.md", markdown("one"));
  const initial = await f.read("claude", "one");
  await assert.rejects(f.service.save("claude", initial.id, initial.revision, markdown("one", "Draft")), /publication failed/);
  assert.equal(await fs.readFile(file, "utf8"), markdown("one"));
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["SKILL.md"]);
});

test("removal fingerprints supporting files, then removes only the confirmed local folder", async (t) => {
  const f = await fixture(t);
  const skill = await f.put(".claude/skills/one/SKILL.md", markdown("one"));
  const supporting = await f.put(".claude/skills/one/references/check.md", "First reference");
  const other = await f.put(".claude/skills/two/SKILL.md", markdown("two"));
  const first = await f.read("claude", "one"); await fs.writeFile(supporting, "Changed reference");
  await assert.rejects(f.service.remove("claude", first.id, first.revision, first.removalRevision), { code: "conflict" });
  assert.equal(await fs.readFile(skill, "utf8"), markdown("one"));
  const current = await f.read("claude", "one");
  await f.service.remove("claude", current.id, current.revision, current.removalRevision);
  await assert.rejects(fs.lstat(path.dirname(skill)), { code: "ENOENT" });
  assert.equal(await fs.readFile(other, "utf8"), markdown("two"));
  assert.ok(!(await fs.readdir(path.dirname(path.dirname(skill)))).some((file) => file.startsWith(".t3-skill-remove")));
});

test("removing file or directory links preserves external targets and their supporting files", async (t) => {
  const f = await fixture(t);
  const target = await f.put("external/directory/SKILL.md", markdown("linked"));
  const refs = await f.put("external/directory/reference.md", "Keep this");
  await fs.mkdir(path.join(f.home, ".claude/skills"), { recursive: true });
  const link = path.join(f.home, ".claude/skills/linked"); await fs.symlink(path.dirname(target), link);
  let current = await f.read("claude", "linked"); assert.equal(current.removalKind, "link");
  await f.service.remove("claude", current.id, current.revision, current.removalRevision);
  await assert.rejects(fs.lstat(link), { code: "ENOENT" }); assert.equal(await fs.readFile(refs, "utf8"), "Keep this");
  await fs.mkdir(link); await fs.symlink(target, path.join(link, "SKILL.md"));
  current = await f.read("claude", "linked"); assert.equal(current.removalKind, "file");
  await f.service.remove("claude", current.id, current.revision, current.removalRevision);
  assert.ok((await fs.stat(link)).isDirectory()); assert.equal(await fs.readFile(target, "utf8"), markdown("linked"));
});

test("shared, plugin, system and package-owned installations remain read-only", async (t) => {
  const f = await fixture(t);
  await f.put(".agents/skills/shared/SKILL.md", markdown("shared"));
  await f.put(".codex/skills/.system/system-one/SKILL.md", markdown("system-one"));
  const plugin = await f.put(".codex/plugins/package/skills/plugin-one/SKILL.md", markdown("plugin-one"));
  await fs.symlink(path.dirname(plugin), path.join(f.home, ".codex/skills/plugin-one"));
  await f.put(".codex/skills/tracked/SKILL.md", markdown("tracked"));
  await f.put(".agents/.skill-lock.json", JSON.stringify({ version: 3, skills: { tracked: { source: "owner/repo" } } }));
  for (const name of ["shared", "system-one", "plugin-one", "tracked"]) {
    const row = await f.read("codex", name); assert.equal(row.canEdit, false, name); assert.equal(row.canRemove, false, name);
    await assert.rejects(f.service.save("codex", row.id, row.revision, markdown(name, "Edit")), { code: "unsupported" });
  }
  await fs.mkdir(path.join(f.home, ".claude")); await fs.symlink(path.join(f.home, ".agents/skills"), path.join(f.home, ".claude/skills"));
  assert.equal((await f.service.list("claude")).canCreate, false);
  await assert.rejects(f.service.create("claude", "new", markdown("new")), { code: "unsupported" });
});

test("nested installations are editable but cannot be recursively removed by their parent", async (t) => {
  const f = await fixture(t);
  await f.put(".claude/skills/parent/SKILL.md", markdown("parent")); await f.put(".claude/skills/parent/nested/SKILL.md", markdown("nested"));
  const parent = await f.read("claude", "parent"); assert.equal(parent.canEdit, true); assert.equal(parent.canRemove, false);
  await assert.rejects(f.service.remove("claude", parent.id, parent.revision, "forged"), { code: "unsupported" });
});

test("a changed staged removal is rolled back without losing the new supporting file", async (t) => {
  let changed = false;
  const io = { ...fs, rename: async (from, to) => {
    await fs.rename(from, to);
    if (!changed && path.basename(to).startsWith(".t3-skill-remove-")) { changed = true; await fs.writeFile(path.join(to, "new-reference.md"), "Concurrent addition"); }
  } };
  const f = await fixture(t, io); const file = await f.put(".claude/skills/one/SKILL.md", markdown("one"));
  const current = await f.read("claude", "one");
  await assert.rejects(f.service.remove("claude", current.id, current.revision, current.removalRevision), { code: "conflict" });
  assert.equal(await fs.readFile(file, "utf8"), markdown("one"));
  assert.equal(await fs.readFile(path.join(path.dirname(file), "new-reference.md"), "utf8"), "Concurrent addition");
});
