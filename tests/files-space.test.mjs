import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { filesFixture } from './lib/files-fixture.mjs';
import { createCleanup } from '../docker/setup/files/cleanup.mjs';
import { createReviews } from '../docker/setup/files/reviews.mjs';
import { createRebuildableService } from '../docker/setup/files/rebuildable.mjs';

async function setup(t){const f=await filesFixture(t),values=new Map(),sizes={facts:value=>values.has(value)?{bytes:values.get(value)}:null,under:root=>[...values].filter(([value])=>value.startsWith(root+'/')),entries:()=>values};
 // Tests use real repository probes and isolated filesystem/process facts.
 const {createGitService}=await import('../docker/setup/files/git.mjs');const git=createGitService({env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}),rules=createRebuildableService({sizes,git,workspace:f.workspace}),reviews=createReviews(),threads={forPath:()=>null,fresh:async()=>null};
 const cleanup=createCleanup({...f,sizes,git,rebuildable:rules,reviews,threads});return {...f,values,sizes,git,reviews,cleanup};}
test('cleanup reviews only verified build output, and a newly tracked file invalidates the whole action',async t=>{
 const f=await setup(t),project=path.join(f.workspace,'project'),candidate=path.join(project,'node_modules');await fs.mkdir(candidate,{recursive:true});await fs.writeFile(path.join(project,'package.json'),'{}');await fs.writeFile(path.join(candidate,'keep-until-reviewed'),'output');f.values.set(candidate,8192);
 await f.git.command(project,['init','-q']);await fs.writeFile(path.join(project,'.gitignore'),'node_modules/\n');const preview=await f.cleanup.cleanPreview({path:project});assert.equal(preview.projects[0].items[0].checked,true);
 await f.git.command(project,['add','-f','node_modules/keep-until-reviewed']);await assert.rejects(f.cleanup.clean({token:preview.token,ids:[preview.projects[0].items[0].id]}),{code:'stale'});assert.equal(await fs.readFile(path.join(candidate,'keep-until-reviewed'),'utf8'),'output');
 const next=await f.cleanup.cleanPreview({path:project});assert.equal(next.projects.length,0);assert.match(next.kept[0].reason,/Git tracks/);
});
test('in-use and unknown activity remain unchecked; successful cleanup consumes its review and isolates removals',async t=>{
 const f=await setup(t),project=path.join(f.workspace,'project'),candidate=path.join(project,'node_modules');await fs.mkdir(candidate,{recursive:true});await fs.writeFile(path.join(project,'package.json'),'{}');f.values.set(candidate,8192);
 f.setProcesses({complete:false,processes:[]});let preview=await f.cleanup.cleanPreview({path:project});assert.equal(preview.projects[0].items[0].checked,false);await assert.rejects(f.cleanup.clean({token:preview.token,ids:[preview.projects[0].items[0].id]}),{code:'in-use'});
 f.setProcesses({complete:true,processes:[]});preview=await f.cleanup.cleanPreview({path:project});const response=await f.cleanup.clean({token:preview.token,ids:[preview.projects[0].items[0].id]}),job=await f.jobs.settled(response.job);assert.equal(job.state,'done',job.error);assert.equal(await fs.stat(candidate).then(()=>true,()=>false),false);assert.equal(await fs.readFile(path.join(project,'package.json'),'utf8'),'{}');await assert.rejects(f.cleanup.clean({token:preview.token,ids:[]}),{code:'stale'});
});
test('delete binds nested edits, exact typed names, activity and protected roots before removing anything',async t=>{
 const f=await setup(t),project=path.join(f.workspace,'project'),nested=path.join(project,'src/file.txt');await fs.mkdir(path.dirname(nested),{recursive:true});await fs.writeFile(nested,'first');
 let preview=await f.cleanup.deletePreview({paths:[project]});assert.equal(preview.confirmName,'project');await assert.rejects(f.cleanup.remove({token:preview.token,confirmName:'wrong'}),{code:'invalid'});
 await fs.writeFile(nested,'changed');await assert.rejects(f.cleanup.remove({token:preview.token,confirmName:'project'}),{code:'stale'});assert.equal(await fs.readFile(nested,'utf8'),'changed');
 preview=await f.cleanup.deletePreview({paths:[project]});const response=await f.cleanup.remove({token:preview.token,confirmName:'project'});assert.equal((await f.jobs.settled(response.job)).state,'done');assert.equal(await fs.stat(project).then(()=>true,()=>false),false);
 for(const value of ['/',f.home,f.workspace,path.join(f.home,'.t3')])await assert.rejects(f.cleanup.deletePreview({paths:[value]}),{code:'locked'});
});
test('reviews expire, are kind-bound and cannot be used twice',()=>{let now=0;const reviews=createReviews({now:()=>now}),first=reviews.issue('delete',{paths:['/one']});assert.throws(()=>reviews.peek(first.token,'zip'),{code:'stale'});assert.deepEqual(reviews.consume(first.token,'delete'),{paths:['/one']});assert.throws(()=>reviews.consume(first.token,'delete'),{code:'stale'});const second=reviews.issue('clean',{});now=300001;assert.throws(()=>reviews.peek(second.token,'clean'),{code:'stale'});});

test('a deletion queued behind transfers rechecks nested changes and activity before removing any selection',async t=>{
 const f=await setup(t),first=path.join(f.workspace,'one'),second=path.join(f.workspace,'two');await fs.mkdir(first);await fs.mkdir(second);await fs.writeFile(path.join(first,'keep'),'first');await fs.writeFile(path.join(second,'keep'),'second');
 let release;const gate=new Promise(resolve=>{release=resolve;}),blockers=[f.jobs.add('test','one',()=>gate),f.jobs.add('test','two',()=>gate)];const preview=await f.cleanup.deletePreview({paths:[first,second]});assert.equal(preview.confirmName,'DELETE 2 ITEMS');const queued=await f.cleanup.remove({token:preview.token,confirmName:preview.confirmName});await fs.writeFile(path.join(second,'keep'),'newer');release();for(const id of blockers)await f.jobs.settled(id);const job=await f.jobs.settled(queued.job);assert.equal(job.state,'failed');assert.equal(job.code,'stale');assert.equal(await fs.readFile(path.join(first,'keep'),'utf8'),'first');assert.equal(await fs.readFile(path.join(second,'keep'),'utf8'),'newer');
 const next=await f.cleanup.deletePreview({paths:[first]});f.setProcesses({complete:true,processes:[{pid:123,label:'Dev server',cwd:first,ports:[3000]}]});await assert.rejects(f.cleanup.remove({token:next.token,confirmName:next.confirmName}),{code:'stale'});assert.equal(await fs.readFile(path.join(first,'keep'),'utf8'),'first');
});
test('project delete review reports local-only commits and modified files without fetching a remote',async t=>{
 const f=await setup(t),project=path.join(f.workspace,'repo');await fs.mkdir(project);await f.git.command(project,['init','-q']);await fs.writeFile(path.join(project,'README.md'),'first');await f.git.command(project,['add','README.md']);await f.git.command(project,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Local commit']);await fs.writeFile(path.join(project,'README.md'),'modified');
 const preview=await f.cleanup.deletePreview({paths:[project]});assert.equal(preview.risks.find(row=>row.kind==='unpushed').count,1);assert.equal(preview.risks.find(row=>row.kind==='unpushed').commits[0].subject,'Local commit');assert(preview.risks.find(row=>row.kind==='uncommitted').files.some(row=>row.path==='README.md'));assert.equal(preview.confirmName,'repo');
});
