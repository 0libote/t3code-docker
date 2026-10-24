import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../docker/setup/client/skills.js', import.meta.url), 'utf8');
const model = await readFile(new URL('../docker/setup/client/skill-model.js', import.meta.url), 'utf8');
const skills = [
  { id: 'user', name: 'My skill', scope: 'user' },
  { id: 'system', name: 'Bundled skill', scope: 'system' },
  { id: 'admin', name: 'Organization skill', scope: 'admin' },
  { id: 'plugin', name: 'Plugin skill', scope: 'user', source: 'Plugin' },
].map(row => ({ ...row, path: '/skills/' + row.id + '/SKILL.md', resolvedPath: '/skills/' + row.id + '/SKILL.md', description: '', canEdit: row.scope === 'user' }));
async function fixture(rows = skills, storage = new Map(), onRequest) {
  const requests = [], installs = [], updates = [];
  const context = vm.createContext({
    Kit: { html: (parts, ...values) => parts.reduce((text, part, i) => text + part + (Array.isArray(values[i]) ? values[i].join('') : values[i] ?? ''), ''), raw: value => value, icon: () => '', announce() {}, menu: (_, config) => config.items.find(item => item.label.startsWith('Review'))?.run() },
    T3Model: { plural: (count, name) => `${count} ${name}${count === 1 ? '' : 's'}`, listOf: names => names.join(', '), absTime: String, relTime: String },
    T3C: { agentMark: () => '' },
    T3SkillImport: { create: () => ({ open: options => installs.push(options) }) },
    T3SkillInspector: { create: () => ({ repaint() {} }) },
    T3SkillHooks: { create: () => ({ open() {}, close: () => true }) },
    T3SkillUpdate: { create: () => ({ open: (provider, id) => updates.push({ provider, id }), close: () => true }) },
    document: { getElementById: () => null },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  });
  vm.runInContext(model + '\n' + source + '\nglobalThis.create = T3SkillsUI.create;', context);
  const ui = context.create({ render() {}, getStatus: () => ({ harnesses: [{ installed: true, id: 'codex' }, { installed: true, id: 'cursor' }] }), api: async (url, options) => {
    requests.push({ url, options });
    const custom = await onRequest?.(url, options);
    if (custom) return custom;
    const provider = url.includes('cursor') ? 'cursor' : 'codex';
    return { ok: true, data: url.includes('/reach') ? { roots: [] } : { provider, scannedAt: Date.now(), skills: structuredClone(rows) } };
  } });
  await ui.refresh();
  return { ui, requests, storage, installs, updates };
}

test('bundled filter hides physical system skills only and persists without provider writes', async () => {
  const { ui, requests, storage } = await fixture();
  assert.match(ui.content(), /Bundled skill/);
  const before = requests.length;
  ui.toggleBundled();
  const content = ui.content();
  assert.doesNotMatch(content, /Bundled skill/);
  for (const name of ['My skill', 'Organization skill', 'Plugin skill']) assert.ok(content.includes(name));
  assert.match(content, /1 skill hidden/);
  assert.equal(requests.length, before);
  const restored = await fixture(skills, storage);
  assert.doesNotMatch(restored.ui.content(), /Bundled skill/);
  restored.ui.toggleBundled();
  assert.match(restored.ui.content(), /Bundled skill/);
});

test('filtered empty state has a working clear action', async () => {
  const { ui } = await fixture([skills[1]]);
  ui.toggleBundled();
  assert.match(ui.content(), /1 skill hidden/);
  assert.match(ui.content(), /No skills match these filters/);
  ui.clear();
  assert.match(ui.content(), /Bundled skill/);
});

test('blocked browser storage still allows filtering for the session', async () => {
  const { ui } = await fixture(skills, { get() { throw Error('blocked'); }, set() { throw Error('blocked'); } });
  ui.toggleBundled();
  assert.doesNotMatch(ui.content(), /Bundled skill/);
});

const tracked = { ...skills[0], origin: { source: 'org/repo', name: 'my-skill', fingerprint: 'a'.repeat(64) } };
test('repository checks deduplicate physical copies and review selects only the owning installation', async () => {
  const sibling = { ...tracked, id: 'second', name: 'second-skill', path: '/skills/second/SKILL.md', resolvedPath: '/skills/second/SKILL.md' };
  const { ui, requests, installs, updates } = await fixture([tracked, sibling], new Map(), (url, options) => url.endsWith('/check-update') ? { ok: true, data: { results: options.body.skills.map(skill => ({ ok: true, ...skill, update: { ...tracked.origin, status: 'available' } })) } } : null);
  await ui.checkUpdates();
  const checks = requests.filter(request => request.url.endsWith('/check-update'));
  assert.equal(checks.length, 1, 'two agent inventories refer to one physical installation');
  assert.deepEqual(JSON.parse(JSON.stringify(checks[0].options.body.skills)), [{ provider: 'codex', id: tracked.id }, { provider: 'codex', id: sibling.id }]);
  assert.match(ui.content(), /Update available/);
  ui.menu(tracked.resolvedPath, {});
  assert.deepEqual(JSON.parse(JSON.stringify(updates[0])), { provider: 'codex', id: tracked.id });
  assert.equal(installs.length, 0, 'reviewing an update never opens the new-copy planner');
});

test('a late update response cannot overwrite a rescanned installation', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const begin = new Promise(resolve => { started = resolve; });
  const { ui } = await fixture([tracked], new Map(), async (url, options) => {
    if (!url.endsWith('/check-update')) return null;
    started(); await gate;
    return { ok: true, data: { results: options.body.skills.map(skill => ({ ok: true, ...skill, update: { ...tracked.origin, status: 'available' } })) } };
  });
  const checking = ui.checkUpdates();
  await begin;
  await ui.refresh();
  release(); await checking;
  assert.doesNotMatch(ui.content(), /Update available/);
});

test('batch failures remain attached to their own installation', async () => {
  const sibling = { ...tracked, id: 'second', name: 'second-skill', path: '/skills/second/SKILL.md', resolvedPath: '/skills/second/SKILL.md' };
  const { ui } = await fixture([tracked, sibling], new Map(), (url, options) => url.endsWith('/check-update') ? { ok: true, data: { results: options.body.skills.map(skill => skill.id === tracked.id
    ? { ok: true, ...skill, update: { ...tracked.origin, status: 'available' } }
    : { ok: false, ...skill, error: 'Installation changed' }) } } : null);
  await ui.checkUpdates();
  assert.match(ui.content(), /Update available/); assert.match(ui.content(), /Update check failed/); assert.match(ui.content(), /Installation changed/);
});

test('different repositories use separate requests', async () => {
  const sibling = { ...tracked, id: 'second', name: 'second-skill', path: '/skills/second/SKILL.md', resolvedPath: '/skills/second/SKILL.md', origin: { ...tracked.origin, source: 'org/other' } };
  const { ui, requests } = await fixture([tracked, sibling], new Map(), (url, options) => url.endsWith('/check-update') ? { ok: true, data: { results: options.body.skills.map(skill => ({ ok: true, ...skill, update: { status: 'current' } })) } } : null);
  await ui.checkUpdates();
  const checks = requests.filter(request => request.url.endsWith('/check-update'));
  assert.equal(checks.length, 2); assert.ok(checks.every(check => check.options.body.skills.length === 1));
});
