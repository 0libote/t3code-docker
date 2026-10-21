#!/usr/bin/env node
// Real console, synthetic hooks and intercepted writes. No native approvals.
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { statusFor, framed } = require('./lib/console-fixtures.cjs');
const { createSkillsFixtures } = require('./lib/skills-fixtures.cjs');
const base = process.argv[2] || 'http://127.0.0.1:23785/__setup/';
const key = process.argv[3] || 'dev';
const output = process.env.T3_HOOKS_UI_OUTPUT || '/tmp/t3-hooks-ui-audit'; fs.mkdirSync(output, { recursive: true });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark']) for (const [width, height, embedded] of [[1440, 900], [390, 844], [360, 720], [1198, 878, true]]) {
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
      page.setDefaultTimeout(8000);
      await page.addInitScript(value => localStorage.setItem('t3-console-theme', value), theme);
      const api = createSkillsFixtures(), errors = [], writes = [];
      api.inventories.codex.skills.push({ ...api.inventories.codex.skills[0], id: 'review-plugin-skill', name: 'review-tools:review-changes', source: 'Plugin', scope: 'user', pluginId: 'review-tools@fixtures',
        path: '/home/t3/.codex/plugins/cache/review-tools/skills/review-changes/SKILL.md', resolvedPath: '/home/t3/.codex/plugins/cache/review-tools/skills/review-changes/SKILL.md',
        canEdit: false, canRemove: false, canToggle: false, canSetState: false, stateReadOnlyReason: 'Managed through the plugin' });
      let reads = 0, getGate, getStarted, saveGate, saveStarted, failRead = false, failSave = false, empty = false;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method(), input = method === 'POST' ? request.postDataJSON() : {};
        if (url.pathname.endsWith('/skills/hooks')) {
          reads++;
          if (getGate) { getStarted.resolve(); await getGate.promise; getGate = null; }
          if (failRead) return route.fulfill({ status: 403, json: { ok: false, error: 'This Codex version could not read plugin hooks.' } });
          if (empty) return route.fulfill({ json: { ok: true, hooks: [], warnings: [] } });
        }
        if (url.pathname.endsWith('/hooks/state')) {
          writes.push(input);
          if (saveGate) { saveStarted.resolve(); await saveGate.promise; saveGate = null; }
          if (failSave) return route.fulfill({ status: 409, json: { ok: false, error: 'The hook changed outside the console. Review the new definition.' } });
        }
        const response = api.respond(method, url, input) || (url.pathname.endsWith('/status') ? { body: statusFor('skills') } : null);
        if (response) return route.fulfill({ status: response.status || 200, json: response.body });
        return route.continue();
      });
      const target = embedded ? await framed(page, base + '?embed=t3&theme=' + theme) : page;
      if (!embedded) await page.goto(base);
      if (await target.locator('input[type=password]').count()) {
        await target.locator('input[type=password]').fill(key); await target.locator('button[type=submit]').click();
      }
      await target.waitForSelector('#app');
      await target.evaluate(() => { location.hash = 'instructions/skills'; });
      await target.locator('[data-cmd="skills.hooks"]').waitFor(); assert.equal(reads, 0, 'No hook discovery during normal inventory/polling');
      await target.locator('[data-cmd="skills.hooks"]').click();
      const sheet = target.locator('.tc-skill-hooks'), first = () => sheet.locator('[data-hook="fixture-hook-0"]');
      await first().waitFor(); assert.equal(await sheet.locator('.tc-hook').count(), 3);
      assert.equal(await sheet.getByRole('heading', { level: 3 }).count(), 2, 'Hooks are grouped by installed plugin');
      assert.match(await sheet.innerText(), /Changed · needs review/); assert.match(await sheet.innerText(), /Disabled/);
      await page.screenshot({ path: path.join(output, `${theme}-${width}${embedded ? '-embedded' : ''}-hooks.png`) });
      assert(await sheet.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await first().getByRole('button', { name: 'Review and trust…' }).click();
      const confirm = target.getByRole('alertdialog'); await confirm.waitFor();
      assert.match(await confirm.innerText(), /session-start.js/); await confirm.getByRole('button', { name: 'Cancel' }).click();
      assert.equal(writes.length, 0); assert(await first().getByRole('button', { name: 'Review and trust…' }).evaluate(el => el === document.activeElement));
      saveGate = deferred(); saveStarted = deferred();
      await first().getByRole('button', { name: 'Review and trust…' }).click(); await confirm.getByRole('button', { name: 'Trust this hook', exact: true }).click();
      await saveStarted.promise; await page.keyboard.press('Escape'); assert(await sheet.isVisible());
      assert(await sheet.getByRole('button', { name: 'Done', exact: true }).isDisabled());
      assert(await target.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); dispatchEvent(event); return event.defaultPrevented; }));
      saveGate.resolve(); await first().getByText('Trusted', { exact: true }).waitFor(); assert.equal(writes.length, 1);
      assert.equal(api.hooks[2].enabled, false, 'Trusting one plugin leaves other plugins unchanged');
      await first().getByRole('button', { name: 'Disable hook' }).click(); await first().getByText('Disabled', { exact: true }).waitFor();
      await first().getByRole('button', { name: 'Enable hook…' }).click(); await confirm.getByRole('button', { name: 'Enable hook', exact: true }).click();
      await first().getByText('Enabled', { exact: true }).waitFor();
      failSave = true;
      await first().getByRole('button', { name: 'Disable hook' }).click(); await sheet.getByRole('alert').waitFor();
      assert.equal(await sheet.locator('.tc-hook').count(), 0, 'Stale actions disappear after failure');
      failSave = false; await sheet.getByRole('button', { name: 'Refresh', exact: true }).click(); await first().waitFor();
      api.hooks[0].command = '<script>window.hookInjected=true</script>' + ' long-argument'.repeat(80);
      await sheet.getByRole('button', { name: 'Refresh', exact: true }).click(); await first().getByLabel('Hook command').filter({ hasText: '<script>' }).waitFor();
      assert.equal(await target.evaluate(() => window.hookInjected), undefined);
      assert(await first().evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Long untrusted commands wrap');
      await sheet.getByRole('button', { name: 'Done', exact: true }).click(); await sheet.waitFor({ state: 'hidden' });
      // A late read must not recreate the closed review sheet.
      getGate = deferred(); getStarted = deferred(); await target.locator('[data-cmd="skills.hooks"]').click(); await getStarted.promise;
      await target.locator('.tc-skill-hooks').getByRole('button', { name: 'Done', exact: true }).click(); getGate.resolve();
      await target.locator('.tc-skill-hooks').waitFor({ state: 'hidden' });
      failRead = true; await target.locator('[data-cmd="skills.hooks"]').click(); await target.locator('.tc-skill-hooks [role=alert]').waitFor();
      failRead = false; empty = true; await target.locator('.tc-skill-hooks').getByRole('button', { name: 'Refresh', exact: true }).click();
      await target.getByText('No installed Codex plugins with hooks were found.', { exact: false }).waitFor();
      await target.locator('.tc-skill-hooks').getByRole('button', { name: 'Done', exact: true }).click(); empty = false;
      const skill = target.locator(width < 640 ? '.tc-prow' : '.tc-skill-name').filter({ hasText: 'review-tools:review-changes' }); await skill.click();
      await target.getByRole('button', { name: 'Review plugin hooks…' }).click(); await target.locator('.tc-skill-hooks .tc-hook').first().waitFor();
      assert.equal(await target.locator('.tc-skill-hooks .tc-hook').count(), 2, 'The inspector limits review to its owning plugin');
      assert(await target.locator('.tc-skill-hooks').getByRole('button', { name: 'All plugins' }).isVisible());
      await target.locator('.tc-skill-hooks').getByRole('button', { name: 'All plugins' }).click();
      assert.equal(await target.locator('.tc-skill-hooks .tc-hook').count(), 3);
      await page.keyboard.press('Escape'); await target.locator('.tc-skill-hooks').waitFor({ state: 'hidden' });
      assert(await target.getByRole('button', { name: 'Review plugin hooks…' }).isVisible());
      assert.deepEqual(errors, []); console.log('Plugin hooks UI passed:', theme, width, embedded ? 'embedded' : 'standalone');
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
