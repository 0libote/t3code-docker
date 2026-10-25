import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createSizesService } from '../docker/setup/files/sizes.mjs';
import { internalName } from '../docker/setup/files/walk.mjs';
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));

test('automatic measurements coalesce exact paths, skip an active ancestor and never exceed two walks',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-files-measure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const a=path.join(root,'a'),child=path.join(a,'child'),b=path.join(root,'b'),c=path.join(root,'c');await Promise.all([child,b,c].map(value=>fs.mkdir(value,{recursive:true})));
 const releases=new Map(),calls=[];
 const service=createSizesService({measure:async value=>{calls.push(value);await new Promise(resolve=>releases.set(value,resolve));return {partial:false,directories:new Map([[value,{bytes:8192,complete:true,mtimeMs:(await fs.lstat(value)).mtimeMs,files:4}]])};}});
 const first=await service.start(a),same=await service.start(a);assert.equal(first.id,same.id);assert.equal(await service.start(child),null);
 assert(await service.start(b));assert.equal(await service.start(c),null);assert.deepEqual(calls.sort(),[a,b].sort());
 for(const release of releases.values())release();for(let count=0;count<1000&&service.jobs().some(row=>row.state==='running');count++)await pause();
 assert.equal(service.facts(a).bytes,8192);assert.equal(service.facts(a).files,4);assert(service.jobs().every(row=>row.state==='done'));
});

test('prefix lookups isolate sibling names and a newer global scan replaces older local facts',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-files-prefix-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const a=path.join(root,'a'),ab=path.join(root,'ab');await Promise.all([a,ab].map(value=>fs.mkdir(value)));let at=Date.now()+1,reads=0;
 const values=new Map([[a,100],[path.join(a,'child'),50],[ab,200]]),storage={sizes:()=>({at,bytesOf:value=>values.get(value)??null,entries:()=>{reads++;return values.entries();}})};
 const service=createSizesService({storage});assert.deepEqual(service.under(a),[[path.join(a,'child'),50]]);service.under(ab);assert.equal(reads,1);
 values.set(path.join(a,'next'),25);at+=1000;assert.equal(service.under(a).length,2);assert.equal(reads,2);
});

test('only Files staging identities are hidden, never an ordinary similarly named file',()=>{
 assert.equal(internalName('.t3-trash'),true);
 assert.equal(internalName('.t3-upload-u_12345678-1234-4234-8234-123456789abc.part'),true);
 assert.equal(internalName('.t3-write-12345678-1234-4234-8234-123456789abc.tmp'),true);
 assert.equal(internalName('.t3-upload-notes.txt'),false);assert.equal(internalName('.t3-extract-guide.md'),false);
});
