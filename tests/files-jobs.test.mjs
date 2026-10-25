import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { filesFixture } from './lib/files-fixture.mjs';
import { createJobs } from '../docker/setup/files/jobs.mjs';
import { createStages } from '../docker/setup/files/stages.mjs';
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
test('jobs limit concurrency, preserve FIFO and cancel queued work without running it',async()=>{
 const jobs=createJobs(),wait=gate(),started=[];let active=0,maximum=0;
 const add=id=>jobs.add('copy',id,async({signal})=>{started.push(id);maximum=Math.max(maximum,++active);await wait.promise;active--;assert.equal(signal.aborted,false);return id;});
 const first=add('one'),second=add('two'),third=add('three');jobs.cancel(third);await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(started,['one','two']);wait.release();assert.equal((await jobs.settled(first)).state,'done');assert.equal((await jobs.settled(second)).state,'done');assert.equal((await jobs.settled(third)).state,'cancelled');assert.equal(maximum,2);
});
test('restart recovery cleans only recorded staging identities and reports interruption',async t=>{
 const f=await filesFixture(t),stages=createStages({stateDir:f.policy.stateDir}),lease=await stages.create(f.workspace,'copy',{id:'j_test',kind:'copy',label:'Copy test'});await fs.writeFile(lease.payload,'partial');
 const foreign=path.join(f.workspace,'.t3-copy-12345678-1234-4234-8234-123456789abc.tmp');await fs.mkdir(foreign);await fs.writeFile(path.join(foreign,'keep'),'mine');
 const recovered=createJobs({stateDir:f.policy.stateDir});await recovered.ready;assert.equal(recovered.get('j_test').state,'failed');assert.equal(await fs.stat(lease.root).then(()=>true,()=>false),false);assert.equal(await fs.readFile(path.join(foreign,'keep'),'utf8'),'mine');await lease.dispose();
});
test('cancelled running stages are removed and finishing jobs cannot be interrupted',async t=>{
 const f=await filesFixture(t),wait=gate();let begun;const started=new Promise(resolve=>{begun=resolve;});const id=f.jobs.add('copy','Copy',async({signal,stage,progress})=>{const lease=await stage(f.workspace,'copy');try{await fs.writeFile(lease.payload,'partial');begun();await wait.promise;if(signal.aborted)throw new DOMException('Cancelled','AbortError');progress({cancellable:false});return {path:lease.payload};}finally{await lease.dispose();}});
 await started;f.jobs.cancel(id);wait.release();assert.equal((await f.jobs.settled(id)).state,'cancelled');assert.equal((await fs.readdir(f.workspace)).some(name=>name.startsWith('.t3-copy-')),false);
 const finish=gate(),ready=gate();const final=f.jobs.add('copy','Finishing',async({progress})=>{progress({cancellable:false});ready.release();await finish.promise;return {};});await ready.promise;assert.throws(()=>f.jobs.cancel(final),{code:'busy'});finish.release();assert.equal((await f.jobs.settled(final)).state,'done');
});
