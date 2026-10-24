#!/usr/bin/env node
// Native hook trust in a disposable plugin/home. No thread, hook or model is run.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const { createSkillsService } = await import(process.env.T3_SKILLS_MODULE || new URL('../docker/setup/skills.mjs', import.meta.url));
const executable = process.argv[2];
if (!path.isAbsolute(executable || '')) throw Error('Pass an absolute Codex executable path.');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-hooks-native-'));
try {
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config') };
  await fs.mkdir(env.CODEX_HOME, { recursive: true });
  for (const key of Object.keys(env)) if (/TOKEN|API_KEY/.test(key)) delete env[key];
  const marketplace = path.join(home, 'marketplace'), plugin = path.join(marketplace, 'plugins/hook-fixture');
  const put = async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); };
  await put(path.join(marketplace, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'hook-smoke', owner: { name: 'Fixture' }, plugins: [{ name: 'hook-fixture', source: './plugins/hook-fixture' }] }));
  await put(path.join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'hook-fixture', version: '1.0.0', skills: './skills/', hooks: './hooks/hooks.json' }));
  await put(path.join(plugin, 'skills/hook-check/SKILL.md'), '---\nname: hook-check\ndescription: Native hook smoke fixture\n---\nFixture.\n');
  await put(path.join(plugin, 'hooks/never-run.js'), "require('node:fs').writeFileSync(require('node:path').join(process.env.HOME, 'HOOK_RAN'), 'unexpected');");
  const definition = command => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 15 }] }] } });
  await put(path.join(plugin, 'hooks/hooks.json'), definition('node "${PLUGIN_ROOT}/hooks/never-run.js"'));
  const run = promisify(execFile);
  await run(executable, ['plugin', 'marketplace', 'add', marketplace], { env, cwd: home, timeout: 20000 });
  await run(executable, ['plugin', 'add', 'hook-fixture@hook-smoke'], { env, cwd: home, timeout: 20000 });
  const options = { home, env, getHarness: async () => ({ runnable: true, executable }) };
  let service = createSkillsService(options), inventory = await service.listHooks(), hook = inventory.hooks[0];
  assert.equal(inventory.hooks.length, 1); assert.equal(hook.pluginId, 'hook-fixture@hook-smoke'); assert.equal(hook.trustStatus, 'untrusted');
  const skill = (await service.list('codex')).skills.find(row => row.path.endsWith('/skills/hook-check/SKILL.md'));
  assert.equal(skill?.pluginId, hook.pluginId, 'Plugin skills retain their identity for the inspector hook action');
  const settings = path.join(env.CODEX_HOME, 'config.toml');
  const persisted = path.join(home, 'persisted-config.toml');
  await fs.rename(settings, persisted); await fs.symlink(persisted, settings);
  await fs.appendFile(settings, '\n# Keep this unrelated comment\n');
  // The symlink/comment change requires a fresh review before the first write.
  hook = (await service.listHooks()).hooks[0];
  const before = await fs.readFile(settings, 'utf8');
  const disabled = await service.setHook(hook.id, hook.revision, 'disable'); hook = disabled.hooks[0]; assert.equal(hook.enabled, false);
  hook = (await service.setHook(hook.id, hook.revision, 'trust')).hooks[0]; assert.equal(hook.trustStatus, 'trusted'); assert.equal(hook.enabled, false);
  hook = (await service.setHook(hook.id, hook.revision, 'enable')).hooks[0]; assert.equal(hook.enabled, true);
  service = createSkillsService(options); hook = (await service.listHooks()).hooks[0]; assert.equal(hook.trustStatus, 'trusted');
  await put(hook.sourcePath, definition('node "${PLUGIN_ROOT}/hooks/never-run.js" changed'));
  await assert.rejects(service.setHook(hook.id, hook.revision, 'trust'), { code: 'conflict' });
  const modified = (await service.listHooks()).hooks[0]; assert.equal(modified.trustStatus, 'modified');
  assert((await fs.lstat(settings)).isSymbolicLink());
  assert.match(await fs.readFile(settings, 'utf8'), /hook-fixture/); assert.match(before, /hook-fixture/);
  assert.match(await fs.readFile(settings, 'utf8'), /Keep this unrelated comment/);
  await assert.rejects(fs.stat(path.join(home, 'HOOK_RAN')), { code: 'ENOENT' });
  console.log('Codex: installed-plugin discovery, separate trust/enablement, persisted trust and changed-definition rejection passed; no hooks ran.');
} finally { await fs.rm(home, { recursive: true, force: true }); }
