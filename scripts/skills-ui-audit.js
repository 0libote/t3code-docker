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
  const mutations = [];
  const skill = (provider, id, name) => ({ id, name, description: 'A description that is long enough to wrap comfortably on a phone. '.repeat(4),
   path: '/fixture/a-long-global-configuration-directory/skills/' + name + '/SKILL.md',
   resolvedPath: '/fixture/shared-source/skills/' + name + '/SKILL.md', source: 'Shared .agents',
   native: provider === 'codex', state: id === firstId ? 'enabled' : 'disabled', bytes: body.length,
   canEdit: true, canRemove: true, revision: 'fixture-revision', removalRevision: 'fixture-removal', removalKind: 'directory', removalPath: '/fixture/local/review' });
  await page.route('**/context/skills**', async (route) => {
   const url = new URL(route.request().url()), provider = url.searchParams.get('provider');
   if (route.request().method() === 'POST') {
    const input = route.request().postDataJSON(); mutations.push({ path: url.pathname, input });
    if (url.pathname.endsWith('/save')) {
     assert.equal(input.id, firstId); assert.equal(input.revision, 'fixture-revision');
     if (gateSave) { gateSave = false; saveStarted(); await new Promise((resolve) => { releaseSave = resolve; }); }
     await route.fulfill(saveError ? { status: 409, json: { ok: false, error: 'The skill changed outside the console.' } } : { json: { ok: true } });
    } else if (url.pathname.endsWith('/remove')) {
     assert.equal(input.revision, 'fixture-revision'); assert.equal(input.removalRevision, 'fixture-removal');
     await route.fulfill({ json: { ok: true } });
    } else {
     assert.ok(url.pathname.endsWith('/create')); assert.equal(input.slug, 'added-skill');
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
    : { json: { ok: true, provider, canCreate: true, skills: [skill(provider, firstId, 'review'), skill(provider, secondId, 'manual-review')],
     coverage: provider === 'codex' ? 'native' : 'files', warnings: [], coverageText: provider + ' global skill inventory' } });
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
  await page.getByText('claude global skill inventory', { exact: true }).waitFor();
  assert.equal(await page.locator('#skill-provider option').count(), 6);
  assert.equal(await page.locator('.tc-skill-row .tc-badge').first().innerText(), 'Unverified');
  const beforeStatus = inventoryRequests;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/status'));
  assert.equal(inventoryRequests, beforeStatus, 'status refresh must not scan skills');

  const started = new Promise((resolve) => { oldInventoryStarted = resolve; });
  gateInventory = true;
  await page.locator('#skill-provider').selectOption('codex'); await started;
  await page.locator('#skill-provider').selectOption('opencode');
  await page.getByText('opencode global skill inventory', { exact: true }).waitFor();
  releaseInventory();
  await page.waitForResponse((response) => response.url().includes('provider=codex'));
  assert.equal(await page.locator('#skill-provider').inputValue(), 'opencode');
  await page.locator('#skill-provider').selectOption('codex');
  await page.getByText('codex global skill inventory', { exact: true }).waitFor();
  assert.deepEqual(await page.locator('.tc-skill-row .tc-badge').allTextContents(), ['Enabled', 'Disabled']);

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
  const draft = body + '\nAn unsaved change.\n';
  await page.locator('#skill-content').fill(draft);
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
  inventoryError = true;
  const refreshed = page.waitForRequest((request) => request.url().includes('refresh=1'));
  await page.getByRole('button', { name: 'Refresh skills', exact: true }).click(); await refreshed;
  await page.getByText('Could not read skills: Fixture inventory unavailable', { exact: true }).waitFor();
  assert.equal(await page.locator('.tc-skill-row').count(), 0, 'stale states must be hidden after a failed refresh');
  inventoryError = false;
  await page.getByRole('button', { name: 'Refresh skills', exact: true }).click();
  await page.locator('.tc-skill-row').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('PASS Skill inventory and file controls:', theme, width + 'x' + height, embedded ? 'embedded-query fallback' : 'standalone');
  await page.close();
 }
 }
 } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
