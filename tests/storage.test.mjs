import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { createStorageManager } from "../docker/harness/storage/manager.mjs";
import { checkCachePath, measureStorage, buildsOrInstallsRunning } from "../docker/harness/storage/system.mjs";
import { DEFAULT_POLICY, GB, readPolicy, writeStorageJson } from "../docker/harness/storage/policy.mjs";
import { runStorageCli } from "../docker/harness/storage/cli.mjs";

const idle = async () => ({ complete: true, processes: [] });
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-storage-test-"));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace");
  const go = path.join(home, ".cache/go-build"), npm = path.join(home, ".npm");
  const sentinels = [path.join(workspace, "source.txt"), path.join(home, ".t3/userdata/history.db"), path.join(home, ".t3/agents/credentials"), path.join(npm, "_npx/tool"), path.join(home, ".t3/backups/backup.db")];
  for (const file of [...sentinels, path.join(go, "aa/archive"), path.join(npm, "_cacache/content/package")]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.alloc(8192, 65));
  }
  const calls = [];
  const env = { HOME: home, T3CODE_HOME: path.join(home, ".t3"), MISE_STATE_DIR: path.join(home, ".local/state/mise") };
  const base = { home, workspace, temporary: path.join(root, "tmp"), env, intervalMs: 0, refreshAfterCleanup: false,
    processes: idle, detectCaches: async () => ({ go: { path: go, executable: "/bin/go" }, npm: { path: npm, executable: "/bin/node", argsPrefix: ["/bin/npm"] } }),
    run: async (args, options) => {
      calls.push({ args, options });
      const target = args[0] === "/bin/go" ? go : path.join(npm, "_cacache");
      await fs.rm(target, { recursive: true, force: true });
      return { code: 0, stdout: "", stderr: "" };
    }, ...overrides };
  const manager = createStorageManager(base);
  t.after(async () => { manager.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await manager.ready;
  return { manager, root, home, workspace, go, npm, env, calls, sentinels, base };
}

test("allocated inventory is cached; polling never detects tools or traverses folders", async (t) => {
  const f = await fixture(t);
  let detections = 0, scans = 0;
  const manager = createStorageManager({ ...f.base, detectCaches: async (...args) => { detections++; return f.base.detectCaches(...args); }, measure: async (...args) => { scans++; return measureStorage(...args); } });
  t.after(() => manager.stop());
  const a = manager.refresh(), b = manager.refresh();
  assert.equal(a, b);
  await a;
  const before = scans;
  for (let i = 0; i < 5; i++) await manager.status();
  assert.equal(scans, before); assert.equal(detections, 1);
  assert.ok(manager.snapshot().cleanableBytes >= 16384);
  assert.equal(manager.snapshot().policy.automatic, false);
});

test("preview preserves every file; native cleanup clears only chosen caches and records effects", async (t) => {
  const f = await fixture(t);
  await f.manager.refresh();
  assert.ok((await f.manager.clean(["go", "npm"], { dryRun: true })).estimatedBytes > 0);
  assert.equal(f.calls.length, 0);
  const starts = [];
  const result = await f.manager.clean(["go", "npm"], { onStarted: (op) => starts.push(op) });
  assert.equal(result.ok, true); assert.ok(result.reclaimedBytes >= 16384);
  assert.equal(starts.length, 1); assert.equal(starts[0].state, "running");
  assert.deepEqual(f.calls.map((c) => c.args), [["/bin/go", "clean", "-cache"], ["/bin/node", "/bin/npm", "cache", "clean", "--force", "--cache", f.npm]]);
  assert.equal(f.calls[0].options.env.GOCACHE, f.go);
  for (const file of f.sentinels) assert.equal((await fs.readFile(file)).length, 8192);
  assert.equal((await f.manager.status()).operation.state, "succeeded");
  assert.equal(f.manager.snapshot().cleanableBytes, 0);
});

test("untrusted cache IDs and running builds fail before any command or running job is recorded", async (t) => {
  const f = await fixture(t, { processes: async () => ({ complete: true, processes: [{ args: ["go", "build"], executable: "/bin/go" }] }) });
  for (const ids of [["all"], ["../../source"], ["go", "go"], [], "go"]) assert.equal((await f.manager.clean(ids)).code, "invalid-cache");
  assert.equal((await f.manager.clean(["go"])).code, "busy");
  assert.equal(f.calls.length, 0); assert.equal(f.manager.snapshot().operation, null);
});

test("unreadable process activity fails closed", async (t) => {
  const f = await fixture(t, { processes: async () => ({ complete: false, processes: [] }) });
  assert.equal((await f.manager.clean(["npm"])).code, "unavailable");
  assert.equal(f.calls.length, 0);
});

test("cleanup shares the cross-process install lock", async (t) => {
  let release, started;
  const wait = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { run: async () => { started(); await wait; return { code: 0 }; } });
  const second = createStorageManager(f.base); t.after(() => second.stop());
  const first = f.manager.clean(["go"]);
  await began;
  assert.equal((await second.clean(["npm"])).code, "busy");
  release(); assert.equal((await first).ok, true);
  assert.equal((await second.clean(["npm"])).ok, true);
});

