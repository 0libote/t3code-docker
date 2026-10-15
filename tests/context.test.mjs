import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { agentsMdTargets, agentsMdPathFor, validateAgentsMd, readAgentsMd, writeAgentsMd, reconcileAgentsMd, contextStatus, readProviderAgentsMd, writeProviderAgentsMd } from "../docker/setup/context.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "t3-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, baseDir: path.join(root, ".t3"), home: path.join(root, "home") };
}

test("native instruction targets respect provider environment overrides", () => {
  assert.deepEqual(agentsMdTargets({}, "/home/t3"), [
    { provider: "claude", path: "/home/t3/.claude/CLAUDE.md" },
    { provider: "codex", path: "/home/t3/.codex/AGENTS.md" },
    { provider: "opencode", path: "/home/t3/.config/opencode/AGENTS.md" },
  ]);
  assert.deepEqual(agentsMdTargets({ CLAUDE_CONFIG_DIR: "/claude", CODEX_HOME: "/codex", XDG_CONFIG_HOME: "/config" }).map((t) => t.path),
    ["/claude/CLAUDE.md", "/codex/AGENTS.md", "/config/opencode/AGENTS.md"]);
});

test("validation rejects blank and oversized UTF-8 content", () => {
  assert.equal(validateAgentsMd("  ").ok, false);
  assert.equal(validateAgentsMd("é".repeat(32769)).ok, false);
  assert.equal(validateAgentsMd("é".repeat(32768)).bytes, 65536);
});

test("saving twice updates existing provider links without replacing them", async (t) => {
  const f = await fixture(t);
  assert.equal((await readAgentsMd(fs, f.baseDir)).present, false);
  await writeAgentsMd(fs, f.baseDir, "# First\n");
  assert.equal((await reconcileAgentsMd(fs, f.baseDir, f)).linked.length, 3);
  await writeAgentsMd(fs, f.baseDir, "# Second\n");
  const again = await reconcileAgentsMd(fs, f.baseDir, f);
  assert.ok(again.linked.every((target) => target.state === "exists"));
  for (const target of agentsMdTargets({}, f.home)) {
    assert.ok((await fs.lstat(target.path)).isSymbolicLink());
    assert.equal(await fs.readFile(target.path, "utf8"), "# Second\n");
  }
  assert.equal((await fs.stat(agentsMdPathFor(f.baseDir))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(f.home, ".claude/AGENTS.md")), { code: "ENOENT" });
  const status = await contextStatus(fs, f);
  assert.deepEqual(Object.keys(status), ["agentsMd", "providers"]);
  assert.deepEqual(status.providers, []);
  assert.equal(status.agentsMd.bytes, 9);
  assert.ok(!("content" in status.agentsMd));
});

test("global reconciliation preserves real files and absolute, relative and dangling user symlinks", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, "# Shared");
  const userFile = path.join(f.root, "user.md");
  await fs.writeFile(userFile, "# User");
  for (const kind of ["file", "absolute", "relative", "dangling"]) {
    for (const target of agentsMdTargets({}, f.home)) {
      await fs.mkdir(path.dirname(target.path), { recursive: true });
      if (kind === "file") await fs.writeFile(target.path, "# Existing");
      else await fs.symlink(kind === "relative" ? path.relative(path.dirname(target.path), userFile) : kind === "dangling" ? path.join(f.root, "missing.md") : userFile, target.path);
    }
    const result = await reconcileAgentsMd(fs, f.baseDir, f);
    assert.equal(result.skipped.length, 3, kind);
    for (const target of agentsMdTargets({}, f.home)) {
      if (kind === "file") assert.equal(await fs.readFile(target.path, "utf8"), "# Existing");
      else {
        assert.ok((await fs.lstat(target.path)).isSymbolicLink());
        assert.notEqual(await fs.readlink(target.path), agentsMdPathFor(f.baseDir));
      }
      await fs.unlink(target.path);
    }
  }
  assert.equal(await fs.readFile(userFile, "utf8"), "# User");
});

