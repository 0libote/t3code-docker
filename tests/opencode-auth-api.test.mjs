import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { authFixture, pause } from './fixtures/opencode-auth.mjs';

test('provider catalog responds while one shared credential read waits', { timeout: 15000 }, async (t) => {
  const f = await authFixture(); t.after(f.close);
  await f.mode({ gateList: true });
  const pending = f.request('/providers');
  for (let i = 0; i < 200; i++) {
    try { await fs.access(path.join(f.home, 'list-started')); break; } catch { await pause(10); }
  }
  await fs.access(path.join(f.home, 'list-started'));
  const response = await Promise.race([pending, pause(500).then(() => null)]);
  // Always release the CLI, including against the regressed implementation.
  if (!response) await f.mode({});
  assert.ok(response, 'the catalog must not wait for OpenCode');
  const first = await response.json();
  assert.ok(first.providers.length); assert.equal(first.credentials.available, false);
  assert.equal(first.credentials.refreshing, true);
  await Promise.all([f.request('/providers'), f.request('/providers')]);
  assert.equal((await fs.readFile(path.join(f.home, 'calls'), 'utf8')).trim().split('\n').filter((action) => action === 'list').length, 1);
  await f.mode({});
  let warm;
  for (let i = 0; i < 100; i++) {
    warm = await (await f.request('/providers')).json();
    if (warm.credentials.available) break;
    await pause(10);
  }
  assert.equal(warm.credentials.available, true); assert.deepEqual(warm.configured, []);
});

test('key-save failures never echo submitted credentials to the HTTP client', { timeout: 15000 }, async (t) => {
  const f = await authFixture(); t.after(f.close);
  await f.mode({ failImport: true });
  const key = 'private-credential-sentinel';
  const response = await f.request('/auth/apikey', { agent: 'opencode', provider: 'anthropic', key });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.ok(!text.includes(key), 'CLI diagnostics may contain the key and must stay private');
  assert.match(JSON.parse(text).error, /OpenCode/i);
});

test('V2 save and provider removal preserve other providers and environment connections', { timeout: 15000 }, async (t) => {
  const f = await authFixture(); t.after(f.close);
  const existing = [{ id: 'anthropic', connections: [{ type: 'credential', id: 'cred_work', label: 'Work', method: 'oauth' }, { type: 'env', name: 'ANTHROPIC_API_KEY' }] },
    { id: 'openai', connections: [{ type: 'credential', id: 'cred_other', label: 'Personal', method: 'oauth' }] }];
  await fs.writeFile(f.stateFile, JSON.stringify(existing));
  assert.equal((await fetch(f.base + '/auth/apikey', { method: 'POST' })).status, 401);
  assert.equal((await f.request('/auth/apikey', { agent: 'opencode', provider: 'anthropic', key: 'fixture-new-key' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  const saved = await f.request('/auth/apikey', { agent: 'opencode', provider: 'anthropic', key: 'fixture-new-key' });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).ok, true);
  const accounts = JSON.parse(await fs.readFile(f.stateFile, 'utf8'));
  assert.equal(accounts[0].connections.filter((connection) => connection.type === 'credential').length, 2);
  assert.equal((await f.request('/auth/apikey/remove', { agent: 'opencode', provider: 'anthropic' })).status, 200);
  const remaining = JSON.parse(await fs.readFile(f.stateFile, 'utf8'));
  assert.deepEqual(remaining[0].connections, existing[0].connections.filter((connection) => connection.type === 'env'));
  assert.deepEqual(remaining[1], existing[1]);
});

test('partial native failures invalidate credential lists and never claim success', { timeout: 15000 }, async (t) => {
  const f = await authFixture(); t.after(f.close);
  await f.mode({ failSwitch: true });
  const saved = await f.request('/auth/apikey', { agent: 'opencode', provider: 'anthropic', key: 'fixture-imported-key' });
  assert.equal(saved.status, 400); assert.match((await saved.json()).error, /saved.*could not list/);
  await f.mode({ ignoreLogout: true });
  const removed = await f.request('/auth/apikey/remove', { agent: 'opencode', provider: 'anthropic' });
  assert.equal(removed.status, 400); assert.match((await removed.json()).error, /could not confirm removal/);
  let snapshot;
  for (let i = 0; i < 100; i++) {
    snapshot = await (await f.request('/providers')).json();
    if (snapshot.credentials.available) break;
    await pause(10);
  }
  assert.deepEqual(snapshot.configured, ['anthropic']);
  assert.equal(snapshot.credentials.counts.anthropic, 1);
});

test('unavailable or unknown managed installations cannot mutate either store', { timeout: 15000 }, async (t) => {
  const f = await authFixture(); t.after(f.close);
  const legacy = path.join(f.env.XDG_DATA_HOME, 'opencode/auth.json');
  await fs.mkdir(path.dirname(legacy), { recursive: true });
  const stale = '{"anthropic":{"type":"api","key":"stale-fixture"}}';
  await fs.writeFile(legacy, stale);
  const accounts = '[{"id":"anthropic","connections":[{"type":"credential","id":"cred_existing"}]}]';
  await fs.writeFile(f.stateFile, accounts);
  for (const facts of [{ runnable: false, inProgress: true }, { executable: null }, { resolveFails: true }, { installedVersion: null }]) {
    await f.facts(facts);
    assert.equal((await f.request('/auth/apikey', { agent: 'opencode', provider: 'anthropic', key: 'new-fixture' })).status, 400);
    assert.equal((await f.request('/auth/apikey/remove', { agent: 'opencode', provider: 'anthropic' })).status, 400);
    assert.equal(await fs.readFile(legacy, 'utf8'), stale);
    assert.equal(await fs.readFile(f.stateFile, 'utf8'), accounts);
  }
  await assert.rejects(fs.access(path.join(f.home, 'import-started')), { code: 'ENOENT' });
});

test('legacy HTTP key changes preserve other providers without running V2 commands', { timeout: 15000 }, async (t) => {
  const f = await authFixture({ version: '1.19.3' }); t.after(f.close);
  assert.equal((await f.request('/auth/apikey', { agent: 'opencode', provider: 'anthropic', key: 'one-fixture' })).status, 200);
  assert.equal((await f.request('/auth/apikey', { agent: 'opencode', provider: 'openai', key: 'two-fixture' })).status, 200);
  assert.equal((await f.request('/auth/apikey/remove', { agent: 'opencode', provider: 'anthropic' })).status, 200);
  const legacy = path.join(f.env.XDG_DATA_HOME, 'opencode/auth.json');
  assert.deepEqual(JSON.parse(await fs.readFile(legacy, 'utf8')), { openai: { type: 'api', key: 'two-fixture' } });
  await assert.rejects(fs.access(path.join(f.home, 'calls')), { code: 'ENOENT' });
});
