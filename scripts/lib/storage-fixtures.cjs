// Shared, entirely in-memory Storage review data for native preview and browser
// audits. No filesystem or tool operation is reachable through this adapter.
const { CACHES } = require('../../docker/harness/storage/caches.mjs');
const { DEFAULT_POLICY, validatePolicy, policyRevision } = require('../../docker/harness/storage/policy.mjs');
const { randomBytes } = require('node:crypto');
const GB = 1e9;
const createStorageFixtures = () => {
  const options = { scenario: 'ready', failPreview: false, failPolicy: false, failAt: null, jobDelay: 200, lifetime: 300000 };
  let policy = structuredClone(DEFAULT_POLICY), operation = null, serial = 0;
  const plans = new Map(), requests = [];
  const sizes = { go: 3.1*GB, gomod: 1.3*GB, npm: .82*GB, uv: 1.7*GB, bun: 1.9*GB, mise: 7*GB, deno: 0 };
  const paths = { go: '.cache/go-build', gomod: 'go/pkg/mod', npm: '.npm/_cacache', uv: '.cache/uv', bun: '.bun/install/cache', mise: '.cache/mise', deno: '.cache/deno' };
  const rows = () => CACHES.map(row => ({ id: row.id, label: row.label, description: row.description, effect: row.effect, cleanupHint: row.cleanupHint, icon: row.icon,
    bytes: options.scenario === 'empty' ? 0 : sizes[row.id], path: '/home/t3/' + paths[row.id], kind: 'cache',
    cleanable: !['bun','deno'].includes(row.id), protection: row.id === 'bun' ? 'Shared dependencies kept' : row.id === 'deno' ? 'Tool unavailable' : null,
    unavailable: row.id === 'bun' ? 'Bun’s shared store is used by installed project dependencies.' : row.id === 'deno' ? 'Install Deno to clean this cache.' : null }));
  const status = () => ({ at: options.scenario === 'loading' ? null : Date.now()-120000, refreshing: options.scenario === 'scanning',
    error: options.scenario === 'partial' ? 'Some folders could not be read. Sizes are partial estimates.' : null,
    policy: structuredClone(policy), policyRevision: policyRevision(policy),
    cachePolicies: CACHES.map(({id,label,icon,budgetKey,defaultGB})=>({id,label,icon,budgetKey,defaultBytes:defaultGB*GB})),
    disk: { usedPercent: options.scenario === 'critical' ? 96 : 89, totalBytes: 207*GB,usedBytes:183*GB,availableBytes:24*GB },
    operation: options.scenario === 'running' ? { id:'other-job',ids:['npm'],state:'running',phase:'npm',completedIds:[],remainingIds:['npm'] } : structuredClone(operation),
    categories: options.scenario === 'loading' ? [] : [...rows(),
      {id:'tools',label:'Agents & toolchains',path:'/home/t3/.local/share/mise/installs',bytes:7.1*GB},
      {id:'backups',label:'Upgrade backups',path:'/home/t3/.t3/backups',bytes:13.6*GB},
      {id:'history',label:'Threads & agent data',path:'/home/t3/.t3/userdata',bytes:2.4*GB},
      {id:'workspace',label:'Projects',path:'/workspace/a-project-with-a-long-name/local-application-state',bytes:22*GB}] });
  const answer = (body,status=200) => ({body,status});
  const respond = (method,url,input={}) => {
    if (!url.pathname.includes('/storage')) return null;
    const at = end => url.pathname.endsWith(end);
    if (method === 'POST') requests.push({route:url.pathname,body:structuredClone(input)});
    if (at('/policy')) {
      if (options.failPolicy) return answer({ok:false,error:'Preferences could not be saved. Your edits are still here.'},503);
      if (input.revision && input.revision!==policyRevision(policy)) return answer({ok:false,code:'stale-policy',error:'Storage preferences changed elsewhere. Reload the latest preferences before saving.'},409);
      try { policy=validatePolicy(input.policy || input); }
      catch(error){return answer({ok:false,error:error.message},400);}
      return answer({ok:true,policy,policyRevision:policyRevision(policy)});
    }
    if (at('/clean/preview')) {
      if (options.failPreview) return answer({ok:false,error:'Cache locations could not be reviewed. Try again; no files have been changed.'},503);
      const caches=rows().filter(row=>input.ids.includes(row.id)).map(row=>({...row,eligible:row.cleanable&&row.bytes>0,status:!row.cleanable?'protected':row.bytes?'ready':'empty',
        reason:row.protection || (!row.bytes?'Already empty':null),detail:row.unavailable || (!row.bytes?'There is no cached data to clear.':null),method:row.id==='uv'?'prune':'clear'}));
      const token=randomBytes(32).toString('hex'),expiresAt=Date.now()+options.lifetime;
      plans.set(token,{eligible:caches.filter(row=>row.eligible).map(row=>row.id),expiresAt});
      return answer({ok:true,token,expiresAt,expiresInMs:options.lifetime,caches,estimatedBytes:caches.filter(row=>row.eligible).reduce((n,row)=>n+row.bytes,0),byteMeaning:'cache-data'});
    }
    if (at('/clean')) {
      const plan=plans.get(input.token);
      if(!plan || plan.expiresAt<=Date.now() || input.ids.some(id=>!plan.eligible.includes(id))) return answer({ok:false,code:'stale-preview',error:'This review has expired. Check the caches again.'},409);
      if(operation?.state==='running')return answer({ok:false,code:'busy',error:'Another cleanup is running. Check again when it finishes.'},409);
      plans.delete(input.token);
      const previous=operation;
      operation={id:'fixture-cleanup-'+(++serial),ids:input.ids,state:'running',phase:'checking',startedAt:Date.now(),finishedAt:null,completedIds:[],remainingIds:[...input.ids],removedCacheBytes:0,cacheResults:{},recent:previous?[previous]:[]};
      const job=operation;
      input.ids.forEach((id,index)=>{
        const timer=setTimeout(()=>{
          if(job.state!=='running')return;
          job.phase=id;
          if(options.failAt===id){Object.assign(job,{state:'failed',finishedAt:Date.now(),error:'A build started while checking '+id+'. Cleanup stopped; review the remaining caches when it finishes.'});return;}
          const remaining=id==='uv'?sizes[id]*.65:0;
          job.removedCacheBytes+=sizes[id]-remaining;sizes[id]=remaining;job.cacheResults[id]=remaining;
          job.completedIds.push(id);job.remainingIds=job.remainingIds.filter(item=>item!==id);
          if(index===input.ids.length-1)Object.assign(job,{state:'succeeded',phase:'done',finishedAt:Date.now()});
        },options.jobDelay*(index+1));timer.unref?.();
      });
      return answer({ok:true,operation:structuredClone(job)},202);
    }
    if(at('/versions')){
      const includePrevious=url.searchParams.get('includePrevious')==='true';
      return answer({ok:true,includePrevious,token:(includePrevious?'b':'a').repeat(64),estimatedBytes:1.2*GB,removableCount:includePrevious?3:2,items:[
        {name:'Claude Code',version:'2.1.303',eligible:true},{name:'Codex',version:'0.161.0',eligible:true},
        {name:'Claude Code',version:'2.1.307',eligible:false,reason:'Current version'},
        {name:'Codex',version:'0.162.0',eligible:includePrevious,reason:includePrevious?null:'Previous version'}]});
    }
    if(at('/prune'))return answer({ok:true,operation:{id:'fixture-version-job',ids:['versions'],state:'running',phase:'versions'}},202);
    if(at('/refresh'))return answer({ok:true,storage:status()},202);
    return answer(status());
  };
  return {options,requests,status,respond,changePolicy:change=>{policy=validatePolicy({...policy,...change});},get operation(){return operation;}};
};
module.exports={createStorageFixtures};
