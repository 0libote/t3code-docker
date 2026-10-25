import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fail,inside,normalizePath,validateName } from './paths.mjs';
import { maybeStat,identity,renameExclusive,uniqueName,checkAbort } from './entries.mjs';
import { inspectZip,extractEntries } from './zip-format.mjs';
import { createZipSources,zipProcess } from './zip-sources.mjs';
import { statRevision } from './text.mjs';
import { createLimiter } from './io.mjs';

const RESERVE=1024**3,free=async value=>{const facts=await fs.statfs(value);return Number(facts.bavail)*Number(facts.bsize);};
export function createArchives({policy,guard,sizes,git,rebuildable,reviews,jobs,trash,recordEvent=()=>{},space=free}){
  const sources=createZipSources({policy,guard,sizes,git,rebuildable}),previews=createLimiter(2,8),metadata=new Map();const downloads=new Map();let streams=0,preparing=0;
  const zipInfo=async value=>{const key=await fs.realpath(value),revision=statRevision(await fs.lstat(key,{bigint:true})),prior=metadata.get(key);if(prior?.revision===revision)return prior;const info=await inspectZip(value);let count=[...metadata.values()].reduce((sum,row)=>sum+row.entries.length,0);while(metadata.size&&(metadata.size>=8||count+info.entries.length>250_000)){const first=metadata.keys().next().value;count-=metadata.get(first).entries.length;metadata.delete(first);}metadata.set(key,info);return info;};
  const fits=async(dest,bytes)=>{const available=await space(dest);if(bytes>available-RESERVE)fail('no-space','This archive won’t fit while keeping 1 GiB free. Free space or choose a smaller archive.',{requiredBytes:bytes,availableBytes:available,reserveBytes:RESERVE});return available;};
  const publicZip=(source,token)=>({ok:true,...token,name:source.name,estimate:source.estimate,options:source.offered,selectedOptions:source.options,secrets:source.secrets});
  const zipPreview=input=>previews(async()=>{const source=await sources.inspect(input);return publicZip(source,reviews.issue('zip',{paths:source.paths,roots:source.roots,options:source.options,name:source.name}));});
  const zip=async input=>{
    const prepared=downloads.get(input.token);if(prepared){downloads.delete(input.token);clearTimeout(prepared.timer);return prepared.response;}
    if(streams>=2)fail('busy','Two ZIP downloads are already running. Wait for one to finish.');streams++;let released=false;
    const release=()=>{if(!released){released=true;streams--;}};
    try{
      const saved=reviews.peek(input.token,'zip'),options={...saved.options};
      for(const [key,value]of Object.entries(input.options||{}))if(['includeGit','includeHidden'].includes(key)){if(value&&!saved.options[key])fail('stale','Review these ZIP options before adding more files.');options[key]=value;}else if(key==='leaveOutRebuildable'){if(!value&&saved.options[key])fail('stale','Review before including rebuildable folders.');options[key]=value;}
      const source=await sources.verify(saved,options);reviews.consume(input.token,'zip');
      const stream=new PassThrough({highWaterMark:64*1024});let complete=false,id;
      id=jobs.add('zip','Download '+saved.name,async({signal,progress})=>{
        try{await zipProcess(source,{signal,progress,onData:async chunk=>{if(!stream.write(chunk))await once(stream,'drain',{signal});}});await sources.verify(saved,options);complete=true;stream.end();return {name:saved.name,bytes:source.rawBytes};}
        catch(error){stream.destroy(error);throw error;}finally{release();}
      },{paths:source.paths});
      stream.on('error',()=>{});stream.once('close',()=>{if(!complete){try{jobs.cancel(id);}catch{}release();}});
      return {raw:true,status:200,stream,job:id,headers:{'content-type':'application/zip','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(saved.name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16)),'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"sandbox; default-src 'none'"}};
    }catch(error){release();throw error;}
  };
  // The UI validates via POST before handing a native download to the browser.
  // Only two prepared, backpressured streams can wait, for at most 30 seconds.
  const zipStart=async input=>{
    if(downloads.size+preparing>=2)fail('busy','Two downloads are preparing. Start one before preparing another.');preparing++;
    try{const response=await zip(input),token=randomBytes(32).toString('hex');
      const timer=setTimeout(()=>{downloads.delete(token);response.stream.destroy(new Error('This download was not started. Prepare the ZIP again.'));},30_000);timer.unref();downloads.set(token,{response,timer});return {ok:true,token,job:response.job};
    }finally{preparing--;}
  };
  const preflight=(input,specs)=>guard.run({...input,stopT3:false},specs.map(row=>input.stopT3?{...row,inUse:false}:row),async()=>{},{notify:false});
  const compress=async input=>{
    const source=await previews(()=>sources.inspect({...input,options:{leaveOutRebuildable:false,includeGit:true,includeHidden:true}}));
    const parent=source.parent,name=validateName(input.name||source.name),base=name.endsWith('.zip')?name:name+'.zip',target=path.join(parent,await uniqueName(parent,base));
    await preflight(input,[{path:target,mode:'write',missing:true}]);await fits(parent,source.rawBytes+source.count*256);
    const job=jobs.add('compress','Compress '+base,async({signal,progress,stage})=>{
      const lease=await stage(parent,'zip'),file=lease.payload+'.zip';let timer,stopped=false;
      const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
      try{
        await sources.verify({paths:source.paths,roots:source.roots,options:source.options},source.options);
        let checking=false;timer=setInterval(()=>{if(checking)return;checking=true;void Promise.all([space(parent),maybeStat(file)]).then(([available,stat])=>{if(available<RESERVE||stat&&Number(stat.size)>source.rawBytes*1.1+source.count*1024+65536){stopped=true;controller.abort();}},()=>{stopped=true;controller.abort();}).finally(()=>{checking=false;});},2000);timer.unref();
        await zipProcess(source,{file,signal:combined,progress});checkAbort(signal);if(stopped)fail('no-space','Compression stopped before using the disk’s remaining space. Staged output was removed.');
        const synced=await fs.open(file,'r+');try{await synced.sync();}finally{await synced.close();}
        await sources.verify({paths:source.paths,roots:source.roots,options:source.options},source.options);await fits(parent,0);
        return await guard.run(input,[{path:target,mode:'write',missing:true}],async([row],verify)=>{if(row.stat)fail('stale','The archive name is now taken. Choose another name.');await sources.verify({paths:source.paths,roots:source.roots,options:source.options},source.options);await verify();progress({cancellable:false,phase:'finishing'});await renameExclusive(file,row.pin.pinned);return {ok:true,path:row.path};});
      }finally{clearInterval(timer);await lease.dispose();}
    },{paths:source.paths,dest:parent});return {ok:true,job};
  };
  const extractionFacts=async(input)=>{
    const deadline=Date.now()+20_000;
    const archive=await policy.entry(normalizePath(input.path)),dest=await fs.realpath(normalizePath(input.dest||path.dirname(archive))),info=await zipInfo(archive),parentStat=await fs.lstat(dest,{bigint:true});
    if(!parentStat.isDirectory())fail('invalid','Choose a destination folder.');const topLevel=[...new Set(info.entries.map(row=>row.name.split('/')[0]))];
    const collisions=[];for(const name of topLevel.slice(0,500)){if(Date.now()>deadline)fail('too-large','This ZIP takes too long to review here. Extract a smaller archive.');const stat=await maybeStat(path.join(dest,name));if(stat)collisions.push({name,existing:{revision:statRevision(stat),bytes:Number(stat.size),kind:stat.isDirectory()?'folder':stat.isSymbolicLink()?'link':'file',modified:new Date(Number(stat.mtimeMs)).toISOString()}});}
    const suggested=path.basename(archive).replace(/\.zip$/i,'')||'Extracted files',suggestedFolder=await uniqueName(dest,suggested),available=await space(dest);
    return {archive,dest,info,topLevel,collisions,suggestedFolder,available,parentIdentity:identity(parentStat)};
  };
  const extractPreview=input=>previews(async()=>{
    const facts=await extractionFacts(input),{info}=facts;
    const topKinds=new Map(facts.topLevel.slice(0,100).map(name=>[name,'folder']));for(const entry of info.entries)if(topKinds.has(entry.name))topKinds.set(entry.name,entry.kind);
    return {ok:true,...reviews.issue('extract',{archive:facts.archive,dest:facts.dest,revision:info.revision,parentIdentity:facts.parentIdentity,collisions:facts.collisions}),path:facts.archive,dest:facts.dest,bytes:info.bytes,uncompressedBytes:info.total,entries:info.entries.length,freeBytes:facts.available,reserveBytes:RESERVE,canExtract:info.total<=facts.available-RESERVE&&info.entries.length>0,canExtractHere:facts.topLevel.length<=500,topLevel:facts.topLevel.slice(0,100),topLevelEntries:[...topKinds].map(([name,kind])=>({name,kind})),topLevelCount:facts.topLevel.length,suggestedFolder:facts.suggestedFolder,collisionsHere:facts.collisions.length,collisions:facts.collisions,skipped:info.skipped.slice(0,100),skippedCount:info.skipped.length};
  });
  const extract=async input=>{
    const saved=reviews.peek(input.token,'extract'),facts=await previews(()=>extractionFacts({path:saved.archive,dest:saved.dest})),into=input.into||'new';
    if(!['new','here'].includes(into))fail('invalid','Extract into a new folder or here.');
    if(into==='here'&&facts.topLevel.length>500)fail('too-large','Extract into a new folder when a ZIP has more than 500 top-level items.');
    if(facts.info.revision!==saved.revision||facts.parentIdentity!==saved.parentIdentity||JSON.stringify(facts.collisions)!==JSON.stringify(saved.collisions))fail('stale','The archive or destination changed. Review extraction again.');
    await fits(saved.dest,facts.info.total);if(!facts.info.entries.length)fail('invalid','There are no safe entries to extract in this ZIP.');
    const target=into==='new'?path.join(saved.dest,validateName(input.name||facts.suggestedFolder)):null,plans=[],taken=new Set();
    if(target&&await maybeStat(target))fail('exists','That folder already exists. Choose another name.');
    for(const name of into==='here'?facts.topLevel:[]){
      const existing=saved.collisions.find(row=>row.name===name),choice=existing?input.choices?.[name]||'ask':'keep-both';
      if(!['ask','replace','keep-both','skip'].includes(choice))fail('invalid','Choose Replace, Keep both or Skip for each name.');
      if(into==='here'&&existing&&choice==='ask')fail('conflicts','Choose what to keep at the destination.',{conflicts:saved.collisions});
      if(into==='here'&&choice==='skip')continue;
      const output=into==='here'?path.join(saved.dest,existing&&choice==='keep-both'||taken.has(name)?await uniqueName(saved.dest,name,{reserved:taken}):name):target;
      taken.add(path.basename(output));if(into==='here'&&inside(output,(await policy.classify(saved.archive)).target))fail('invalid','A ZIP cannot replace itself or its containing folder. Extract into a new folder instead.');
      plans.push({name,to:output,existing:existing&&choice==='replace'?existing.existing.revision:null});
    }
    if(into==='here'&&facts.info.entries.some(row=>row.kind==='link')&&(plans.length!==facts.topLevel.length||plans.some(row=>path.basename(row.to)!==row.name)))fail('invalid','Extract into a new folder to keep this ZIP’s links together when names are skipped or kept separately.');
    const specs=into==='new'?[{path:target,mode:'write',missing:true}]:plans.map(row=>({path:row.to,mode:row.existing?'remove':'write',missing:true}));
    if(input.trashArchive)specs.push({path:saved.archive,mode:'remove'});
    await preflight(input,specs);reviews.consume(input.token,'extract');
    const job=jobs.add('extract','Extract '+path.basename(saved.archive),async({signal,progress,stage})=>{
      const lease=await stage(saved.dest,'extract');let published=false;const replacements=[];
      try{
        await extractEntries(saved.archive,facts.info,lease.payload,{signal,progress,reserveCheck:()=>fits(saved.dest,0)});checkAbort(signal);
        return await guard.run(input,specs,async(rows,verify)=>{
          if(statRevision(await fs.stat(saved.archive,{bigint:true}))!==saved.revision)fail('stale','The original ZIP changed before publication. It was kept; review extraction again.');
          const parent=await fs.lstat(saved.dest,{bigint:true});if(identity(parent)!==saved.parentIdentity)fail('stale','The destination folder changed. Review extraction again.');
          if(into==='new'&&rows[0].stat)fail('stale','The destination name is now taken.');
          if(into==='here')for(let index=0;index<plans.length;index++){const row=rows[index],plan=plans[index];if((row.stat?statRevision(row.stat):null)!==plan.existing)fail('stale','A destination item changed. Review extraction again.');}
          await verify();progress({cancellable:false,phase:'finishing'});const paths=[];
          if(into==='new'){await renameExclusive(lease.payload,rows[0].pin.pinned);paths.push(target);published=true;}
          else for(let index=0;index<plans.length;index++){const row=rows[index],plan=plans[index];if(row.stat)replacements.push(await trash.stash(row,{reason:'replaced'}));await renameExclusive(path.join(lease.payload,plan.name),row.pin.pinned);paths.push(row.path);published=true;progress({publishedPaths:[...paths]});}
          if(input.trashArchive)await trash.stash(rows.at(-1),{reason:'extracted archive'});
          recordEvent('files.extracted','Extracted '+path.basename(saved.archive));return {ok:true,path:into==='new'?target:saved.dest,paths,skipped:facts.info.skipped.length};
        });
      }catch(error){if(!published)for(const row of replacements)await trash.rollback(row).catch(()=>{});else error.message+=' Completed files were kept. Check the destination before retrying.';throw error;}
      finally{await lease.dispose();}
    },{paths:[saved.archive],dest:target||saved.dest});return {ok:true,job};
  };
  return {zipPreview,zipStart,zip,compress,extractPreview,extract,sources};
}
