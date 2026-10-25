import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fail,inside,isSecret } from './paths.mjs';
import { treeRevision,pathsOf,pinParent,checkAbort } from './entries.mjs';
import { internalName } from './walk.mjs';

const ignored=relative=>relative.split('/').some(internalName);
export const sourceOptions=input=>({leaveOutRebuildable:input?.leaveOutRebuildable!==false,includeGit:input?.includeGit!==false,includeHidden:input?.includeHidden!==false});
export function createZipSources({policy,guard,sizes,git,rebuildable}){
  const inspect=async(input,{signal,options=sourceOptions(input.options)}={})=>{
    const paths=await Promise.all(pathsOf(input.paths).map(value=>policy.entry(value)));
    if(paths.some(value=>value==='/'||internalName(path.basename(value))))fail('invalid','Select ordinary files or folders, not the filesystem root or Files staging.');
    let parent=path.dirname(paths[0]);for(const value of paths)while(!inside(parent,value))parent=path.dirname(parent);
    const deadline=Date.now()+20_000,entries=[],roots=[],secrets=[],candidates=[],mounts=await guard.mounts.snapshot(true);let count=0;
    for(const value of paths){
      checkAbort(signal);const stat=await fs.lstat(value);
      if(stat.isDirectory()&&(!mounts.available||mounts.mounts.some(row=>row.path!==value&&inside(value,row.path))))fail('invalid','This selection includes another mounted filesystem. Download that mount separately.');
      const facts=await treeRevision(value,{signal,timeoutMs:Math.max(1,deadline-Date.now()),maxEntries:200_000-count,skip:ignored,onEntry:row=>{
        if(++count>200_000)fail('too-large','Download up to 200,000 entries at a time. Choose a smaller folder.');
        if(!row.stat.isFile()&&!row.stat.isDirectory()&&!row.stat.isSymbolicLink())fail('invalid','Special files cannot be archived here.');
        const name=path.relative(parent,row.path),kind=row.stat.isSymbolicLink()?'link':row.stat.isDirectory()?'folder':'file';
        entries.push({path:row.path,name,kind,bytes:Number(row.stat.size)});
        if(secrets.length<20&&(isSecret(path.basename(row.path))||inside(path.join(policy.home,'.ssh'),row.path)))secrets.push(name);
      }});
      const rule=await policy.classify(value),relative=path.relative(parent,value);if((rule.signIns.length||rule.keys)&&!secrets.includes(relative))secrets.push(relative);roots.push({path:value,revision:facts.revision,entries:facts.entries});
      if(stat.isDirectory()){
        const listed=entries.filter(row=>row.kind==='folder'&&inside(value,row.path)),repo=await git.rootFor(value),analysis=await rebuildable.fresh(value,repo,listed);
        candidates.push(...analysis.candidates);
      }
    }
    const excludedRoots=new Set(candidates.map(row=>row.path)),excluded=value=>{while(inside(parent,value)&&value!==parent){if(excludedRoots.has(value))return true;value=path.dirname(value);}return false;};
    const hidden=row=>row.name.split('/').some(part=>part.startsWith('.')&&part!=='.git');
    const common=row=>!(options.leaveOutRebuildable&&excluded(row.path))&&(options.includeGit||!row.name.split('/').includes('.git'));
    const choose=row=>common(row)&&(options.includeHidden||!hidden(row));
    const selected=entries.filter(choose);if(!selected.length)fail('invalid','These options leave no files to archive. Include hidden files or select another folder.');
    const rawBytes=selected.reduce((sum,row)=>sum+(row.kind==='folder'?0:row.bytes),0),excludedBytes=candidates.reduce((sum,row)=>sum+(row.bytes||0),0),gitBytes=entries.filter(row=>row.name.split('/').includes('.git')&&row.kind!=='folder').reduce((sum,row)=>sum+row.bytes,0),hiddenBytes=entries.filter(common).filter(hidden).reduce((sum,row)=>sum+(row.kind==='folder'?0:row.bytes),0),selectedNames=new Set(selected.map(row=>row.name)),activeSecrets=secrets.filter(name=>selectedNames.has(name));
    return {paths,parent,roots,entries:selected,rawBytes,count:selected.length,secrets:activeSecrets,options,name:paths.length===1?path.basename(paths[0])+'.zip':'Files.zip',estimate:{bytes:rawBytes,files:selected.length},offered:{leaveOutRebuildable:{default:options.leaveOutRebuildable,bytes:excludedBytes,folders:candidates.slice(0,100).map(row=>path.relative(parent,row.path))},includeGit:{default:options.includeGit,bytes:gitBytes},includeHidden:{default:options.includeHidden,bytes:hiddenBytes,secrets:activeSecrets}}};
  };
  const verify=async(saved,options=saved.options)=>{
    const current=await inspect({paths:saved.paths},{options});
    if(JSON.stringify(current.roots)!==JSON.stringify(saved.roots))fail('stale','These files changed after the ZIP review. Review the current files again.');return current;
  };
  return {inspect,verify};
}

