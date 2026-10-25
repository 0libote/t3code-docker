import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createFilesService, filesFailure } from '../docker/setup/files.mjs';
import { walk, allocatedBytes } from '../docker/setup/files/walk.mjs';
import { createThreadFacts } from '../docker/setup/files/activity.mjs';
const run=promisify(execFile);
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-files-browse-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),workspace=path.join(root,'work'),external=path.join(root,'elsewhere');
  await Promise.all([home,workspace,external].map(file=>fs.mkdir(file,{recursive:true})));
  let measuredAt=Date.now();
  const values=new class extends Map {set(key,value){measuredAt=Date.now()+1;return super.set(key,value);}}(),storage={sizes:()=>({at:measuredAt,partial:false,bytesOf:file=>values.get(file)??null,entries:()=>values.entries(),childrenOf:root=>[...values].filter(([file])=>path.dirname(file)===root).map(([path,bytes])=>({path,bytes}))}),snapshot:()=>({categories:[]})};
  const activity={forPath:()=>({complete:true,running:[]})};
  const service=createFilesService({home,workspace,stateDir:path.join(home,'.t3/setup'),env:{},storage,activity});
  return {root,home,workspace,external,values,service};
}
const query = value=>new URLSearchParams(value);

test('browse is not jailed; link entries preserve their identity and opening follows a folder link',async t=>{
  const {home,workspace,external,service}=await fixture(t);
  await fs.mkdir(path.join(home,'.t3'),{recursive:true});await fs.writeFile(path.join(external,'hello.txt'),'hello');
  await fs.symlink(path.join(home,'.t3'),path.join(workspace,'managed-alias'));
  const list=await service.handle('/files/list',{query:query({path:workspace})});
  assert.equal(list.entries[0].kind,'link');assert(list.entries[0].tags.includes('managed'));assert.equal(list.entries[0].target.kind,'folder');
  assert.equal((await service.handle('/files/list',{query:query({path:external})})).entries[0].name,'hello.txt');
  assert.equal((await service.handle('/files/list',{query:query({path:path.join(workspace,'managed-alias')})})).managed.root,path.join(home,'.t3'));
  assert.equal(service.capabilities.change,true);assert.equal(service.capabilities.archives,true);assert.equal(service.capabilities.space,true);
});

test('listing has stable etags, natural sorting, hidden counts and explicit 500 / 20,000 paging',async t=>{
  const {workspace,values,service}=await fixture(t);
  await Promise.all(Array.from({length:503},(_,index)=>fs.writeFile(path.join(workspace,`file-${index}.txt`),'x')));
  await fs.writeFile(path.join(workspace,'.hidden'),'hidden');values.set(workspace,4096);
  await service.rebuildable.settled(workspace,null);
  const first=await service.listing.list(workspace,{sort:'name'}),second=await service.listing.list(workspace,{sort:'name'});
  assert.equal(first.entries.length,500);assert.equal(first.more,true);assert.equal(first.total,503);assert.equal(first.counts.hidden,1);assert.equal(first.etag,second.etag);
  assert.equal(first.entries[2].name,'file-2.txt');
  const all=await service.listing.list(workspace,{all:true,hidden:true});assert.equal(all.entries.length,504);
  await fs.writeFile(path.join(workspace,'file-0.txt'),'changed');assert.notEqual((await service.listing.list(workspace,{sort:'name'})).etag,first.etag);
});

test('measurement deduplicates hard links and never traverses a directory link or races into its replacement',async t=>{
  const {workspace,external}=await fixture(t),directory=path.join(workspace,'folder'),file=path.join(workspace,'source');
  await fs.mkdir(directory);await fs.writeFile(file,Buffer.alloc(32768));await fs.link(file,path.join(workspace,'hardlink'));
  await fs.writeFile(path.join(external,'secret'),Buffer.alloc(65536));await fs.symlink(external,path.join(workspace,'link'));
  const facts=await walk(workspace);const paths=[];
  assert.equal(facts.files,3);assert(!facts.directories.has(external));
  const expected=(await Promise.all([workspace,directory,file,path.join(workspace,'link')].map(file=>fs.lstat(file)))).reduce((sum,stat)=>sum+allocatedBytes(stat),0);
  assert.equal(facts.bytes,expected);
  await fs.writeFile(path.join(directory,'before'),'safe');
  const raced=await walk(workspace,{visit:async row=>{
    paths.push(row.path);
    if(row.path===workspace){await fs.rename(directory,directory+'-old');await fs.symlink(external,directory);}
  }});
  assert(!paths.includes(path.join(directory,'secret')));assert(!raced.directories.has(directory));
});

