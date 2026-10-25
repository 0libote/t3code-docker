#!/usr/bin/env node
// Real Files components, isolated API fixtures. Every filesystem call stays in
// memory; this audit cannot touch projects, credentials or production APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require('playwright-core'));}
const {statusFor,portsFor,routeConsole,framed,unlock}=require('./lib/console-fixtures.cjs');
const {createFilesFixtures}=require('./lib/files-fixtures.cjs');
const base=process.argv[2]||'http://127.0.0.1:23830/__setup/',key=process.argv[3]||'dev';
const out=process.env.T3_FILES_UI_OUTPUT||'/tmp/t3-files-ui-audit';fs.mkdirSync(out,{recursive:true});
const variants=[['desktop',1440,1000],['tablet',834,1112],['phone',390,844],['narrow',320,740],['embedded',1198,878],['embedded-phone',390,844]];
const subset=process.env.T3_FILES_UI_VARIANTS?.split(',');
const delayGate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',args:['--no-sandbox']});let checks=0;
 try{
  for(const theme of (process.env.T3_FILES_UI_THEMES?.split(',')||['light','dark']))for(const [variant,width,height]of variants){
   if(subset&&!subset.includes(variant))continue;
   const phone=width<640,small=width<1024,embedded=variant.startsWith('embedded');
   const context=await browser.newContext({viewport:{width,height},colorScheme:theme,reducedMotion:'reduce'}),page=await context.newPage(),api=createFilesFixtures();
   const errors=[],requests=[];let gate=null,readError=false;
   page.on('pageerror',error=>{errors.push(error.message);console.error(variant,theme,'PAGE ERROR',error.stack);});
   await routeConsole(page,{status:()=>statusFor('skills'),ports:()=>portsFor('ready')});
   await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());if(!url.pathname.includes('/files/'))return route.fallback();
    requests.push(url.pathname+url.search);
    if(gate&&url.pathname.endsWith('/list'))await gate.promise;
    if(readError&&url.pathname.endsWith('/read'))return route.fulfill({status:503,json:{ok:false,error:'Synthetic preview interruption'}});
    const result=await api.respond(request.method(),url,request.method()==='POST'?(url.pathname.endsWith('/files/upload/chunk')?request.postDataBuffer():request.postDataJSON()):{});
    if(result.raw)return route.fulfill({body:result.raw,headers:result.headers});
    const headers={...(result.body.etag?{etag:result.body.etag}:{})};
    if(result.body.etag&&request.headers()['if-none-match']===result.body.etag)return route.fulfill({status:304,headers});
    return route.fulfill({status:result.status||200,json:result.body,headers});
   });
   const target=embedded?await framed(page,base+'?embed=t3&theme='+theme):page;
   if(!embedded)await page.goto(base,{waitUntil:'domcontentloaded'});await unlock(target,key);
   const visit=async hash=>{await target.evaluate(value=>{location.hash=value;},hash);await target.locator('#files-search').waitFor();try{await target.locator('#files-browser .tc-skel-row').first().waitFor({state:'detached',timeout:12000});}catch(error){console.error(hash,await target.locator('#files-browser').innerText(),requests.slice(-8));await page.screenshot({path:path.join(out,variant+'-'+theme+'-failure.png')});throw error;}};
   const shot=async name=>{await page.screenshot({path:path.join(out,`${variant}-${theme}-${name}.png`),fullPage:!embedded&&await target.locator('.tc-layer').count()===0});};
   const fits=async()=>{
    assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'The page must fit the viewport');
    const bad=await target.locator('#files-browser .tc-bar').evaluateAll(bars=>bars.flatMap(bar=>[...bar.children].filter(span=>{const a=span.getBoundingClientRect(),b=bar.getBoundingClientRect();return a.height>0&&(a.top<b.top-1||a.bottom>b.bottom+1);}).map(span=>span.outerHTML)));
    assert.deepEqual(bad,[],'Every size segment stays inside its track');checks++;
   };
   await visit('files');await target.locator('[data-files-row]').first().waitFor();assert.match(await target.locator('.tc-fsum-lead').innerText(),/38.4 GB/);await fits();assert.equal(await target.locator('#files-browser [role=grid] > :not([role=row])').count(),0,'A grid contains rows only');await shot('projects');
   if(phone){
    const tooSmall=await target.locator('#files-browser button:visible').evaluateAll(buttons=>buttons.filter(button=>{const r=button.getBoundingClientRect();return r.height<43.9||r.width<43.9;}).map(button=>({label:button.getAttribute('aria-label')||button.textContent,height:button.getBoundingClientRect().height,width:button.getBoundingClientRect().width})));
    assert.deepEqual(tooSmall,[],'Phone controls have 44 px touch targets');
   }
   // Go to folder has keyboard input, suggestions, failure recovery and real navigation.
   await page.keyboard.press('Control+l');await target.locator('#files-goto-input').waitFor();
   await target.locator('#files-goto-input').fill('/root');await page.keyboard.press('Enter');
   await target.locator('.tc-files-goto [role="alert"]').waitFor();assert.match(await target.locator('.tc-files-goto').innerText(),/belongs to root/);await shot('goto-denied');
   await target.locator('#files-goto-input').fill('/workspace/acme-web/apps/web');await page.keyboard.press('Enter');
   await target.locator('.tc-files-goto').waitFor({state:'detached'});await target.locator('[data-files-row][data-path$="next.config.mjs"]').waitFor();
   const file=target.locator('[data-files-row][data-path$="next.config.mjs"]');
   await file.click();await target.locator('.tc-fprev').waitFor();assert.match(await target.locator('.tc-fprev').innerText(),/reactStrictMode/);await fits();await shot('preview');
   // Polling keeps the same row and field objects. A preview has an explicit close.
   await target.evaluate(()=>{window.__filesRow=document.querySelector('[data-files-row][data-path$="next.config.mjs"]');});
   await page.waitForTimeout(5200);
   assert.equal(await target.evaluate(()=>window.__filesRow===document.querySelector('[data-files-row][data-path$="next.config.mjs"]')),true);
   if(!await target.getByRole('button',{name:'Close details',exact:true}).count()){await page.screenshot({path:path.join(out,variant+'-'+theme+'-lost-details.png')});console.error('Lost details',await target.evaluate(()=>({top:Kit.top()?.kind,layers:document.querySelectorAll('.tc-layer').length,close:[...document.querySelectorAll('[aria-label="Close details"]')].map(x=>({html:x.outerHTML,inert:!!x.closest('[inert]')})),text:document.body.innerText.slice(-3000)})),errors,requests.slice(-8));}
   await target.getByRole('button',{name:'Close details',exact:true}).click();
   // A failed preview has a local retry, with no stale content under its title.
   readError=true;await target.locator('[data-files-row][data-path$="README.md"]').click();if(!small)await page.keyboard.press('Space');
   await target.locator('.tc-files-preview-fallback').filter({hasText:'Synthetic preview interruption'}).waitFor();await shot('preview-error');
   readError=false;await target.getByRole('button',{name:'Try again',exact:true}).click();await target.locator('.tc-fprev').waitFor();
   await target.getByRole('button',{name:'Close details',exact:true}).click();
   // Secret values stay outside the rendered preview until explicitly revealed.
   await target.getByRole('button',{name:phone?'View options':'View',exact:true}).click();
   await target.getByRole('menuitemcheckbox',{name:'Show hidden files',exact:true}).click();
   await target.locator('[data-files-row][data-path$=".env.local"]').click();if(!small)await page.keyboard.press('Space');await target.getByRole('button',{name:'Show values',exact:true}).waitFor();
   assert(!await target.locator('.tc-fprev').innerText().then(text=>text.includes('fixture-not-a-real-secret')));
   await shot('secret-masked');await target.getByRole('button',{name:'Show values',exact:true}).click();assert.match(await target.locator('.tc-fprev').innerText(),/fixture-not-a-real-secret/);
   await target.getByRole('button',{name:'Hide values',exact:true}).click();
   await target.getByRole('button',{name:'Download',exact:true}).click();await target.getByRole('alertdialog').waitFor();assert.match(await target.getByRole('alertdialog').innerText(),/secrets/);
   await target.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();
   await target.getByRole('button',{name:'Close details',exact:true}).click();
   // Search supports type/size/date predicates; text never becomes executable markup.
   await target.locator('#files-search').fill('config');await target.locator('.tc-files-search-status').filter({hasText:'match'}).waitFor();await fits();await shot('search');
   await target.getByRole('button',{name:'Clear',exact:true}).click();assert.equal(await target.locator('#files-search').inputValue(),'');
   if(phone){await target.getByRole('button',{name:'View options',exact:true}).click();await target.getByRole('menuitem',{name:'Select items',exact:true}).click();}
   const rows=target.locator('[data-files-row]');await rows.nth(0).locator('[data-files-check]').click();await rows.nth(1).locator('[data-files-check]').click();
   assert.equal(await target.locator('[data-files-row][aria-selected="true"]').count(),2);assert.equal(await rows.nth(0).locator('[data-files-check]').isChecked(),true);assert.equal(await rows.nth(1).locator('[data-files-check]').isChecked(),true);await shot('selection');
   if(phone)await target.getByRole('button',{name:'Done',exact:true}).click();else await target.getByRole('button',{name:'Clear selection',exact:true}).click();
   // Sizes folding never allocates a trailing action column. Expand/collapse works.
   await visit('files/projects/acme-web');
   if(phone||!await target.locator('[data-cmd="files.view"][data-view="sizes"]').isVisible()){await target.getByRole('button',{name:phone?'View options':'View',exact:true}).click();await target.getByRole('menuitemradio',{name:'Sizes',exact:true}).click();}
   else await target.locator('[data-cmd="files.view"][data-view="sizes"]').click();
   await target.locator('[role="treegrid"] [data-files-tree-row]').first().waitFor();
   const collapse=target.getByRole('button',{name:'Collapse node_modules',exact:true});await collapse.waitFor();
   await target.getByRole('button',{name:'Collapse node_modules',exact:true}).waitFor();
   assert(await target.locator('[data-files-tree-row][aria-level="2"]').count()>0);await fits();await shot('sizes');
   await target.getByRole('button',{name:'Collapse node_modules',exact:true}).click();await target.getByRole('button',{name:'Expand node_modules',exact:true}).click();
   // Absolute file paths open the parent with the file selected and previewed.
   await page.keyboard.press('Control+l');await target.locator('#files-goto-input').fill('/workspace/acme-web/apps/web/next.config.mjs');await page.keyboard.press('Enter');
   await target.locator('.tc-files-goto').waitFor({state:'detached'});await target.locator('.tc-fprev').waitFor();
   assert.match(await target.locator('.tc-fprev').innerText(),/reactStrictMode/);
   if(small)await target.getByRole('button',{name:'Close details',exact:true}).click();
   // Home tagging, managed guidance, no permission, missing and empty states.
   await visit('files/home');await target.locator('[data-files-row][data-path="/home/t3/.t3"]').waitFor();await shot('home');await fits();
   await visit('files/home/.t3');await target.getByText('Managed by T3 Code and Setup',{exact:true}).waitFor();await fits();await shot('managed');
   await visit('files/path//root');await target.getByRole('heading',{name:'You can’t open this folder',exact:true}).waitFor();await fits();await shot('no-access');
   await target.getByRole('button',{name:'Open parent folder',exact:true}).click();
   await visit('files/path//missing-folder');await target.getByRole('heading',{name:'This folder is no longer here',exact:true}).waitFor();await shot('missing');
   await visit('files/home/notes');await target.getByRole('heading',{name:'This folder is empty',exact:true}).waitFor();await shot('empty');
   // Late listings must not bring the previous folder back after navigation.
   gate=delayGate();await target.evaluate(()=>{location.hash='files/projects/acme-web/apps/web';});await target.locator('[aria-label="Loading files"]').waitFor();
   await target.evaluate(()=>{location.hash='files';});await target.locator('[data-files-row]').first().waitFor();gate.resolve();gate=null;await page.waitForTimeout(100);
   assert.equal(await target.evaluate(()=>location.hash),'#files');assert.match(await target.locator('#files-browser').innerText(),/ml-experiments/);
   // Leaving the page stops the Files poller.
   await target.evaluate(()=>{location.hash='overview';});await target.locator('#page-overview:not([hidden])').waitFor();const before=requests.length;await page.waitForTimeout(5200);assert.equal(requests.length,before);
   assert.deepEqual(errors,[],'No page exceptions');await context.close();console.log(`${variant} ${theme}: passed`);
  }
 }finally{await browser.close();}
 console.log(`Files browser audit passed (${checks} layout checks). Screens: ${out}`);
})().catch(error=>{console.error(error);process.exit(1);});
