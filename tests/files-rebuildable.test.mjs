import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import rules from '../docker/setup/files/rebuildable-folders.json' with {type:'json'};
import { createRebuildableService } from '../docker/setup/files/rebuildable.mjs';
import { createGitService } from '../docker/setup/files/git.mjs';
import { createCommandRunner } from '../docker/setup/files/io.mjs';
import { parseMounts } from '../docker/setup/files/mounts.mjs';
const sizesFor=values=>({facts:value=>values.has(value)?{bytes:values.get(value)}:null,entries:()=>values,under:root=>[...values].filter(([file])=>file.startsWith(root+'/'))});
const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-files-rules-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('every supplied marker rule is recognized outside Git, with exact file types and case',async t=>{
 const base=await fixture(t),values=new Map(),git=createGitService({env}),service=createRebuildableService({sizes:sizesFor(values),git});
 for(const [index,rule]of rules.rules.entries()){
  const root=path.join(base,'case-'+index),candidate=path.join(root,rule.parent||'',rule.name);await fs.mkdir(candidate,{recursive:true});values.set(candidate,4096);
  if(rule.marker){
   const marker=rule.marker[0],inside=marker.endsWith(' (inside)'),name=marker.split(' ')[0].replace('*','fixture').replace('?','x'),directory=inside?candidate:root;
   if(name.endsWith('.xcodeproj'))await fs.mkdir(path.join(directory,name));else await fs.writeFile(path.join(directory,name),'fixture');
  }
  const facts=await service.settled(root,null);
  assert.equal(facts.candidates.some(row=>row.path===candidate),!!rule.marker,rule.name+' / '+rule.group);
 }
 const root=path.join(base,'wrong-case'),candidate=path.join(root,'node_modules');await fs.mkdir(candidate,{recursive:true});await fs.writeFile(path.join(root,'Package.json'),'{}');values.set(candidate,4096);
 assert.equal((await service.settled(root,null)).candidates.length,0);
});

test('a workspace summary checks each nested repository and never labels tracked source or project roots rebuildable',async t=>{
 const workspace=await fixture(t),project=path.join(workspace,'project'),plain=path.join(workspace,'plain'),top=path.join(workspace,'node_modules'),values=new Map();
 for(const directory of [project,plain,top])await fs.mkdir(directory);
 const run=createCommandRunner(env),git=createGitService({env});await run('git',['init','-q',project]);
 await fs.writeFile(path.join(project,'.gitignore'),'dist/\nnode_modules/\n');await fs.mkdir(path.join(project,'dist'));await fs.writeFile(path.join(project,'dist','source.js'),'keep');await run('git',['-C',project,'add','-f','dist/source.js']);await fs.mkdir(path.join(project,'node_modules'));
 await fs.writeFile(path.join(plain,'package.json'),'{}');await fs.mkdir(path.join(plain,'node_modules'));await fs.writeFile(path.join(workspace,'package.json'),'{}');
 for(const directory of [path.join(project,'dist'),path.join(project,'node_modules'),path.join(plain,'node_modules'),top])values.set(directory,8192);
 const service=createRebuildableService({sizes:sizesFor(values),git,workspace}),facts=await service.settled(workspace,null);
 assert.deepEqual(facts.candidates.map(row=>row.path).sort(),[path.join(project,'node_modules'),path.join(plain,'node_modules')].sort());
 assert.match(facts.kept.find(row=>row.path===path.join(project,'dist')).reason,/Git tracks/);assert.match(facts.kept.find(row=>row.path===top).reason,/Project folders/);
});

test('same-device bind mounts, symlinks, unknown mounts and nested repositories are kept',async t=>{
 const root=await fixture(t),candidate=path.join(root,'node_modules'),values=new Map([[candidate,8192]]);await fs.mkdir(candidate);await fs.writeFile(path.join(root,'package.json'),'{}');
 const git=createGitService({env}),sizes=sizesFor(values);
 for(const available of [true,false]){
  const service=createRebuildableService({sizes,git,mounts:{snapshot:async()=>({available,mounts:[{path:'/'},{path:candidate}]})}});
  const facts=await service.settled(root,null);assert.equal(facts.candidates.length,0);assert.match(facts.kept[0].reason,/mount/i);
 }
 await fs.mkdir(path.join(candidate,'.git'));const repository=createRebuildableService({sizes,git});assert.match((await repository.settled(root,null)).kept[0].reason,/own Git/);
 await fs.rm(candidate,{recursive:true});await fs.symlink(root,candidate);assert.equal((await createRebuildableService({sizes,git}).settled(root,null)).candidates.length,0);
});

test('mount parsing preserves escaped paths, read-only flags and a required namespace root',()=>{
 const facts=parseMounts('22 1 0:20 / / rw,relatime - overlay overlay rw\n23 22 0:20 /a /space\\040name ro,relatime - ext4 /dev/test rw\n');
 assert.equal(facts.available,true);assert.deepEqual(facts.mounts[0],{path:'/space name',readOnly:true});
 assert.equal(parseMounts('broken').available,false);assert.equal(parseMounts('').available,false);
});
