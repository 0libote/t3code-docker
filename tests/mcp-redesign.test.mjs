import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMcpService } from '../docker/setup/mcp.mjs';
import { readProviderMcp } from '../docker/setup/mcp/adapters.mjs';
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 't3-mcp-design-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const options = { home, env: { HOME: home }, io: fs, baseDir: path.join(home, '.t3') };
  return { ...options, service: createMcpService(options) };
}
const local = { name: 'example', type: 'local', command: ['do-not-execute'], env: { TOKEN: 'fixture-shared-secret' } };
for (const provider of ['codex', 'opencode']) for (const v2 of provider === 'opencode' ? [false, true] : [false]) test(`${provider} ${v2 ? 'V2' : ''}: per-agent off survives editing and never diverges`, async t => {
  const f = await fixture(t), svc = f.service;
  if (v2) { await fs.mkdir(path.join(f.home, '.config/opencode'), { recursive: true }); await fs.writeFile(path.join(f.home, '.config/opencode/opencode.jsonc'), '{// keep\n"mcp":{"timeout":3000,"servers":{}}}'); }
  let revision = (await svc.create(local)).revision;
  let native = await readProviderMcp(fs, provider, f);
  await svc.setLink(provider, 'example', true, revision, native.revision, false);
  let state = (await svc.status({ refresh: true })).providers.find(p => p.provider === provider);
  assert.deepEqual(state.linked, ['example']); assert.deepEqual(state.disabled, ['example']); assert.deepEqual(state.diverged, []);
  revision = (await svc.save('example', revision, { ...local, command: ['new-command'] })).revision;
  assert.deepEqual((await svc.list(provider)).diverged, ['example']);
  await svc.setLink(provider, 'example', true, revision, state.revision);
  state = (await svc.list(provider)); assert.deepEqual(state.disabled, ['example']); assert.deepEqual(state.diverged, []);
  await svc.setLink(provider, 'example', true, revision, state.revision, true);
  assert.deepEqual((await svc.list(provider)).disabled, []);
  native = await readProviderMcp(fs, provider, f);
  assert.equal(native.servers[0].canonical.enabled, true);
  if (v2) { const text = await fs.readFile(native.path, 'utf8'); assert.match(text, /keep/); assert.match(text, /"timeout":\s*3000/); }
});
for (const provider of ['claude', 'cursor']) test(provider + ' rejects Off without modifying the file', async t => {
  const f = await fixture(t), svc = f.service, created = await svc.create(local);
  const before = await readProviderMcp(fs, provider, f);
  await assert.rejects(svc.setLink(provider, 'example', true, created.revision, before.revision, false), /has no global off switch/);
  assert.equal((await readProviderMcp(fs, provider, f)).revision, before.revision);
});
test('own summaries and grouping compare secrets privately; adopting keeps the native entry exact', async t => {
  const f = await fixture(t), svc = f.service;
  const file = path.join(f.home, '.claude.json');
  const raw = '{"mcpServers":{"docs":{"type":"http","url":"https://docs.test/path?token=fixture-url-secret","headers":{"Authorization":"fixture-agent-secret"},"timeout":120}}}';
  await fs.writeFile(file, raw, { mode: 0o600 });
  await fs.mkdir(path.join(f.home, '.cursor')); await fs.writeFile(path.join(f.home, '.cursor/mcp.json'), raw);
  let state = await svc.status({ refresh: true });
  assert.equal(state.ownGroups[0].identical, true);
  const serialized = JSON.stringify(state); for (const secret of ['fixture-agent-secret', 'fixture-url-secret', 'timeout":120']) assert.equal(serialized.includes(secret), false);
  const source = state.providers.find(p => p.provider === 'claude');
  assert.deepEqual(source.own[0].extra, ['timeout']); assert.equal(source.own[0].url, 'https://docs.test');
  await assert.rejects(svc.adopt('claude', 'docs', 'stale', state.shared.revision), { code: 'conflict' });
  const adopted = await svc.adopt('claude', 'docs', source.revision, state.shared.revision);
  assert.deepEqual(adopted.dropped, ['timeout']); assert.equal(await fs.readFile(file, 'utf8'), raw);
  assert.equal((await fs.stat(path.join(f.baseDir, 'setup/mcp/servers.json'))).mode & 0o777, 0o600);
  assert.equal((await svc.read('docs')).server.headers.Authorization, 'fixture-agent-secret');
  await assert.rejects(svc.adopt('claude', 'docs', source.revision, adopted.revision), { code: 'conflict' });
  const diff = await svc.diff('claude', 'docs'); assert.deepEqual(diff.extraOptions, ['timeout']);
  await fs.writeFile(file, raw.replace('fixture-agent-secret', 'different-secret').replace('/path?', '/v2?'));
  const changed = await svc.diff('claude', 'docs');
  assert.ok(changed.fields.some(field => field.field === 'header' && field.secret));
  assert.equal(JSON.stringify(changed).includes('different-secret'), false);
  assert.equal(JSON.stringify(changed).includes('fixture-agent-secret'), false);
  await assert.rejects(svc.adopt('claude', 'docs', changed.providerRevision, 'stale', true), { code: 'conflict' });
  await svc.adopt('claude', 'docs', changed.providerRevision, changed.sharedRevision, true);
  assert.equal((await svc.read('docs')).server.headers.Authorization, 'different-secret');
});
test('unsupported own entries stay visible and cannot be adopted', async t => {
  const f = await fixture(t), svc = f.service;
  await fs.writeFile(path.join(f.home, '.claude.json'), '{"mcpServers":{"legacy":{"type":"sse","url":"https://test/sse"}}}');
  const state = await svc.status(); assert.equal(state.ownGroups[0].identical, false);
  const source = state.providers.find(p => p.provider === 'claude'); assert.equal(source.own[0].recognized, false);
  await assert.rejects(svc.adopt('claude', 'legacy', source.revision, state.shared.revision), { code: 'unsupported' });
  assert.equal((await svc.status({ refresh: true })).shared.count, 0);
});
