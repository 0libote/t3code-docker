import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fail } from './paths.mjs';
import { maybeStat, identity } from './entries.mjs';

/** The supervisor owns restarting. Setup only holds that restart while a
 * requested file change runs, and always releases its own hold in finally. */
export function createHoldControl({runDir,runtimeBusy=()=>false,readPid,restart,probe=async()=>true,
  alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}},now=Date.now,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),stopTimeoutMs=30_000,startTimeoutMs=60_000,recordEvent=()=>{}}) {
  const hold=path.join(runDir,'hold'),restartFile=path.join(runDir,'restart');let holding=false;
  const active=async()=>holding||!!await maybeStat(hold);
  const wait=async(condition,timeout,message)=>{const end=now()+timeout;do{if(await condition())return;await sleep(250);}while(now()<end);fail('busy',message);};
  const withStopped=async work=>{
    if(holding||await runtimeBusy()||await maybeStat(restartFile))fail('busy','Wait for the T3 Code update or restart to finish before changing its files.');
    const pid=await readPid();if(!Number.isInteger(pid)||pid<=1||!alive(pid))fail('in-use','T3 Code is not supervised or is no longer running. Refresh before trying again.');
    const supervisor=await fs.readFile(path.join(runDir,'supervisor.json'),'utf8').then(JSON.parse,()=>null);
    if(!supervisor||supervisor.protocol<3||!alive(supervisor.pid))fail('in-use','This T3 Code command is not managed by the image supervisor. Restart the container after saving your work.');
    const handle=await fs.open(hold,'wx',0o600),own=identity(await handle.stat({bigint:true}));holding=true;
    try{
      await handle.writeFile(JSON.stringify({createdAt:now(),expiresAt:now()+10*60_000}));await handle.sync();await handle.close();
      if(await runtimeBusy()||await maybeStat(restartFile))fail('busy','An update or restart started. Try again after it finishes.');
      const response=await restart();if(response?.body?.ok===false||response?.ok===false)fail('busy',response.body?.error||response.error||'T3 Code could not be stopped.');
      await wait(()=>!alive(pid),stopTimeoutMs,'T3 Code did not stop in time. No file change was made.');
      recordEvent('files.t3-stopped','Stopped T3 Code to change a managed file');
      let result,error;try{result=await work();}catch(cause){error=cause;}
      if(identity(await maybeStat(hold))===own)await fs.unlink(hold);
      let warning=null;
      try{await wait(async()=>{const next=await readPid();return next&&next!==pid&&alive(next)&&await probe();},startTimeoutMs,'T3 Code is taking longer to restart. Check Server before starting more work.');}catch(cause){warning=cause.message;}
      if(error){if(warning)error.fields={...error.fields,t3:'needs-attention',restartWarning:warning};throw error;}
      return {...result,t3:warning?'needs-attention':'restarted',...(warning?{restartWarning:warning}:{})};
    }finally{await handle.close().catch(()=>{});if(identity(await maybeStat(hold))===own)await fs.unlink(hold);holding=false;}
  };
  return {active,withStopped};
}
