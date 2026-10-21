import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPluginHookService } from '../docker/setup/skills/hooks.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-hook-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = path.join(home, '.codex/config.toml'); await fs.mkdir(path.dirname(config));
  await fs.writeFile(config, '# private unrelated settings\nmodel = "fixture"\n');
  const hook = { key: '/plugin/hooks.json:session_start:0:0', source: 'plugin', sourcePath: '/plugin/hooks.json', pluginId: 'demo@local',
    eventName: 'sessionStart', handlerType: 'command', command: 'node /plugin/start.js', currentHash: 'sha256:' + 'a'.repeat(64),
    trustStatus: 'untrusted', enabled: true, isManaged: false, matcher: 'startup|resume', timeoutSec: 15, async: false };
  const hooks = [hook], writes = [];
  let failRead = false, failWrite = false, verifyWrite = true, discoveryErrors = [];
  const options = { home, env: {}, io: fs, getHarness: async () => ({ runnable: true, executable: '/fixture/codex' }),
    nativeList: async () => {
      if (failRead) throw Error('Discovery failed');
      return { hooks: structuredClone(hooks), configVersion: 'fixture-version', warnings: [], errors: discoveryErrors };
    },
    nativeWrite: async input => {
      if (failWrite) throw Error('Native write failed');
      writes.push(input);
      assert.equal(input.configVersion, 'fixture-version'); assert.equal(input.resolvedConfigPath, await fs.realpath(config));
      await fs.appendFile(config, '# saved hook setting\n');
      if (verifyWrite) {
        if (input.action === 'trust') hook.trustStatus = 'trusted';
        else hook.enabled = input.action === 'enable';
      }
    } };
  const service = createPluginHookService(options), row = async () => (await service.listHooks()).hooks[0];
  return { home, config, hook, hooks, writes, options, service, row, failRead: () => { failRead = true; }, failWrite: () => { failWrite = true; },
    unverifiable: () => { verifyWrite = false; }, discoveryError: () => { discoveryErrors = [{}]; } };
}

test('plugin hook review exposes native definitions without private settings or write authority', async t => {
  const f = await fixture(t);
  f.hooks.push({ ...f.hook, source: 'user', key: 'user-hook', pluginId: null });
  const listed = await f.service.listHooks();
  assert.equal(listed.hooks.length, 1); assert.equal(listed.hooks[0].command, f.hook.command);
  assert(!JSON.stringify(listed).includes('private unrelated')); assert(!JSON.stringify(listed).includes('currentHash'));
  assert.equal(listed.hooks[0].key, undefined); assert.equal(f.writes.length, 0);
});

test('trust preserves disabled state; enable and disable remain separate native settings', async t => {
  const f = await fixture(t); f.hook.enabled = false;
  let row = await f.row();
  await assert.rejects(f.service.setHook(row.id, row.revision, 'enable'), { code: 'conflict' });
  let result = await f.service.setHook(row.id, row.revision, 'trust'); row = result.hooks[0];
  assert.equal(row.trustStatus, 'trusted'); assert.equal(row.enabled, false);
  assert.equal(f.writes[0].key, f.hook.key); assert.equal(f.writes[0].currentHash, f.hook.currentHash);
  result = await f.service.setHook(row.id, row.revision, 'enable'); row = result.hooks[0]; assert.equal(row.enabled, true);
  result = await f.service.setHook(row.id, row.revision, 'disable'); assert.equal(result.hooks[0].enabled, false);
  assert.match(await fs.readFile(f.config, 'utf8'), /private unrelated settings/);
});

test('changed commands, settings, missing hooks and forged identifiers reject consent', async t => {
  const f = await fixture(t); let row = await f.row();
  for (const id of [null, '/arbitrary/path', '__proto__']) await assert.rejects(f.service.setHook(id, row.revision, 'trust'), { code: 'invalid' });
  await assert.rejects(f.service.setHook(row.id, null, 'trust'), { code: 'conflict' });
  await assert.rejects(f.service.setHook(row.id, row.revision, 'trust-all'), { code: 'invalid' });
  f.hook.command += ' changed'; f.hook.currentHash = 'sha256:' + 'b'.repeat(64);
  await assert.rejects(f.service.setHook(row.id, row.revision, 'trust'), { code: 'conflict' });
  row = await f.row(); await fs.appendFile(f.config, '# external change\n');
  await assert.rejects(f.service.setHook(row.id, row.revision, 'trust'), { code: 'conflict' });
  row = await f.row(); f.hooks.length = 0;
  await assert.rejects(f.service.setHook(row.id, row.revision, 'trust'), { code: 'missing' });
  assert.equal(f.writes.length, 0);
});

