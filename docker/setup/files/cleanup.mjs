import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail,inside,normalizePath } from './paths.mjs';
import { pathsOf,treeRevision,identity,renameExclusive,checkAbort } from './entries.mjs';
import { statRevision } from './text.mjs';
import { directoryEntries } from './listing.mjs';
import { createLimiter,mapLimit } from './io.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const displayBytes=value=>{const unit=value>=1e9?'GB':value>=1e6?'MB':value>=1e3?'KB':'B',scale={GB:1e9,MB:1e6,KB:1e3,B:1}[unit];return new Intl.NumberFormat('en',{maximumFractionDigits:1}).format(value/scale)+' '+unit;};
const users=(facts,value,parent=false)=>facts.processes.filter(row=>row.cwd&&inside(parent?path.dirname(value):value,row.cwd)||row.openFiles?.some(file=>inside(value,file))).map(({openFiles,...row})=>({...row,...(row.ports?.length?{port:row.ports[0]}:{})})).sort((a,b)=>a.pid-b.pid);
export function createCleanup({policy,guard,sizes,git,rebuildable,activity,threads,reviews,jobs,trash,recordEvent=()=>{}}){
  const previews=createLimiter(2,8);
  const preflight=(input,specs)=>guard.run({...input,stopT3:false},specs.map(row=>input.stopT3?{...row,inUse:false}:row),async()=>{},{notify:false});
  const forbidden=async value=>{
    await policy.refresh(true);const rule=await policy.classify(value),roots=await policy.managedRoots();
    if(rule.path==='/'||rule.path===policy.workspace||rule.path===policy.home||inside(rule.path,policy.stateDir)||roots.some(root=>root.root===rule.path))fail('locked','This root cannot be deleted permanently in Files. Use Storage for managed roots, or select a child item.');
    return rule;
  };
  const cleanFacts=async input=>{
    const root=await fs.realpath(normalizePath(input.path||policy.workspace));await policy.refresh(true);
    const workspaceIsRepo=root===policy.workspace&&await git.hasMarker(root),children=await directoryEntries(root),projects=root===policy.workspace&&!workspaceIsRepo?children.rows.filter(row=>row.stat?.isDirectory()&&!row.name.startsWith('.')).map(row=>row.path):[root];
    if(projects.length>500)fail('too-large','Choose one project to review when a workspace has more than 500 folders.');
    let reviewed=0;const deadline=Date.now()+20_000,analyses=await mapLimit(projects,2,async project=>{
      const kept=reason=>({path:project,analysis:{partial:true,candidates:[],kept:[{path:project,reason}]}});
      if(Date.now()>deadline||reviewed>=2000)return kept('Review limit reached. Open this project to check it separately.');
      try{const listed=await directoryEntries(project),repo=await git.rootFor(project),analysis=await rebuildable.fresh(project,repo,listed.rows.map(row=>({...row,kind:row.stat?.isDirectory()?'folder':'file'})));reviewed+=analysis.candidates.length+analysis.kept.length;return {path:project,analysis};}
      catch(error){if(['EACCES','EPERM','ENOENT','missing','denied','changed','too-large'].includes(error.code))return kept('Could not read this folder completely. Kept for safety; open this project to review it separately.');throw error;}
    });
    const running=await activity.fresh(),groups=[],kept=[];let partial=false,total=0,unknown=false;
    for(const {path:project,analysis}of analyses){
      partial||=!!analysis.partial;const items=[];
      for(const row of analysis.kept)if(kept.length<2000)kept.push({...row,project:path.basename(project),path:path.relative(project,row.path)});
      for(const row of analysis.candidates){
        const rule=await policy.classify(row.path);if(rule.managed||rule.ancestor){kept.push({project:path.basename(project),path:path.relative(project,row.path),reason:'Managed files are kept. Use Storage for this location.'});continue;}
        const stat=await fs.lstat(row.path,{bigint:true}),processes=users(running,row.path,path.basename(row.path)==='.next');
        const id='c_'+hash(row.path).slice(0,24),inUse=!running.complete?{complete:false,label:'Couldn’t check what’s running'}:processes.length?{complete:true,...processes[0],processes}:null;
        items.push({id,path:path.relative(project,row.path),absolutePath:row.path,bytes:row.bytes,recreate:row.recreate,group:row.group,checked:!inUse,inUse,revision:statRevision(stat)});if(row.bytes===null)unknown=true;else total+=row.bytes;
      }
      if(items.length)groups.push({name:path.basename(project),path:project,bytes:items.every(row=>row.bytes!==null)?items.reduce((sum,row)=>sum+row.bytes,0):null,items});
    }
    const signature=hash({groups,kept,partial});return {root,projects:groups,kept,bytes:unknown?null:total,partial,signature};
  };
  const cleanPreview=input=>previews(async()=>{const facts=await cleanFacts(input);return {ok:true,...reviews.issue('clean',{root:facts.root,signature:facts.signature}),...facts,signature:undefined,root:facts.root};});
  const clean=async input=>{
    const saved=reviews.peek(input.token,'clean'),current=await previews(()=>cleanFacts({path:saved.root}));
    if(current.signature!==saved.signature)fail('stale','The folders, Git checks or running processes changed. Review Free up space again.');
    if(!Array.isArray(input.ids)||!input.ids.length||input.ids.length>500)fail('invalid','Choose between 1 and 500 rebuildable folders.');
    const all=current.projects.flatMap(project=>project.items.map(row=>({...row,project:project.path}))),selected=[...new Set(input.ids)].map(id=>all.find(row=>row.id===id));
    if(selected.some(row=>!row))fail('stale','A selected folder is no longer rebuildable. Review it again.');
    if(selected.some(row=>row.inUse))fail('in-use','Stop the processes using these folders, then review them again.',{processes:selected.flatMap(row=>row.inUse?.processes||[]),complete:selected.every(row=>row.inUse?.complete!==false)});
    const specs=selected.map(row=>({path:row.absolutePath,mode:'remove'}));await preflight(input,specs);reviews.consume(input.token,'clean');
    const job=jobs.add('clean','Free up space',async({signal,progress,stage})=>{
      const fresh=await cleanFacts({path:saved.root});if(fresh.signature!==saved.signature)fail('stale','The cleanup changed while waiting. Nothing was removed; review it again.');
      return guard.run(input,specs,async(rows,verify)=>{
        for(let index=0;index<rows.length;index++)if(statRevision(rows[index].stat)!==selected[index].revision)fail('stale','A folder changed. Nothing was removed; review it again.');await verify();checkAbort(signal);progress({cancellable:false,phase:'removing',total:rows.length});let count=0,bytes=0;
        for(let index=0;index<rows.length;index++){
          const row=rows[index],lease=await stage(row.pin.parent,'copy');
          try{await renameExclusive(row.pin.pinned,lease.payload);await fs.rm(lease.payload,{recursive:true,force:false});count++;bytes+=selected[index].bytes||0;progress({done:count,total:rows.length,freedBytes:bytes,unit:'folders'});}finally{await lease.dispose();}
        }
        const projects=new Set(selected.map(row=>row.project)).size;recordEvent('files.cleaned','Freed '+displayBytes(bytes)+' in '+projects+' '+(projects===1?'project':'projects'));return {ok:true,bytes,estimated:true,projects,removed:count};
      });
    },{paths:selected.map(row=>row.absolutePath),dest:saved.root});return {ok:true,job};
  };
  const deleteFacts=async input=>{
    const paths=await Promise.all(pathsOf(input.paths).map(value=>policy.entry(value))),roots=[],risks=[],consequences=[],deadline=Date.now()+20_000;let bytes=0,count=0;
    for(const value of paths){
      if(Date.now()>deadline)fail('too-large','This selection takes too long to review. Choose fewer items.');
      const rule=await forbidden(value),stat=await fs.lstat(value,{bigint:true}),facts=await treeRevision(value,{maxEntries:200_000-count,timeoutMs:Math.max(1,deadline-Date.now())});count+=facts.entries;bytes+=stat.isDirectory()?facts.bytes:Number(stat.size);
      const project=path.dirname(value)===policy.workspace&&!path.basename(value).startsWith('.')&&stat.isDirectory();roots.push({path:value,revision:facts.revision,isProject:project});
      if(rule.signIns.length||rule.keys)consequences.push({path:value,signIns:rule.signIns,keys:rule.keys});
      if(project){const repo=await git.rootFor(value);if(repo){git.invalidate(repo);const facts=await git.settled(repo);
        if(!facts?.available)risks.push({kind:'git-unavailable',tone:'warn',path:value});
        else{
          if(facts.unpushed){const log=await git.command(repo,['log','--branches','--not','--remotes','--format=%h%x09%s','-n','20']);risks.push({kind:'unpushed',tone:'danger',path:value,count:facts.unpushed,commits:log.stdout.trimEnd().split('\n').filter(Boolean).map(line=>{const at=line.indexOf('\t');return {sha:line.slice(0,at),subject:line.slice(at+1,at+501)};})});}
          if(facts.changed)risks.push({kind:'uncommitted',tone:'danger',path:value,count:facts.changed,files:Object.entries(facts.statuses).slice(0,20).map(([path,status])=>({path,status}))});
        }
      }}
    }
    await threads.fresh?.();const running=await activity.fresh();
    for(const row of roots){const processes=users(running,row.path);if(!running.complete)risks.push({kind:'unknown-processes',tone:'warn',path:row.path});else for(const process of processes)risks.push({kind:'running',tone:'warn',path:row.path,...process});const threadsHere=threads.forPath(row.path);if(threadsHere?.count)risks.push({kind:'threads',path:row.path,count:threadsHere.count,lastActiveAt:threadsHere.lastActiveAt});}
    const projects=roots.filter(row=>row.isProject),confirmName=projects.length?(paths.length===1?path.basename(paths[0]):'DELETE '+paths.length+' ITEMS'):null;
    const trashAvailable=(await Promise.all(paths.map(value=>trash.rootFor(value).then(()=>true,()=>false)))).every(Boolean);
    return {paths,roots,bytes,risks,consequences,isProject:projects.length>0,confirmName,trashAvailable,signature:hash({roots,risks,consequences})};
  };
  const deletePreview=input=>previews(async()=>{const facts=await deleteFacts(input);return {ok:true,...reviews.issue('delete',{paths:facts.paths,signature:facts.signature,confirmName:facts.confirmName}),...facts,signature:undefined,roots:undefined};});
  const remove=async input=>{
    const saved=reviews.peek(input.token,'delete');if(saved.confirmName&&input.confirmName!==saved.confirmName)fail('invalid','Type the exact name shown in the delete review.');
    const facts=await previews(()=>deleteFacts({paths:saved.paths}));if(facts.signature!==saved.signature)fail('stale','Files, Git status or activity changed after the review. Nothing was deleted; review it again.');
    const specs=facts.paths.map(path=>({path,mode:'remove'}));await preflight(input,specs);reviews.consume(input.token,'delete');
    const job=jobs.add('delete','Delete '+(facts.paths.length===1?path.basename(facts.paths[0]):facts.paths.length+' items'),async({signal,progress,stage})=>{
      const current=await deleteFacts({paths:facts.paths});if(current.signature!==saved.signature)fail('stale','The selection changed while waiting. Nothing was deleted; review it again.');
      return guard.run(input,specs,async(rows,verify)=>{
        await verify();checkAbort(signal);progress({cancellable:false,phase:'removing',total:rows.length});let done=0;
        for(const row of rows){const lease=await stage(row.pin.parent,'copy');try{await renameExclusive(row.pin.pinned,lease.payload);await fs.rm(lease.payload,{recursive:true,force:false});done++;progress({done,total:rows.length,unit:'items'});}finally{await lease.dispose();}}
        recordEvent('files.deleted','Deleted '+(rows.length===1?path.basename(rows[0].path):rows.length+' items')+' permanently',{detail:displayBytes(facts.bytes)});return {ok:true,bytes:facts.bytes,removed:done};
      });
    },{paths:facts.paths});return {ok:true,job};
  };
  return {cleanPreview,clean,deletePreview,remove,cleanFacts,deleteFacts};
}
