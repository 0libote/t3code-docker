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
 const providerModes = {claude:'separate',codex:'separate',opencode:'separate'};
 let oversizedStatus = false;
 const oversizedError = 'Instructions are too large to edit (64 KiB maximum). Edit the file directly to reduce its size.';
 const errors=[];page.on('pageerror', e=>errors.push(e.message));
 await page.route('**/status', async route => {
   const response = await route.fetch();
   const status = await response.json();
   status.context.agentsMd = {present:true,bytes:12};
   status.context.providers = ['claude', 'codex', 'opencode'].map(provider => ({provider, mode:providerModes[provider],sourceRevision:provider+'-'+providerModes[provider],path:'/home/t3/a-very-long-existing-configuration-directory-for-' + provider + '/AGENTS.md', bytes:12}));
   if (oversizedStatus) {
     status.context.agentsMd = {present:true,bytes:65537,error:oversizedError};
     Object.assign(status.context.providers[1], {error:oversizedError,sourceRevision:null});
   }
   await route.fulfill({json:status});
 });
 await page.goto(base);
 if (await page.locator('input[type="password"]').isVisible()) {
   await page.locator('input[type="password"]').fill(key);
   await page.getByRole('button',{name:/unlock/i}).click();
   await page.locator('#app').waitFor();
 }
 await page.goto(base + (embedded ? '?embed=t3&theme=' + theme : '') + '#instructions');
 await page.locator('[data-cmd="context.edit"]').waitFor();
 assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
 assert.equal(await page.locator('#page-instructions .tc-section').count(),2);
 assert.equal(await page.locator('[data-cmd="context.edit"]').innerText(),'Edit');
 const checkCentered = async () => {
   const box = await page.getByRole('dialog').boundingBox();
   assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
   if (width >= 1024) assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 2);
 };
 const checkDownload = async (name, content) => {
   const downloadReady = page.waitForEvent('download');
   await page.getByRole('button',{name:'Download',exact:true}).click();
   const download = await downloadReady;
   assert.equal(download.suggestedFilename(),name);
   assert.equal(require('node:fs').readFileSync(await download.path(),'utf8'),content);
 };

 let instructionReads = 0;
 let releaseOldRead, oldReadStarted, oldReadFinished;
 const oldGate = new Promise(resolve => { releaseOldRead = resolve; });
 const started = new Promise(resolve => { oldReadStarted = resolve; });
 const finished = new Promise(resolve => { oldReadFinished = resolve; });
 await page.route('**/context/agents-md', async route => {
   const first = instructionReads++ === 0;
   if (first) { oldReadStarted(); await oldGate; }
   await route.fulfill({json:{ok:true,content:first ? '# Old response' : '# Current instructions',revision:'shared-revision'}});
   if (first) oldReadFinished();
 });
 await page.locator('[data-cmd="context.edit"]').click();
 await started;
 assert.equal(await page.locator('[data-sheet="save"]').isDisabled(),true);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.locator('[data-cmd="context.edit"]').click();
 await page.waitForFunction(() => document.querySelector('#cx-input')?.value === '# Current instructions');
 assert.equal(await page.locator('[data-sheet="save"]').isDisabled(),true,'unchanged instructions cannot be saved again');
 releaseOldRead();
 await finished;
 assert.equal(await page.locator('#cx-input').inputValue(),'# Current instructions');
 await checkCentered();
 await page.locator('#cx-file').setInputFiles({name:'AGENTS.md',mimeType:'text/markdown',buffer:Buffer.from('# Uploaded instructions')});
 await page.waitForFunction(() => document.querySelector('#cx-input')?.value === '# Uploaded instructions');
 await page.locator('#cx-input').fill('# Unsaved draft');
 assert.equal(await page.locator('[data-sheet="save"]').isDisabled(),false,'edited instructions can be saved');
 await checkDownload('AGENTS.md','# Unsaved draft');
 await page.locator('#cx-file').setInputFiles({name:'too-large.md',mimeType:'text/markdown',buffer:Buffer.alloc(65 * 1024, 'x')});
 await page.getByText('File too large (64 KB max).', {exact:true}).waitFor();
 assert.equal(await page.locator('#cx-input').inputValue(),'# Unsaved draft');
 let releaseFailedSave, saveStarted;
 const saveGate = new Promise(resolve => { releaseFailedSave = resolve; });
 const saving = new Promise(resolve => { saveStarted = resolve; });
 await page.route('**/context/agents-md', async route => {
   if (route.request().method() === 'GET') { await route.fulfill({json:{ok:true,content:'# Current instructions',revision:'shared-revision'}}); return; }
   assert.equal(route.request().postDataJSON().revision,'shared-revision');
   assert.equal(route.request().postDataJSON().content,'# Unsaved draft');
   saveStarted();
   await saveGate;
   await route.fulfill({status:409,json:{ok:false,error:'Shared instructions changed since opening'}});
 });
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await saving;
 assert.equal(await page.locator('#cx-input').isDisabled(),true);
 releaseFailedSave();
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
 let modeSaves = 0;
 let failMode = false;
 await page.route('**/context/agents-md', async route => {
   if (route.request().method() === 'GET') { await route.fulfill({json:{ok:true,content:'# Shared fixture',revision:'shared-revision'}}); return; }
   const body = route.request().postDataJSON();
   if (body.mode) {
     assert.equal(body.sourceRevision,body.provider+'-'+providerModes[body.provider]);
     modeSaves++;
     if (!failMode) providerModes[body.provider]=body.mode;
     await route.fulfill({status:failMode ? 409 : 200,json:failMode ? {ok:false,error:'Source changed while switching'} : {ok:true}});
     return;
   }
   assert.equal(body.provider,expectedProvider);
   assert.equal(body.revision,expectedProvider + '-revision');
   assert.equal(body.content,'# Edited ' + expectedProvider);
   providerSaves++;
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
 // Per-provider source selection is explicit and updates after a successful save.
 const sharedButton = page.locator('[data-cmd="context.provider.mode"][data-id="codex"][data-mode="shared"]');
 const separateButton = page.locator('[data-cmd="context.provider.mode"][data-id="codex"][data-mode="separate"]');
 await sharedButton.click();
 await page.getByRole('alertdialog').waitFor();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(modeSaves,0);
 assert.equal(await separateButton.getAttribute('aria-pressed'),'true');
 await sharedButton.click();
 await page.getByRole('button',{name:'Use shared',exact:true}).click();
 await page.waitForFunction(() => document.querySelector('[data-cmd="context.provider.mode"][data-id="codex"][data-mode="shared"]')?.getAttribute('aria-pressed') === 'true');
 await page.locator('[data-cmd="context.provider.edit"][data-id="codex"]').click();
 await page.getByRole('heading',{name:'Global AGENTS.md',exact:true}).waitFor();
 await page.waitForFunction(() => document.querySelector('#cx-input')?.value === '# Shared fixture');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await separateButton.click();
 await page.waitForFunction(() => document.querySelector('#cx-input')?.value === '# Existing codex');
 assert.equal(await separateButton.getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 failMode = true;
 await sharedButton.click();
 await page.getByRole('button',{name:'Use shared',exact:true}).click();
 await page.getByText('Source changed while switching',{exact:true}).waitFor();
 assert.equal(await separateButton.getAttribute('aria-pressed'),'true');
 assert.equal(modeSaves,3);
 // Failed reads cannot turn into a save of blank content.
 await page.route('**/context/agents-md?provider=*', route => route.fulfill({status:400,json:{ok:false,error:'Instruction file unavailable'}}));
 await page.locator('[data-cmd="context.provider.edit"][data-id="claude"]').click();
 await page.getByText('Instruction file unavailable',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 // An oversized file discovered after status cannot load an editable blank draft.
 await page.route('**/context/agents-md', route => route.fulfill({status:400,json:{ok:false,code:'too_large',error:oversizedError}}));
 await page.locator('[data-cmd="context.edit"]').click();
 await page.getByText(oversizedError,{exact:true}).waitFor();
 assert.equal(await page.locator('#cx-input').isDisabled(),true);
 assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 // Polling keeps oversized instructions visible while removing unsafe actions.
 oversizedStatus = true;
 await page.reload();
 await page.getByText(oversizedError,{exact:true}).first().waitFor();
 assert.equal(await page.locator('[data-cmd="context.edit"]').count(),0);
 assert.equal(await page.locator('[data-cmd="context.provider.edit"][data-id="codex"]').isDisabled(),true);
 assert.equal(await separateButton.getAttribute('aria-pressed'),'true');
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
 assert.deepEqual(errors,[]);
 console.log('PASS Context interactions:',theme,width+'x'+height,embedded?'embedded':'standalone');
 await page.close();
 }
 }
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
