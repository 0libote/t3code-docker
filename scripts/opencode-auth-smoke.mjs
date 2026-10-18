#!/usr/bin/env node
// Native credential lifecycle without valid keys, external login or model turns.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const { createOpenCodeAuth } = await import(process.env.T3_HARNESS_MODULE || new URL('../docker/harness/index.mjs', import.meta.url));
const [executable] = process.argv.slice(2);
if (!path.isAbsolute(executable || '')) throw new Error('Pass an absolute OpenCode executable path.');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-opencode-auth-native-'));
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
  XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache') };
for (const key of Object.keys(env)) if (/TOKEN|API_KEY|^OPENCODE/.test(key)) delete env[key];
const run = (args) => promisify(execFile)(executable, args, { env, cwd: home, timeout: 30000, maxBuffer: 1024 * 1024 });
try {
  const version = /\bv?(\d+\.\d+\.\d+)\b/.exec((await run(['--version'])).stdout)?.[1];
  assert.ok(version);
  const options = { home, env, resolve: async () => ({ executable, installedVersion: version, runnable: true }) };
  let auth = createOpenCodeAuth(options);
  assert.deepEqual(await auth.list(), []);
  const legacy = path.join(env.XDG_DATA_HOME, 'opencode/auth.json');
  const stale = '{"deepseek":{"type":"api","key":"fixture-stale-migrated-key"}}';
  if (version.startsWith('2.')) { await fs.mkdir(path.dirname(legacy), { recursive: true }); await fs.writeFile(legacy, stale); }
  await auth.saveKey('anthropic', 'fixture-anthropic-first');
  await auth.saveKey('anthropic', 'fixture-anthropic-second');
  await auth.saveKey('openai', 'fixture-openai');
  assert.equal((await auth.list()).filter((entry) => entry.integration === 'anthropic').length, version.startsWith('2.') ? 2 : 1);
  auth = createOpenCodeAuth(options);
  assert.deepEqual([...new Set((await auth.list()).map((entry) => entry.integration))].sort(), ['anthropic', 'openai']);
  if (version.startsWith('1.')) assert.match((await run(['auth', 'list'])).stdout, /[Aa]nthropic/);
  assert.equal((await auth.removeProvider('anthropic')).removed, true);
  assert.deepEqual([...new Set((await auth.list()).map((entry) => entry.integration))], ['openai']);
  await auth.removeProvider('openai'); assert.deepEqual(await auth.list(), []);
  if (version.startsWith('2.')) assert.equal(await fs.readFile(legacy, 'utf8'), stale, 'V2 never modifies or falls back to the migrated legacy file');
  console.log(`OpenCode ${version}: native save, selection, provider isolation, fresh-service discovery and removal passed.`);
} finally { await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
