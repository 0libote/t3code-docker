#!/usr/bin/env node
// Real console, intercepted fixture APIs and disposable browser contexts.
// Never reads production skills or sends a write to the Setup service.
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { statusFor, framed } = require('./lib/console-fixtures.cjs');
const { createSkillsFixtures } = require('./lib/skills-fixtures.cjs');
const base = process.argv[2] || 'http://127.0.0.1:23785/__setup/';
const key = process.argv[3] || 'dev';
const output = process.env.T3_SKILL_UPDATE_UI_OUTPUT || '/tmp/t3-skill-update-ui';
fs.mkdirSync(output, { recursive: true });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark']) for (const [width, height, embedded] of [[1440, 900], [390, 844], [360, 640], [1198, 878, true]]) {
      if (process.env.T3_SKILL_UPDATE_UI_WIDTHS && !process.env.T3_SKILL_UPDATE_UI_WIDTHS.split(',').includes(String(width))) continue;
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
      page.setDefaultTimeout(8000);
      await page.addInitScript(mode => localStorage.setItem('t3-console-theme', mode), theme);
      const api = createSkillsFixtures(), errors = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      let previewGate, previewStarted, saveGate, saveStarted, failRead = false, failSave = false, loseSave = false, expire = false, long = false;
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method(), input = method === 'POST' ? request.postDataJSON() : {};
        const at = suffix => url.pathname.endsWith(suffix);
        if (url.pathname.includes('/context/skills') && method === 'POST') writes.push({ path: url.pathname, input });
        if (at('/update/preview')) {
          if (previewGate) { previewStarted.resolve(); await previewGate.promise; previewGate = null; }
          if (failRead) return route.fulfill({ status: 503, json: { ok: false, error: 'Repository temporarily unavailable. Existing files are kept.' } });
        }
        if (at('/skills/update')) {
          if (saveGate) { saveStarted.resolve(); await saveGate.promise; saveGate = null; }
          if (failSave) return route.fulfill({ status: 409, json: { ok: false, error: 'The installed files changed after review. Review them again.' } });
        }
        const response = api.respond(method, url, input) || (at('/status') ? { body: statusFor('skills') } : null);
        if (response && at('/update/preview')) {
          if (expire) response.body.expiresAt = response.body.createdAt + 50;
          if (long) {
            response.body.target.directory += '/long folder'.repeat(20);
            response.body.changes[0].name = 'references/' + 'a-long-file-name-'.repeat(15) + '.md';
          }
        }
        if (response && at('/skills/update') && loseSave) { loseSave = false; return route.abort('connectionreset'); }
        if (response) return route.fulfill({ status: response.status || 200, json: response.body });
        return route.continue();
      });
      const target = embedded ? await framed(page, base + '?embed=t3&theme=' + theme) : page;
      if (!embedded) await page.goto(base);
      if (await target.locator('input[type=password]').count()) { await target.locator('input[type=password]').fill(key); await target.locator('button[type=submit]').click(); }
      await target.waitForSelector('#app');
      await target.evaluate(() => { location.hash = 'instructions/skills'; });
      await target.locator('#skill-search').fill('frontend-design');
      const sheet = target.locator('.tc-skill-update');
      const open = async () => {
        await target.locator(width < 640 ? '.tc-prow' : '.tc-skill-name').filter({ visible: true, hasText: 'frontend-design' }).click();
        await target.locator('[data-inspect-review-source]').click();
      };
      const ready = async () => { await sheet.locator('[data-update-consent]').waitFor(); };
      const shot = name => page.screenshot({ path: path.join(output, `${theme}-${width}${embedded ? '-embedded' : ''}-${name}.png`) });
      const restoreFixture = () => { for (const inventory of Object.values(api.inventories)) for (const row of inventory.skills) if (row.name === 'frontend-design') delete row.update; };
      // Dismiss a slow source read. Its eventual snapshot must be discarded.
      previewGate = deferred(); previewStarted = deferred(); await open(); await previewStarted.promise;
      await sheet.getByRole('status').filter({ hasText: 'Checking the repository' }).waitFor();
      await sheet.getByRole('button', { name: 'Cancel', exact: true }).click(); previewGate.resolve();
      await sheet.waitFor({ state: 'hidden' });
      await open(); await ready();
      assert.equal(await sheet.locator('[data-update-save]').isDisabled(), true);
      assert(await sheet.locator('[data-update-consent]').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'replacement consent stays visible beside the action');
      assert.match(await sheet.innerText(), /Update in place/); assert.match(await sheet.innerText(), /Local edits will be replaced/);
      assert.match(await sheet.innerText(), /front.*design/s); assert.match(await sheet.innerText(), /Muse Code/);
      assert.equal(await sheet.locator('[data-import-agent]').count(), 0);
      assert(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      assert(await sheet.locator('.tc-update-files li code').evaluateAll(nodes => nodes.every(node => node.parentElement.getBoundingClientRect().width >= 100)), 'file paths retain a readable column in every change state');
      await shot('review');
      await sheet.getByRole('button', { name: 'Compare instructions' }).click();
      const compare = target.getByRole('dialog', { name: 'SKILL.md', exact: true }); await compare.waitFor();
      await compare.getByRole('button', { name: 'Installed', exact: true }).click();
      assert.equal(await compare.getByRole('button', { name: 'Installed', exact: true }).getAttribute('aria-pressed'), 'true');
      if (width < 1024) assert((await compare.getByRole('button', { name: 'Installed', exact: true }).boundingBox()).height >= 44, 'instruction comparison retains touch targets');
      await compare.getByRole('button', { name: 'Incoming', exact: true }).click();
      assert.match(await compare.innerText(), /Check accessibility/);
      assert.equal(await target.evaluate(() => window.skillInjected), undefined);
      await shot('instructions');
      await compare.getByRole('button', { name: 'Close instruction comparison' }).click();
      const consent = sheet.locator('[data-update-consent]'); await consent.check();
      assert.equal(await sheet.locator('[data-update-save]').isDisabled(), false);
      saveGate = deferred(); saveStarted = deferred(); await sheet.locator('[data-update-save]').click(); await saveStarted.promise;
      assert.match(await sheet.innerText(), /Updating/); await page.keyboard.press('Escape'); assert(await sheet.isVisible());
      assert(await sheet.locator('[data-update-close]').first().isDisabled());
      assert(await target.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; }));
      assert.equal(writes.filter(write => write.path.endsWith('/skills/update')).length, 1);
      await shot('saving'); saveGate.resolve();
      await sheet.getByRole('heading', { name: 'Skill updated' }).waitFor(); await shot('success');
      await sheet.getByRole('button', { name: 'Done', exact: true }).click(); await sheet.waitFor({ state: 'hidden' });
      await open(); await sheet.getByText('This skill already matches its repository source.', { exact: true }).waitFor();
      assert.equal(await sheet.locator('[data-update-save]').count(), 0);
      await sheet.getByRole('button', { name: 'Cancel', exact: true }).click(); restoreFixture();
      // Failed reads and stale writes both have recovery and reset consent.
      failRead = true; await open(); await sheet.locator('[data-update-error]').waitFor(); await shot('read-failure');
      failRead = false; await sheet.getByRole('button', { name: 'Review again' }).click(); await ready();
      await sheet.locator('[data-update-consent]').check(); failSave = true; await sheet.locator('[data-update-save]').click();
      await sheet.locator('[data-update-error]').waitFor(); assert.match(await sheet.innerText(), /files changed after review/);
      await shot('conflict'); failSave = false; await sheet.getByRole('button', { name: 'Review again' }).click(); await ready();
      assert.equal(await sheet.locator('[data-update-consent]').isChecked(), false);
      // A dropped response retries the same plan. It does not fetch/replan.
      await sheet.locator('[data-update-consent]').check(); loseSave = true; await sheet.locator('[data-update-save]').click();
      await sheet.getByRole('button', { name: 'Check result' }).waitFor();
      const submitted = writes.filter(write => write.path.endsWith('/skills/update')).at(-1).input;
      await sheet.getByRole('button', { name: 'Check result' }).click(); await sheet.getByRole('heading', { name: 'Skill updated' }).waitFor();
      assert.deepEqual(writes.filter(write => write.path.endsWith('/skills/update')).at(-1).input, submitted);
      await sheet.getByRole('button', { name: 'Done', exact: true }).click(); restoreFixture();
      expire = true; await open(); await sheet.getByText('This review expired. Review again to check the current files.', { exact: true }).waitFor();
      assert.equal(await sheet.locator('[data-update-save]').count(), 0); expire = false;
      long = true; await sheet.getByRole('button', { name: 'Review again' }).click(); await ready();
      assert(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      assert(await sheet.locator('[data-update-save]').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
      await shot('long-paths'); await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.deepEqual(errors, []); console.log('Skill update UI passed:', theme, width, embedded ? 'embedded' : 'standalone');
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
