#!/usr/bin/env node
// Real console + in-memory API. No mutations reach a running agent or server.
// See CONTRIBUTING.md for the documented Playwright browser-audit workflow.
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { statusFor, portsFor, fixture, framed } = require('./lib/console-fixtures.cjs');
const { createSkillsFixtures } = require('./lib/skills-fixtures.cjs');
const base = process.argv[2] || 'http://127.0.0.1:23780/__setup/';
const key = process.argv[3] || 'dev';
const output = process.env.T3_SKILLS_UI_OUTPUT || '/tmp/t3-skills-ui-audit';
fs.mkdirSync(output, { recursive: true });
const deferred = () => { let resolve; const promise = new Promise((done, reject) => { const timer = setTimeout(() => reject(new Error('Timed out waiting for a fixture gate')), 15000); timer.unref(); resolve = () => { clearTimeout(timer); done(); }; }); return { promise, resolve }; };
const visible = (target, selector) => target.locator(selector).filter({ visible: true });
const checkSelect = async (page, select, theme) => {
  await select.focus();
  const normal = await select.evaluate(control => {
    const style = getComputedStyle(control), option = getComputedStyle(control.options[0]);
    return { scheme: style.colorScheme, color: style.color, optionColor: option.color, optionBackground: option.backgroundColor, appearance: style.appearance, arrow: style.backgroundImage };
  });
  assert.equal(normal.scheme, theme);
  assert.equal(normal.color, normal.optionColor);
  assert.notEqual(normal.optionColor, normal.optionBackground);
  assert(normal.appearance !== 'none' || normal.arrow !== 'none');
  await page.emulateMedia({ forcedColors: 'active' });
  const contrast = await select.evaluate(control => ({ focus: control === document.activeElement, appearance: getComputedStyle(control).appearance, outline: parseFloat(getComputedStyle(control).outlineWidth) }));
  assert(contrast.focus); assert.notEqual(contrast.appearance, 'none'); assert(contrast.outline >= 2);
  await page.emulateMedia({ forcedColors: 'none' });
};
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const theme of ['light', 'dark']) for (const [width, height, embedded] of [[1440, 900], [390, 844], [360, 720], [820, 900], [1198, 878, true]]) {
      if (process.env.T3_SKILLS_UI_THEMES && !process.env.T3_SKILLS_UI_THEMES.split(',').includes(theme)) continue;
      if (process.env.T3_SKILLS_UI_WIDTHS && !process.env.T3_SKILLS_UI_WIDTHS.split(',').includes(String(width))) continue;
      console.log('Starting', theme, width);
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript(mode => localStorage.setItem('t3-console-theme', mode), theme);
      const api = createSkillsFixtures(), status = statusFor('skills'), errors = [], writes = [], gets = {};
      page.setDefaultTimeout(8000);
      page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
      let stateGate, stateStarted, planGate, planStarted, sourceGate, sourceStarted, readGate, readStarted, installGate, installStarted;
      let stateFail = false, saveFail = false, partial = false, blocked = false, expire = false, providerError = null;
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        const input = method === 'POST' ? request.postDataJSON() : {};
        const at = suffix => url.pathname.endsWith(suffix);
        if (url.pathname.includes('/context/skills')) {
          if (method === 'GET') gets[url.pathname + url.search] = (gets[url.pathname + url.search] || 0) + 1;
          else writes.push({ path: url.pathname, input });
          if (at('/skills') && url.searchParams.get('provider') === providerError) return route.fulfill({ status: 503, json: { ok: false, error: 'Fixture agent is temporarily unavailable' } });
          if (at('/state')) {
            if (stateGate) { stateStarted.resolve(); await stateGate.promise; stateGate = null; }
            if (stateFail) return route.fulfill({ status: 409, json: { ok: false, error: 'Settings changed outside the console. Rescan before trying again.' } });
          }
          if (at('/install') && installGate) { installStarted.resolve(); await installGate.promise; installGate = null; }
          if (at('/read') && readGate) { readStarted.resolve(); await readGate.promise; readGate = null; }
          if (at('/source') && sourceGate) { sourceStarted.resolve(); await sourceGate.promise; sourceGate = null; }
          if (at('/plan') && planGate) { planStarted.resolve(); await planGate.promise; planGate = null; }
          if (at('/save') && saveFail) return route.fulfill({ status: 409, json: { ok: false, error: 'The skill changed outside the console. Your draft is kept.' } });
        }
        let response = api.respond(method, url, input);
        if (response && at('/source') && expire) response.body.expiresAt = Date.now() + 1000;
        if (response && at('/plan') && blocked) { response.body.canInstall = false; response.body.destinations[0] = { ...response.body.destinations[0], action: 'blocked', error: 'This folder is read-only' }; }
        if (response && at('/install') && partial) response.body.results[0] = { ...response.body.results[0], status: 'failed', error: 'Fixture disk is temporarily full' };
        if (!response && at('/status')) response = { body: status };
        if (!response && at('/ports')) response = { body: portsFor('ready') };
        if (!response && at('/providers')) response = { body: fixture('providers.json') };
        if (!response && method === 'POST' && !at('/login')) response = { body: { ok: true } };
        if (response) return route.fulfill({ status: response.status || 200, json: response.body });
        return route.continue();
      });
      const target = embedded ? await framed(page, base + '?embed=t3&theme=' + theme) : page;
      if (!embedded) await page.goto(base);
      if (await target.locator('input[type=password]').count()) {
        await target.locator('input[type=password]').fill(key);
        await target.locator('button[type=submit]').click();
      }
      await target.waitForSelector('#app');
      const navigate = async hash => { await target.evaluate(value => { location.hash = value; window.scrollTo(0, 0); }, hash); };
      const shot = async step => { console.log('Captured', theme, width, step); return page.screenshot({ path: path.join(output, `${theme}-${width}${embedded ? '-embedded' : ''}-${step}.png`) }); };
      const close = async () => { await page.keyboard.press('Escape'); await target.locator('.tc-layer:not([data-closing]) [role=dialog]').waitFor({ state: 'hidden' }); };
      const openSource = async () => { await visible(target, '[data-cmd="skills.import"]').click(); await target.locator('#skill-source').fill('vercel-labs/skills'); await target.locator('#skill-source').press('Enter'); await target.locator('[data-import-all]').waitFor(); };
      const next = () => target.locator('[data-import-next]');
      await navigate('instructions/skills');
      await target.locator('.tc-mx-row').first().waitFor({ state: 'attached' });
      await target.waitForFunction(() => !document.querySelector('.tc-mx-agent-kind')?.textContent.includes('Reading'));
      assert.equal(await target.locator('.tc-mx-row').count(), 18);
      assert.equal(await target.locator('.tc-mx-agent').count(), 5);
      assert.equal(await target.locator('#cx-tab-skills').innerText(), 'Skills 22');
      const inventoryCount = Object.values(gets).reduce((a, b) => a + b, 0);
      await target.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(300);
      assert.equal(Object.values(gets).reduce((a, b) => a + b, 0), inventoryCount, 'routine status polling must not discover skills');
      await page.keyboard.press('/');
      assert.equal(await target.evaluate(() => document.activeElement.id), 'skill-search');
      await target.locator('#skill-search').fill('research narrative');
      assert.equal(await target.locator('.tc-mx-row').count(), 1);
      await target.locator('#skill-search').fill('');
      if (width >= 1024) {
        await target.locator('[data-cmd="skills.attention"]').first().click();
        assert.equal(await target.locator('.tc-mx-row').count(), 1);
        await target.locator('[data-cmd="skills.attention"]').first().click();
        await target.locator('[data-cmd="skills.filter"]').click();
        await target.getByRole('menuitemradio', { name: 'Codex', exact: true }).click();
        assert.equal(await target.locator('.tc-mx-row').count(), 1, 'off skills and collapsed system skills are not available user rows');
        await target.locator('[data-cmd="skills.filter"]').click();
        await target.getByRole('menuitemradio', { name: 'Any agent', exact: true }).click();
      } else {
        await target.locator('[data-cmd="skills.agent"][data-provider=codex]').click();
        assert.equal(await target.locator('.tc-mx-row').count(), 1);
        await target.locator('[data-cmd="skills.agent"][data-provider=""]').click();
      }
      await shot('library');
      const deep = () => visible(target, '[data-cmd="skills.view"]').filter({ hasText: 'deep-research' });
      await deep().click();
      await target.locator('.tc-insp-body .tc-code').waitFor();
      assert.equal(await target.evaluate(() => window.skillInjected), undefined);
      assert.equal(await target.locator('.tc-avail-row').count(), 5);
      assert.equal(await target.locator('.tc-files li').count(), 3);
      await checkSelect(page, target.getByRole('combobox', { name: /Claude Code visibility/ }), theme);
      await shot('inspector');
      await target.locator('[data-inspect-edit]').click();
      const draft = '---\nname: deep-research\ndescription: A reviewed draft\n---\nUnsaved draft survives status refresh.';
      await target.locator('#skill-content').fill(draft);
      await target.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(250);
      assert.equal(await target.locator('#skill-content').inputValue(), draft);
      saveFail = true; await target.locator('[data-inspect-save]').click();
      await target.getByRole('alert').filter({ hasText: 'Your draft is kept' }).waitFor();
      assert.equal(await target.locator('#skill-content').inputValue(), draft);
      await page.keyboard.press('Escape');
      await target.getByRole('alertdialog').waitFor();
      await target.getByRole('button', { name: 'Discard draft', exact: true }).click();
      await target.locator('.tc-skill-inspector').waitFor({ state: 'hidden' });
      if (width === 1440 && theme === 'light') {
        // Separate settings files stay usable while one provider is writing.
        const policy = target.getByRole('button', { name: 'Claude Code visibility for deep-research: Name only', exact: true });
        await policy.click();
        assert.equal(await target.getByRole('menuitemradio', { name: /Name only/ }).getAttribute('aria-checked'), 'true');
        await page.keyboard.press('Escape'); assert(await policy.evaluate(el => el === document.activeElement));
        stateGate = deferred(); stateStarted = deferred();
        await policy.click(); await target.getByRole('menuitemradio', { name: /^Off/ }).click(); await stateStarted.promise;
        assert(await target.getByRole('button', { name: 'Claude Code visibility for built-in-browser: On', exact: true }).isDisabled());
        assert(await target.getByRole('button', { name: 'OpenCode permission for deep-research: Allowed', exact: true }).isEnabled());
        stateGate.resolve();
        await target.getByRole('button', { name: 'Claude Code visibility for deep-research: Off', exact: true }).waitFor();
        stateFail = true;
        await target.getByRole('button', { name: 'Claude Code visibility for deep-research: Off', exact: true }).click();
        await target.getByRole('menuitemradio', { name: /^On / }).click();
        await target.locator('.tc-toast[data-tone=danger]').filter({ hasText: 'Settings changed' }).waitFor();
        stateFail = false;
        providerError = 'grok'; await visible(target, '[data-cmd="skills.refresh"]').click();
        await target.getByText('Fixture agent is temporarily unavailable', { exact: true }).waitFor();
        assert(await target.getByRole('button', { name: 'OpenCode permission for deep-research: Allowed', exact: true }).isEnabled());
        providerError = null; await visible(target, '[data-cmd="skills.refresh"]').click();
        await target.getByText('Fixture agent is temporarily unavailable', { exact: true }).waitFor({ state: 'hidden' });
        await target.locator('[data-cmd="skills.columns"]').click();
        await target.waitForFunction(() => document.querySelectorAll('.tc-mx-agent').length === 7);
        assert.equal(await target.locator('.tc-mx-agent[data-uninstalled]').count(), 2);
        await target.locator('[data-cmd="skills.columns"]').click();
        // A closed source request must release its late snapshot, never reopen.
        sourceGate = deferred(); sourceStarted = deferred();
        await visible(target, '[data-cmd="skills.import"]').click();
        await target.locator('#skill-source').fill('slow-source'); await target.locator('#skill-source').press('Enter'); await sourceStarted.promise;
        await close(); sourceGate.resolve();
        await page.waitForTimeout(200);
        assert(writes.some(write => write.path.endsWith('/discard')));
        assert.equal(await target.locator('.tc-skill-import').count(), 0);
        // A late detail must not overwrite another inspector's draft.
        readGate = deferred(); readStarted = deferred();
        await deep().click(); await readStarted.promise; await close();
        await visible(target, '[data-cmd="skills.add"]').click();
        await target.locator('#skill-slug').fill('my-workflow');
        await target.locator('#skill-content').fill(draft);
        readGate.resolve(); await page.waitForTimeout(100);
        assert.equal(await target.locator('#skill-content').inputValue(), draft);
        await page.keyboard.press('Escape'); await target.getByRole('button', { name: 'Discard draft', exact: true }).click();
      }
      await target.locator('#skill-search').fill('design');
      await openSource();
      assert(await next().isDisabled());
      await target.locator('[data-import-skill=frontend-design]').check();
      assert.equal(await target.locator('[data-import-all]').evaluate(el => el.indeterminate), true);
      await target.locator('[data-import-all]').check();
      await target.locator('[data-import-files=frontend-design]').click();
      await target.locator('[data-import-markdown=frontend-design]').click();
      await target.locator('.tc-source-markdown .tc-code').waitFor();
      assert.equal(await target.evaluate(() => window.skillInjected), undefined);
      await page.keyboard.press('Escape');
      await shot('source');
      await next().click();
      await target.locator('[data-import-replace]').waitFor();
      assert(await next().isDisabled());
      assert.equal(writes.filter(write => write.path.endsWith('/plan')).at(-1).input.providers.join(','), 'claude,codex');
      if (width < 1024) await target.locator('[data-import-rail]').click();
      assert((await target.locator('.tc-wizard-rail').innerText()).includes('Cursor finds 2 copies'));
      if (width >= 1024) {
        await target.evaluate(() => document.fonts.ready);
        await target.waitForFunction(() => {
          const rail = document.querySelector('.tc-wizard-rail');
          return rail && Math.abs(rail.getBoundingClientRect().bottom - rail.querySelector('.tc-plan-bottom').getBoundingClientRect().bottom - 20) < 2;
        });
      }
      await target.locator('[data-import-replace]').check();
      assert(await next().isEnabled());
      await shot('agents');
      if (width === 1440 && theme === 'light') {
        // Selection invalidates consent synchronously while an old plan is pending.
        planGate = deferred(); planStarted = deferred();
        await target.locator('[data-import-mode=each]').click(); await planStarted.promise;
        assert(await next().isDisabled());
        await target.locator('[data-import-mode=fewest]').click(); planGate.resolve();
        await target.locator('[data-import-replace]').waitFor();
        assert.equal(await target.locator('[data-import-replace]').isChecked(), false);
        await target.locator('[data-import-replace]').check();
        blocked = true; await target.locator('[data-import-mode=each]').click();
        await target.getByText('This folder is read-only', { exact: false }).waitFor();
        assert(await next().isDisabled());
        blocked = false; await target.locator('[data-import-mode=fewest]').click();
        await target.locator('[data-import-replace]').waitFor(); await target.locator('[data-import-replace]').check();
        partial = true;
        installGate = deferred(); installStarted = deferred();
      }
      await next().click();
      if (installGate) {
        await installStarted.promise;
        assert(await target.locator('[data-import-close]').isDisabled());
        await page.keyboard.press('Escape');
        assert(await target.locator('.tc-skill-import').isVisible(), 'publication cannot be dismissed halfway through');
        installGate.resolve();
      }
      await target.locator('.tc-result-hero').waitFor();
      await shot('result');
      if (partial) {
        assert.equal(await target.locator('[data-import-review-again]').count(), 1);
        partial = false;
        const sourceCalls = writes.filter(write => write.path.endsWith('/source')).length;
        await target.locator('[data-import-review-again]').click();
        await target.locator('[data-import-replace]').waitFor(); await target.locator('[data-import-replace]').check();
        await next().click(); await target.locator('.tc-result-hero').waitFor();
        assert.equal(writes.filter(write => write.path.endsWith('/source')).length, sourceCalls);
      }
      await target.locator('[data-import-show]').click();
      await target.locator('.tc-skill-import').waitFor({ state: 'hidden' });
      assert.equal(await target.locator('#skill-search').inputValue(), '', 'Show in library clears the visible search field too');
      if (width === 1440 && theme === 'light') {
        expire = true; await openSource(); await target.locator('[data-import-all]').check();
        await target.getByText('This snapshot expired', { exact: true }).waitFor();
        assert(await next().isDisabled());
        expire = false; await target.locator('[data-import-reread]').click();
        await target.locator('[data-import-all]').waitFor();
        await target.getByText('This snapshot expired', { exact: true }).waitFor({ state: 'hidden' });
        await close();
        // File actions preserve drafts and carry both Markdown/tree revisions.
        await deep().click(); await target.locator('.tc-insp-body .tc-code').waitFor();
        await target.locator('[data-inspect-remove]').click();
        await target.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert(!writes.some(write => write.path.endsWith('/remove')));
        await target.locator('[data-inspect-remove]').click();
        await target.getByRole('button', { name: 'Remove skill', exact: true }).click();
        await target.locator('.tc-skill-inspector').waitFor({ state: 'hidden' });
        const removal = writes.find(write => write.path.endsWith('/remove')).input;
        assert.equal(removal.revision, 'fixture-file-deep-research'); assert.equal(removal.removalRevision, 'fixture-removal');
        await visible(target, '[data-cmd="skills.add"]').first().click();
        await target.locator('#skill-slug').fill('my-workflow');
        const upload = '---\nname: my-workflow\ndescription: Uploaded workflow\n---\nSafe literal text.';
        await target.locator('#skill-file').setInputFiles({ name: 'workflow.md', mimeType: 'text/markdown', buffer: Buffer.from(upload) });
        await target.waitForFunction(text => document.querySelector('#skill-content')?.value === text, upload);
        assert(!writes.some(write => write.path.endsWith('/create')), 'upload changes only a draft');
        const download = page.waitForEvent('download');
        await target.locator('[data-inspect-download]').click();
        assert.equal((await download).suggestedFilename(), 'my-workflow.md');
        await target.locator('#skill-content').press('Control+s');
        await target.locator('.tc-skill-inspector').waitFor({ state: 'hidden' });
        assert.equal(writes.find(write => write.path.endsWith('/create')).input.content, upload);
      }
      await navigate('instructions');
      await target.locator('.tc-doc-preview .tc-code').waitFor();
      assert.equal(await target.locator('.tc-reads-row').count(), 3);
      assert.equal(await target.locator('.tc-reads-row .tc-seg button').count(), 9);
      assert.equal(await target.locator('.tc-doc-preview script').count(), 0);
      await shot('instructions');
      const overflow = await target.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, 'the page never scrolls sideways');
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`${theme} ${width}${embedded ? ' embedded' : ''}: library, policies, safe inspector, draft conflicts, placement, consent, results and instructions passed`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
