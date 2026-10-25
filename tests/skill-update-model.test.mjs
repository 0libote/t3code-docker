import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../docker/setup/client/skill-model.js', import.meta.url), 'utf8') + '\nglobalThis.model=T3SkillModel;', context);
const S = context.model, plain = value => JSON.parse(JSON.stringify(value));

test('update summaries deduplicate repositories and use the oldest completed check', () => {
  const row = (name, source, status, checkedAt) => ({ name, key: name, origin: { source }, update: status ? { status, checkedAt } : null });
  const rows = [row('A', 'one/repo', 'available', 100), row('B', 'one/repo', 'current', 150), row('C', 'two/repo', 'error', 80), row('D', 'three/repo'), { name: 'Local' }];
  const summary = S.updateSummary(rows);
  assert.equal(summary.tracked.length, 4); assert.equal(summary.sources, 3); assert.equal(summary.checkedAt, 80);
  assert.equal(summary.available.length, 1); assert.equal(summary.errors.length, 1);
  assert.equal(S.updateSummary([rows[3]]).checkedAt, null);
});

test('Updates view ordering follows the behavioral brief before the illustrative JSON', () => {
  const rows = ['current', 'error', 'available', null].map((status, i) => ({ name: String(i), key: String(i), update: status && { status } }));
  assert.deepEqual(rows.sort(S.updateOrder).map(row => row.update?.status || null), ['available', 'error', null, 'current']);
});

test('file ordering keeps SKILL.md first, then modified, added, removed and unchanged', () => {
  const files = [{ name: 'z.md', status: 'modified' }, { name: 'a.md', status: 'removed' }, { name: 'b.md', status: 'added' }, { name: 'SKILL.md', status: 'modified' }, { name: 'c.md', status: 'unchanged' }];
  assert.deepEqual(files.sort(S.changeOrder).map(file => file.name), ['SKILL.md', 'z.md', 'b.md', 'a.md', 'c.md']);
});

test('hook statuses distinguish review, trusted availability and read-only definitions', () => {
  const hook = { pluginId: 'review-tools@team', handlerType: 'command', command: 'node review.js', trustStatus: 'untrusted', enabled: true };
  assert.equal(S.hookStatus(hook).label, 'Waiting for review');
  assert.equal(S.hookStatus({ ...hook, trustStatus: 'modified' }).label, 'Changed since you trusted it');
  assert.equal(S.hookStatus({ ...hook, enabled: false }).label, 'Off · not trusted');
  assert.equal(S.hookStatus({ ...hook, trustStatus: 'trusted' }).label, 'Runs');
  assert.equal(S.hookStatus({ ...hook, trustStatus: 'trusted', enabled: false }).label, 'Off');
  assert.equal(S.hookStatus({ ...hook, readOnlyReason: 'Policy', isManaged: true }).label, 'Managed');
  assert.equal(S.hookStatus({ ...hook, handlerType: 'prompt', readOnlyReason: 'Review in Codex' }).label, 'Review in Codex');
  assert.equal(S.hooksSummary([hook, { ...hook, enabled: false }, { ...hook, readOnlyReason: 'Policy' }]).waiting.length, 1);
});

test('hook copy explains native events, matchers, timeouts and scoped plugin names', () => {
  assert.equal(S.pluginName('review-tools@team'), 'review-tools');
  assert.equal(S.pluginName('@team/review@registry'), '@team/review');
  assert.equal(S.hookLabel('sessionStart'), 'When a session starts');
  assert.equal(S.hookLabel('futureEvent'), 'Future event');
  assert.deepEqual(plain(S.hookMatcher({ eventName: 'sessionStart', matcher: 'startup|resume|clear|compact' })), { text: 'on startup, resume, clear or compact' });
  assert.deepEqual(plain(S.hookMatcher({ eventName: 'preToolUse', matcher: 'shell' })), { text: 'for tools matching ', code: 'shell' });
  assert.equal(S.hookTimeout({ eventName: 'userPromptSubmit', timeoutSec: 15 }), '15 seconds. The prompt waits for it.');
  assert.equal(S.hookTimeout({ timeoutSec: 1, async: true }), '1 second. Runs in the background.');
  assert.equal(S.hookTimeout({ timeoutSec: 0 }), 'No limit');
});
