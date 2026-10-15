#!/usr/bin/env node
// Storage UI states and keyboard flow against a running console. All storage
// mutations are intercepted: this audit cannot clear a real cache or save a
// policy. Usage: node scripts/storage-ui-audit.js <console-url> <setup-key>
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }
const base = process.argv[2] || "http://127.0.0.1:23780/__setup/";
const key = process.argv[3] || "dev";
const output = process.env.T3_STORAGE_UI_OUTPUT || "/tmp/t3-storage-ui-audit";
const GB = 1e9;

const geometry = () => {
  const issues = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push("horizontal page overflow");
  const panel = document.querySelector('.tc-layer [role="dialog"], .tc-layer [role="alertdialog"]');
  if (panel) {
    const rect = panel.getBoundingClientRect();
    if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) issues.push("dialog outside viewport");
  }
  for (const el of document.querySelectorAll('.tc-storage *, .tc-layer [role="dialog"] *, .tc-layer [role="alertdialog"] *')) {
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || el.matches('input, .tc-storage-path, .tc-switch')) continue;
    if (style.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1) issues.push(`${el.className || el.tagName} clipped`);
    if (el.matches('.tc-tile--icon') && !el.querySelector('svg')) issues.push("missing row icon");
  }
  return issues;
};

(async () => {
  await fs.mkdir(output, { recursive: true });
  const statusUrl = new URL('status', base.endsWith('/') ? base : base + '/');
  const initial = await fetch(statusUrl, { headers: { 'x-t3-setup-key': key } });
  assert.equal(initial.ok, true, 'console must accept the supplied setup key');
  const fixtureStatus = await initial.json();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
  try {
    const runs = [[360,800,false],[390,844,false],[820,1180,false],[1100,1000,false],[1440,1000,false],[390,844,true],[1198,878,true]];
    const widths = process.env.T3_STORAGE_UI_WIDTHS?.split(',').map(Number);
    for (const [width,height,embed] of runs.filter(([width])=>!widths || widths.includes(width))) for (const theme of ['light','dark']) {
      const context = await browser.newContext({ viewport: { width,height }, colorScheme: theme, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [], requests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let state = 'ready', policyFailure = false;
      const policy = { schema:1, automatic:false, retainManagedVersions:true, goBudgetBytes:10*GB, npmBudgetBytes:2*GB };
      const storage = () => ({ at:Date.now(), refreshing:state === 'scanning', policy,
        error:state === 'partial' ? 'Some folders could not be read. Sizes are partial estimates.' : null,
        operation:state === 'running' ? { id:'mock-job',state:'running',phase:'npm' } : null,
        disk:{usedPercent:state === 'critical' ? 96 : 89,totalBytes:207*GB,usedBytes:183*GB,availableBytes:24*GB},
        categories:state === 'loading' ? [] : [
          {id:'go',label:'Go build cache',path:'/home/t3/.cache/go-build',bytes:state === 'empty' ? 0 : 39*GB,cleanable:true,description:'Compiled packages. Builds recreate these when needed.'},
          {id:'npm',label:'npm downloads',path:'/home/t3/.npm/_cacache',bytes:state === 'empty' ? 0 : 6.5*GB,cleanable:true,description:'Downloaded packages. Installs fetch them again when needed.'},
          {id:'backups',label:'Upgrade backups',path:'/home/t3/.t3/backups',bytes:13.6*GB},
          {id:'workspace',label:'Projects',path:'/workspace/a-project-with-a-long-name/local-application-state',bytes:22*GB},
        ] });
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url()), method = route.request().method();
        if (url.pathname.endsWith('/status')) {
          return route.fulfill({ json:{ ...fixtureStatus, storage:storage() } });
        }
        if (/\/storage(?:\/|$)/.test(url.pathname)) {
          if (method === 'POST') {
            requests.push({route:url.pathname,body:route.request().postDataJSON()});
            if (url.pathname.endsWith('/policy') && policyFailure) return route.fulfill({status:503,json:{error:'Preferences could not be saved. Try again.'}});
            if (url.pathname.endsWith('/policy')) Object.assign(policy,route.request().postDataJSON());
            return route.fulfill({json:{ok:true}});
          }
          if (url.pathname.endsWith('/versions')) return route.fulfill({json:{ok:true,token:'a'.repeat(64),estimatedBytes:5.2*GB,removableCount:2,items:[
            {name:'Claude Code',version:'2.0.1',eligible:true},{name:'Codex',version:'0.110.0',eligible:true},
            {name:'Claude Code',version:'2.0.3',eligible:false,reason:'Current version'},
            {name:'Codex',version:'0.111.0',eligible:false,reason:'Previous version'},
            {name:'Go',version:'1.25.0',eligible:false,reason:'Required by a project or tool selection'},
          ]}});
          return route.fulfill({json:storage()});
        }
        return route.continue();
      });
      const url = new URL(base); url.hash = 'environment'; if(embed) { url.searchParams.set('embed','t3'); url.searchParams.set('theme',theme); }
      await page.goto(url.href);
      await page.getByLabel('Setup key',{exact:true}).fill(key); await page.getByRole('button',{name:'Unlock',exact:true}).click();
      await page.locator('[data-key=storage-clean-all]:not([disabled])').waitFor();
      const tag = `${width}-${theme}${embed ? '-embedded' : ''}`;
      const check = async (name) => { assert.deepEqual(await page.evaluate(geometry),[],`${tag} ${name}`); };
      await page.locator('.tc-storage').scrollIntoViewIfNeeded(); await check('card');
      await page.screenshot({path:path.join(output,`${tag}-card.png`)});
      await page.locator('[data-key=storage-details]').click(); await check('folder usage');
      await page.locator('[data-key=storage-clean-all]').click(); await page.getByRole('alertdialog').waitFor(); await check('confirmation');
      assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'Cancel');
      await page.keyboard.press('Escape'); assert.equal(requests.length,0);
      await page.locator('[data-key=storage-preferences]').click(); await page.getByRole('dialog').waitFor(); await check('preferences');
      await page.screenshot({path:path.join(output,`${tag}-preferences.png`)});
      await page.locator('#storage-go-limit').fill('0'); await page.locator('[data-storage-save]').click();
      assert.equal(await page.locator('#storage-go-limit').getAttribute('aria-invalid'),'true'); assert.equal(requests.length,0);
      await page.locator('#storage-go-limit').fill('12.5');
      const toggle=page.locator('[data-storage-switch=automatic]'); await toggle.focus(); await page.keyboard.press('Space');
      assert.equal(await toggle.getAttribute('aria-checked'),'true');
      // A real status poll while editing must keep both the value and focus.
      if(width === 390 && theme === 'dark' && !embed) {
        await page.locator('#storage-go-limit').focus();
        const poll=page.waitForResponse((response)=>new URL(response.url()).pathname.endsWith('/status'));
        await poll;
        assert.equal(await page.locator('#storage-go-limit').inputValue(),'12.5');
        assert.equal(await page.evaluate(()=>document.activeElement.id),'storage-go-limit');
      }
      policyFailure=true; await page.locator('[data-storage-save]').click();
      await page.locator('#storage-settings-error:not([hidden])').waitFor(); assert.equal(await page.locator('#storage-go-limit').inputValue(),'12.5'); await check('save failure');
      policyFailure=false; await page.locator('[data-storage-save]').click(); await page.getByRole('dialog').waitFor({state:'hidden'});
      assert.equal(policy.goBudgetBytes,12.5*GB); assert.equal(policy.automatic,true);
      await page.locator('[data-key=storage-review]').click(); await page.getByRole('dialog').waitFor();
      await page.locator('[data-storage-trim]:not([disabled])').waitFor(); await check('version review');
      await page.screenshot({path:path.join(output,`${tag}-versions.png`)});
      await page.locator('[data-storage-trim]').focus(); await page.keyboard.press('Enter');
      assert.equal(requests.some((request)=>request.route.endsWith('/prune')),false);
      await page.locator('[data-storage-cancel]').click();
      for(const scenario of ['critical','empty','scanning','running','partial','loading']) {
        state=scenario; await page.reload(); await page.locator('.tc-storage').waitFor(); await check(scenario);
        if(['scanning','running','empty','loading'].includes(scenario)) assert.equal(await page.locator('[data-key=storage-clean-all]').isDisabled(),true);
      }
      assert.deepEqual(errors,[]); await context.close(); console.log(`PASS ${tag}: layouts, keyboard, drafts, failures, six storage states`);
    }
  } finally { await browser.close(); }
})().catch((error)=>{console.error(error);process.exitCode=1;});
