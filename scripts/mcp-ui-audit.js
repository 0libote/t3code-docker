#!/usr/bin/env node
// MCP tab behavior with deterministic, isolated API responses. No real config writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({chromium} = require('playwright')); } catch { ({chromium} = require('playwright-core')); }
const {statusFor, portsFor, routeConsole, framed, unlock, visit} = require('./lib/console-fixtures.cjs');
const base = process.argv[2] || 'http://127.0.0.1:23780/__setup/';
const key = process.argv[3] || 'dev';
const out = process.env.T3_MCP_UI_OUTPUT || '/tmp/t3-mcp-ui-audit';
fs.mkdirSync(out, {recursive:true});
(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/chromium',args:['--no-sandbox']});
  try {
    for (const theme of ['light','dark']) for (const variant of ['phone','desktop','embedded']) {
      const viewport = variant === 'phone' ? {width:375,height:667} : variant === 'embedded' ? {width:1198,height:878} : {width:1440,height:900};
      const context = await browser.newContext({viewport,colorScheme:theme,reducedMotion:'reduce'});
      const page = await context.newPage();
      const errors = []; page.on('pageerror',e=>errors.push(e.message));
      let revision = 'shared-1', nativeRevision = 1, configured = false, differs = false, claudePresent = false, readError = false, pendingRead, pendingSave;
      let definition = {name:'probe',type:'local',enabled:true,command:['server'],env:{}};
      const calls = [];
      const snapshot = () => ({ok:true,shared:{present:true,count:1,revision,servers:[{name:'probe',type:definition.type,enabled:definition.enabled,command:definition.command,secretCount:Object.keys(definition.env).length}]},providers:[
        {provider:'codex',supported:true,path:'/home/t3/.codex/config.toml',revision:'native-'+nativeRevision,linked:configured&&!differs?['probe']:[],diverged:configured&&differs?['probe']:[],unlinked:configured?[]:['probe']},
        {provider:'claude',supported:true,path:'/home/t3/.claude.json',revision:'native-'+nativeRevision,linked:[],diverged:claudePresent?['probe']:[],unlinked:claudePresent?[]:['probe']}
      ]});
      const status = statusFor('ready'); status.context.mcp = snapshot();
      await routeConsole(page,{status:()=>status,ports:()=>portsFor('ready')});
      await page.route('**/*',async route=>{
        const req = route.request(), url = new URL(req.url());
        if (!url.pathname.includes('/context/mcp')) return route.fallback();
        if (req.method() === 'GET') {
          if (url.pathname.endsWith('/read')) {
            const value = {ok:true,server:structuredClone(definition),revision};
            if (pendingRead) await pendingRead.promise;
            return route.fulfill({status:readError?500:200,json:readError?{ok:false,error:'Fixture read failure'}:value});
          }
          return route.fulfill({json:snapshot()});
        }
        if (url.pathname.endsWith('/save') && pendingSave) await pendingSave;
        const body = req.postDataJSON(); calls.push({route:url.pathname,body});
        if (url.pathname.endsWith('/link')) {
          assert.equal(body.providerRevision,'native-'+nativeRevision);
          assert.equal(body.sharedRevision,revision);
          if(body.provider==='codex') {configured=body.linked;differs=false;} else claudePresent=body.linked;
          nativeRevision++;
        } else if (url.pathname.endsWith('/save')) {
          assert.equal(body.revision,revision,'Save must use the revision loaded with the editor');
          definition=body.server; revision += '-saved'; differs=configured;
        }
        return route.fulfill({json:{ok:true}});
      });
      const url = new URL(base); url.searchParams.set('theme',theme);
      if(variant==='embedded')url.searchParams.set('embed','t3');
      const target = variant==='embedded'?await framed(page,url.href):page;
      if(variant!=='embedded')await page.goto(url.href);
      await unlock(target,key); await visit(target,page,'instructions/mcp');
      await target.locator('#mcp-provider').selectOption('codex');
      const toggle=target.getByRole('switch',{name:'Codex configured for probe'});
      await toggle.click(); await toggle.waitFor({state:'visible'});
      await target.waitForFunction(()=>document.querySelector('[aria-label="Codex configured for probe"]')?.getAttribute('aria-checked')==='true');
      await toggle.click(); await target.getByRole('button',{name:'Unlink',exact:true}).click();
      await target.waitForFunction(()=>document.querySelector('[aria-label="Codex configured for probe"]')?.getAttribute('aria-checked')==='false');
      assert.deepEqual(calls.filter(c=>c.route.endsWith('/link')).map(c=>c.body.linked),[true,false]);
      // The list and global /status remain stale; the editor must use its read response.
      revision='externally-updated'; definition={...definition,command:['server',' spaced ',''],env:{MULTILINE:'line one\nline two',SPACES:' value '}};
      await target.getByRole('button',{name:'Edit probe',exact:true}).click();
      await target.locator('#mcp-command').waitFor();
      await target.waitForFunction(()=>document.querySelector('#mcp-command')?.value.includes('spaced'));
      assert.equal(await target.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
      // Each transport keeps its own values, including when the DOM is morphed.
      const originalEnv=await target.locator('#mcp-pairs').inputValue();
      await target.locator('#mcp-type').selectOption('remote');
      assert.equal(await target.locator('#mcp-pairs').inputValue(),'{}');
      await target.locator('#mcp-pairs').fill('{"Authorization":"fixture"}');
      await target.locator('#mcp-type').selectOption('local');
      assert.equal(await target.locator('#mcp-pairs').inputValue(),originalEnv);
      await target.locator('#mcp-command').fill('["server", " spaced ", ""]');
      let finishSave; pendingSave=new Promise(resolve=>{finishSave=resolve;});
      await target.getByRole('button',{name:'Save',exact:true}).click();
      await target.getByRole('button',{name:'Saving…',exact:true}).waitFor();
      assert.equal(await target.locator('.tc-mcp-editor [aria-label=Close]').isDisabled(),true);
      await page.keyboard.press('Escape');
      assert.equal(await target.locator('.tc-mcp-editor').count(),1);
      finishSave(); pendingSave=null;
      await target.locator('.tc-mcp-editor').waitFor({state:'detached'});
      assert.deepEqual(definition.command,['server',' spaced ','']);
      assert.deepEqual(definition.env,{MULTILINE:'line one\nline two',SPACES:' value '});
      configured=true; differs=true;
      await target.getByRole('button',{name:'Refresh MCP servers'}).click();
      await target.getByRole('button',{name:'Apply',exact:true}).click();
      await target.getByRole('button',{name:'Apply shared',exact:true}).click();
      await target.getByRole('button',{name:'Apply',exact:true}).waitFor({state:'detached'});
      assert.equal(differs,false);assert.equal(configured,true);
      // A disabled definition with a surviving Claude entry must remain removable.
      definition.enabled=false;claudePresent=true;
      await target.getByRole('button',{name:'Refresh MCP servers'}).click();
      await target.locator('#mcp-provider').selectOption('claude');
      const claude=target.getByRole('switch',{name:'Claude Code configured for probe'});
      await target.waitForFunction(()=>document.querySelector('[aria-label="Claude Code configured for probe"]')?.getAttribute('aria-checked')==='true');
      await claude.click();await target.getByRole('button',{name:'Unlink',exact:true}).click();
      await target.waitForFunction(()=>document.querySelector('[aria-label="Claude Code configured for probe"]')?.getAttribute('aria-checked')==='false');
      assert.equal(claudePresent,false);
      await target.locator('#mcp-provider').selectOption('codex');
      assert.equal(await toggle.getAttribute('aria-checked'),'true');
      // A dismissed read must never populate a newly opened Add dialog.
      let release;pendingRead={promise:new Promise(resolve=>{release=resolve;})};
      await target.getByRole('button',{name:'Edit probe',exact:true}).click();
      await target.locator('.tc-mcp-editor [data-mcp=close][aria-label=Close]').click();
      await target.getByRole('button',{name:'Add server',exact:true}).click();
      release();pendingRead=null;
      await target.locator('#mcp-name').waitFor();
      assert.equal(await target.locator('#mcp-name').inputValue(),'');
      await target.locator('#mcp-name').fill('new-server');
      await target.locator('#mcp-command').fill('not JSON');
      const count=calls.length;
      await target.getByRole('button',{name:'Add server',exact:true}).last().click();
      await target.getByRole('alert').filter({hasText:'JSON array'}).waitFor();
      assert.equal(calls.length,count,'invalid JSON must not submit');
      assert.equal(await target.locator('#mcp-command').inputValue(),'not JSON');
      await page.keyboard.press('Escape');
      await target.getByRole('alertdialog').getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal(await target.locator('#mcp-command').inputValue(),'not JSON');
      await target.locator('.tc-mcp-editor [data-mcp=close][aria-label=Close]').click();
      await target.getByRole('button',{name:'Discard changes',exact:true}).click();
      readError=true;
      await target.getByRole('button',{name:'Edit probe',exact:true}).click();
      await target.getByRole('alert').filter({hasText:'Fixture read failure'}).waitFor();
      assert.equal(await target.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
      assert.equal(await target.getByRole('button',{name:'Remove…',exact:true}).isDisabled(),true);
      await page.screenshot({path:path.join(out,`${variant}-${theme}-read-error.png`)});
      await target.locator('.tc-mcp-editor [data-mcp=close][aria-label=Close]').click();
      assert.equal(await target.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);
      await context.close();
      console.log(`${variant} ${theme}: agent selection, links, editor revisions, separate transport drafts, guarded saves/discard, apply/unlink, failed and late reads passed.`);
    }
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
