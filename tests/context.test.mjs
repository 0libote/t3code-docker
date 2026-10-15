import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { agentsMdTargets, agentsMdPathFor, validateAgentsMd, readAgentsMd, writeAgentsMd, reconcileAgentsMd, contextStatus } from "../docker/setup/context.mjs";

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
  assert.deepEqual(Object.keys(status), ["agentsMd"]);
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
