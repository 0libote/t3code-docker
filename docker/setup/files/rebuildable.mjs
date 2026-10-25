import path from 'node:path';
import { promises as fs } from 'node:fs';
import rules from './rebuildable-folders.json' with { type: 'json' };
import { inside, glob } from './paths.mjs';
import { mapLimit, createLimiter } from './io.mjs';
import { createMountService } from './mounts.mjs';

// Both the inventory and native probes are bounded. In particular, Projects
// may contain many independent repositories; every candidate uses its nearest
// repository, never the workspace's lack of a .git directory as a safety proof.
export function createRebuildableService({ sizes, git, workspace='/workspace', mounts=createMountService(), now=Date.now }={}) {
  const cache=new Map(),limit=createLimiter(2),matches=new Map();
  for(const rule of rules.rules){const values=matches.get(rule.name)||[];values.push(rule);matches.set(rule.name,values);}
  const regular=async value=>fs.lstat(value).then(stat=>stat.isFile()&&!stat.isSymbolicLink(),()=>false);
  const markerFor=async(candidate,rule,boundary)=>{
    const directory=rule.parent?path.dirname(path.dirname(candidate)):path.dirname(candidate);
    for(const marker of rule.marker||[]){
      if(marker.endsWith(' (inside)')){if(await regular(path.join(candidate,marker.slice(0,-9))))return true;continue;}
      const pattern=marker.split(' ')[0],test=new RegExp(glob(pattern).source,'u');let current=directory;
      do{
        if(!/[*?]/.test(pattern)){if(await regular(path.join(current,pattern)))return true;}
        else{
          let stream;
          try{stream=await fs.opendir(current);let seen=0;for await(const entry of stream){if(++seen>20_000)break;if(test.test(entry.name)&&(entry.isFile()||pattern.endsWith('.xcodeproj')&&entry.isDirectory()))return true;}}
          catch{/* A marker that cannot be read is never proof that a folder is rebuildable. */}
          finally{await stream?.close().catch(()=>{});}
        }
        if(!marker.includes('above')||current===boundary)break;
        current=path.dirname(current);
      }while(inside(boundary,current));
    }
    return false;
  };
  const probe=async(root,rows)=>{
    const ignored=new Set(),tracked=new Set();
    try{
      const [ignore,files]=await Promise.all([
        git.command(root,['check-ignore','--stdin','-z','-v','-n'],rows.map(row=>path.relative(root,row.path)).join('\0')+'\0').catch(error=>{if(error.code===1)return {stdout:error.stdout};throw error;}),
        git.command(root,['ls-files','-z','--']),
      ]);
      const fields=ignore.stdout.split('\0');
      for(let i=0;i+3<fields.length;i+=4)if(fields[i+2]&&!fields[i+2].startsWith('!'))ignored.add(path.resolve(root,fields[i+3]));
      const paths=new Set(rows.map(row=>row.path));
      for(const name of files.stdout.split('\0').filter(Boolean)){
        let current=path.resolve(root,name);
        while(inside(root,current)){if(paths.has(current))tracked.add(current);const parent=path.dirname(current);if(parent===current)break;current=parent;}
      }
      return {available:true,ignored,tracked};
    }catch{return {available:false,ignored,tracked};}
  };
  const inspect=async(boundary,root,listed)=>{
    const known=new Set([...(sizes.under?sizes.under(boundary).map(([file])=>file):sizes.entries().keys()),...listed.filter(row=>row.kind==='folder').map(row=>row.path)]);
    const potential=[...known].filter(value=>value!==boundary&&inside(boundary,value)&&matches.has(path.basename(value))&&!path.relative(boundary,value).split(path.sep).includes('.git'));
    const mountFacts=await mounts.snapshot(),mountPoints=new Set(mountFacts.mounts.map(row=>row.path)),roots=new Map();
    const rootFor=value=>{if(!roots.has(value))roots.set(value,git.rootFor(value));return roots.get(value);};
    let partial=potential.length>2000;
    const facts=await mapLimit(potential.slice(0,2000),8,async value=>{
      const [stat,parent]=await Promise.all([fs.lstat(value).catch(()=>null),fs.lstat(path.dirname(value)).catch(()=>null)]);
      if(!stat){partial=true;return null;}
      if(!stat.isDirectory()||stat.isSymbolicLink())return null;
      const common={path:value,bytes:sizes.facts(value,stat)?.bytes??null};
      if(!mountFacts.available)return {...common,reason:'Mount boundaries could not be checked.'};
      if(stat.dev!==parent?.dev||mountPoints.has(value))return {...common,reason:'This folder is a mount point.'};
      if(await fs.realpath(value).catch(()=>null)!==value){partial=true;return {...common,reason:'This folder’s location changed. Measure it again.'};}
      if(await git.hasMarker(value))return {...common,reason:'This folder contains its own Git repository.'};
      const repo=await rootFor(path.dirname(value));
      if(path.dirname(value)===workspace&&repo!==workspace)return {...common,reason:'Project folders are kept.'};
      const choices=matches.get(path.basename(value)).filter(item=>!item.parent||path.basename(path.dirname(value))===item.parent);
      let rule;for(const choice of choices)if(await markerFor(value,choice,boundary)){rule=choice;break;}
      if(!rule&&!repo)return {...common,reason:'No matching project marker was found.'};
      rule||=choices[0];if(!rule)return null;
      let recreate=rule.recreate;
      if(recreate.includes('{pm}')){
        let pm=rules.packageManager.fallback;
        for(const item of rules.packageManager.order)if(await regular(path.join(path.dirname(value),item.file))){pm=item.pm;break;}
        recreate=recreate.replace('{pm}',pm);
      }
      return {...common,recreate,group:rule.group,repo};
    });
    const rows=facts.filter(Boolean).sort((a,b)=>a.path.length-b.path.length),groups=new Map();
    for(const row of rows)if(row.repo&&!row.reason){const group=groups.get(row.repo)||[];group.push(row);groups.set(row.repo,group);}
    const checks=new Map(await mapLimit([...groups],2,async([repo,rows])=>[repo,await probe(repo,rows)]));
    const candidates=[],kept=[];
    for(const row of rows){
      if(candidates.some(outer=>inside(outer.path,row.path)))continue;
      const {repo,...item}=row;
      if(item.reason){kept.push(item);continue;}
      const check=repo?checks.get(repo):null;
      if(repo&&(!check?.available||check.tracked.has(row.path)||!check.ignored.has(row.path))){
        kept.push({...item,reason:!check?.available?'Git status unavailable; kept for safety.':check.tracked.has(row.path)?'Git tracks it, so it’s treated as source, not build output.':'Git does not ignore it.'});continue;
      }
      candidates.push(item);
    }
    return {loading:false,candidates,kept,partial};
  };
  const get=(boundary,root,listed=[])=>{
    let row=cache.get(boundary);
    if(!row){if(cache.size>=128){const key=[...cache].find(([,item])=>!item.pending)?.[0];if(key)cache.delete(key);else return {loading:false,candidates:[],kept:[],partial:true};}
      row={value:{loading:true,candidates:[],kept:[]},at:0,pending:null};cache.set(boundary,row);}
    if(!row.pending&&(!row.at||now()-row.at>=15_000))row.pending=limit(()=>inspect(boundary,root,listed)).then(value=>{row.value=value;},()=>{row.value={loading:false,candidates:[],kept:[],partial:true};}).finally(()=>{row.at=now();row.pending=null;});
    return row.value;
  };
  return {get,fresh:(boundary,root,listed=[])=>limit(()=>inspect(boundary,root,listed)),settled:async(boundary,root,listed=[])=>{const fallback=get(boundary,root,listed);await cache.get(boundary)?.pending;return cache.get(boundary)?.value||fallback;},invalidate:()=>cache.clear()};
}