test('managed and incompletely inspectable hooks cannot be changed', async t => {
  const f = await fixture(t);
  for (const variation of [{ isManaged: true, trustStatus: 'managed' }, { handlerType: 'mcpTool' }, { handlerType: 'prompt' }]) {
    Object.assign(f.hook, { isManaged: false, trustStatus: 'untrusted', ...variation });
    const row = await f.row(); assert(row.readOnlyReason);
    await assert.rejects(f.service.setHook(row.id, row.revision, 'trust'), { code: 'unsupported' });
  }
  assert.equal(f.writes.length, 0);
});

test('concurrent reviews serialize through the shared settings queue', async t => {
  const f = await fixture(t), other = createPluginHookService(f.options), row = await f.row();
  const results = await Promise.allSettled([f.service.setHook(row.id, row.revision, 'trust'), other.setHook(row.id, row.revision, 'trust')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'conflict'); assert.equal(f.writes.length, 1);
});

test('native failures, malformed inventories and failed verification never report trust saved', async t => {
  for (const mode of ['failRead', 'failWrite', 'unverifiable', 'discoveryError', 'malformed']) {
    const f = await fixture(t), row = await f.row();
    if (mode === 'malformed') f.hook.currentHash = 'forged'; else f[mode]();
    await assert.rejects(f.service.setHook(row.id, row.revision, 'trust'));
  }
});

test('symlinked user settings retain their target and directory overrides', async t => {
  const f = await fixture(t), target = path.join(f.home, 'persisted.toml');
  await fs.rename(f.config, target); await fs.symlink(target, f.config);
  const row = await f.row(); await f.service.setHook(row.id, row.revision, 'trust');
  assert((await fs.lstat(f.config)).isSymbolicLink()); assert.match(await fs.readFile(target, 'utf8'), /saved hook/);
  const custom = path.join(f.home, 'custom'); await fs.mkdir(custom); await fs.copyFile(target, path.join(custom, 'config.toml'));
  const service = createPluginHookService({ ...f.options, env: { CODEX_HOME: 'custom' }, nativeWrite: async input => {
    assert.equal(input.resolvedConfigPath, path.join(custom, 'config.toml')); f.hook.trustStatus = 'trusted';
  } });
  f.hook.trustStatus = 'untrusted'; const customRow = (await service.listHooks()).hooks[0];
  await service.setHook(customRow.id, customRow.revision, 'trust');
});

test('enablement cannot report success if trust disappears during verification', async t => {
  const f = await fixture(t); f.hook.trustStatus = 'trusted'; f.hook.enabled = false;
  const service = createPluginHookService({ ...f.options, nativeWrite: async input => {
    await f.options.nativeWrite(input); f.hook.trustStatus = 'untrusted';
  } });
  const row = (await service.listHooks()).hooks[0];
  await assert.rejects(service.setHook(row.id, row.revision, 'enable'), { code: 'conflict' });
});

test('reviewing one plugin preserves the hooks of other installed plugins', async t => {
  const f = await fixture(t);
  f.hooks.push({ ...f.hook, key: '/other/hooks.json:session_start:0:0', sourcePath: '/other/hooks.json', pluginId: 'other-tools@local' });
  const before = await f.service.listHooks(); assert.equal(before.hooks.length, 2);
  const selected = before.hooks.find(hook => hook.pluginId === 'demo@local');
  const updated = await f.service.setHook(selected.id, selected.revision, 'trust');
  assert.equal(updated.hooks.find(hook => hook.pluginId === 'demo@local').trustStatus, 'trusted');
  assert.equal(updated.hooks.find(hook => hook.pluginId === 'other-tools@local').trustStatus, 'untrusted');
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].key, f.hook.key);
});
