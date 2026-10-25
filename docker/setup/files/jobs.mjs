import { randomUUID } from 'node:crypto';
import { fail } from './paths.mjs';
import { createStages } from './stages.mjs';

/** Two independent jobs; queued work owns an AbortSignal before it starts. */
export function createJobs({ concurrency=2, now=Date.now,stateDir,mounts }={}) {
  const jobs=new Map(); let running=0;
  const stages=createStages({stateDir,mounts});
  const ready=stages.ready.then(interrupted=>{for(const job of interrupted)if(!jobs.has(job.id))jobs.set(job.id,{...job,finishedAt:new Date(now()).toISOString(),controller:new AbortController()});});
  const pump=()=>{
    for(const job of jobs.values()) {
      if(running>=concurrency)break;
      if(job.state!=='queued')continue;
      running++;job.state='running';job.startedAt=new Date(now()).toISOString();
      void ready.then(()=>{if(job.controller.signal.aborted)throw new DOMException('Cancelled','AbortError');return job.work({signal:job.controller.signal,progress:facts=>Object.assign(job,facts),stage:(parent,kind)=>stages.create(parent,kind,{id:job.id,label:job.label,kind:job.kind,dest:job.dest,paths:job.paths})});}).then(result=>{
        job.result=result;job.state=job.controller.signal.aborted?'cancelled':'done';
      },error=>{job.state=job.controller.signal.aborted?'cancelled':'failed';job.error=error.message||'This operation could not finish.';job.code=error.code||'failed';}).finally(()=>{
        running--;job.finishedAt=new Date(now()).toISOString();delete job.work;pump();
      });
    }
    for(const [id,job]of jobs)if(jobs.size>100&&!['queued','running'].includes(job.state))jobs.delete(id);
  };
  const add=(kind,label,work,facts={})=>{
    if([...jobs.values()].filter(job=>['queued','running'].includes(job.state)).length>=128)fail('busy','The transfer queue is full. Wait for a job to finish.');
    const job={id:'j_'+randomUUID(),kind,label,state:'queued',done:0,total:null,unit:'files',createdAt:new Date(now()).toISOString(),...facts,controller:new AbortController(),work};
    jobs.set(job.id,job);pump();return job.id;
  };
  const cancel=id=>{const job=jobs.get(id);if(!job)fail('missing','This job is no longer here.');if(job.cancellable===false&&job.state==='running')fail('busy','This job is finishing its change. Wait for the result.');if(['queued','running'].includes(job.state)){job.controller.abort();if(job.state==='queued'){job.state='cancelled';job.finishedAt=new Date(now()).toISOString();delete job.work;}}return {ok:true};};
  const list=()=>[...jobs.values()].map(({controller,work,...job})=>structuredClone({...job,...(job.paths?{paths:job.paths.slice(0,20),pathCount:job.paths.length}:{})}));
  return {ready,add,cancel,list,stage:(parent,kind,job)=>stages.create(parent,kind,job),get:id=>list().find(job=>job.id===id),settled:async(id,{timeoutMs=30_000}={})=>{const deadline=Date.now()+timeoutMs;while(['queued','running'].includes(jobs.get(id)?.state)){if(Date.now()>deadline)fail('busy','This job is still running.');await new Promise(resolve=>setTimeout(resolve,10));}return list().find(job=>job.id===id);}};
}
