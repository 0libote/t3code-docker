import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHoldControl } from '../docker/setup/files/hold.mjs';
import { waitForFilesHold } from '../docker/runtime/supervisor.mjs';

async function fixture(t){const runDir=await fs.mkdtemp(path.join(os.tmpdir(),'t3-files-hold-'));t.after(()=>fs.rm(runDir,{recursive:true,force:true}));await fs.writeFile(path.join(runDir,'supervisor.json'),JSON.stringify({pid:100,protocol:3}));let current=42,alive=true,at=Date.now();const options={runDir,readPid:()=>current,alive:pid=>pid===100||pid===current&&alive,now:()=>at,sleep:async ms=>{at+=ms;},restart:async()=>{alive=false;setImmediate(()=>{current=43;alive=true;});return {ok:true};}};return {options,runDir};}
test('managed changes release the hold and report restart health without replaying a completed action',async t=>{
 const {options,runDir}=await fixture(t);let count=0;
 const control=createHoldControl({...options,sleep:async()=>{await new Promise(resolve=>setImmediate(resolve));}});
 const result=await control.withStopped(async()=>{count++;assert.equal(await control.active(),true);return {ok:true,path:'fixture'};});assert.equal(count,1);assert.equal(result.t3,'restarted');assert.equal(await control.active(),false);assert.equal(await fs.stat(path.join(runDir,'hold')).then(()=>true,()=>false),false);
});
test('busy and failed changes never leave a hold, and the supervisor bounds abandoned holds',async t=>{
 const {options,runDir}=await fixture(t),busy=createHoldControl({...options,runtimeBusy:()=>true});await assert.rejects(busy.withStopped(async()=>{}),{code:'busy'});
 const failed=createHoldControl({...options,sleep:async()=>{await new Promise(resolve=>setImmediate(resolve));}});await assert.rejects(failed.withStopped(async()=>{throw new Error('operation failed');}),/operation failed/);assert.equal(await failed.active(),false);
 const hold=path.join(runDir,'hold');await fs.writeFile(hold,'abandoned');let time=0;await waitForFilesHold(hold,{timeoutMs:1000,now:()=>time,sleep:async ms=>{time+=ms;}});assert(time>=1000);assert.equal(await fs.stat(hold).then(()=>true,()=>false),false);
});
