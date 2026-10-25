// Files is an authenticated, terminal-equivalent view of this container. It
// never elevates privileges. Every traversal, process and preview is bounded.
import path from 'node:path';
import os from 'node:os';
import { constants, promises as fs } from 'node:fs';
import { createPathPolicy, normalizePath, inside, FilesError } from './files/paths.mjs';
import { createGitService } from './files/git.mjs';
import { createSizesService } from './files/sizes.mjs';
import { createRebuildableService } from './files/rebuildable.mjs';
import { createListingService, permissions, directoryEntries, fingerprint } from './files/listing.mjs';
import { createActivityService, createThreadFacts } from './files/activity.mjs';
import { createSearchService } from './files/search.mjs';
import { kindOf, typeOf, previewOf } from './files/kinds.mjs';
import { readText, rawFile, fileMode } from './files/text.mjs';
import { mapLimit } from './files/io.mjs';
import { createJobs } from './files/jobs.mjs';
import { createMutationGuard } from './files/guard.mjs';
import { createTrash } from './files/trash.mjs';
import { createChanges } from './files/changes.mjs';
import { createUploads } from './files/uploads.mjs';

export const FILES_POST_ROUTES=['/mkdir','/rename','/move','/to-trash','/trash/restore','/trash/empty','/write','/upload/start','/upload/chunk','/upload/finish','/upload/cancel','/jobs/cancel','/measure'].map(route=>'/files'+route);
export const FILES_ROUTES = [...FILES_POST_ROUTES,...['/places','/projects','/list','/details','/tree','/largest','/read','/raw','/search','/suggest','/trash','/jobs'].map(route=>'/files'+route)];
const STATUS={invalid:400,'no-access':403,'read-only':403,missing:404,'too-large':413,locked:423,range:416,
  exists:409,conflicts:409,stale:409,changed:409,'in-use':409,busy:409,'no-trash-here':409,'no-space':507};
