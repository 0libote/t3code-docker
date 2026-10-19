import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../docker/setup/client/skills.js', import.meta.url), 'utf8');
const skills = [
  { id: 'user', name: 'My skill', scope: 'user' },
  { id: 'system', name: 'Bundled skill', scope: 'system' },
  { id: 'admin', name: 'Organization skill', scope: 'admin' },
  { id: 'plugin', name: 'Plugin skill', scope: 'user', source: 'Plugin' },
];
async function fixture(rows = skills, storage = new Map()) {
  const requests = [];
  const context = vm.createContext({
    Kit: { html: (parts, ...values) => parts.reduce((text, part, i) => text + part + (Array.isArray(values[i]) ? values[i].join('') : values[i] ?? ''), ''), raw: (value) => value, icon: () => '' },
    T3Model: { plural: (count, name) => `${count} ${name}${count === 1 ? '' : 's'}` },
    T3SkillImport: { create: () => ({}) },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  });
  vm.runInContext(source + '\nglobalThis.create = T3SkillsUI.create;', context);
  const ui = context.create({ render() {}, getStatus: () => ({ harnesses: [{ installed: true, id: 'codex' }] }), api: async (url) => {
    requests.push(url);
    return { ok: true, data: { provider: 'codex', skills: rows } };
  } });
  await ui.refresh();
  return { ui, requests, storage };
}

test('bundled filter hides only system skills and never changes provider state', async () => {
  const { ui, requests, storage } = await fixture();
  assert.match(ui.content(), /View Bundled skill/);
  ui.toggleBundled();
  const content = ui.content();
  assert.doesNotMatch(content, /View Bundled skill/);
  for (const name of ['My skill', 'Organization skill', 'Plugin skill']) assert.ok(content.includes('View ' + name));
  assert.match(content, /3 skills · 1 hidden/);
  assert.equal(requests.length, 1, 'filtering needs no API call');
  const restored = await fixture(skills, storage);
  assert.doesNotMatch(restored.ui.content(), /View Bundled skill/);
  restored.ui.toggleBundled();
  assert.match(restored.ui.content(), /View Bundled skill/);
  assert.match(restored.ui.content(), /4 skills/);
});

test('filtered empty state explains how to reveal bundled skills', async () => {
  const { ui } = await fixture([skills[1]]);
  ui.toggleBundled();
  assert.match(ui.content(), /0 skills · 1 hidden/);
  assert.match(ui.content(), /All skills are hidden/);
  assert.match(ui.content(), /Turn off Hide bundled skills to show them/);
  assert.doesNotMatch(ui.content(), /No skills yet/);
});

test('blocked browser storage still allows filtering for the session', async () => {
  const storage = { get() { throw Error('blocked'); }, set() { throw Error('blocked'); } };
  const { ui } = await fixture(skills, storage);
  ui.toggleBundled();
  assert.doesNotMatch(ui.content(), /View Bundled skill/);
});