test("canonical symlinks and invalid saves preserve existing instructions", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "user.md"), canonical = agentsMdPathFor(f.baseDir);
  await fs.mkdir(path.dirname(canonical), { recursive: true });
  await fs.writeFile(target, "# User");
  await fs.symlink(target, canonical);
  assert.equal((await writeAgentsMd(fs, f.baseDir, "# Replacement")).ok, false);
  assert.equal(await fs.readlink(canonical), target);
  assert.equal(await fs.readFile(target, "utf8"), "# User");
  await fs.unlink(canonical);
  await writeAgentsMd(fs, f.baseDir, "# Original");
  assert.equal((await writeAgentsMd(fs, f.baseDir, "")).ok, false);
  assert.equal((await readAgentsMd(fs, f.baseDir)).content, "# Original");
});

test("a failed atomic rename preserves instructions and cleans up its temporary file", async (t) => {
  const f = await fixture(t);
  await writeAgentsMd(fs, f.baseDir, "# Original");
  const broken = { ...fs, rename: async () => { throw new Error("rename failed"); } };
  await assert.rejects(writeAgentsMd(broken, f.baseDir, "# Replacement"), /rename failed/);
  assert.equal((await readAgentsMd(fs, f.baseDir)).content, "# Original");
  assert.deepEqual(await fs.readdir(path.dirname(agentsMdPathFor(f.baseDir))), ["AGENTS.md"]);
});

test("read errors remain visible in instruction status", async (t) => {
  const f = await fixture(t);
  const broken = { ...fs, readFile: async () => { throw new Error("permission denied"); } };
  assert.match((await contextStatus(broken, f)).agentsMd.error, /permission denied/);
});

const ctx = vm.createContext({ URL });
vm.runInContext(`${readFileSync(new URL("../docker/setup/client/model.js", import.meta.url), "utf8")}\nthis.M = T3Model;`, ctx);
const M = ctx.M;
const ui = { busy: new Map(), pending: new Map(), notices: new Map() };

test("Context offers only global instructions and never adds attention", () => {
  const status = { server: { ok: true }, harnesses: [], toolchains: [], sessions: [], pairings: [], operations: {} };
  assert.equal(M.contextView(status).present, false);
  assert.equal(M.navBadges(status, null, ui).context, null);
  const row = M.contextAgentsMdRow(status);
  assert.equal(row.action.cmd, "context.edit");
  assert.equal(row.attention, false);
  const items = M.paletteItems(status, null, ui, Date.now()).filter((i) => i.group === "Context");
  assert.ok(M.paletteItems(status, null, ui, Date.now()).some((i) => i.label === "Edit global AGENTS.md…"));
  assert.ok(items.every((i) => !/skill|setup|project/i.test(i.label)));
});

test("existing provider files appear in Context and edits preserve their permissions and separation", async (t) => {
  const f = await fixture(t);
  for (const target of agentsMdTargets({}, f.home)) {
    await fs.mkdir(path.dirname(target.path), { recursive: true });
    await fs.writeFile(target.path, `# Existing ${target.provider}`, { mode: 0o664 });
    await fs.chmod(target.path, 0o664);
  }
  const before = await contextStatus(fs, f);
  assert.equal(before.agentsMd.present, false);
  assert.deepEqual(before.providers.map((p) => p.provider), ["claude", "codex", "opencode"]);
  assert.ok(before.providers.every((p) => !('content' in p)));
  for (const target of agentsMdTargets({}, f.home)) {
    const read = await readProviderAgentsMd(fs, target.provider, f);
    assert.equal(read.content, `# Existing ${target.provider}`);
    const saved = await writeProviderAgentsMd(fs, target.provider, `# Edited ${target.provider}`, read.revision, f);
    assert.equal(saved.ok, true);
    assert.equal(await fs.readFile(target.path, "utf8"), `# Edited ${target.provider}`);
    assert.equal((await fs.stat(target.path)).mode & 0o777, 0o664);
  }
  assert.equal((await readAgentsMd(fs, f.baseDir)).present, false);
});

