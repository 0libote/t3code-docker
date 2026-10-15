#!/usr/bin/env node
// Global instruction editor regression checks against a disposable console.
// node scripts/context-ui-audit.js http://127.0.0.1:23780/__setup/ dev
// Read/save responses are fixtures; this audit never changes instructions.
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('playwright-core')); }
const base = process.argv[2] || 'http://127.0.0.1:23780/__setup/';
const key = process.argv[3] || 'dev';
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/chromium', args:['--no-sandbox']});
 try {
 for (const theme of ['light', 'dark']) {
 for (const [width, height, embedded] of [[360, 720], [390, 844], [820, 900], [1280, 900], [1198, 878, true]]) {
 const page = await browser.newPage({viewport:{width,height},colorScheme:theme,reducedMotion:'reduce'});
 await page.addInitScript(mode => localStorage.setItem('t3-console-theme', mode), theme);
 const errors=[];page.on('pageerror', e=>errors.push(e.message));
 await page.route('**/status', async route => {
   const response = await route.fetch();
   const status = await response.json();
   status.context.providers = ['claude', 'codex', 'opencode'].map(provider => ({provider, path:'/home/t3/a-very-long-existing-configuration-directory-for-' + provider + '/AGENTS.md', bytes:12}));
   await route.fulfill({json:status});
 });
 await page.goto(base);
 if (await page.locator('input[type="password"]').isVisible()) {
   await page.locator('input[type="password"]').fill(key);
   await page.getByRole('button',{name:/unlock/i}).click();
   await page.locator('#app').waitFor();
 }
 await page.goto(base + (embedded ? '?embed=t3&theme=' + theme : '') + '#context');
 await page.locator('[data-cmd="context.edit"]').waitFor();
 assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
 assert.equal(await page.locator('#page-context .tc-section').count(),1);
 assert.equal(await page.locator('[data-cmd="context.edit"]').innerText(),'Edit');
 const checkCentered = async () => {
   const box = await page.getByRole('dialog').boundingBox();
   assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
   if (width >= 1024) assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 2);
 };
 const checkDownload = async (name, content) => {
   const downloadReady = page.waitForEvent('download');
   await page.getByRole('button',{name:'Download .md',exact:true}).click();
   const download = await downloadReady;
   assert.equal(download.suggestedFilename(),name);
   assert.equal(require('node:fs').readFileSync(await download.path(),'utf8'),content);
 };

 let instructionReads = 0;
 await page.route('**/context/agents-md', async route => {
   const first = instructionReads++ === 0;
   await new Promise(resolve => setTimeout(resolve, first ? 1000 : 100));
   await route.fulfill({json:{ok:true,content:first ? '# Old response' : '# Current instructions', revision:'shared-revision'}});
 });
 await page.locator('[data-cmd="context.edit"]').click();
 assert.equal(await page.locator('[data-sheet="save"]').isDisabled(),true);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.locator('[data-cmd="context.edit"]').click();
 await page.waitForTimeout(1200);
 assert.equal(await page.locator('#cx-input').inputValue(),'# Current instructions');
 await checkCentered();
 await page.locator('#cx-file').setInputFiles({name:'AGENTS.md',mimeType:'text/markdown',buffer:Buffer.from('# Uploaded instructions')});
 await page.waitForFunction(() => document.querySelector('#cx-input')?.value === '# Uploaded instructions');
 await page.locator('#cx-input').fill('# Unsaved draft');
 await checkDownload('AGENTS.md','# Unsaved draft');
 await page.locator('#cx-file').setInputFiles({name:'too-large.md',mimeType:'text/markdown',buffer:Buffer.alloc(65 * 1024, 'x')});
 await page.getByText('File too large (64 KB max).', {exact:true}).waitFor();
 assert.equal(await page.locator('#cx-input').inputValue(),'# Unsaved draft');
 await page.route('**/context/agents-md', async route => {
   if (route.request().method() === 'GET') { await route.fulfill({json:{ok:true,content:'# Current instructions',revision:'shared-revision'}}); return; }
   assert.equal(route.request().postDataJSON().revision,'shared-revision');
   assert.equal(route.request().postDataJSON().content,'# Unsaved draft');
   await new Promise(resolve => setTimeout(resolve, 400));
   await route.fulfill({status:409,json:{ok:false,error:'Shared instructions changed since opening'}});
 });
 await page.getByRole('button',{name:'Save',exact:true}).click();
 assert.equal(await page.locator('#cx-input').isDisabled(),true);
 await page.getByText('Shared instructions changed since opening',{exact:true}).waitFor();
 assert.equal(await page.locator('#cx-input').inputValue(),'# Unsaved draft');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 // All existing provider files are discoverable, editable and saved explicitly.
 await page.route('**/context/agents-md?provider=*', async route => {
   const provider = new URL(route.request().url()).searchParams.get('provider');
   await route.fulfill({json:{ok:true, content:'# Existing ' + provider, revision:provider + '-revision', resolvedPath:'/home/t3/existing/' + provider + '/instructions.md'}});
 });
 let expectedProvider = null;
 let conflict = false;
 let providerSaves = 0;
 await page.route('**/context/agents-md', async route => {
   assert.equal(route.request().method(),'POST');
   const body = route.request().postDataJSON();
   assert.equal(body.provider,expectedProvider);
   assert.equal(body.revision,expectedProvider + '-revision');
   assert.equal(body.content,'# Edited ' + expectedProvider);
   providerSaves++;
   await new Promise(resolve => setTimeout(resolve,100));
   await route.fulfill({status:conflict ? 409 : 200,json:conflict ? {ok:false,error:'Instructions changed since you opened them.'} : {ok:true}});
 });
 assert.equal(await page.locator('[data-cmd="context.provider.edit"]').count(),3);
 for (const provider of ['claude','codex','opencode']) {
   expectedProvider = provider;
   await page.locator('[data-cmd="context.provider.edit"][data-id="' + provider + '"]').click();
   await page.waitForFunction(text => document.querySelector('#cx-input')?.value === text,'# Existing ' + provider);
   await checkCentered();
   await page.locator('#cx-input').fill('# Edited ' + provider);
   await checkDownload(provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md','# Edited ' + provider);
   if (provider === 'codex') {
     conflict = true;
     await page.getByRole('button',{name:'Save',exact:true}).click();
     await page.getByText('Instructions changed since you opened them.',{exact:true}).waitFor();
     assert.equal(await page.locator('#cx-input').inputValue(),'# Edited codex');
     conflict = false;
   }
   await page.getByRole('button',{name:'Save',exact:true}).click();
   await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
 }
 assert.equal(providerSaves,4);
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
 // Failed reads cannot turn into a save of blank content.
 await page.route('**/context/agents-md?provider=*', route => route.fulfill({status:400,json:{ok:false,error:'Instruction file unavailable'}}));
 await page.locator('[data-cmd="context.provider.edit"][data-id="claude"]').click();
 await page.getByText('Instruction file unavailable',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.deepEqual(errors,[]);
 console.log('PASS Context interactions:',theme,width+'x'+height,embedded?'embedded':'standalone');
 await page.close();
 }
 }
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
