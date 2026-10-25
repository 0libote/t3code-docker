import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createPathPolicy } from '../../docker/setup/files/paths.mjs';
import { createMutationGuard } from '../../docker/setup/files/guard.mjs';
import { createTrash } from '../../docker/setup/files/trash.mjs';
import { createChanges } from '../../docker/setup/files/changes.mjs';
import { createJobs } from '../../docker/setup/files/jobs.mjs';
import { createGitService } from '../../docker/setup/files/git.mjs';
import { createUploads } from '../../docker/setup/files/uploads.mjs';

export async function filesFixture(t,options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-files-change-')),home=path.join(root,'home'),workspace=path.join(root,'workspace');
  await Promise.all([home,workspace,path.join(home,'.t3')].map(value=>fs.mkdir(value,{recursive:true})));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const policy=createPathPolicy({home,workspace,stateDir:path.join(home,'.t3/setup'),env:{}}),git=createGitService(),sizes={facts:()=>({bytes:4096}),invalidate(){}};
  let processes={complete:true,processes:[]};
  const activity={fresh:async()=>processes},events=[],guard=createMutationGuard({policy,activity,...options,recordEvent:(...args)=>events.push(args)});
  const jobs=createJobs({stateDir:policy.stateDir,mounts:guard.mounts}),trash=createTrash({policy,guard,sizes,git,...options}),changes=createChanges({policy,guard,trash,jobs,sizes,...options}),uploads=createUploads({policy,guard,trash,...options});
  return {root,home,workspace,policy,guard,trash,changes,uploads,jobs,events,activity,setProcesses:value=>{processes=value;}};
}
