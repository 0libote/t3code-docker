#!/usr/bin/env node
// Exercises the real UI against isolated, mutable in-memory Files routes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
let chromium;try{({chromium}=require('playwright'));}catch{({chromium}=require('playwright-core'));}
const {statusFor,portsFor,routeConsole,framed,unlock}=require('./lib/console-fixtures.cjs');
const {createFilesFixtures}=require('./lib/files-fixtures.cjs');
const base=process.argv[2]||'http://127.0.0.1:23832/__setup/',key=process.argv[3]||'dev',out=process.env.T3_FILES_UI_OUTPUT||'/tmp/t3-files-change-ui';fs.mkdirSync(out,{recursive:true});
const variants=[['desktop',1440,1000],['compact',1280,800],['small-desktop',1100,1000],['tablet',834,1112],['phone',390,844],['narrow',320,740],['embedded',1198,878],['embedded-phone',390,844]],subset=process.env.T3_FILES_UI_VARIANTS?.split(',');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',args:['--no-sandbox']});let checks=0;
 try{for(const theme of (process.env.T3_FILES_UI_THEMES?.split(',')||['light','dark']))for(const [variant,width,height]of variants){if(subset&&!subset.includes(variant))continue;
  const context=await browser.newContext({viewport:{width,height},colorScheme:theme,reducedMotion:'reduce'}),page=await context.newPage(),fixture=createFilesFixtures(),errors=[];let hold=null,lostFinish=false,extraJobs=[];
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.stack));await routeConsole(page,{status:()=>statusFor('skills'),ports:()=>portsFor('ready')});
  await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(!url.pathname.includes('/files/'))return route.fallback();const input=req.method()==='POST'?(url.pathname.endsWith('/chunk')?req.postDataBuffer():req.postDataJSON()):{};
   if(hold&&url.pathname.endsWith(hold.route))await hold.promise;
   const result=await fixture.respond(req.method(),url,input);if(url.pathname.endsWith('/files/jobs'))result.body.jobs.push(...extraJobs);if(lostFinish&&url.pathname.endsWith('/upload/finish')){lostFinish=false;return route.abort('failed');}if(result.raw)return route.fulfill({body:result.raw,headers:result.headers});
   if(result.body.etag&&result.body.etag===req.headers()['if-none-match'])return route.fulfill({status:304,headers:{etag:result.body.etag}});
   return route.fulfill({status:result.status||200,json:result.body});});
  const target=variant.startsWith('embedded')?await framed(page,base+'?embed=t3&theme='+theme):page;if(target===page)await page.goto(base);await unlock(target,key);
  const shot=async name=>{await page.screenshot({path:path.join(out,variant+'-'+theme+'-'+name+'.png')});};
  const fits=async()=>{const bad=await target.evaluate(()=>[...document.querySelectorAll('.tc-layer:not([hidden]) .tc-fdlg,.tc-layer:not([hidden]) .tc-files-editor,#files-browser .tc-ftb')].filter(el=>{const r=el.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5||r.bottom>innerHeight+.5&&el.closest('.tc-layer');}).map(el=>el.className));assert.deepEqual(bad,[],variant+' '+theme+' layers fit');assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(await target.locator('#files-browser .tc-fl--projects .tc-fcell').evaluateAll(cells=>cells.filter(cell=>cell.clientWidth&&cell.scrollWidth>cell.clientWidth+1).map(cell=>cell.textContent)),[],'project names and badges stay inside their column');checks++;};
  await target.evaluate(()=>{window.__fileMenuCloses=[];const menu=Kit.menu;Kit.menu=(...args)=>{const layer=menu(...args);if(layer){const close=layer.close;layer.close=reason=>{window.__fileMenuCloses.push({reason,y:scrollY,triggerConnected:!!layer.returnTo?.isConnected});return close(reason);};}return layer;};});
  const visit=async hash=>{await target.evaluate(value=>{location.hash=value;},hash);await target.locator('#files-search').waitFor();await target.locator('#files-browser .tc-skel-row').first().waitFor({state:'detached'});};
  // Reduced motion must not create a new visibility transition on
  // the notification host. Hiding and restoration both happen in this task.
  const ownership=await target.evaluate(()=>{
   const host=document.getElementById('toaster'),before=getComputedStyle(host).visibility;
   const layer=Kit.open({kind:'bottom',panel:{class:'tc-sheet tc-sheet--bottom tc-files-transfer-sheet',role:'dialog','aria-label':'Notification visibility probe'},render:()=>''});
   const immediate=getComputedStyle(host).visibility==='hidden';layer.close('replaced');
   return {immediate,restored:getComputedStyle(host).visibility===before};
  });
  assert.deepEqual(ownership,{immediate:true,restored:true});
  try{await visit('files/projects/acme-web/apps/web');await target.locator('[data-path$="next.config.mjs"][data-files-row]').waitFor();await fits();
  // Native textarea draft survives a refresh; conflict comparison never drops it.
  if(width<1024){await target.locator('[data-path$="next.config.mjs"][data-files-row]').click();await target.getByRole('button',{name:'Edit',exact:true}).click();}else await target.locator('[data-path$="next.config.mjs"][data-files-row]').dblclick();await target.locator('[data-files-editor-text]').waitFor();
  const edit=target.locator('[data-files-editor-text]');await edit.fill('// My edit\nexport default { strict: true };');
  await fixture.respond('POST',new URL('http://fixture/files/write'),{path:'/workspace/acme-web/apps/web/next.config.mjs',text:'// Outside edit\nexport default {};',mode:'overwrite'});
  await target.locator('[data-editor-save]').click();await target.getByText('next.config.mjs changed on disk while you were editing',{exact:true}).waitFor();assert.equal(await edit.inputValue(),'// My edit\nexport default { strict: true };');await fits();await shot('editor-conflict');
  await target.locator('[data-editor-compare]').click();await target.locator('.tc-files-compare').waitFor();assert.match(await target.locator('.tc-files-compare').innerText(),/Outside edit/);await shot('editor-compare');await target.locator('[data-editor-compare-close]').click();assert.equal(await edit.inputValue(),'// My edit\nexport default { strict: true };');
  await target.locator('[data-editor-copy]').click();await target.getByText('next.config (copy).mjs',{exact:true}).first().waitFor();await target.locator('[data-editor-close]').click();if(width<1024)await target.getByRole('button',{name:'Close details',exact:true}).click();
  // New folder and collision errors keep their field and typed draft.
  if(width<640){await target.getByRole('button',{name:'View options',exact:true}).click();await target.getByRole('menuitem',{name:'New folder',exact:true}).click();}else await target.locator('[data-cmd="files.new-folder"]').click();
  const rename=target.locator('#files-rename-name');await rename.fill('public');await page.keyboard.press('Enter');await target.locator('#files-rename-error').waitFor();assert.equal(await rename.inputValue(),'public');await fits();await shot('rename-error');
  await rename.fill('New assets');let release;hold={route:'/mkdir',promise:new Promise(resolve=>{release=resolve;})};await page.keyboard.press('Enter');await target.locator('#files-rename-name:disabled').waitFor();assert.equal(await target.locator('[data-cmd="files.rename-save"]').isDisabled(),true);release();hold=null;await rename.waitFor({state:'detached'});await target.locator('[data-files-row][data-path$="New assets"]').waitFor();
  // Context menu destinations and Trash undo.
  const row=target.locator('[data-files-row][data-path$="New assets"]');await row.click({button:'right'});await target.getByRole('menuitem',{name:'Move to…',exact:true}).click();await target.locator('.tc-files-move').waitFor();await fits();await shot('move');
  await target.locator('[data-move-row="/workspace"]').click();await target.locator('[data-move-submit]:not([disabled])').waitFor();await target.locator('[data-move-submit]').click();await target.locator('.tc-files-move').waitFor({state:'detached'});
  await visit('files');const moved=target.locator('[data-files-row][data-path="/workspace/New assets"]');await moved.waitFor();await moved.click({button:'right'});await target.getByRole('menuitem',{name:'Move to Trash',exact:true}).click();await moved.waitFor({state:'detached'});
  await visit('files/trash');await target.locator('[data-files-row]').first().waitFor();await fits();await shot('trash');await target.locator('[data-cmd="files.restore"]').first().click();await target.getByText('Trash is empty',{exact:true}).waitFor();
  // Guarded roots never expose active write controls until explicitly unlocked.
  await visit('files/home/.t3');await target.getByRole('button',{name:'Edit anyway…',exact:true}).click();await target.getByRole('alertdialog').waitFor();await target.getByRole('button',{name:'Edit anyway',exact:true}).click();await target.getByRole('button',{name:'Lock again',exact:true}).waitFor();await shot('managed-unlocked');await target.getByRole('button',{name:'Lock again',exact:true}).click();
  // Upload conflict, pause and resume, and atomic final publication.
  await visit('files/projects/acme-web/apps/web');const picker=page.waitForEvent('filechooser');await target.locator('[data-cmd="files.upload"]').first().click();await (await picker).setFiles({name:'README.md',mimeType:'text/plain',buffer:Buffer.from('Uploaded content')});
  if(width<640){await target.locator('.tc-files-transfer-pill').waitFor();await target.locator('.tc-files-transfer-pill').click();}await target.locator('[data-transfer-action="resolve"]').waitFor();await target.locator('[data-transfer-action="resolve"]').click();await target.locator('.tc-files-conflicts').waitFor();await fits();await shot('upload-conflict');await target.locator('[data-conflict-continue]').click();await target.getByText('Show in web',{exact:true}).waitFor();await target.locator('[data-files-row][data-path$="README (2).md"]').waitFor();await shot('transfer-done');
  if(width<640)await target.locator('[data-transfer-action="fold"]').click();
  let releaseChunk;hold={route:'/upload/chunk',promise:new Promise(resolve=>{releaseChunk=resolve;})};
  const secondPicker=page.waitForEvent('filechooser');await target.locator('[data-cmd="files.upload"]').first().click();await(await secondPicker).setFiles({name:'resumed.txt',mimeType:'text/plain',buffer:Buffer.alloc(128*1024,0x62)});
  if(width<640){await target.locator('.tc-files-transfer-pill').click();}await target.getByRole('button',{name:'Pause resumed.txt',exact:true}).click();await target.getByRole('button',{name:'Resume resumed.txt',exact:true}).waitFor();await shot('upload-paused');releaseChunk();hold=null;await page.waitForTimeout(100);lostFinish=true;
  await target.getByRole('button',{name:'Resume resumed.txt',exact:true}).click();await target.locator('.tc-tray-item').filter({hasText:'resumed.txt'}).getByRole('button',{name:'Show in web',exact:true}).waitFor();
  const check=await fixture.respond('GET',new URL('http://fixture/files/read?path='+encodeURIComponent('/workspace/acme-web/apps/web/resumed.txt')));assert.equal(check.body.text.length,128*1024);assert.equal(check.body.text[0],'b');
  // Long native job names must fit the tray without losing their full accessible
  // label or the destination. These also exercise the phone transfer sheet.
  if(width<640)await target.locator('[data-transfer-action="fold"]').click();
  const longFolder='project-'+('very-long-folder-name-'.repeat(10)),dest='/workspace/'+longFolder,longFile='report-'+('very-long-file-name-'.repeat(10))+'.txt',completedPath=dest+'/'+longFile;
  await fixture.respond('POST',new URL('http://fixture/files/mkdir'),{parent:'/workspace',name:longFolder});
  await fixture.respond('POST',new URL('http://fixture/files/write'),{path:completedPath,text:'Transferred content',mode:'create'});
  extraJobs=[{id:'j_long_destination',kind:'move',label:longFile,dest,path:completedPath,state:'done',result:{path:completedPath},finishedAt:new Date().toISOString()},
    {id:'j_long_failure',kind:'move',label:longFile,state:'failed',error:'Could not write '+completedPath+'. Choose another folder.',finishedAt:new Date().toISOString()}];
  await target.evaluate(()=>{location.hash='overview';});await target.locator('#page-overview:not([hidden])').waitFor();await visit('files');
  if(width<640)await target.locator('.tc-files-transfer-pill').click();
  const show=target.getByRole('button',{name:'Show in '+longFolder,exact:true});await show.waitFor();
  assert.equal(await show.getAttribute('title'),dest,'the full destination remains available');
  assert.deepEqual(await target.locator('.tc-files-transfer-list').evaluate(el=>[...el.querySelectorAll('*')].filter(item=>{const r=item.getBoundingClientRect(),style=getComputedStyle(item);return r.width>0&&r.height>0&&['visible','clip'].includes(style.overflowX)&&item.scrollWidth>item.clientWidth+1;}).map(item=>({tag:item.tagName,text:item.textContent.slice(0,50),width:item.clientWidth,content:item.scrollWidth}))),[],'transfer content must stay inside its column');
  await fits();if(width<640){await target.evaluate(()=>Kit.toast('Transfer notice',{duration:1000}));assert.equal(await target.locator('.tc-toaster').evaluate(el=>getComputedStyle(el).visibility),'hidden','notifications stay behind the modal transfer sheet');}await show.scrollIntoViewIfNeeded();await target.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await shot('transfer-long-destination');await show.click();await target.locator('[data-files-row]').filter({hasText:longFile}).waitFor();
  assert.deepEqual(errors,[]);}catch(error){await shot('failure');console.error(variant,theme,await target.evaluate(()=>({menus:window.__fileMenuCloses,hash:location.hash,route:document.body.dataset.consoleRoute,toaster:document.querySelector('.tc-toaster')&&getComputedStyle(document.querySelector('.tc-toaster')).visibility,layerClasses:[...document.querySelectorAll('.tc-layer')].map(el=>el.className),top:Kit.top()?.panel?.outerHTML?.slice(0,900),text:document.body.innerText.slice(-4000)})),errors);throw error;}await context.close();console.log(variant+' '+theme+': passed');
 }}finally{await browser.close();}console.log('Files Change audit passed ('+checks+' layout checks). Screens: '+out);
})().catch(error=>{console.error(error);process.exitCode=1;});
