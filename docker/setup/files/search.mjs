import path from 'node:path';
import { promises as fs } from 'node:fs';
import { walk } from './walk.mjs';
import { directoryEntries } from './listing.mjs';
import { glob, fail } from './paths.mjs';
import { kindOf } from './kinds.mjs';
export function createSearchService({ policy, sizes, git, rebuildable: rebuildableService, now=Date.now }={}) {
  let active=0;
  const largestCache=new Map(), pending=new Map();
  const bounded=async work=>{
    if(active>=2)fail('busy','Two searches are already running. Try again when one finishes.');
    active++;try{return await work();}finally{active--;}
  };
  const search=async(value,{q='',kind='',size='',modified='',rebuildable=false}={})=>{
    if(typeof q!=='string'||q.length>256)fail('invalid','Use a search of up to 256 characters.');
    const absolute=await fs.realpath(value), query=q.toLocaleLowerCase(), wildcard=/[*?]/.test(q)?glob(q):null;
    let truncated=false,skippedRebuildable=0;const results=[]; const controller=new AbortController();
    const minimum=size?Number(size):0;
    if(size&&(!Number.isFinite(minimum)||minimum<0))fail('invalid','Use a size in bytes.');
    const since=modified?Date.parse(modified):null;if(modified&&!Number.isFinite(since))fail('invalid','Use a valid modification date.');
    const omitted=new Set(rebuildableService?.get(absolute,await git?.rootFor(absolute))?.candidates.map(row=>row.path)||[]);
    const facts=await bounded(()=>walk(absolute,{timeoutMs:3000,maxEntries:50_000,signal:controller.signal,
      skip:file=>{
        const name=path.basename(file),skip=!rebuildable&&(name==='.git'||omitted.has(file));
        if(skip)skippedRebuildable++;return skip;
      },
      visit:({path:file,stat})=>{
        if(file===absolute)return;
        const name=path.basename(file),index=name.toLocaleLowerCase().indexOf(query),category=kindOf(name,stat),bytes=stat.isDirectory()?sizes.facts(file,stat)?.bytes??null:Number(stat.size);
        if((wildcard?!wildcard.test(name):index<0)||kind&&kind!==category||(minimum>0&&(bytes===null||bytes<minimum))||since!==null&&stat.mtimeMs<since)return;
        if(results.length>=200){truncated=true;controller.abort();return;}
        results.push({name,path:file,relativeFolder:path.relative(absolute,path.dirname(file))||'.',kind:category,
          bytes,modified:stat.mtime.toISOString(),match:query&&!wildcard?[[index,index+q.length]]:[]});
      }}));
    return {ok:true,path:absolute,results,searched:facts.entries,skippedRebuildable,skippedUnit:'folders',truncated:truncated||facts.partial,
      partial:facts.unreadable>0,invalidNames:facts.invalidNames};
  };
  const suggest=async q=>{
    if(typeof q!=='string'||q.length>4096)fail('invalid','Enter an absolute folder path.');
    const expanded=q==='~'?policy.home:q.startsWith('~/')?path.join(policy.home,q.slice(2)):q;
    if(!path.isAbsolute(expanded))return {ok:true,base:null,matches:[]};
    const base=q.endsWith('/')?expanded:path.dirname(expanded),prefix=q.endsWith('/')?'':path.basename(expanded).toLocaleLowerCase();
    const resolved=await fs.realpath(base);
    const {rows,overflow}=await directoryEntries(resolved);
    const folders=rows.filter(row=>row.name.toLocaleLowerCase().startsWith(prefix)&&(row.stat?.isDirectory()||row.stat?.isSymbolicLink())).sort((a,b)=>a.name.localeCompare(b.name));
    const matches=[];
    for(const row of folders){
      if(matches.length>=20)break;
      if(!await fs.stat(row.path).then(stat=>stat.isDirectory(),()=>false))continue;
      matches.push({path:row.path,display:policy.display(row.path)+'/',bytes:sizes.facts(row.path)?.bytes??null,tags:(await policy.classify(row.path)).tags});
    }
    return {ok:true,base:resolved,matches,truncated:overflow||folders.length>20};
  };
  const largest=async value=>{
    const absolute=await fs.realpath(value),stat=await fs.lstat(absolute);
    const revision=[stat.dev,stat.ino,stat.mtimeMs,sizes.facts(absolute)?.at].join(':');
    const cached=largestCache.get(absolute);if(cached?.revision===revision&&now()-cached.at<60_000)return cached.value;
    if(pending.has(absolute))return pending.get(absolute);
    const request=bounded(async()=>{
    const files=[];
    const result=await walk(absolute,{timeoutMs:30_000,visit:({path:file,stat})=>{
      if(!stat.isFile())return;
      files.push({path:path.relative(absolute,file),absolute:file,bytes:Number(stat.size),part:path.relative(absolute,file).split('/').includes('.git')?'git':'kept'});
      files.sort((a,b)=>b.bytes-a.bytes);if(files.length>20)files.pop();
    }});
    const value={ok:true,path:absolute,files,truncated:result.partial};
    if(largestCache.size>=64)largestCache.delete(largestCache.keys().next().value);
    largestCache.set(absolute,{revision,at:now(),value});return value;
    }).finally(()=>pending.delete(absolute));
    pending.set(absolute,request);return request;
  };
  return {search,suggest,largest};
}