test("editing an existing provider symlink writes through its chain, including with custom config paths", async (t) => {
  const f = await fixture(t);
  const options = { home: f.home, env: { CODEX_HOME: path.join(f.root, 'custom-codex'), CLAUDE_CONFIG_DIR: path.join(f.root, 'custom-claude'), XDG_CONFIG_HOME: path.join(f.root, 'custom-config') } };
  const shared = path.join(f.root, "user-shared.md");
  const middle = path.join(f.root, "middle.md");
  await fs.writeFile(shared, "# Existing user instructions");
  await fs.symlink(path.basename(shared), middle);
  for (const target of agentsMdTargets(options.env, f.home)) {
    await fs.mkdir(path.dirname(target.path), { recursive: true });
    await fs.symlink(path.relative(path.dirname(target.path), middle), target.path);
  }
  await writeAgentsMd(fs, f.baseDir, "# Managed shared file");
  assert.equal((await reconcileAgentsMd(fs, f.baseDir, options)).skipped.length, 3);
  for (const target of agentsMdTargets(options.env, f.home)) {
    const link = await fs.readlink(target.path);
    const read = await readProviderAgentsMd(fs, target.provider, options);
    assert.equal(read.resolvedPath, shared);
    assert.equal((await writeProviderAgentsMd(fs, target.provider, `# Edited ${target.provider}`, read.revision, options)).ok, true);
    assert.equal(await fs.readlink(target.path), link);
    assert.equal(await fs.readlink(middle), path.basename(shared));
    assert.equal(await fs.readFile(shared, "utf8"), `# Edited ${target.provider}`);
    assert.equal((await readAgentsMd(fs, f.baseDir)).content, "# Managed shared file");
  }
});

test("provider edits reject external changes, link retargeting and simultaneous saves from the same revision", async (t) => {
  const f = await fixture(t);
  const target = agentsMdTargets({}, f.home)[0].path;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "# Original");
  let read = await readProviderAgentsMd(fs, 'claude', f);
  await fs.writeFile(target, "# Changed outside Context");
  assert.equal((await writeProviderAgentsMd(fs, 'claude', '# Draft', read.revision, f)).code, 'conflict');
  assert.equal(await fs.readFile(target, 'utf8'), '# Changed outside Context');
  read = await readProviderAgentsMd(fs, 'claude', f);
  const saves = await Promise.all(['# A', '# B'].map((content) => writeProviderAgentsMd(fs, 'claude', content, read.revision, f)));
  assert.equal(saves.filter((save) => save.ok).length, 1);
  assert.equal(saves.filter((save) => save.code === 'conflict').length, 1);
  const other = path.join(f.root, 'other.md');
  await fs.writeFile(other, await fs.readFile(target));
  read = await readProviderAgentsMd(fs, 'claude', f);
  await fs.unlink(target);
  await fs.symlink(other, target);
  assert.equal((await writeProviderAgentsMd(fs, 'claude', '# Draft', read.revision, f)).code, 'conflict');
});

test("unknown, absent, dangling and directory provider targets cannot be overwritten", async (t) => {
  const f = await fixture(t);
  assert.equal((await readProviderAgentsMd(fs, '../escape', f)).ok, false);
  assert.equal((await writeProviderAgentsMd(fs, '../escape', '# Draft', 'fake', f)).ok, false);
  assert.equal((await readProviderAgentsMd(fs, 'codex', f)).code, 'missing');
  const target = agentsMdTargets({}, f.home).find((p) => p.provider === 'codex').path;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const missing = path.join(f.root, 'missing.md');
  await fs.symlink(missing, target);
  assert.match((await contextStatus(fs, f)).providers[0].error, /no longer exists/);
  assert.equal((await writeProviderAgentsMd(fs, 'codex', '# Draft', 'fake', f)).ok, false);
  assert.equal(await fs.readlink(target), missing);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  await fs.unlink(target);
  await fs.mkdir(target);
  assert.equal((await writeProviderAgentsMd(fs, 'codex', '# Draft', 'fake', f)).ok, false);
  assert.deepEqual(await fs.readdir(target), []);
});

test("provider view rows and palette expose each discovered file without adding attention", () => {
  const status = { context: { providers: [{ provider: 'claude', path: '/custom/CLAUDE.md', bytes: 12 }] } };
  const row = M.contextProviderRows(status)[0];
  assert.equal(row.name, 'Claude Code instructions');
  assert.equal(row.status.text, '/custom/CLAUDE.md');
  assert.equal(row.action.cmd, 'context.provider.edit');
  assert.equal(row.attention, false);
  assert.ok(M.paletteItems(status, null, ui, Date.now()).some((i) => i.cmd.cmd === 'context.provider.edit' && i.cmd.id === 'claude'));
});