test("linked cache ancestors, project caches, credentials, and custom external paths cannot be cleared", async (t) => {
  const f = await fixture(t);
  const guard = (target) => checkCachePath(target, { userHome: f.home, workspace: f.workspace, stateRoot: path.join(f.home, ".t3") });
  await fs.symlink(f.workspace, path.join(f.home, ".cache/linked"));
  for (const target of [path.join(f.home, ".cache/linked/new-cache"), f.workspace, path.join(f.home, ".t3/agents"), path.join(f.root, "outside"), "relative"]) assert.equal((await guard(target)).safe, false, target);
  assert.equal((await guard(path.join(f.home, ".cache/missing"))).safe, true);
});

test("a build that starts during measurement stops cleanup", async (t) => {
  let checks = 0;
  const f = await fixture(t, { processes: async () => ++checks === 1 ? idle() : ({ complete: true, processes: [{ args: ["npm", "install"] }] }) });
  const result = await f.manager.clean(["go"]);
  assert.equal(result.ok, false); assert.equal(f.calls.length, 0);
  assert.equal(f.manager.snapshot().operation.state, "failed");
});

test("failed or partial scans preserve the previous trustworthy inventory", async (t) => {
  let fail = false;
  const f = await fixture(t, { measure: async (...args) => { if (fail) throw new Error("scan timeout"); return measureStorage(...args); } });
  await f.manager.refresh(); const previous = f.manager.snapshot(); fail = true;
  await f.manager.refresh();
  assert.deepEqual(f.manager.snapshot().categories, previous.categories);
  assert.equal(f.manager.snapshot().at, previous.at);
  assert.match(f.manager.snapshot().error, /timeout/);
});

test("cleanup failure is durable; a partial result is never reported as all bytes reclaimed", async (t) => {
  let measures = 0;
  const f = await fixture(t, { measure: async (roots) => ({ sizes: { [roots[0]]: 1000 }, partial: ++measures === 2 }) });
  assert.equal((await f.manager.clean(["go"])).ok, false);
  const restarted = createStorageManager(f.base); t.after(() => restarted.stop());
  assert.equal((await restarted.status()).operation.state, "failed");
  assert.equal((await restarted.status()).operation.reclaimedBytes, 0);
});

test("interrupted jobs are recovered without clearing files", async (t) => {
  const f = await fixture(t);
  await writeStorageJson(path.join(f.home, ".t3/setup/storage-operation.json"), { id: "lost", state: "running", pid: 98765, startedAt: 1 });
  const restarted = createStorageManager({ ...f.base, isAlive: () => false }); t.after(() => restarted.stop());
  assert.equal((await restarted.status()).operation.state, "interrupted");
  assert.equal(f.calls.length, 0);
});