test('measurement stops at its budget and search is bounded, filename-only, with no link following',async t=>{
  const {workspace,external,service}=await fixture(t);
  await fs.mkdir(path.join(workspace,'nested'));await fs.writeFile(path.join(workspace,'nested','logo.svg'),'<svg/>');
  await fs.writeFile(path.join(external,'logo-secret'),'private');await fs.symlink(external,path.join(workspace,'external'));
  const found=await service.handle('/files/search',{query:query({path:workspace,q:'LOGO'})});
  assert.equal(found.results.length,1);assert.equal(found.results[0].name,'logo.svg');assert.equal(found.truncated,false);
  const limited=await walk(workspace,{maxEntries:1});assert.equal(limited.partial,true);assert.equal(limited.entries,1);
  await assert.rejects(service.handle('/files/search',{query:query({path:workspace,q:'x',size:'invalid'})}),{code:'invalid'});
});

test('rebuildability requires Git ignore and no tracked source, with outermost-only accounting',async t=>{
  const {workspace,values,service}=await fixture(t),project=path.join(workspace,'project');
  await fs.mkdir(project);await run('git',['init','-q',project]);await fs.writeFile(path.join(project,'.gitignore'),'node_modules/\ndist/\n');
  await fs.mkdir(path.join(project,'node_modules'));await fs.mkdir(path.join(project,'dist'));await fs.writeFile(path.join(project,'dist','source.js'),'source');
  await run('git',['-C',project,'add','-f','dist/source.js']);values.set(path.join(project,'node_modules'),8192);values.set(path.join(project,'dist'),4096);
  const facts=await service.rebuildable.settled(project,project);
  assert.deepEqual(facts.candidates.map(row=>path.basename(row.path)),['node_modules']);
  assert.equal(facts.kept[0].path,path.join(project,'dist'));assert.match(facts.kept[0].reason,/Git tracks/);
  await fs.mkdir(path.join(project,'node_modules','build'));values.set(path.join(project,'node_modules','build'),2048);
  service.rebuildable.invalidate();const next=await service.rebuildable.settled(project,project);assert.equal(next.candidates.length,1);
});

test('optional thread facts use supported RPC roots, cache once and fail closed when unsupported',async()=>{
  let calls=0;
  const facts=createThreadFacts({t3:{first:async(tag,payload)=>{calls++;assert.equal(tag,'orchestration.subscribeShell');assert.deepEqual(payload,{});return {kind:'snapshot',snapshot:{projects:[{id:'p',workspaceRoot:'/work'}],threads:[{projectId:'p',updatedAt:'2026-10-24T20:00:00Z'},{projectId:'p',worktreePath:'/other'}]}};}}});
  assert.equal(facts.forPath('/work'),null);await facts.settled();assert.equal(facts.forPath('/work').count,1);assert.equal(calls,1);
  const unavailable=createThreadFacts({t3:{first:async()=>{throw new Error('unsupported');}}});await unavailable.settled();assert.equal(unavailable.forPath('/work'),null);
});

test('error responses are stable and never expose CLI output, arguments or stacks',()=>{
  const failure=filesFailure(Object.assign(new Error('PRIVATE TOKEN in CLI output'),{code:'EACCES',stdout:'private'}));
  assert.equal(failure.status,403);assert.equal(failure.body.code,'no-access');assert(!JSON.stringify(failure).includes('PRIVATE'));
});

test('Home composition uses exclusive managed roots, not all contents of an ancestor folder',async t=>{
 const {home,workspace,values}=await fixture(t),t3Root=path.join(home,'.t3'),cache=path.join(t3Root,'cache'),tools=path.join(home,'.local/share/mise');
 await Promise.all([cache,tools].map(file=>fs.mkdir(file,{recursive:true})));
 values.set(home,40000);values.set(t3Root,10000);values.set(cache,5000);values.set(tools,16000);
 const storage={sizes:()=>({at:Date.now(),partial:false,bytesOf:file=>values.get(file)??null,entries:()=>values.entries()}),snapshot:()=>({categories:[],volumeName:'fixture-home'})};
 const service=createFilesService({home,workspace,env:{XDG_CACHE_HOME:cache},storage,activity:{forPath:()=>({complete:true,running:[]})}});
 const result=await service.places();
 assert.deepEqual(result.home.composition.map(row=>[row.id,row.bytes]),[['tools',16000],['t3',5000],['caches',5000],['other',14000]]);
 assert.equal(result.home.composition.reduce((sum,row)=>sum+row.bytes,0),result.home.bytes);
});

test('Projects composition includes independent repository histories and worktree marker files do not imply missing history',async t=>{
 const {workspace,values,service}=await fixture(t);
 for(const name of ['one','two']){const project=path.join(workspace,name);await fs.mkdir(path.join(project,'.git'),{recursive:true});values.set(project,16000);values.set(path.join(project,'.git'),4000);}
 values.set(workspace,40000);await service.rebuildable.settled(workspace,null);
 const result=await service.places();assert.equal(result.projects.composition.gitBytes,8000);assert.equal(result.projects.composition.keptBytes,32000);
 const other=await fixture(t);await fs.writeFile(path.join(other.workspace,'.git'),'gitdir: /a/history/elsewhere');other.values.set(other.workspace,8192);
 await other.service.rebuildable.settled(other.workspace,other.workspace);
 const projects=await other.service.handle('/files/projects');assert.equal(projects.projects[0].composition.gitBytes,0);assert.equal(projects.projects[0].composition.keptBytes,8192);
});