export function filesFailure(error) {
  const code=error instanceof FilesError?error.code:({ENOENT:'missing',ENOTDIR:'missing',EACCES:'no-access',EPERM:'no-access',EROFS:'read-only',ENOSPC:'no-space',EDQUOT:'no-space',ELOOP:'invalid'})[error?.code]||'failed';
  const messages={missing:'This item is no longer here. Refresh the folder or open its parent.','no-access':'You can’t open this item. This console runs as t3, like agents’ terminals.',
    'read-only':'This filesystem is read-only for t3. You can look and download here.','no-space':'The disk is full. Free some space in Storage and try again.',invalid:'This path cannot be opened. Check it and try again.',failed:'This file operation could not finish. Refresh the folder and try again.'};
  return {status:STATUS[code]||500,body:{ok:false,code,error:error instanceof FilesError?error.message:messages[code],...(error instanceof FilesError?error.fields:{})}};
}
export function createFilesService({ home=os.homedir(), workspace='/workspace', stateDir, env=process.env, storage, listeners, t3, recordEvent=()=>{}, git:givenGit, activity:givenActivity, processSnapshot, now=Date.now, withStopped, maintenance=true }={}) {
  const policy=createPathPolicy({home,workspace,stateDir,env,storage});
  const git=givenGit||createGitService({env,now}), sizes=createSizesService({storage,home:policy.home,workspace:policy.workspace,now});
  const rebuildable=createRebuildableService({sizes,git,workspace:policy.workspace,now}), listing=createListingService({policy,sizes,git,rebuildable});
  const activity=givenActivity||createActivityService({env,listeners,now,snapshot:processSnapshot}), threads=createThreadFacts({t3,now});
  const search=createSearchService({policy,sizes,git,rebuildable,now});
  const capabilities={browse:true,change:true,archives:false,space:false};
  let placesCache=null,placesAt=0,placesPending=null;
  const jobs=createJobs({now,stateDir:policy.stateDir});
  const changed=async value=>{placesAt=0;placesCache=null;sizes.invalidate(value);rebuildable.invalidate();const root=await git.rootFor(path.dirname(value)).catch(()=>null);if(root)git.invalidate(root);};
  const guard=createMutationGuard({policy,activity,withStopped,changed,recordEvent});
  const trashService=createTrash({policy,guard,sizes,git,now,recordEvent});
  const changes=createChanges({policy,guard,trash:trashService,jobs,sizes,now});
  const uploads=createUploads({policy,guard,trash:trashService,now,onFinish:()=>trashService.retention()});
  const maintain=()=>Promise.allSettled([trashService.retention(),uploads.prune()]);
  let maintenanceTimer;if(maintenance){void maintain();maintenanceTimer=setInterval(()=>void maintain(),60*60_000);maintenanceTimer.unref();}

  const composition=async(root,bytes,repo)=>{
    const analysis=rebuildable.get(root,repo);
    if(bytes===null||sizes.facts(root)?.partial||analysis.loading||analysis.partial||analysis.candidates.some(row=>row.bytes===null))return null;
    const directories=sizes.under(root).filter(([file])=>path.basename(file)==='.git').sort(([a],[b])=>a.length-b.length),histories=[];
    for(const [file,size]of directories)if(!histories.some(row=>inside(row.path,file)))histories.push({path:file,bytes:size});
    // Worktree .git files point to history elsewhere; that history is not
    // allocated in this folder. A real unmeasured .git directory stays unknown.
    if(repo===root){const marker=await fs.lstat(path.join(root,'.git')).catch(()=>null);if(marker?.isDirectory()&&sizes.facts(path.join(root,'.git'))?.bytes===undefined)return null;}
    const gitBytes=histories.reduce((sum,row)=>sum+row.bytes,0),rebuildableBytes=analysis.candidates.reduce((sum,row)=>sum+row.bytes,0);
    if(rebuildableBytes+gitBytes>bytes)return null;
    return {keptBytes:bytes-gitBytes-rebuildableBytes,gitBytes,rebuildableBytes};
  };
  const projectRows=async()=>{
    let source;
    const workspaceIsRepo=await git.hasMarker(policy.workspace);
    if(workspaceIsRepo){ const stat=await fs.lstat(policy.workspace);source=[{name:path.basename(policy.workspace),path:policy.workspace,stat}]; }
    else source=(await directoryEntries(policy.workspace)).rows.filter(row=>row.stat?.isDirectory()&&!row.name.startsWith('.'));
    return mapLimit(source,8,async row=>{
      const root=await git.hasMarker(row.path)?row.path:null;
      const fact=sizes.facts(row.path,row.stat);if(!fact)void sizes.start(row.path).catch(()=>{});
      const use=activity.forPath(row.path);
      return {name:row.name,path:row.path,kind:'folder',bytes:fact?.bytes??null,partial:fact?.partial||false,composition:await composition(row.path,fact?.bytes??null,root),
        modified:row.stat.mtime.toISOString(),git:git.get(root),running:use.running.filter(item=>item.port),activityComplete:use.complete,threads:threads.forPath(row.path)};
    });
  };
  const trash=()=>trashService.list();
  const places=async()=>{
    if(placesCache&&now()-placesAt<30_000)return placesCache;
    return placesPending??=(async()=>{
      const [disk,workspaceFacts,homeFacts,trashFacts,workspaceIsRepo]=await Promise.all([fs.statfs(policy.workspace),fs.lstat(policy.workspace),fs.lstat(policy.home),trash(),git.hasMarker(policy.workspace)]);
      const projects=workspaceIsRepo?1:(await directoryEntries(policy.workspace)).rows.filter(row=>row.stat?.isDirectory()&&!row.name.startsWith('.')).length;
      const projectSize=sizes.facts(policy.workspace,workspaceFacts),homeSize=sizes.facts(policy.home,homeFacts);
      if(!projectSize)void sizes.start(policy.workspace).catch(()=>{});if(!homeSize)void sizes.start(policy.home).catch(()=>{});
      const totalBytes=Number(disk.blocks)*Number(disk.bsize),availableBytes=Number(disk.bavail)*Number(disk.bsize),usedPercent=totalBytes?Math.round((1-availableBytes/totalBytes)*100):0;
      const parts={tools:0,t3:0,caches:0,other:0};let complete=!!homeSize;
      const managedRoots=[...new Map((await policy.managedRoots()).filter(row=>inside(policy.home,row.root)).map(row=>[row.root,row])).values()];
      const measured=[];
      for(const row of managedRoots){
        const fact=sizes.facts(row.root);
        if(!fact){const exists=await fs.lstat(row.root).then(()=>true,error=>error.code==='ENOENT'?false:null);if(exists!==false)complete=false;continue;}
        measured.push({...row,bytes:fact.bytes});
      }
      for(const row of measured){
        const descendants=measured.filter(child=>child.root!==row.root&&inside(row.root,child.root));
        const immediate=descendants.filter(child=>!descendants.some(parent=>parent!==child&&inside(parent.root,child.root)));
        const exclusive=row.bytes-immediate.reduce((sum,child)=>sum+child.bytes,0);
        if(exclusive<0){complete=false;continue;}
        parts[row.tag==='Agents and toolchains'?'tools':row.tag==='T3 Code and Setup'?'t3':'caches']+=exclusive;
      }
      const known=Object.values(parts).reduce((sum,value)=>sum+value,0);
      if(homeSize&&known<=homeSize.bytes)parts.other+=homeSize.bytes-known;else complete=false;
      const compositionHome=complete?Object.entries(parts).map(([id,bytes])=>({id,bytes,label:{tools:'Agents and toolchains',t3:'T3 Code data',caches:'Caches',other:'Everything else'}[id],part:{tools:'kept',t3:'git',caches:'rebuild',other:'other'}[id]})):null;
      placesAt=now();return placesCache={ok:true,capabilities,disk:{totalBytes,availableBytes,usedPercent,severity:usedPercent>=90?'danger':usedPercent>=80?'warn':'ok'},
        measuredAt:projectSize?.at||homeSize?.at||null,measuring:sizes.jobs().some(row=>row.state==='running'),partial:!!(projectSize?.partial||homeSize?.partial),
        projects:{...await permissions(policy.workspace),path:policy.workspace,count:projects,bytes:projectSize?.bytes??null,composition:await composition(policy.workspace,projectSize?.bytes??null,workspaceIsRepo?policy.workspace:null),workspaceIsRepo},
        home:{...await permissions(policy.home),path:policy.home,display:'~',volume:storage?.snapshot?.().volumeName||null,bytes:homeSize?.bytes??null,composition:compositionHome},
        trash:{count:trashFacts.items.length,bytes:trashFacts.bytes,retentionDays:7}};
    })().finally(()=>{placesPending=null;});
  };
  const details=async value=>{
    const absolute=await policy.entry(normalizePath(value)),stat=await fs.lstat(absolute),classification=await policy.classify(absolute),kind=kindOf(path.basename(absolute),stat);
    const owner=stat.uid===process.getuid?.()?'t3':stat.uid===0?'root':String(stat.uid),mode=fileMode(stat.mode);
    const common={ok:true,path:absolute,name:path.basename(absolute),kind,type:typeOf(path.basename(absolute),kind),owner,mode,modified:stat.mtime.toISOString(),created:stat.birthtime.toISOString(),
      writable:await fs.access(absolute,constants.W_OK).then(()=>true,()=>false),managed:classification.managed,tags:classification.tags,signIns:classification.signIns,keys:classification.keys,secret:classification.secret||classification.keys||classification.signIns.length>0,
      target:classification.linked?{path:classification.target,kind:await fs.stat(absolute).then(item=>kindOf(path.basename(classification.target),item),()=>null)}:null};
    if(kind==='folder'){
      const repo=await git.rootFor(absolute),project=await listing.projectFor(absolute),facts=sizes.facts(absolute,stat);
      if(!facts)void sizes.start(absolute).catch(()=>{});
      const known=sizes.under(absolute);
      const analysis=rebuildable.get(absolute,repo),clean=new Set(analysis.candidates.map(row=>row.path)),largestFolders=[];
      for(const [file,bytes] of known.sort((a,b)=>b[1]-a[1])) {
        if(largestFolders.some(row=>inside(path.resolve(absolute,row.path),file)))continue;
        largestFolders.push({path:path.relative(absolute,file),bytes,rebuildable:clean.has(file),git:path.basename(file)==='.git'});
        if(largestFolders.length===4)break;
      }
      return {...common,bytes:facts?.bytes??null,files:facts?.files??null,partial:facts?.partial||false,measuredAt:facts?.at||null,isProject:project===absolute,
        composition:await composition(absolute,facts?.bytes??null,repo===absolute?repo:null),
        largestFolders,
        git:git.get(repo),threads:threads.forPath(absolute),...activity.forPath(absolute),rebuildable:analysis};
    }
    let text=null;const preview=previewOf(kind,Number(stat.size));
    if(preview==='text')text=await readText(absolute);
    return {...common,...activity.forPath(absolute,{parent:true}),bytes:Number(stat.size),preview:text?.kind==='binary'?null:preview,editable:!!text?.editable,etag:text?.etag||null,
      ...(text?.kind==='text'?{lines:text.lines,encoding:'utf-8',eol:text.eol,truncated:text.truncated}:{})};
  };
  const tree=async (value,limit=6)=>{
    const data=await listing.list(value,{hidden:true,sort:'size',dir:'desc',pageSize:limit});
    const children=data.entries.map(row=>({...row,share:row.bytes!==null&&data.counts.bytes>0?row.bytes/data.counts.bytes*100:null,rebuildable:!!row.rebuildable,git:row.name==='.git',hasChildren:row.kind==='folder'}));
    return {ok:true,path:data.path,bytes:data.counts.bytes,children,measuredAt:data.measuredAt,partial:data.partial,total:data.total,more:data.more?data.tail:null};
  };
  const handle=async(route,{query=new URLSearchParams(),input={},headers={},bodyBuffer}={})=>{
    const value=()=>normalizePath(query.get('path')||input.path||policy.workspace);
    if(['/files/mkdir','/files/rename','/files/move','/files/write'].includes(route))return changes.invoke(route.slice(7),input);
    if(route==='/files/to-trash')return trashService.move(input);
    if(route==='/files/trash/restore')return trashService.restore(input);
    if(route==='/files/trash/empty')return trashService.empty(input);
    if(route==='/files/upload/start')return uploads.start(input);
    if(route==='/files/upload/chunk')return uploads.chunk({...input,id:query.get('id'),offset:query.get('offset')},bodyBuffer);
    if(route==='/files/upload/finish')return uploads.finish(input);
    if(route==='/files/upload/cancel')return uploads.cancel(input);
    if(route==='/files/jobs/cancel')return jobs.cancel(input.id);
    if(route==='/files/places')return places();
    if(route==='/files/projects')return {ok:true,projects:await projectRows(),measuredAt:storage?.sizes?.()?.at||null,threadsAvailable:threads.get()!==null};
    if(route==='/files/list')return listing.list(value(),{hidden:query.get('hidden')==='1',sort:query.get('sort')||'size',dir:query.get('dir')||'desc',all:query.get('all')==='1'});
    if(route==='/files/details')return details(value());
    if(route==='/files/tree'){const limit=query.has('limit')?Number(query.get('limit')):6;if(!Number.isSafeInteger(limit)||limit<6||limit>20_000)throw new FilesError('invalid','Use a tree page size between 6 and 20,000.');return tree(value(),limit);}
    if(route==='/files/read')return readText(value(),{edit:query.get('edit')==='1',ifNoneMatch:headers['if-none-match']});
    if(route==='/files/raw')return {raw:true,...await rawFile(value(),{range:headers.range,ifRange:headers['if-range']})};
    if(route==='/files/search')return search.search(value(),{q:query.get('q')||'',kind:query.get('kind')||'',size:query.get('size')||'',modified:query.get('modified')||'',rebuildable:query.get('rebuildable')==='1'});
    if(route==='/files/suggest')return search.suggest(query.get('q')||'');
    if(route==='/files/largest'){const min=Number(query.get('min')||0);if(!Number.isSafeInteger(min)||min<0)throw new FilesError('invalid','Use a minimum size in bytes.');const result=await search.largest(value());return {...result,files:result.files.filter(row=>row.bytes>=min)};}
    if(route==='/files/trash')return trash();
    if(route==='/files/jobs'){await jobs.ready;return {ok:true,jobs:[...sizes.jobs(),...jobs.list(),...await uploads.jobs()]};}
    if(route==='/files/measure'){placesAt=0;const job=await sizes.start(value(),{force:true});return {ok:true,measuring:!!job,job:job?.id||null,busy:!job};}
    throw new FilesError('missing','This Files action is not available.');
  };
  const guardedHandle=async(route,options={})=>{try{return await handle(route,options);}catch(error){
    if(['EACCES','EPERM'].includes(error.code)){
      const value=normalizePath(options.query?.get('path')||options.input?.path||policy.workspace);
      const stat=await fs.lstat(value).catch(()=>null),owner=stat?stat.uid===0?'root':stat.uid===process.getuid?.()?'t3':'user '+stat.uid:null;
      throw new FilesError('no-access','You can’t open '+policy.display(value)+'. '+(owner?'It belongs to '+owner+'. ':'')+'This console runs as t3, like agents’ terminals.',{path:value,owner});
    }throw error;
  }};
  return {handle:guardedHandle,places,details,tree,trash,listing,policy,sizes,git,rebuildable,activity,threads,capabilities,changes,trashService,uploads,jobs,guard,stop:()=>{clearInterval(maintenanceTimer);for(const job of jobs.list())if(['queued','running'].includes(job.state)){try{jobs.cancel(job.id);}catch{/* Finishing jobs keep their journal for restart verification. */}}}};
}