test("recent completions remain visible after a second client starts another operation", async (t) => {
  const f = await fixture(t);
  const first = await f.manager.clean(["go"]);
  const second = await f.manager.clean(["npm"]);
  assert.equal(second.operation.recent[0].id, first.operation.id);
  assert.equal(second.operation.recent[0].state, "succeeded");
});

test("CLI cleanup updates the console's cached cache sizes without a new scan", async (t) => {
  const f = await fixture(t);
  await f.manager.refresh();
  const cli = createStorageManager(f.base); t.after(() => cli.stop());
  assert.equal((await cli.clean(["go"])).ok, true);
  const status = await f.manager.status();
  assert.equal(status.categories.find((row) => row.id === "go").bytes, 0);
  assert.equal(status.operation.state, "succeeded");
});

test("preferences are private and atomic; corrupt preferences disable all automatic maintenance", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.manager.setPolicy({ automatic: "on" })).ok, false);
  assert.equal((await f.manager.setPolicy({ arbitrary: true })).ok, false);
  assert.equal((await f.manager.setPolicy({ goBudgetBytes: GB / 8 })).ok, false);
  assert.equal((await f.manager.setPolicy({ ...DEFAULT_POLICY, automatic: true })).ok, true);
  const file = f.manager.paths.policyFile;
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.writeFile(file, "broken json");
  const prefs = await readPolicy(file);
  assert.equal(prefs.policy.automatic, false); assert.equal(prefs.policy.retainManagedVersions, false);
  assert.ok(prefs.error); assert.equal(await f.manager.maintain(), undefined);
});

test("opt-in budget maintenance waits for ten quiet minutes and stops for build activity", async (t) => {
  let clock = 1000, busy = false;
  const f = await fixture(t, { now: () => clock, processes: async () => busy ? ({ complete: true, processes: [{ args: ["go", "build"] }] }) : idle(),
    measure: async (roots) => ({ sizes: Object.fromEntries(roots.map((p) => [p, GB])), partial: false }) });
  await f.manager.refresh(); await f.manager.maintain(); assert.equal(f.calls.length, 0);
  await f.manager.setPolicy({ ...DEFAULT_POLICY, automatic: true, goBudgetBytes: GB / 4, npmBudgetBytes: GB / 4 });
  clock += 599999; await f.manager.maintain(); assert.equal(f.calls.length, 0);
  busy = true; clock++; await f.manager.maintain(); assert.equal(f.calls.length, 0);
  busy = false; clock += 600000; await f.manager.maintain(); assert.equal(f.calls.length, 2);
  assert.equal(f.manager.snapshot().operation.automatic, true);
});

test("package commands executed through node and Go compiler processes block cleanup", () => {
  for (const args of [["node", "/tools/npm-cli.js", "ci"], ["pnpm", "install"], ["yarn", "add", "foo"], ["bun", "install"], ["/go/pkg/tool/linux/compile", "-o", "obj"]]) assert.equal(buildsOrInstallsRunning({ complete: true, processes: [{ args }] }), true, args.join(" "));
  assert.equal(buildsOrInstallsRunning({ complete: true, processes: [{ args: ["node", "server.mjs"] }] }), false);
});

test("CLI defaults to previews, requires explicit apply, and rejects irrelevant flags", async (t) => {
  const f = await fixture(t), out = [], err = [];
  const run = (args) => runStorageCli(args, { create: () => createStorageManager(f.base), out: (line) => out.push(line), err: (line) => err.push(line) });
  assert.equal(await run(["clean", "all", "--json"]), 0); assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(out.pop()).dryRun, true);
  for (const args of [["status", "--yes"], ["policy", "--dry-run"], ["clean", "all", "--yes", "--dry-run"], ["policy", "--go-budget", "oops"], ["clean", "/tmp"]]) assert.equal(await run(args), 2);
  assert.equal(await run(["clean", "go", "--yes"]), 0); assert.equal(f.calls.length, 1);
});
