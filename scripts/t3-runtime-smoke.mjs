// Stage a real nightly in a disposable home, without selecting it or restarting
// the container. CI runs this inside both images on native amd64 and arm64.
// Locally: node scripts/t3-runtime-smoke.mjs docker/runtime docker/t3-client/setup-bridge.js
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const directory = path.resolve(process.argv[2] || "/opt/t3-runtime");
const bridge = path.resolve(process.argv[3] || "/usr/local/share/t3-client/setup-bridge.js");
const { packageRelease, installRelease } = await import(pathToFileURL(path.join(directory, "manager.mjs")));
const { runtimePaths, readJson } = await import(pathToFileURL(path.join(directory, "state.mjs")));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "t3-runtime-smoke-"));
try {
  const env = { ...process.env, HOME: root, T3CODE_HOME: path.join(root, "home") };
  const paths = runtimePaths(env);
  const release = await packageRelease("nightly");
  assert.match(release.integrity, /^sha256-[a-f0-9]{64}$/);
  assert.ok(release.url.endsWith(`-linux-${process.arch}.tar.gz`));
  const staged = await installRelease(paths, release, { env, bridge });
  const metadata = await readJson(path.join(staged, ".installed.json"));
  assert.equal(metadata.version, release.version);
  assert.equal(metadata.integrity, release.integrity);
  assert.ok(metadata.database && metadata.scopes.length, "native auth capabilities were probed");
  const output = await promisify(execFile)(path.join(staged, "t3"), ["--version"], { env, timeout: 30_000 });
  assert.ok(output.stdout.includes(release.version));
  const html = await fs.readFile(path.join(staged, "client/index.html"), "utf8");
  assert.equal(html.split("<script data-t3-setup-bridge>").length, 2, "one Setup bridge");
  assert.equal(await readJson(paths.selection), null, "staging cannot select a runtime");
  assert.equal(await readJson(paths.request), null, "staging cannot request a restart");
  console.log(`Verified GitHub nightly ${release.version} on linux/${process.arch}; Setup, protocol and native auth probes passed.`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
