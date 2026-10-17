#!/usr/bin/env node
// Skill inventory and local file UI regression checks against a disposable console.
// NODE_PATH=/opt/t3/node_modules node scripts/skills-ui-audit.js http://127.0.0.1:23860/__setup/ skills-preview
// Browser responses below are fixtures; no skill/configuration files are changed.
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('playwright-core')); }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.argv[2] || 'http://127.0.0.1:23780/__setup/';
const key = process.argv[3] || 'dev';
const firstId = 'a'.repeat(32), secondId = 'b'.repeat(32);
const body = '---\nname: review\ndescription: Review changes\n---\nText, including </textarea><script>window.skillInjected = true</script>.\n';

(async () => {
 const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
 try {
 for (const theme of ['light', 'dark']) {
 for (const [width, height, embedded] of [[360, 720], [390, 844], [820, 900], [1280, 900], [1198, 878, true]]) {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
  await page.addInitScript((mode) => localStorage.setItem('t3-console-theme', mode), theme);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  let inventoryRequests = 0, gateInventory = false, releaseInventory, oldInventoryStarted;
  let gateRead = false, releaseRead, oldReadStarted, readError = false, inventoryError = false;
  let saveError = true, gateSave = false, releaseSave, saveStarted;
  let stateError = true, gateState = false, releaseState, stateStarted, firstEnabled = true;
  let policies = false, importFailure = true, gateImport = false, releaseImport, importStarted;
  const policyValues = { claude: 'on', opencode: 'allow' };
  const mutations = [];
  const skill = (provider, id, name) => ({ id, name, description: 'A description that is long enough to wrap comfortably on a phone. '.repeat(4),
   path: '/fixture/a-long-global-configuration-directory/skills/' + name + '/SKILL.md',
   resolvedPath: '/fixture/shared-source/skills/' + name + '/SKILL.md', source: 'Shared .agents',
   native: provider === 'codex', state: policies && provider !== 'codex' ? policyValues[provider] : id === firstId && firstEnabled ? 'enabled' : 'disabled', bytes: body.length,
   ...(policies && provider !== 'codex' ? { stateAuthority: 'user-policy', stateLabel: 'User policy: ' + policyValues[provider], canSetState: true,
    stateOptions: (provider === 'claude' ? ['on', 'name-only', 'user-invocable-only', 'off'] : ['allow', 'ask', 'deny']).map((value) => ({ value, label: value })), effectiveStateText: 'Native runtime checked' } : {}),
   canToggle: provider === 'codex', stateRevision: 'native-state-revision',
   canEdit: true, canRemove: true, revision: 'fixture-revision', removalRevision: 'fixture-removal', removalKind: 'directory', removalPath: '/fixture/local/review' });
  const inventoryFor = (provider) => ({ ok: true, provider, canCreate: true,
   creationTargets: [{ id: 'provider', name: 'Provider folder' }, ...(provider === 'codex' || provider === 'opencode' ? [{ id: 'shared', name: 'Shared .agents folder' }] : [])],
   skills: [skill(provider, firstId, 'review'), skill(provider, secondId, 'manual-review')],
   coverage: provider === 'codex' ? 'native' : policies ? 'policy' : 'files', warnings: [], coverageText: provider + ' global skill inventory' });
  await page.route('**/context/skills**', async (route) => {
   const url = new URL(route.request().url()), provider = url.searchParams.get('provider');
   if (route.request().method() === 'POST') {
    const input = route.request().postDataJSON(); mutations.push({ path: url.pathname, input });
    if (url.pathname.endsWith('/source')) {
     if (input.source === 'bad-source') await route.fulfill({ status: 400, json: { ok: false, error: 'No skill found at this source.' } });
     else if (input.source === 'catalog') await route.fulfill({ json: { ok: true, skills: [], warnings: [], links: [{ label: 'Frontend skill', source: 'org/repo@review' }, { label: 'Other skill', source: 'org/other' }] } });
     else await route.fulfill({ json: { ok: true, previewId: 'fixture-preview', source: input.source, warnings: [], skills: [{ name: 'review', description: 'Source description', content: body, bytes: body.length, files: [{ name: 'SKILL.md', bytes: body.length }, { name: 'scripts/check.sh', bytes: 30, executable: true }] }] } });
    } else if (url.pathname.endsWith('/plan')) {
     assert.equal(input.previewId, 'fixture-preview'); assert.deepEqual(input.skills, ['review']); assert.ok(input.providers.includes('cursor'));
     await route.fulfill({ json: { ok: true, planId: 'fixture-plan', canInstall: true, destinations: [{ provider: 'cursor', name: 'review', action: 'replace', directory: '/fixture/a-very-long-path-for-mobile-layout-checks/skills/review' }] } });
    } else if (url.pathname.endsWith('/install')) {
     assert.equal(input.previewId, 'fixture-preview'); assert.equal(input.planId, 'fixture-plan'); assert.equal(input.replace, true);
     if (gateImport) { importStarted(); await new Promise((resolve) => { releaseImport = resolve; }); }
     await route.fulfill(importFailure ? { status: 409, json: { ok: false, error: 'Destination changed after review.' } } : { json: { ok: true, results: [{ provider: 'cursor', name: 'review', directory: '/fixture/skills/review', status: 'installed' }, { provider: 'muse', name: 'review', directory: '/fixture/muse/skills/review', status: 'failed', error: 'Fixture permission error' }] } });
    } else if (url.pathname.endsWith('/discard')) {
     await route.fulfill({ json: { ok: true } });
    } else if (url.pathname.endsWith('/state')) {
     assert.ok(['claude', 'codex', 'opencode'].includes(input.provider)); assert.equal(input.id, firstId);
     assert.equal(input.stateRevision, 'native-state-revision');
     if (input.provider === 'codex') assert.equal(typeof input.enabled, 'boolean'); else assert.equal(typeof input.state, 'string');
     if (gateState) { gateState = false; stateStarted(); await new Promise((resolve) => { releaseState = resolve; }); }
     if (!stateError) { if (input.provider === 'codex') firstEnabled = input.enabled; else policyValues[input.provider] = input.state; }
     await route.fulfill(stateError ? { status: 409, json: { ok: false, error: 'Codex settings changed. Refresh required.' } }
      : { json: { ok: true, inventory: inventoryFor(input.provider) } });
    } else if (url.pathname.endsWith('/save')) {
     assert.equal(input.id, firstId); assert.equal(input.revision, 'fixture-revision');
     if (gateSave) { gateSave = false; saveStarted(); await new Promise((resolve) => { releaseSave = resolve; }); }
     await route.fulfill(saveError ? { status: 409, json: { ok: false, error: 'The skill changed outside the console.' } } : { json: { ok: true } });
    } else if (url.pathname.endsWith('/remove')) {
     assert.equal(input.revision, 'fixture-revision'); assert.equal(input.removalRevision, 'fixture-removal');
     await route.fulfill({ json: { ok: true } });
    } else {
     assert.ok(url.pathname.endsWith('/create')); assert.equal(input.slug, 'added-skill'); assert.equal(input.target, 'shared');
     await route.fulfill({ json: { ok: true } });
    }
    return;
   }
   assert.equal(route.request().method(), 'GET');
   if (url.pathname.endsWith('/read')) {
    const delayed = gateRead;
    if (delayed) { gateRead = false; oldReadStarted(); await new Promise((resolve) => { releaseRead = resolve; }); }
    await route.fulfill(readError ? { status: 409, json: { ok: false, error: 'This skill link changed. Refresh the list.' } }
     : { json: { ok: true, ...skill(provider, firstId, 'review'), bytes: body.length, content: delayed ? '# Old response' : body } });
    return;
   }
   inventoryRequests++;
   if (gateInventory && provider === 'codex') {
    gateInventory = false; oldInventoryStarted(); await new Promise((resolve) => { releaseInventory = resolve; });
   }
   await route.fulfill(inventoryError ? { status: 500, json: { ok: false, error: 'Fixture inventory unavailable' } }
    : { json: inventoryFor(provider) });
  });
  await page.goto(base);
  if (await page.locator('input[type="password"]').isVisible()) {
   await page.locator('input[type="password"]').fill(key);
   await page.getByRole('button', { name: /unlock/i }).click();
   await page.locator('#app').waitFor();
  }
  await page.goto(base + (embedded ? '?embed=t3&theme=' + theme : '') + '#context');
  await page.locator('[data-cmd="skills.view"]').first().waitFor();
  await page.locator('#skill-provider').selectOption('claude');
  await page.locator('.tc-skills[data-provider="claude"]').waitFor();
  assert.equal(await page.locator('#skill-provider option').count(), 7);
  assert.equal(await page.locator('.tc-skill-row .tc-badge').first().innerText(), 'Unverified');
  assert.equal(await page.locator('[data-cmd="skills.state"]').count(), 0);
  const beforeStatus = inventoryRequests;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/status'));
  assert.equal(inventoryRequests, beforeStatus, 'status refresh must not scan skills');

  const started = new Promise((resolve) => { oldInventoryStarted = resolve; });
  gateInventory = true;
  await page.locator('#skill-provider').selectOption('codex'); await started;
  await page.locator('#skill-provider').selectOption('opencode');
  await page.locator('.tc-skills[data-provider="opencode"]').waitFor();
  releaseInventory();
  await page.waitForResponse((response) => response.url().includes('provider=codex'));
  assert.equal(await page.locator('#skill-provider').inputValue(), 'opencode');
  await page.locator('#skill-provider').selectOption('codex');
  await page.locator('.tc-skills[data-provider="codex"]').waitFor();
  assert.deepEqual(await page.locator('.tc-skill-row .tc-badge').allTextContents(), ['Enabled', 'Disabled']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Disable review for Codex', exact: true }).click();
  await page.getByText('Codex settings changed. Refresh required.', { exact: true }).waitFor();
  await page.locator('.tc-toast[data-tone="danger"] [data-toast-close]').click();
  await page.getByRole('button', { name: 'Disable review for Codex', exact: true }).waitFor();
  assert.deepEqual(await page.locator('.tc-skill-row .tc-badge').allTextContents(), ['Enabled', 'Disabled']);
  stateError = false; gateState = true;
  const stateSaving = new Promise((resolve) => { stateStarted = resolve; });
  await page.getByRole('button', { name: 'Disable review for Codex', exact: true }).click(); await stateSaving;
  assert.equal(await page.locator('[data-cmd="skills.state"]:disabled').count(), 2);
  assert.equal(await page.getByRole('button', { name: 'Refresh skills', exact: true }).isDisabled(), true);
  assert.deepEqual(await page.locator('.tc-skill-row .tc-badge').allTextContents(), ['Enabled', 'Disabled'], 'no optimistic availability');
  await page.locator('#skill-provider').selectOption('opencode');
  await page.locator('.tc-skills[data-provider="opencode"]').waitFor();
  const stateSaved = page.waitForResponse((response) => response.url().endsWith('/context/skills/state'));
  releaseState(); await stateSaved;
  assert.equal(await page.locator('#skill-provider').inputValue(), 'opencode');
  assert.equal(await page.locator('[data-cmd="skills.state"]').count(), 0, 'late native result must not replace another provider');
  await page.locator('#skill-provider').selectOption('codex');
  await page.getByRole('button', { name: 'Enable review for Codex', exact: true }).waitFor();
  const enabled = page.waitForResponse((response) => response.url().endsWith('/context/skills/state'));
  await page.getByRole('button', { name: 'Enable review for Codex', exact: true }).click(); await enabled;
  await page.getByRole('button', { name: 'Disable review for Codex', exact: true }).waitFor();

  gateRead = true;
  const readStarted = new Promise((resolve) => { oldReadStarted = resolve; });
  await page.getByRole('button', { name: 'View review', exact: true }).click(); await readStarted;
  assert.equal(await page.locator('[data-skill-copy]').isDisabled(), true);
  await page.locator('[data-skill-close]').first().click();
  await page.getByRole('button', { name: 'View review', exact: true }).click();
  await page.locator('#skill-content').waitFor();
  assert.equal(await page.locator('#skill-content').inputValue(), body);
  assert.equal(await page.locator('#skill-content').evaluate((element) => element.readOnly), true);
  releaseRead();
  await page.waitForResponse((response) => response.url().includes('/context/skills/read'));
  assert.equal(await page.locator('#skill-content').inputValue(), body, 'late viewer response must be ignored');
  assert.equal(await page.evaluate(() => Boolean(window.skillInjected)), false);
  const box = await page.getByRole('dialog').boundingBox();
  assert.ok(box.x >= -1 && box.x + box.width <= width + 1);
  assert.ok(box.y >= -1 && box.y + box.height <= height + 1);
  const downloadReady = page.waitForEvent('download');
  await page.locator('[data-skill-download]').click();
  const download = await downloadReady;
  assert.equal(download.suggestedFilename(), 'review.md');
  assert.equal(fs.readFileSync(await download.path(), 'utf8'), body);
  await page.locator('[data-skill-edit]').click();
  assert.equal(await page.locator('#skill-content').evaluate((element) => element.readOnly), false);
  assert.equal(await page.locator('[data-skill-save]').isDisabled(), true, 'unchanged skill Markdown cannot be saved again');
  const draft = body + '\nAn unsaved change.\n';
  await page.locator('#skill-content').fill(draft);
  assert.equal(await page.locator('[data-skill-save]').isDisabled(), false, 'edited skill Markdown can be saved');
  await page.locator('[data-skill-save]').click();
  await page.getByText('The skill changed outside the console.', { exact: true }).waitFor();
  assert.equal(await page.locator('#skill-content').inputValue(), draft);
  const draftReady = page.waitForEvent('download'); await page.locator('[data-skill-download]').click();
  assert.equal(fs.readFileSync(await (await draftReady).path(), 'utf8'), draft);
  saveError = false; gateSave = true;
  const saving = new Promise((resolve) => { saveStarted = resolve; });
  await page.locator('[data-skill-save]').click(); await saving;
  assert.equal(await page.locator('[data-skill-save]').isDisabled(), true);
  assert.equal(await page.locator('[data-skill-close]').first().isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 1);
  releaseSave(); await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'View review', exact: true }).click();
  await page.locator('[data-skill-remove]').waitFor();
  const removalsBefore = mutations.filter((item) => item.path.endsWith('/remove')).length;
  await page.locator('[data-skill-remove]').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(mutations.filter((item) => item.path.endsWith('/remove')).length, removalsBefore);
  await page.locator('[data-skill-remove]').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove skill', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Add skill', exact: true }).click();
  await page.locator('#skill-target').selectOption('shared');
  await page.locator('#skill-slug').fill('added-skill');
  assert.ok((await page.locator('#skill-content').inputValue()).includes('added-skill'));
  const imported = '---\nname: added-skill\ndescription: Imported Markdown\n---\nKeep this text exactly.\n';
  await page.locator('#skill-file').setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(imported) });
  await page.waitForFunction((text) => document.querySelector('#skill-content')?.value === text, imported);
  await page.locator('[data-skill-save]').click(); await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(mutations.find((item) => item.path.endsWith('/create')).input.content, imported);
  await page.getByRole('button', { name: 'View review', exact: true }).click();
  await page.locator('#skill-content').waitFor();
  await page.locator('[data-skill-close]').first().click();
  readError = true;
  await page.getByRole('button', { name: 'View review', exact: true }).click();
  await page.getByText('This skill link changed. Refresh the list.', { exact: true }).waitFor();
  assert.equal(await page.locator('#skill-content').count(), 0);
  assert.equal(await page.locator('[data-skill-download]').isDisabled(), true);
  await page.locator('[data-skill-close]').first().click();
  policies = true;
  for (const [nativeProvider, count, chosen] of [['claude', 4, 'off'], ['opencode', 3, 'deny']]) {
   await page.locator('#skill-provider').selectOption(nativeProvider);
   await page.locator('[data-skill-policy]').first().waitFor();
   assert.equal(await page.locator('[data-skill-policy]').first().locator('option').count(), count);
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
   gateState = true;
   const savingPolicy = new Promise((resolve) => { stateStarted = resolve; });
   await page.locator('[data-skill-policy]').first().selectOption(chosen); await savingPolicy;
   assert.equal(await page.locator('[data-skill-policy]:disabled').count(), 2);
   const savedPolicy = page.waitForResponse((response) => response.url().endsWith('/context/skills/state'));
   releaseState(); await savedPolicy;
   await page.waitForFunction((expected) => document.querySelector('[data-skill-policy]')?.value === expected && !document.querySelector('[data-skill-policy]').disabled, chosen);
   assert.ok((await page.locator('.tc-skill-row .tc-badge').first().innerText()).includes(chosen));
  }
  inventoryError = true;
  const refreshed = page.waitForRequest((request) => request.url().includes('refresh=1'));
  await page.getByRole('button', { name: 'Refresh skills', exact: true }).click(); await refreshed;
  await page.getByText('Could not read skills: Fixture inventory unavailable', { exact: true }).waitFor();
  assert.equal(await page.locator('.tc-skill-row').count(), 0, 'stale states must be hidden after a failed refresh');
  inventoryError = false;
  await page.getByRole('button', { name: 'Refresh skills', exact: true }).click();
  await page.locator('.tc-skill-row').first().waitFor();
  await page.getByRole('button', { name: 'Install from source', exact: true }).click();
  await page.locator('#skill-source').fill('bad-source'); await page.locator('[data-import-preview]').click();
  await page.getByRole('alert').filter({ hasText: 'No skill found at this source.' }).waitFor();
  await page.locator('#skill-source').fill('catalog'); await page.locator('[data-import-preview]').click();
  await page.locator('#skill-catalog-search').fill('Frontend');
  assert.equal(await page.locator('[data-import-link]').count(), 1);
  await page.locator('[data-import-link]').click();
  await page.locator('[data-import-skill]').waitFor();
  assert.equal(await page.locator('[data-import-skill]').isChecked(), true);
  assert.equal(await page.locator('[data-import-provider]').count(), 7);
  await page.getByText('Review 2 files', { exact: false }).click();
  assert.equal(await page.locator('.tc-import-markdown').innerText(), body);
  assert.equal(await page.evaluate(() => Boolean(window.skillInjected)), false);
  await page.locator('[data-import-provider="cursor"]').check();
  await page.locator('[data-import-review]').click(); await page.locator('[data-import-install]').waitFor();
  assert.equal(await page.locator('[data-import-install]').isDisabled(), true);
  await page.locator('[data-import-replace]').check(); await page.locator('[data-import-install]').click();
  await page.getByRole('alert').filter({ hasText: 'Destination changed after review.' }).waitFor();
  await page.locator('[data-import-back]').click();
  assert.equal(await page.locator('[data-import-provider="cursor"]').isChecked(), true);
  await page.locator('[data-import-review]').click(); await page.locator('[data-import-replace]').check();
  importFailure = false; gateImport = true;
  const installing = new Promise((resolve) => { importStarted = resolve; });
  await page.locator('[data-import-install]').click(); await installing;
  assert.equal(await page.locator('[data-import-install]').isDisabled(), true);
  assert.equal(await page.locator('[data-import-close]').first().isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 1);
  const installBox = await page.getByRole('dialog').boundingBox();
  assert.ok(installBox.x >= -1 && installBox.x + installBox.width <= width + 1);
  assert.ok(installBox.y >= -1 && installBox.y + installBox.height <= height + 1);
  releaseImport(); await page.getByText('Fixture permission error', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('PASS Skill inventory, native state, files and source installation:', theme, width + 'x' + height, embedded ? 'embedded-query fallback' : 'standalone');
  await page.close();
 }
 }
 } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
