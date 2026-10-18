#!/usr/bin/env node
// Auto-update settings and the T3 Code risk confirmation against a running
// console. Policy saves are intercepted: this audit cannot change a real
// policy. Usage: node scripts/auto-update-ui-audit.js <console-url> <setup-key>
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }
const base = process.argv[2] || "http://127.0.0.1:23780/__setup/";
const key = process.argv[3] || "dev";
const output = process.env.T3_AUTO_UPDATE_UI_OUTPUT || "/tmp/t3-auto-update-ui-audit";

const freshPolicy = () => ({
  version: 2,
  providers: { enabled: false, checkMinutes: 180, idleMinutes: 30 },
  toolchains: { enabled: false, checkMinutes: 180, idleMinutes: 30 },
  t3: { enabled: false, checkMinutes: 180, idleMinutes: 30, stayOnChannel: true },
});

const geometry = () => {
  const issues = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push(`horizontal page overflow (${document.documentElement.scrollWidth}px > ${innerWidth}px)`);
  for (const panel of document.querySelectorAll('.tc-layer [role="dialog"], .tc-layer [role="alertdialog"]')) {
    const rect = panel.getBoundingClientRect();
    if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) {
      issues.push("dialog outside viewport");
    }
  }
  for (const el of document.querySelectorAll('.tc-layer [role="dialog"] *, .tc-layer [role="alertdialog"] *')) {
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || el.matches('input, .tc-switch')) continue;
    if (style.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1) issues.push(`${el.className || el.tagName} clipped`);
  }
  return issues;
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const statusUrl = new URL('status', base.endsWith('/') ? base : base + '/');
  const initial = await fetch(statusUrl, { headers: { 'x-t3-setup-key': key } });
  assert.equal(initial.ok, true, 'console must accept the supplied setup key');
  const fixtureStatus = await initial.json();
  // Model a failed first install independently of the live home's versions
  // and startup work. CI may already have OpenCode installed or queued; those
  // facts would otherwise turn this fixture into a different row state.
  const failure = 'GitHub rate limit exceeded: https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting Reference: sha512-' + 'a'.repeat(96)
    + '\n' + ('Registry diagnostic: sha512-' + 'b'.repeat(128) + '\n').repeat(20);
  fixtureStatus.harnesses = fixtureStatus.harnesses.map((row) => row.id === 'opencode'
    ? { ...row, installed: false, installedVersion: null, version: null, inProgress: false, failed: true, operation: 'install', failure }
    : row);
  if (fixtureStatus.operations) delete fixtureStatus.operations['harness:opencode'];
  // A finished first-start failure also has a page notice. Keep it in every
  // run: otherwise an empty scratch home misses long errors present in CI.
  fixtureStatus.setup = { ...fixtureStatus.setup, state: 'finished', items: [
    { kind: 'agent', id: 'opencode', name: 'OpenCode', state: 'failed', error: failure },
  ] };
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
  try {
    const runs = [[320, 740, false], [360, 800, false], [390, 844, false], [1100, 1000, false], [390, 844, true], [1198, 878, true]];
    const widths = process.env.T3_AUTO_UPDATE_UI_WIDTHS?.split(',').map(Number);
    for (const [width, height, embedded] of runs.filter(([width]) => !widths || widths.includes(width))) for (const theme of ['light', 'dark']) {
      const fixture = structuredClone(fixtureStatus);
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' });
      const host = await context.newPage(), errors = [], saved = [];
      let page = host;
      host.on('pageerror', (error) => errors.push(error.message));
      let policy = freshPolicy();
      let updates = { refreshing: false, manual: false, errors: {} }, checkRequests = 0, startFailure = false;
      let holdStatus = null;
      const runtime = { ...fixture.t3?.runtime, channel: 'stable', version: '0.1.0',
        releases: { stable: { version: '0.1.0' }, nightly: { version: '0.1.1-nightly.20261017.1' } }, checkedAt: 1, checking: false,
        checkError: 'registry offline', operation: null, supported: true };

      let requestedChannel;
      await host.route('**/*', async (route) => {
        const url = new URL(route.request().url()), method = route.request().method();
        if (url.pathname.endsWith('/status')) {
          const snapshot = structuredClone({ ...fixture, updates, t3: { ...fixture.t3, runtime }, autoUpdate: { policy, state: {}, lastActivityAt: Date.now(), busy: null } });
          if (holdStatus) { const gate = holdStatus; holdStatus = null; gate.started(); await gate.wait; }
          return route.fulfill({ json: snapshot });
        }
        if (url.pathname.endsWith('/updates/check')) {
          if (url.pathname.endsWith('/t3/updates/check')) {
            requestedChannel = route.request().postDataJSON().channel || runtime.channel;
            const error = requestedChannel === runtime.channel ? runtime.checkError : null;
            return route.fulfill({ status: error ? 502 : 200, json: {
              ok: !error, error, channels: runtime.releases,
              errors: runtime.checkError ? { stable: runtime.checkError } : {},
            } });
          }
          if (startFailure) return route.fulfill({ status: 503, json: { ok: false, error: 'Setup service temporarily unavailable' } });
          checkRequests++;
          updates = { refreshing: true, manual: true, errors: {} };
          return route.fulfill({ status: 202, json: { ok: true, code: 'checking' } });
        }
        if (/\/auto-update(?:\/policy)?$/.test(url.pathname)) {
          if (method === 'POST') {
            const body = route.request().postDataJSON();
            saved.push(body);
            policy = JSON.parse(JSON.stringify(body));
            return route.fulfill({ json: { ok: true, policy } });
          }
          return route.fulfill({ json: { ok: true, policy, state: {}, lastActivityAt: Date.now() } });
        }
        return route.continue();
      });
      const url = new URL(base); url.hash = 'agents';
      if (embedded) {
        url.searchParams.set('embed', 't3'); url.searchParams.set('theme', theme);
        const parentUrl = new URL('/__update-audit-frame', base).href;
        await host.route(parentUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe title="Setup"></iframe>' }));
        await host.goto(parentUrl);
        page = await (await host.locator('iframe').elementHandle()).contentFrame();
      }
      await page.goto(url.href);
      await page.getByLabel('Setup key', { exact: true }).fill(key);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await page.locator('[data-cmd="auto.settings"]:visible').first().waitFor();
      if (embedded) assert.equal(await page.evaluate(() => window.parent !== window && document.documentElement.dataset.embed === 't3'), true, 'embedded cases run inside a real iframe');
      await page.evaluate(() => { window.T3C.copyText = async (text) => { window.auditCopiedText = text; return true; }; });
      const tag = `${width}-${theme}${embedded ? '-embedded' : ''}`;
      const check = async (name) => { assert.deepEqual(await page.evaluate(geometry), [], `${tag} ${name}`); };

      const startupWarning = page.locator('#page-agents > .tc-notice').filter({ hasText: 'First start could not install OpenCode' });
      await startupWarning.waitFor();
      assert.equal((await startupWarning.textContent()).includes('sha512-'), false, 'the warning keeps raw diagnostics in Details');
      await check('finished startup failure');
      await host.screenshot({ path: path.join(output, `${tag}-startup-failed.png`) });
      await startupWarning.getByRole('button', { name: 'Setup failure details', exact: true }).click();
      const startupDialog = page.getByRole('dialog', { name: 'Setup failures', exact: true });
      await startupDialog.waitFor();
      assert.equal(await startupDialog.locator('pre').textContent(), 'OpenCode\n' + failure, 'startup details retain the complete diagnostic');
      assert.equal(await startupDialog.locator('.tc-dialog-body').evaluate((el) => el.scrollHeight > el.clientHeight), true, 'long diagnostics scroll within the dialog');
      assert.equal(await startupDialog.locator('.tc-dialog-foot').evaluate((el) => { const rect = el.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), true, 'copy and close stay visible');
      await check('startup error details');
      await startupDialog.getByRole('button', { name: 'Copy details', exact: true }).click();
      assert.equal(await page.evaluate(() => window.auditCopiedText), 'OpenCode\n' + failure);
      await host.keyboard.press('Escape');
      await startupDialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.dataset.cmd), 'setup.errors', 'Escape returns focus to startup Details');

      await page.locator('[data-cmd="auto.settings"]:visible').first().click();
      const settings = page.getByRole('dialog', { name: 'Automatic updates' });
      await settings.waitFor(); await check('settings');
      await host.screenshot({ path: path.join(output, `${tag}-settings.png`) });
      const providers = page.locator('[data-auto-switch="providers.enabled"]');
      const toolchains = page.locator('[data-auto-switch="toolchains.enabled"]');
      const t3 = page.locator('[data-auto-switch="t3.enabled"]');
      for (const toggle of [providers, toolchains, t3]) assert.equal(await toggle.getAttribute('aria-checked'), 'false');

      await providers.click();
      assert.equal(await providers.getAttribute('aria-checked'), 'true');
      assert.equal(await toolchains.getAttribute('aria-checked'), 'false');
      assert.equal(await page.getByRole('alertdialog').count(), 0);

      // Turning T3 Code on must warn before the draft changes. Cancelling the
      // warning leaves the switch and its timing fields off.
      await t3.click();
      const warning = page.getByRole('alertdialog');
      await warning.waitFor(); await check('T3 Code warning');
      const warningText = await warning.innerText();
      assert.match(warningText, /alpha software/);
      assert.match(warningText, /setup console/);
      assert.match(warningText, /active agent turns and terminals stop/);
      assert.equal(await t3.getAttribute('aria-checked'), 'false');
      assert.equal(await page.locator('#auto-t3-check').isDisabled(), true);
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Cancel');
      await host.screenshot({ path: path.join(output, `${tag}-warning.png`) });
      await host.keyboard.press('Escape');
      await warning.waitFor({ state: 'hidden' });
      assert.equal(await t3.getAttribute('aria-checked'), 'false');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.autoSwitch), 't3.enabled');

      // Confirming enables T3 Code. Within this settings session, turning it
      // off and back on does not repeat a warning the user just accepted.
      await t3.click(); await warning.waitFor();
      await page.getByRole('button', { name: 'Turn on automatic updates', exact: true }).click();
      await warning.waitFor({ state: 'hidden' });
      assert.equal(await t3.getAttribute('aria-checked'), 'true');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.autoSwitch), 't3.enabled');
      await t3.click(); assert.equal(await t3.getAttribute('aria-checked'), 'false');
      await t3.click(); await host.waitForTimeout(100);
      assert.equal(await t3.getAttribute('aria-checked'), 'true');
      assert.equal(await page.getByRole('alertdialog').count(), 0);

      await toolchains.click(); await host.waitForTimeout(100);
      assert.equal(await toolchains.getAttribute('aria-checked'), 'true');
      assert.equal(await page.getByRole('alertdialog').count(), 0);
      await page.locator('#auto-t3-check').fill('1.5');
      await page.locator('#auto-t3-idle').fill('15');
      await page.locator('[data-auto-save]').click();
      await settings.waitFor({ state: 'hidden' });
      assert.equal(saved.length, 1);
      assert.equal(saved[0].providers.enabled, true);
      assert.equal(saved[0].toolchains.enabled, true);
      assert.equal(saved[0].t3.enabled, true);
      assert.equal(saved[0].t3.checkMinutes, 90);
      assert.equal(saved[0].t3.idleMinutes, 15);

      // Long diagnostics stay available without consuming the agent list.
      const failedRow = page.locator('[data-key="row-harness:opencode"]');
      await failedRow.getByRole('button', { name: 'Error details for OpenCode' }).waitFor();
      const failedHeight = await failedRow.evaluate((el) => el.getBoundingClientRect().height);
      assert.ok(failedHeight <= 110, `${tag}: opaque failed-install row is ${failedHeight}px (maximum 110px)`);
      await failedRow.getByRole('button', { name: 'Error details for OpenCode' }).click();
      const errorDialog = page.getByRole('dialog', { name: 'OpenCode: install failed' });
      await errorDialog.waitFor();
      assert.ok((await errorDialog.locator('pre').textContent()).includes('sha512-' + 'a'.repeat(96)), 'the full diagnostic remains inspectable');
      await check('row error details');
      await host.screenshot({ path: path.join(output, `${tag}-row-error.png`) });
      await errorDialog.getByRole('button', { name: 'Copy details' }).click();
      assert.equal(await page.evaluate(() => window.auditCopiedText), await errorDialog.locator('pre').textContent());
      await host.keyboard.press('Escape');
      await errorDialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.dataset.cmd), 'row.error', 'Escape returns focus to Details');

      const control = () => page.locator('[data-cmd="updates.check"]:visible').first();
      const firstTop = () => page.locator('#page-agents .tc-row').first().evaluate((el) => el.getBoundingClientRect().top);
      const refreshStatus = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await control().scrollIntoViewIfNeeded();
      const idleTop = await firstTop();
      const idleNotices = await page.locator('#page-agents > .tc-notice').count();
      const controlSize = () => control().evaluate((el) => { const { width, height } = el.getBoundingClientRect(); return { width, height }; });
      const idleSize = await controlSize();
      // A pre-existing status read must not briefly re-enable the control or
      // report completion while the accepted manual request is still waiting.
      let releaseStatus, statusStarted;
      const started = new Promise((resolve) => { statusStarted = resolve; });
      holdStatus = { started: statusStarted, wait: new Promise((resolve) => { releaseStatus = resolve; }) };
      await refreshStatus();
      await started;
      try {
        await control().click();
        await page.getByRole('button', { name: 'Checking for updates', exact: true }).filter({ visible: true }).waitFor();
        await check('checking');
        assert.equal(await control().isDisabled(), true, 'manual checks coalesce while running');
        assert.equal(checkRequests, 1);
        assert.equal(await page.evaluate(() => document.activeElement.dataset.cmd), 'updates.check', 'starting a check preserves keyboard focus');
        await host.keyboard.press('Enter');
        // Wait for a second request, if the keyboard guard allowed one.
        await host.waitForTimeout(100);
        assert.equal(checkRequests, 1, 'aria-disabled blocks keyboard resubmission during an older status read');
      } finally { releaseStatus(); }
      assert.equal(await firstTop(), idleTop, 'checking does not shift the first agent');
      assert.deepEqual(await controlSize(), idleSize, 'checking preserves control dimensions');
      await host.screenshot({ path: path.join(output, `${tag}-checking.png`) });
      updates = { refreshing: false, manual: false, errors: { 'harness:claude': 'offline <script>unsafe</script>', 'toolchain:go': 'offline' } };
      await refreshStatus();
      await page.getByRole('button', { name: 'Review update checks', exact: true }).filter({ visible: true }).waitFor();
      assert.equal(await firstTop(), idleTop, 'a failed check does not shift the first agent');
      assert.deepEqual(await controlSize(), idleSize, 'a failure preserves control dimensions');
      assert.equal(await page.locator('#page-agents > .tc-notice').count(), idleNotices, 'update checks add no page notice alongside the existing startup warning');
      await check('agent failure');
      await host.screenshot({ path: path.join(output, `${tag}-agent-failure.png`) });
      assert.equal(await page.getByText('Some update checks failed', { exact: true }).count(), 1, 'manual completion is announced once');
      await control().click();
      const checks = page.getByRole('dialog', { name: 'Update checks', exact: true });
      await checks.waitFor();
      assert.equal(await checks.getByText('Claude Code', { exact: true }).count(), 1);
      assert.equal(await checks.getByText('Go', { exact: true }).count(), 0, 'only sources on this page are listed');
      assert.equal(await checks.locator('pre').isVisible(), false, 'technical diagnostics start collapsed');
      await checks.locator('summary').click();
      assert.equal(await checks.locator('pre').textContent(), 'offline <script>unsafe</script>', 'diagnostics render as text');
      assert.equal(await checks.locator('script').count(), 0);
      await check('check details');
      await host.screenshot({ path: path.join(output, `${tag}-check-details.png`) });
      await checks.getByRole('button', { name: 'Copy details' }).click();
      assert.equal(await page.evaluate(() => window.auditCopiedText), 'Claude Code\noffline <script>unsafe</script>');
      await host.keyboard.press('Escape');
      await checks.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement.dataset.cmd), 'updates.check');
      await control().click();
      await checks.waitFor();
      await checks.getByRole('button', { name: 'Check again', exact: true }).click();
      await checks.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Checking for updates', exact: true }).filter({ visible: true }).waitFor();
      assert.equal(checkRequests, 2);
      updates = { refreshing: false, manual: false, errors: {} };
      await refreshStatus();
      await page.getByRole('button', { name: 'Check for updates', exact: true }).filter({ visible: true }).waitFor();
      assert.equal(await firstTop(), idleTop, 'recovery preserves the list position');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.cmd), 'updates.check', 'the retry control keeps focus after recovery');
      await check('recovered check');

      startFailure = true;
      await control().click();
      await page.getByText('Could not start the update check', { exact: true }).waitFor();
      assert.equal(await control().isEnabled(), true, 'failed requests leave the check available');
      assert.equal(await control().getAttribute('aria-label'), 'Check for updates');
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
      startFailure = false;

      updates = { refreshing: true, manual: false, errors: {} };
      await refreshStatus();
      await page.getByRole('button', { name: 'Checking for updates', exact: true }).filter({ visible: true }).waitFor();
      assert.equal(await control().isDisabled(), false, 'a background pass still accepts a fresh manual check');
      await control().click();
      assert.equal(checkRequests, 3);
      updates = { refreshing: false, manual: false, errors: { 'toolchain:go': 'offline' } };
      fixture.setup = { ...fixture.setup, state: 'running', items: [
        ...fixture.setup.items,
        { kind: 'toolchain', id: 'go', name: 'Go', state: 'installing' },
      ] };
      await refreshStatus();
      url.hash = 'toolchains'; await page.goto(url.href);
      await page.locator('#banner:not([hidden])').waitFor();
      await page.getByRole('button', { name: 'Review update checks', exact: true }).filter({ visible: true }).waitFor();
      await control().click();
      await checks.waitFor();
      assert.equal(await checks.getByText('Go', { exact: true }).count(), 1);
      assert.equal(await checks.getByText('Claude Code', { exact: true }).count(), 0);
      await check('toolchain failure');
      await checks.getByRole('button', { name: 'Close', exact: true }).click();

      url.hash = 'environment'; await page.goto(url.href);
      const card = page.getByRole('region', { name: 'T3 Code updates', exact: true });
      await card.getByText('Could not verify updates', { exact: true }).waitFor();
      assert.equal(await card.getByText('You’re up to date', { exact: true }).count(), 0);
      await card.getByRole('button', { name: 'Check for updates', exact: true }).click();
      await card.getByText('Could not verify updates', { exact: true }).waitFor();
      await check('selected channel failure');
      await host.screenshot({ path: path.join(output, `${tag}-check-failed.png`) });
      await card.getByRole('button', { name: 'Nightly', exact: true }).click();
      const switchDialog = page.getByRole('alertdialog', { name: 'Switch to Nightly?' });
      await switchDialog.waitFor();
      assert.equal(requestedChannel, 'nightly', 'switch checks the target channel even when Stable failed');
      await switchDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await switchDialog.waitFor({ state: 'hidden' });
      runtime.checkError = null;
      runtime.checkedAt = Date.now();
      runtime.releases.stable.version = '0.1.1';
      await card.getByRole('button', { name: 'Check for updates', exact: true }).click();
      await card.getByText('Stable update available', { exact: true }).waitFor();
      assert.equal(await card.getByRole('button', { name: 'Update and restart', exact: true }).count(), 1);
      await check('recovered update');
      runtime.releases.stable.version = runtime.version;
      await card.getByRole('button', { name: 'Check for updates', exact: true }).click();
      await card.getByText('You’re up to date', { exact: true }).waitFor();

      assert.deepEqual(errors, []); await context.close();
      console.log(`PASS ${tag}: defaults, independent toggles, T3 Code warning, save payload, check progress, failures and recovery`);
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
