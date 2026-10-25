import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedProjectDefaults } from "../docker/runtime/project-defaults.mjs";

async function world(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-project-defaults-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { HOME: path.join(root, "home"), T3CODE_HOME: path.join(root, "state"), T3_WORKSPACE: path.join(root, "work spaces 世界") };
  const settings = path.join(env.T3CODE_HOME, "userdata/settings.json");
  const record = path.join(env.T3CODE_HOME, "container-runtime/project-defaults.json");
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
  const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
  return { root, env, settings, record, write, read };
}

test("a first start gives native project browsing and cloning the real workspace", async (t) => {
  const w = await world(t);
  const result = await seedProjectDefaults(w.env);
  assert.equal(result.changed, true);
  assert.deepEqual(await w.read(w.settings), { addProjectBaseDirectory: w.env.T3_WORKSPACE });
  assert.equal((await fs.stat(w.env.T3_WORKSPACE)).isDirectory(), true);
  assert.equal((await fs.stat(w.settings)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(w.record)).mode & 0o777, 0o600);
  assert.equal((await seedProjectDefaults(w.env)).changed, false);
});

test("seeding preserves unrelated preferences and existing project folders", async (t) => {
  const w = await world(t);
  const settings = { addProjectBaseDirectory: "", providerInstances: { claude: { enabled: false } }, unknownFutureSetting: { retain: true } };
  await w.write(w.settings, settings);
  const existing = path.join(w.env.T3CODE_HOME, "projects/existing/README.md");
  await fs.mkdir(path.dirname(existing), { recursive: true });
  await fs.writeFile(existing, "Existing project\n");
  await seedProjectDefaults(w.env);
  assert.deepEqual(await w.read(w.settings), { ...settings, addProjectBaseDirectory: w.env.T3_WORKSPACE });
  assert.equal(await fs.readFile(existing, "utf8"), "Existing project\n");
  assert.equal((await fs.lstat(path.join(w.env.T3CODE_HOME, "projects"))).isDirectory(), true);
  assert.deepEqual(await fs.readdir(w.env.T3_WORKSPACE), []);
});

test("a pre-existing custom folder preference is never replaced", async (t) => {
  const w = await world(t);
  await w.write(w.settings, { addProjectBaseDirectory: "~/Development" });
  const before = await fs.readFile(w.settings, "utf8");
  assert.equal((await seedProjectDefaults(w.env)).managed, false);
  assert.equal(await fs.readFile(w.settings, "utf8"), before);
  await w.write(w.settings, {});
  await seedProjectDefaults(w.env);
  assert.deepEqual(await w.read(w.settings), {}, "a later reset is also a user choice");
});

test("a changed workspace follows the image's previous default without moving files", async (t) => {
  const w = await world(t);
  await seedProjectDefaults(w.env);
  await fs.writeFile(path.join(w.env.T3_WORKSPACE, "keep.txt"), "keep");
  const next = { ...w.env, T3_WORKSPACE: path.join(w.root, "second workspace/") };
  await seedProjectDefaults(next);
  assert.equal((await w.read(w.settings)).addProjectBaseDirectory, path.resolve(next.T3_WORKSPACE));
  assert.equal(await fs.readFile(path.join(w.env.T3_WORKSPACE, "keep.txt"), "utf8"), "keep");
  assert.deepEqual(await fs.readdir(next.T3_WORKSPACE), []);
});

for (const value of ["~/my-projects", "", undefined]) test(`a later ${value === undefined ? "removed" : JSON.stringify(value)} preference survives restarts and workspace changes`, async (t) => {
  const w = await world(t);
  await seedProjectDefaults(w.env);
  const settings = { ...(value === undefined ? {} : { addProjectBaseDirectory: value }), theme: "dark" };
  await w.write(w.settings, settings);
  await seedProjectDefaults(w.env);
  await seedProjectDefaults({ ...w.env, T3_WORKSPACE: path.join(w.root, "other") });
  assert.deepEqual(await w.read(w.settings), settings);
  assert.deepEqual(await w.read(w.record), { schema: 1, directory: null });
});

for (const value of [[], null, { addProjectBaseDirectory: 42 }]) test(`invalid settings ${JSON.stringify(value)} are kept byte for byte`, async (t) => {
  const w = await world(t);
  await w.write(w.settings, value);
  const before = await fs.readFile(w.settings, "utf8");
  await assert.rejects(seedProjectDefaults(w.env), /unreadable/);
  assert.equal(await fs.readFile(w.settings, "utf8"), before);
  await assert.rejects(fs.access(w.record), { code: "ENOENT" });
});

test("truncated JSON and an invalid ownership record never overwrite settings", async (t) => {
  const w = await world(t);
  await fs.mkdir(path.dirname(w.settings), { recursive: true });
  await fs.writeFile(w.settings, '{"providerInstances":');
  await assert.rejects(seedProjectDefaults(w.env), SyntaxError);
  assert.equal(await fs.readFile(w.settings, "utf8"), '{"providerInstances":');
  await w.write(w.settings, {});
  for (const record of [null, [], { schema: 2, directory: w.env.T3_WORKSPACE }, { schema: 1, directory: "relative" }]) {
    await w.write(w.record, record);
    await assert.rejects(seedProjectDefaults(w.env), /saved folder default/);
    assert.deepEqual(await w.read(w.settings), {});
  }
});

test("an invalid or unusable workspace leaves all settings intact", async (t) => {
  const w = await world(t);
  await w.write(w.settings, { theme: "dark" });
  for (const value of [undefined, "", "relative", "~/workspace", "/bad\0path"]) {
    await assert.rejects(seedProjectDefaults({ ...w.env, T3_WORKSPACE: value }), /absolute directory/);
  }
  await fs.writeFile(path.join(w.root, "file"), "not a directory");
  await assert.rejects(seedProjectDefaults({ ...w.env, T3_WORKSPACE: path.join(w.root, "file") }));
  assert.deepEqual(await w.read(w.settings), { theme: "dark" });
  await assert.rejects(fs.access(w.record), { code: "ENOENT" });
});

test("without T3CODE_HOME the setting belongs to HOME/.t3", async (t) => {
  const w = await world(t);
  const { T3CODE_HOME, ...env } = w.env;
  await seedProjectDefaults(env);
  assert.equal((await w.read(path.join(env.HOME, ".t3/userdata/settings.json"))).addProjectBaseDirectory, env.T3_WORKSPACE);
  await assert.rejects(fs.access(T3CODE_HOME), { code: "ENOENT" });
});
