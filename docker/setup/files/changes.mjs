import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fail, inside, normalizePath, validateName } from './paths.mjs';
import { maybeStat, pathsOf, uniqueName, same, copyEntry, treeRevision, checkAbort, renameExclusive } from './entries.mjs';
import { readText, EDIT_BYTES } from './text.mjs';

export function createChanges({policy,guard,trash,jobs,sizes,now=Date.now}) {
  const undos=new Map(),requests=new Map();
  const rememberUndo=items=>{const token='undo_'+randomUUID();if(undos.size>=128)undos.delete(undos.keys().next().value);undos.set(token,{at:now(),items});return token;};
  const mkdir=input=>{
    const target=path.join(normalizePath(input.parent),validateName(input.name));
    return guard.run(input,[{path:target,mode:'write',missing:true}],async([row])=>{if(row.stat)fail('exists',input.name+' is already here. Choose another name.');await fs.mkdir(row.pin.pinned);return {ok:true,path:row.path};});
  };
  const rename=input=>{
    const source=normalizePath(input.path),target=path.join(path.dirname(source),validateName(input.name));
    if(source===target)return Promise.resolve({ok:true,path:source});
    return guard.run(input,[{path:source,mode:'remove'},{path:target,mode:'write',missing:true}],async([from,to],verify)=>{
      if(to.stat)fail('exists',input.name+' is already here. Choose another name.');await verify();await renameExclusive(from.pin.pinned,to.pin.pinned);return {ok:true,path:to.path};
    });
  };
  const write=async input=>{
    const target=normalizePath(input.path),mode=input.mode||'save';
    if(!['save','copy','overwrite','create'].includes(mode)||typeof input.text!=='string'||!input.text.isWellFormed()||input.text.includes('\0'))fail('invalid','Use UTF-8 text and a supported save option.');
    const bytes=Buffer.from(input.text);if(bytes.length>EDIT_BYTES)fail('too-large','The editor supports text up to 5 MiB. Download this file instead.');
    const output=mode==='copy'?path.join(path.dirname(target),await uniqueName(path.dirname(target),path.basename(target),{suffix:'copy'})):target;
    return guard.run(input,[{path:output,mode:'write',missing:mode==='copy'||mode==='create'}],async([row],verify)=>{
      if(row.stat?.isSymbolicLink())fail('locked','Open the link’s real file to edit it. The link itself is kept.');
      if((mode==='copy'||mode==='create')&&row.stat)fail('exists','This name is already here. Choose another name.');
      if(row.stat){
        const current=await readText(row.pin.pinned,{edit:true});if(current.kind!=='text')fail('invalid','This file is binary or is not valid UTF-8.');
        if(mode==='save'&&(typeof input.etag!=='string'||current.etag!==input.etag))fail('changed','This file changed on disk while you were editing. Your edit hasn’t been saved.',{current:{...current,path:row.path,modified:new Date(Number(row.stat.mtimeMs)).toISOString()}});
      }
      const lease=await jobs.stage(row.pin.parent,'copy',{id:'save_'+randomUUID(),kind:'write',label:'Save '+path.basename(row.path),dest:row.pin.parent,paths:[row.path]}),temp=lease.payload,handle=await fs.open(temp,'wx',0o600).catch(async error=>{await lease.dispose();throw error;});
      try{await handle.writeFile(bytes);await handle.chmod(row.stat?Number(row.stat.mode&0o777n):0o644);await handle.sync();await handle.close();await verify();if(row.stat)await fs.rename(temp,row.pin.pinned);else await renameExclusive(temp,row.pin.pinned);const parent=await fs.open(row.pin.parent,'r');try{await parent.sync();}finally{await parent.close();}}
      finally{await handle.close().catch(()=>{});await lease.dispose();}
      const read=await readText(row.path,{edit:true});return {ok:true,path:row.path,etag:read.etag,bytes:bytes.length};
    });
  };
  const move=async input=>{
    if(input.undo){
      const undo=undos.get(input.undo);if(!undo||now()-undo.at>5*60_000)fail('stale','This Undo has expired. Move the items back from their current folder.');
      undos.delete(input.undo);
      return guard.run(input,undo.items.flatMap(item=>[{path:item.to,mode:'remove'},{path:item.from,mode:'write',missing:true}]),async rows=>{
        for(let index=0;index<rows.length;index+=2)if(rows[index+1].stat||!same(undo.items[index/2].stat,rows[index].stat))fail('stale','An item changed after the move. Move it back manually to keep both versions.');
        const restored=[];for(let index=0;index<rows.length;index+=2){await renameExclusive(rows[index].pin.pinned,rows[index+1].pin.pinned);restored.push(rows[index+1].path);const replaced=undo.items[index/2].replacement;if(replaced)await trash.rollback(replaced,rows[index].path);}return {ok:true,restored};
      });
    }
    const sources=pathsOf(input.paths),dest=await fs.realpath(normalizePath(input.dest));
    const destStat=await fs.lstat(dest,{bigint:true});if(!destStat.isDirectory())fail('invalid','Choose a destination folder.');
    if(sources.some(source=>inside(source,dest)))fail('invalid','A folder cannot be moved or copied into itself.');
    const copy=input.copy===true,plans=[],conflicts=[],taken=new Set();
    for(const source of sources){
      const from=await policy.entry(source);if(path.dirname(from)===dest&&!copy)continue;
      let name=input.duplicate?await uniqueName(dest,path.basename(from),{suffix:'copy'}):path.basename(from),target=path.join(dest,name),stat=await maybeStat(target);
      const choice=input.choices?.[path.basename(from)]||input.onConflict||'ask';
      if(!['ask','replace','keep-both','skip'].includes(choice))fail('invalid','Choose Replace, Keep both or Skip.');
      if(stat&&choice==='ask'){conflicts.push({name,path:target,existing:{bytes:Number(stat.size),modified:new Date(Number(stat.mtimeMs)).toISOString()}});continue;}
      if(stat&&choice==='skip')continue;
      if(stat&&choice==='keep-both'){name=await uniqueName(dest,name);target=path.join(dest,name);stat=null;}
      if(taken.has(target))fail('conflicts','Two selected items have the same destination name. Move them separately.');taken.add(target);
      plans.push({from,to:target,replace:!!stat});
    }
    if(conflicts.length)fail('conflicts','Some names are already in this folder. Choose what to keep.',{conflicts});
    if(!plans.length)return {ok:true,moved:0,instant:true};
    const specs=plans.flatMap(plan=>[{path:plan.from,mode:copy?'read':'remove'},{path:plan.to,mode:'write',missing:true}]);
    const sourceStats=await Promise.all(plans.map(plan=>fs.lstat(plan.from,{bigint:true}))),destMount=await guard.mounts.forPath(dest,{fresh:true}),sourceMounts=await Promise.all(plans.map(plan=>guard.mounts.forPath(path.dirname(plan.from)))),instant=!copy&&destMount.available&&sourceMounts.every(row=>row.mount?.id===destMount.mount?.id)&&sourceStats.every(stat=>stat.dev===destStat.dev);
    if(instant)return guard.run(input,specs,async(rows,verify)=>{
      await verify();const replaced=[],done=[];
      try{
        for(let index=0;index<plans.length;index++){
          const from=rows[index*2],to=rows[index*2+1];
          let replacement;if(to.stat){replacement=await trash.stash(to,{reason:'replaced'});replaced.push(replacement);}
          await renameExclusive(from.pin.pinned,to.pin.pinned);done.push({from:from.path,to:to.path,replacement,stat:await fs.lstat(to.pin.pinned,{bigint:true})});
        }
      }catch(error){for(const row of [...done].reverse())if(!await maybeStat(row.from))await renameExclusive(row.to,row.from).catch(()=>{});for(const meta of replaced)await trash.rollback(meta).catch(()=>{});throw error;}
      return {ok:true,moved:done.length,instant:true,paths:done.map(row=>row.to),undo:rememberUndo(done),replaced:replaced.map(row=>row.id)};
    });
    // Authorize before queuing, then again at publication. A changing source
    // cannot cause an across-disk move to remove a newer original.
    await guard.run(input,specs,async()=>{});
    const job=jobs.add(copy?'copy':'move',(copy?'Copy ':'Move ')+plans.length+' items',async({signal,progress,stage:makeStage})=>{
      const staged=[],publishedPaths=[];let published=false;
      try{
        for(const plan of plans){
          checkAbort(signal);const before=await treeRevision(plan.from,{signal}),lease=await makeStage(dest,'copy'),stage=lease.payload;
          staged.push({...plan,stage,before,lease});await copyEntry(plan.from,stage,{signal,progress,mounts:guard.mounts});
          if((await treeRevision(plan.from,{signal})).revision!==before.revision)fail('changed','A source changed during copying. The originals were kept.');
        }
        return await guard.run(input,specs,async(rows,verify)=>{
          checkAbort(signal);await verify();
          for(const item of staged)if((await treeRevision(item.from,{signal})).revision!==item.before.revision)fail('changed','A source changed. The originals were kept.');
          progress({cancellable:false,phase:'finishing'});const output=[];
          for(let index=0;index<staged.length;index++){
            const to=rows[index*2+1],item=staged[index];if(to.stat)await trash.stash(to,{reason:'replaced'});
            await renameExclusive(item.stage,to.pin.pinned);output.push(to.path);publishedPaths.push(to.path);progress({publishedPaths:[...publishedPaths]});published=true;
          }
          published=true;
          if(!copy)for(let index=0;index<staged.length;index++)await fs.rm(rows[index*2].pin.pinned,{recursive:true,force:false});
          return {ok:true,paths:output,copied:copy?output.length:0,moved:copy?0:output.length};
        });
      }catch(error){if(published)error.message+=' Published copies were kept; check the destination before retrying.';throw error;}
      finally{await Promise.allSettled(staged.map(item=>item.lease.dispose()));}
    },{paths:plans.map(plan=>plan.from),dest});
    return {ok:true,job,instant:false};
  };
  const invoke=(name,input)=>{
    const action={mkdir,rename,write,move}[name];if(!action)fail('invalid','Unknown file change.');
    const id=input.requestId;
    if(id!==undefined&&(typeof id!=='string'||!/^r_[0-9a-f-]{36}$/.test(id)))fail('invalid','Use a valid operation identity.');
    if(!id)return action(input);
    const fingerprint=createHash('sha256').update(name).update(JSON.stringify(input)).digest('hex'),existing=requests.get(id);
    if(existing){if(existing.fingerprint!==fingerprint)fail('changed','This operation identity was already used for another change.');return existing.result;}
    if(requests.size>=256){const key=[...requests].find(([,row])=>now()-row.at>5*60_000)?.[0];if(!key)fail('busy','Too many recent changes. Wait a moment before trying again.');requests.delete(key);}
    const result=action(input),cached=result.catch(error=>{if(error.fields?.current)throw new (error.constructor)(error.code,'Read the file again before retrying this save.',{recheck:true});throw error;});requests.set(id,{fingerprint,result:cached,at:now()});cached.catch(()=>{});return result;
  };
  return {invoke,mkdir,rename,write,move};
}
