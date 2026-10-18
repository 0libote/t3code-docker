import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createOpenCodeAuth, parseAuthList, runAuthCommand } from '../docker/harness/opencode-auth.mjs';

async function fixture(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-opencode-auth-service-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_DATA_HOME: path.join(home, 'custom-data') };
  const file = path.join(env.XDG_DATA_HOME, 'opencode/auth.json');
  const service = createOpenCodeAuth({ home, env, resolve: async () => ({ runnable: true, executable: '/fixture/opencode', installedVersion: '1.19.3' }), ...options });
  return { home, env, file, service };
}

test('legacy key changes serialize, honor XDG data and preserve other credentials', async (t) => {
  const f = await fixture(t);
  await Promise.all([f.service.saveKey('anthropic', 'private-one'), f.service.saveKey('openai', 'private-two')]);
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(saved.anthropic.key, 'private-one'); assert.equal(saved.openai.key, 'private-two');
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual((await f.service.list()).map((row) => row.integration), ['anthropic', 'openai']);
  await f.service.removeProvider('anthropic');
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { openai: saved.openai });
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['auth.json']);
});

test('malformed files, special files and unknown versions never become replacement stores', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.file), { recursive: true }); await fs.writeFile(f.file, '{broken-private-state');
  await assert.rejects(f.service.saveKey('anthropic', 'new'), /unreadable/);
  assert.equal(await fs.readFile(f.file, 'utf8'), '{broken-private-state');
  const unknown = createOpenCodeAuth({ home: f.home, env: f.env, resolve: async () => ({ runnable: true, executable: '/fixture/opencode' }) });
  await assert.rejects(unknown.saveKey('anthropic', 'new'), /version/);
  await fs.unlink(f.file); await promisify(execFile)('mkfifo', [f.file]);
  await assert.rejects(f.service.list(), /could not be read/);
});

test('native output parsing rejects malformed account identities and tolerates bracketed logs', () => {
  const list = [{ id: 'anthropic', connections: [{ type: 'credential', id: 'cred_work' }] }];
  assert.deepEqual(parseAuthList('[INFO] Starting OpenCode\n' + JSON.stringify(list)), list);
  for (const malformed of ['{}', '[{}]', '[{"id":"anthropic","connections":{}}]', '[{"id":"anthropic","connections":[{"type":"credential","id":"--all"}]}]']) assert.throws(() => parseAuthList(malformed), /OpenCode/);
});

test('credential subprocess failures stay bounded and never return raw diagnostics', { timeout: 10000 }, async (t) => {
  const f = await fixture(t), options = { executable: process.execPath, home: f.home, env: process.env, timeoutMs: 3000 };
  await assert.rejects(runAuthCommand(options, ['-e', "process.stderr.write('private-sentinel');process.exit(1)"]), (error) => !error.message.includes('private-sentinel') && /OpenCode/.test(error.message));
  await assert.rejects(runAuthCommand(options, ['-e', "process.stdout.write('x'.repeat(2*1024*1024));setTimeout(()=>{},5000)"]), /output exceeded/);
  await assert.rejects(runAuthCommand({ ...options, timeoutMs: 100 }, ['-e', 'setTimeout(()=>{},5000)']), /in time/);
  await assert.rejects(runAuthCommand(options, ['-e', 'process.exit(1)'], { input: 'private-input'.repeat(100000) }), /OpenCode/);
  const unicode = await runAuthCommand(options, ['-e', "const b=Buffer.from('你好');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.end(b.subarray(1)),10)"]);
  assert.equal(unicode.stdout, '你好');
});
