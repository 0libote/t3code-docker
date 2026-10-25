import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FilesError, fail, inside, normalizePath } from './paths.mjs';
import { createMountService } from './mounts.mjs';
import { permissions } from './listing.mjs';
import { maybeStat, same, pinParent, identity } from './entries.mjs';
import { createLimiter } from './io.mjs';

/** One policy for every write, including upload chunks and job publication.
 * Callers operate on pinned parent descriptors, never a user-supplied alias. */
export function createMutationGuard({policy,activity,mounts=createMountService(),withStopped,changed=()=>{},recordEvent=()=>{}}) {
  const serial=createLimiter(1,128);
  const run=(input,requests,work,{notify=true}={})=>serial(async()=>{
    const perform=async()=>{
      await policy.refresh(true);const pins=[],facts=[];
      try{
        const use=await activity.fresh?.()||{complete:false,processes:[]};
        for(const request of requests){
          const requested=normalizePath(request.path),classification=await policy.classify(requested),value=classification.path;
          if(request.mode==='remove'&&(value==='/'||value===policy.home||value===policy.workspace||inside(value,policy.stateDir)))fail('locked','Files cannot remove this root or an ancestor of its own state. Open a child folder instead.');
          const stat=await maybeStat(value);if(!stat&&!request.missing)fail('missing','This item is no longer here. Refresh and try again.');
          if(request.mode!=='read'){
            const rule=classification.managed||classification.ancestor;
            if(rule&&input.unlock!==rule.root)fail('locked','This location is managed. Choose Edit anyway in its managed folder first.',{managed:rule});
            if((classification.signIns.length||classification.keys)&&input.confirmed!==true)fail('conflicts','Review the sign-ins or keys affected by this action.',{consequence:{signIns:classification.signIns,keys:classification.keys}});
            const parent=path.dirname(value),mount=await mounts.forPath(parent,{fresh:true}),access=await permissions(parent);
            if(mount.mount?.readOnly||!access.writable)fail('read-only','This folder is read-only for t3. You can look and download here.');
            if(request.mode==='remove'&&(!mount.available||mount.mounts.some(row=>inside(value,row.path))))fail('locked','A mounted filesystem cannot be moved or removed here. Work with its contents instead.');
            if(stat&&request.inUse!==false){
              const running=use.processes.filter(row=>row.cwd&&inside(value,row.cwd)||row.openFiles?.some(file=>inside(value,file)));
              if(!use.complete||running.length)fail('in-use',use.complete?'This item is being used. Stop the listed process before changing it.':'Couldn’t check what’s running. Try again before changing this item.',{processes:running.map(({openFiles,...row})=>({...row,...(row.ports?.length?{port:row.ports[0]}:{})})),complete:use.complete,canStopT3:use.complete&&running.length>0&&running.every(row=>row.label==='T3 Code')});
            }
          }
          const pin=await pinParent(value);pins.push(pin);
          if(!same(stat,await maybeStat(pin.pinned)))fail('changed','This item changed while it was being opened. Try again.');
          facts.push({...classification,...request,requested,path:value,stat,pin});
        }
        const verify=async()=>{
          await policy.refresh(true);
          for(const row of facts){
            const current=await policy.classify(row.requested);
            if(current.path!==row.path||current.managed?.root!==row.managed?.root||current.ancestor?.root!==row.ancestor?.root||identity(await fs.lstat(row.pin.parent,{bigint:true}))!==identity(row.pin.stat)||!same(row.stat,await maybeStat(row.pin.pinned)))fail('changed','The selection changed. Refresh and review it again.');
          }
        };
        await verify();
        let succeeded=false;
        try{const result=await work(facts,verify);succeeded=true;return result;}
        finally{for(const row of facts)if(notify&&row.mode!=='read'){await changed(row.path);if(succeeded&&row.managed)recordEvent('files.managed','Changed a managed file',{detail:policy.display(row.path)});}}
      }finally{await Promise.allSettled(pins.map(pin=>pin.close()));}
    };
    if(input.stopT3===true){if(!withStopped)throw new FilesError('in-use','This T3 Code command is not supervised, so Files cannot stop and restart it.');return withStopped(perform);}
    return perform();
  });
  return {run,mounts};
}