/** No shell, no ambient ZIPOPT, no recursion/wildcards controlled by filenames.
 * Inventory supplies exact entries. Newline/CR names use argv; the rest stream
 * through -@, avoiding ARG_MAX without losing Linux filename semantics. */
export async function zipProcess(source,{file,signal,onData,progress=()=>{},timeoutMs=20*60_000}={}){
  const pin=await pinParent(path.join(source.parent,'.files-zip-cwd')),forChild=value=>value.replace(/^\/proc\/self\/fd\//,`/proc/${process.pid}/fd/`),ordinary=[],odd=[];
  for(const row of source.entries){const name='./'+row.name+(row.kind==='folder'?'/':'');(/\r|\n/.test(name)?odd:ordinary).push(name);}
  if(odd.reduce((sum,value)=>sum+Buffer.byteLength(value)+1,0)>120_000){await pin.close();fail('too-large','Too many names contain line breaks. Archive smaller groups.');}
  const args=[...(file?['-dc']:['-q']),'-y','-nw','-UN=UTF8','-@',file?forChild(file):'-','--',...odd];
  let child,timer,stderr='',completed=false,received=0,output='';
  const terminate=signal=>{if(child?.pid)try{process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
  try{
    checkAbort(signal);
    child=spawn('/usr/bin/timeout',['--signal=TERM','--kill-after=5s','20m','/usr/bin/zip',...args],{cwd:`/proc/${process.pid}/fd/${pin.handle.fd}`,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},detached:true,stdio:['pipe','pipe','pipe']});
    const abort=()=>terminate('SIGTERM');signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,timeoutMs);timer.unref();
    const result=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,termination)=>code===0?resolve():reject(Object.assign(new Error(termination?'ZIP processing was interrupted.':'The ZIP tool could not read every file. The originals were kept.'),{code:'archive-failed'})));});result.catch(()=>{});
    child.stdin.on('error',()=>{});Readable.from(ordinary.map(value=>value+'\n')).pipe(child.stdin);
    child.stderr.on('data',chunk=>{if(stderr.length<65536)stderr+=chunk.toString();});
    try{
      for await(const chunk of child.stdout){
        checkAbort(signal);
        if(file){output=(output+chunk.toString()).slice(-8192);const matches=[...output.matchAll(/(?:^|\n)\s*(\d+)\/\s*(\d+)/g)];const last=matches.at(-1);if(last)progress({done:Number(last[1]),total:source.count,unit:'files'});}
        else{received+=chunk.length;await onData(chunk);progress({bytes:received,done:received,total:null,unit:'bytes'});}
      }
      await result;completed=true;
    }finally{signal?.removeEventListener('abort',abort);}
    return {bytes:received};
  }finally{clearTimeout(timer);if(child&&!completed)terminate('SIGKILL');await pin.close();}
}
