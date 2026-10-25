import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

test('Files loads from the installed image layout and receives process facts through the harness interface',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-files-image-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const setup=path.join(root,'opt/t3-setup'),harness=path.join(root,'opt/t3-harness');await Promise.all([fs.cp(new URL('../docker/setup/',import.meta.url),setup,{recursive:true}),fs.cp(new URL('../docker/harness/',import.meta.url),harness,{recursive:true})]);
 const installed=await import(pathToFileURL(path.join(setup,'files.mjs')).href),manager=await import(pathToFileURL(path.join(harness,'index.mjs')).href);assert.equal(typeof manager.processSnapshot,'function');
 const home=path.join(root,'home'),workspace=path.join(root,'workspace');await fs.mkdir(home);await fs.mkdir(workspace);let calls=0;
 const service=installed.createFilesService({home,workspace,env:{},maintenance:false,processSnapshot:async()=>{calls++;return {complete:true,processes:[]};}});await service.activity.fresh();assert.equal(calls,1);assert.equal(service.activity.get().complete,true);service.stop?.();
});
