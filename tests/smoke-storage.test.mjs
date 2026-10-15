// Execute the shipping smoke assertions against a Docker transport fixture.
// This catches shell definition ordering and script-manifest drift without
// needing a daemon; image CI still exercises the same functions in Docker.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CONSOLE_SCRIPTS, loadAssets, renderConsole } from "../docker/setup/page.mjs";

const source = await fs.readFile(new URL("../scripts/smoke-test.sh", import.meta.url), "utf8");
const functionBody = (name) => {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `${name} exists`);
  return match[0];
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-smoke-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assetsRoot = path.join(root, "assets"), page = path.join(root, "page.html");
  const assets = loadAssets();
  for (const { path: asset, code } of assets.console) {
    await fs.mkdir(path.dirname(path.join(assetsRoot, asset)), { recursive: true });
    await fs.writeFile(path.join(assetsRoot, asset), code);
  }
  await fs.writeFile(page, renderConsole({ assets, nonce: "fixture", mount: "" }));
  await fs.writeFile(path.join(root, "docker"), `#!/bin/bash
if [ "$1" = cp ]; then cp -a "$SMOKE_ASSETS/." "$3"; exit; fi
if [ "$1" != exec ]; then exit 9; fi
case "$3" in
 t3-storage) printf '%s' "$SMOKE_RESULT"; exit "$SMOKE_EXIT" ;;
 sh) cat "$SMOKE_PAGE" ;;
 /usr/local/bin/node) printf '%s' "$SMOKE_MANIFEST" ;;
 *) exit 9 ;;
esac
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, TMPDIR: root,
    SMOKE_RESULT: JSON.stringify({ disk: { totalBytes: 1000, availableBytes: 300 } }), SMOKE_EXIT: "0",
    SMOKE_ASSETS: assetsRoot, SMOKE_PAGE: page, SMOKE_MANIFEST: JSON.stringify(CONSOLE_SCRIPTS) };
  const run = (name, overrides = {}) => spawnSync("bash", ["-c", `set -euo pipefail\nNAME=fixture\nSETUP_KEY=fixture\n${functionBody(name)}\n${name}`], { env: { ...env, ...overrides }, encoding: "utf8" });
  return { run, env, root, assetsRoot, page };
}

test("storage smoke check is defined before use and validates successful filesystem output", async (t) => {
  const f = await fixture(t);
  assert.ok(source.indexOf("storage_cli_has_disk() {") < source.indexOf('check "storage CLI reads filesystem space"'));
  assert.equal(f.run("storage_cli_has_disk").status, 0);
  assert.equal(f.run("storage_cli_has_disk", { SMOKE_RESULT: JSON.stringify({ disk: { totalBytes: 1000, availableBytes: 0 } }) }).status, 0);
  for (const overrides of [{ SMOKE_EXIT: "1" }, { SMOKE_RESULT: "broken" }, { SMOKE_RESULT: '{"disk":null}' }, { SMOKE_RESULT: '{"disk":{"totalBytes":0,"availableBytes":0}}' }]) assert.notEqual(f.run("storage_cli_has_disk", overrides).status, 0);
});

test("verbatim smoke check follows the shipped manifest and rejects missing or modified scripts", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run("client_script_is_verbatim").status, 0);
  const original = await fs.readFile(f.page, "utf8");
  await fs.writeFile(f.page, original.replace('const T3StorageUI = (() => {', 'const T3StorageUI = (() => { /* changed */'));
  assert.notEqual(f.run("client_script_is_verbatim").status, 0);
  await fs.writeFile(f.page, original.replace(/<script nonce="[^"]*" data-src="client\/storage.js">[\s\S]*?<\/script>/, ""));
  assert.notEqual(f.run("client_script_is_verbatim").status, 0);
  const extra = "// a new declared console asset\n";
  await fs.writeFile(path.join(f.assetsRoot, "additional.js"), extra);
  await fs.writeFile(f.page, original.replace('</body>', `<script nonce="fixture" data-src="additional.js">${extra}</script></body>`));
  assert.equal(f.run("client_script_is_verbatim", { SMOKE_MANIFEST: JSON.stringify([...CONSOLE_SCRIPTS, "additional.js"]) }).status, 0);
});
