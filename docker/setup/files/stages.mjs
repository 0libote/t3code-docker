import { constants,promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLimiter } from './io.mjs';
import { readText } from './text.mjs';
import { maybeStat,identity,pinParent,privateDirectory,atomicJSON } from './entries.mjs';
import { fail,inside,normalizePath } from './paths.mjs';
import { createMountService } from './mounts.mjs';

/** Journal only the staging directories we created. Restart cleanup must never
 * infer ownership from a filename prefix or delete a user-created lookalike. */
export function createStages({stateDir,mounts=createMountService()}={}) {
  const records=new Map(),serial=createLimiter(1),directory=stateDir&&path.join(stateDir,'files'),file=directory&&path.join(directory,'stages.json');
  const save=async()=>{if(!file)return;const data={version:1,stages:[...records.values()]};if(Buffer.byteLength(JSON.stringify(data))>1024*1024)fail('busy','Too many staged files. Let an operation finish before starting more.');await privateDirectory(directory);await atomicJSON(file,data);};
  const remove=async row=>{
    const stat=await maybeStat(row.path);if(!stat)return true;if(!stat.isDirectory()||stat.isSymbolicLink()||identity(stat)!==row.identity)return false;
    const canonical=await fs.realpath(row.path),facts=await mounts.forPath(canonical,{fresh:true});if(!facts.available||facts.mounts.some(mount=>inside(canonical,mount.path)))return false;
    const pin=await pinParent(row.path);try{if(identity(await fs.lstat(pin.pinned,{bigint:true}))!==row.identity)return false;await fs.rm(pin.pinned,{recursive:true,force:false});return true;}finally{await pin.close();}
  };
  const ready=(async()=>{
    if(!file)return [];const stat=await maybeStat(file);if(!stat)return [];
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024n*1024n||stat.uid!==BigInt(process.getuid?.()))return [];
    const interrupted=[];
    try{
      const text=await readText(file),data=JSON.parse(text.text);if(data.version!==1||!Array.isArray(data.stages)||data.stages.length>256)return [];
      for(const row of data.stages){
        try{normalizePath(row.path);if(!/^\.t3-(copy|zip|extract)-[0-9a-f-]{36}\.tmp$/.test(path.basename(row.path))||typeof row.identity!=='string')continue;
          if(row.job?.id&&typeof row.job.label==='string')interrupted.push({...row.job,state:'failed',error:'Interrupted when Setup restarted. Check the destination before retrying; completed files were kept.'});
          if(!await remove(row))records.set(row.path,row);
        }catch{/* Invalid records never become cleanup authority. */}
      }
      await save();
    }catch{/* Invalid metadata cannot authorize cleanup. */}
    return interrupted;
  })();
  const create=(parent,kind,job)=>serial(async()=>{
    await ready;if(!['copy','zip','extract'].includes(kind))fail('invalid','Unknown staging kind.');if(records.size>=256)fail('busy','Too many staged operations.');
    const target=path.join(await fs.realpath(normalizePath(parent)),'.t3-'+kind+'-'+randomUUID()+'.tmp'),pin=await pinParent(target);let handle;
    try{
      await fs.mkdir(pin.pinned,{mode:0o700});handle=await fs.open(pin.pinned,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      const stat=await handle.stat({bigint:true}),row={path:pin.path,identity:identity(stat),job};records.set(row.path,row);
      try{await save();}catch(error){await handle.close();handle=null;await fs.rm(pin.pinned,{recursive:true,force:true});records.delete(row.path);throw error;}
      const root=handle;handle=null;
      return {root:row.path,path:path.join(row.path,'item'),payload:`/proc/self/fd/${root.fd}/item`,dispose:()=>serial(async()=>{try{if(await remove(row))records.delete(row.path);await save();}finally{await root.close();}})};
    }finally{await handle?.close();await pin.close();}
  });
  return {ready,create};
}
