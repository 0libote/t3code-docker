// Deterministic Files API fixtures. Never touches the host filesystem.
const crypto = require('node:crypto');
const path = require('node:path').posix;
const clone = value => structuredClone(value);
function createFilesFixtures({ now = Date.now(), scenario = 'ready' } = {}) {
  const at = new Date(now - 4 * 60_000).toISOString(), modified = new Date(now - 2 * 3600_000).toISOString();
  const work = '/workspace', home = '/home/t3';
  const capabilities = { browse: true, change: true, archives: false, space: false };
  const projectSpecs = [ ['acme-web',12.4,1.1,.42,10.88,'main',3,2,4], ['ml-experiments',9.8,7.2,.3,2.3,'exp/lora-sweep',0,0,2], ['mobile-app',6.2,4.8,.5,.9,'develop',0,1,3], ['infra',4.1,.5,.08,3.52,'main',0,0,1], ['docs-site',2.7,.9,.1,1.7,'main',12,0,6], ['old-prototype',1.9,1.65,.0,.25,'master',0,0,0], ['scratch',1.3,.9,0,.4,null,0,0,0] ];
  const projects=projectSpecs.map(([name,size,kept,git,rebuild,branch,changed,ahead,threads],index)=>({name,path:work+'/'+name,kind:'folder',bytes:size*1e9,composition:{keptBytes:kept*1e9,gitBytes:git*1e9,rebuildableBytes:rebuild*1e9},modified:new Date(now-[2,24,72,192,0.3,4100,384][index]*3600_000).toISOString(),git:branch?{root:work+'/'+name,branch,upstream:'origin/'+branch,changed,ahead,behind:0,available:true,loading:false,noRemote:name==='old-prototype',lastCommit:{subject:'Fix billing webhook retries',at:modified}}:null,running:index===0?[{pid:2214,label:'Dev server',port:3000,cwd:work+'/acme-web/apps/web'}]:[],activityComplete:true,threads:{count:threads,lastActiveAt:modified}}));
  const files=new Map(),folders=new Map();
  const add=(parent,name,kind,bytes,extra={})=>{const row={name,path:parent+'/'+name,kind,bytes,measured:true,modified,tags:[],...extra};if(!folders.has(parent))folders.set(parent,[]);folders.get(parent).push(row);if(kind==='folder'&&!folders.has(row.path))folders.set(row.path,[]);files.set(row.path,row);return row;};
  projects.forEach(row=>{files.set(row.path,row);folders.set(row.path,[]);});folders.set(work,projects);
  const web=work+'/acme-web/apps/web';
  add(work+'/acme-web','node_modules','folder',9.6e9,{tags:['rebuildable'],rebuildable:true});add(work+'/acme-web','apps','folder',1.7e9);add(work+'/acme-web','packages','folder',280e6);add(work+'/acme-web','.git','folder',420e6);add(work+'/acme-web','.turbo','folder',180e6,{tags:['rebuildable'],rebuildable:true});add(work+'/acme-web','coverage','folder',54e6,{tags:['rebuildable'],rebuildable:true});add(work+'/acme-web','pnpm-lock.yaml','code',1.2e6);
  add(work+'/acme-web/apps','web','folder',1.3e9);add(work+'/acme-web/apps','admin','folder',380e6);
  for(const [name,size] of [['@next',1.9e9],['@swc',1.1e9],['typescript',420e6],['@img',380e6],['esbuild',210e6],['react',120e6],['eslint',89e6],['tailwindcss',80e6]])add(work+'/acme-web/node_modules',name,'folder',size);
  for(const [name,size] of [['.next',820e6],['public',310e6],['node_modules',142e6],['src',4.2e6],['tests',1.1e6]])add(web,name,'folder',size,{tags:['.next','node_modules'].includes(name)?['rebuildable']:[],rebuildable:['.next','node_modules'].includes(name)});
  const code='// @ts-check\nimport { withSentryConfig } from "@sentry/nextjs";\n\n/** @type {import("next").NextConfig} */\nconst config = {\n  reactStrictMode: true,\n  output: "standalone",\n  images: {\n    remotePatterns: [{ hostname: "cdn.example.com" }],\n  },\n  experimental: {\n    typedRoutes: true,\n  },\n};\n\nexport default withSentryConfig(config);';
  const texts = new Map();
  for(const [name,kind,size,status,text] of [['README.md','text',4800,null,'# Acme web\n\nA project for the web.'],['next.config.mjs','code',2150,'M',code],['package.json','code',3400,'M','{\n  "name": "acme-web",\n  "private": true\n}'],['middleware.ts','code',2600,'U','export function middleware() {}'],['tsconfig.json','code',1200,null,'{ "compilerOptions": { "strict": true } }'],['.env.local','secret',128,null,'API_KEY=fixture-not-a-real-secret\nDATABASE_URL=postgres://fixture\n']]){const row=add(web,name,kind,size,{git:status,tags:kind==='secret'?['secret']:[]});texts.set(row.path,text);}
  add(web+'/public','logo.svg','image',150);add(web+'/public','brand-kit.zip','archive',8e6);add(web+'/public','hero.mp4','video',182e6);
  const homeSpecs=[['.t3',6.4e9,['managed'],'Threads and agent data'],['.local',14.8e9,['managed'],'Agents and toolchains'],['.cache',10e9,['managed'],'Caches'],['.codex',1.2e9,['sign-in'],'Codex sign-in and settings'],['.ssh',22e3,['keys'],'Private keys'],['notes',32e6,[],null]];
  for(const [name,size,tags,what] of homeSpecs)add(home,name,'folder',size,{tags,what});
  add(home,'hello.txt','text',48);texts.set(home+'/hello.txt','Your home folder is persistent.\n');add(home+'/.t3','userdata','folder',3.8e9,{tags:['managed'],what:'Threads and agent data'});add(home+'/.t3','runtime','folder',2.1e9,{tags:['managed'],what:'T3 Code runtimes'});add(home+'/.t3','setup','folder',500e6,{tags:['managed'],what:'Setup settings'});
  const managed=value=>value===home+'/.t3'||value.startsWith(home+'/.t3/')?{root:home+'/.t3',title:'Managed by T3 Code and Setup',body:'Threads, sign-ins, backups and runtimes live here. T3 Code and the Agents and Updates pages manage them, and check what’s in use first.',pages:['agents','updates']}:null;
  let measureCount=0,revision=0;
  const trash=new Map(),uploads=new Map(),undos=new Map();
  const etag=value=>'"fixture-'+revision+'-'+path.basename(value)+'"';
  const error=(code,message,extra={})=>({status:({locked:423,missing:404,invalid:400,changed:409,exists:409,conflicts:409,stale:409})[code]||409,body:{ok:false,code,error:message,...extra}});
  const remove=value=>{for(const [parent,rows]of folders)folders.set(parent,rows.filter(row=>row.path!==value&&!row.path.startsWith(value+'/')));for(const key of files.keys())if(key===value||key.startsWith(value+'/')){files.delete(key);texts.delete(key);folders.delete(key);}};
  const unique=(parent,name,suffix='')=>{const ext=path.extname(name),base=ext?name.slice(0,-ext.length):name;let candidate=name,n=2;while(files.has(path.join(parent,candidate)))candidate=base+' ('+(suffix?(n===2?suffix:suffix+' '+(n-1)):n)+')'+ext,n++;return candidate;};
  const capture=value=>[...files.values()].filter(row=>row.path===value||row.path.startsWith(value+'/')).map(row=>({row:clone(row),text:texts.get(row.path)}));
  const publish=(entries,from,to)=>{for(const {row,text}of entries){const next=to+row.path.slice(from.length),parent=path.dirname(next);const added=add(parent,path.basename(next),row.kind,row.bytes,{...row,path:next,name:path.basename(next)});if(text!==undefined)texts.set(added.path,text);}};
  const stash=value=>{const entries=capture(value),row=files.get(value),id='t_'+crypto.randomUUID();trash.set(id,{id,name:row.name,path:value,from:value,deletedAt:new Date().toISOString(),removeAt:new Date(Date.now()+7*86400_000).toISOString(),bytes:row.bytes,kind:row.kind,entries,batch:'batch_'+revision});remove(value);return id;};
  const listing=value=>{
    const entries=folders.get(value);if(!entries)return null;
    return {ok:true,path:value,requested:value,place:value.startsWith(work)?'projects':value.startsWith(home)?'home':'path',project:value.startsWith(work+'/acme-web')?work+'/acme-web':null,relative:value,writable:value!=='/usr',readOnly:value==='/usr',managed:managed(value),volumeId:'fixture-mount',volume:value.startsWith(work)?'workspace':'home',trash:work+'/.t3-trash',git:value.startsWith(work+'/acme-web')?projects[0].git:null,counts:{items:entries.length,hidden:entries.filter(row=>row.name.startsWith('.')).length,bytes:files.get(value)?.bytes||38.4e9,rebuildableBytes:entries.filter(row=>row.rebuildable).reduce((sum,row)=>sum+row.bytes,0)},entries:clone(entries),measuredAt:at,partial:false,more:false,total:entries.length};
  };
  const places=()=>({ok:true,capabilities,disk:{totalBytes:1e12,availableBytes:412e9,usedPercent:59,severity:'ok'},measuredAt:at,measuring:false,partial:false,projects:{writable:true,volumeId:"fixture-mount",path:work,count:projects.length,bytes:38.4e9,composition:{keptBytes:12.1e9,gitBytes:1.4e9,rebuildableBytes:24.9e9},workspaceIsRepo:false},home:{writable:true,volumeId:'fixture-mount',path:home,display:'~',volume:'t3-home',bytes:33.2e9,composition:[{id:'tools',label:'Agents and toolchains',bytes:14.8e9,part:'kept'},{id:'t3',label:'T3 Code data',bytes:6.4e9,part:'git'},{id:'caches',label:'Caches',bytes:10e9,part:'rebuild'},{id:'other',label:'Everything else',bytes:2e9,part:'other'}]},trash:{count:trash.size,bytes:[...trash.values()].reduce((sum,row)=>sum+row.bytes,0),retentionDays:7}});
  const respond=async(method,url,input={})=>{
    const route=url.pathname.replace(/^.*\/files/,'/files');if(!url.pathname.includes('/files/'))return null;
    const value=url.searchParams.get('path')||input.path||work;
    if(value==='/root')return {status:403,body:{ok:false,code:'no-access',error:'You can’t open /root. It belongs to root. This console runs as t3, like agents’ terminals.'}};
    if(route==='/files/places')return {body:places()};
    if(route==='/files/projects')return {body:{ok:true,projects:clone((folders.get(work)||[]).filter(row=>!row.name.startsWith('.'))),measuredAt:at,threadsAvailable:true}};
    if(route==='/files/list'){
      const data=listing(value);if(!data&&files.has(value))return {status:400,body:{ok:false,code:'invalid',error:'Open a folder.'}};if(!data)return {status:404,body:{ok:false,code:'missing',error:'This folder is no longer here.'}};
      const hidden=url.searchParams.get('hidden')==='1';data.entries=data.entries.filter(row=>hidden||!row.name.startsWith('.'));
      const sort=url.searchParams.get('sort')||'size',direction=url.searchParams.get('dir')==='asc'?1:-1;
      data.entries.sort((a,b)=>sort==='size'?(a.bytes-b.bytes)*direction:String(a[sort]||'').localeCompare(String(b[sort]||''),undefined,{numeric:true})*direction);
      data.total=data.entries.length;data.counts.items=data.total;data.etag='"'+crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex')+'"';return {body:data};
    }
    if(route==='/files/details'){
      const row=files.get(value)||{path:value,name:path.basename(value),kind:'folder',bytes:folders.has(value)?38.4e9:null};
      const text=texts.get(value);return {body:{ok:true,...clone(row),isProject:projects.some(row=>row.path===value),files:row.kind==='folder'?48201:null,largestFolders:(folders.get(value)||[]).filter(row=>row.kind==='folder').slice(0,4).map(row=>({...row,path:row.name})),rebuildable:{loading:false,candidates:[]},type:row.kind==='secret'?'Environment file':row.kind==='code'?'JavaScript':row.kind==='text'?'Markdown':row.kind,owner:'t3',mode:'rw-r--r--',modified,secret:row.kind==='secret',signIns:row.tags?.includes('sign-in')?['Codex']:[],keys:row.tags?.includes('keys'),preview:text!==undefined?'text':row.kind==='image'?'image':null,editable:text!==undefined,etag:etag(value),lines:text?.split('\n').length,encoding:'utf-8',managed:managed(value)}};
    }
    if(route==='/files/read')return texts.has(value)?{body:{ok:true,kind:'text',text:texts.get(value),bytes:files.get(value).bytes,truncated:false,etag:etag(value),editable:true}}:{status:404,body:{ok:false,code:'missing',error:'This file is no longer here.'}};
    if(route==='/files/raw')return {raw:Buffer.from(value.endsWith('.svg')?'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="20" fill="#1d4ed8"/><text x="22" y="75" fill="white" font-size="40">T3</text></svg>':texts.get(value)||'fixture bytes'),headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="'+path.basename(value)+'"','x-content-type-options':'nosniff'}};
    if(route==='/files/tree'){
      const data=listing(value);if(!data)return {status:404,body:{ok:false,code:'missing',error:'This folder is no longer here.'}};
      const bytes=files.get(value)?.bytes||38.4e9,limit=Number(url.searchParams.get('limit')||6),all=data.entries.sort((a,b)=>b.bytes-a.bytes).map(row=>({...row,share:row.bytes/bytes*100,hasChildren:row.kind==='folder'}));return {body:{ok:true,path:value,bytes,measuredAt:at,children:all.slice(0,limit),total:all.length,more:all.length>limit?{count:all.length-limit,bytes:all.slice(limit).reduce((sum,row)=>sum+row.bytes,0)}:null}};
    }
    if(route==='/files/largest')return {body:{ok:true,path:value,files:[{path:'.git/objects/pack/pack-3f9e1c.pack',bytes:388e6,part:'git'},{path:'apps/web/public/hero.mp4',bytes:182e6,part:'kept'}],truncated:false}};
    if(route==='/files/search'){
      const q=(url.searchParams.get('q')||'').toLowerCase();const results=[...files.values()].filter(row=>row.path.startsWith(value+'/')&&row.name.toLowerCase().includes(q)).slice(0,200).map(row=>({...row,relativeFolder:path.dirname(row.path).slice(value.length+1)||'.'}));return {body:{ok:true,path:value,results,searched:12402,skippedRebuildable:12,truncated:false}};
    }
    if(route==='/files/suggest'){
      const q=(url.searchParams.get('q')||'').replace(/^~/,home);return {body:{ok:true,base:path.dirname(q),matches:[...folders.keys()].filter(file=>file.startsWith(q)).slice(0,20).map(file=>({path:file,display:file.replace(home,'~')+'/',bytes:files.get(file)?.bytes||0,tags:[]}))}};
    }
    if(route==='/files/trash')return {body:{ok:true,items:[...trash.values()].map(({entries,...row})=>row),revision:String(revision),bytes:[...trash.values()].reduce((sum,row)=>sum+row.bytes,0),retentionDays:7,locations:[work+'/.t3-trash',home+'/.t3/trash']}};
    if(route==='/files/measure'){measureCount++;return {body:{ok:true,measuring:true,job:'j_fixture_measure'}};}
    if(route==='/files/jobs')return {body:{ok:true,jobs:[...(measureCount?[{id:'j_fixture_measure',kind:'measure',label:path.basename(value),path:value,state:'done',done:48201,unit:'files',finishedAt:new Date(now).toISOString()}]:[]),...[...uploads.values()].map(row=>({id:row.id,kind:'upload',label:row.path,relative:row.path,dest:row.dest,path:path.join(row.dest,row.path),state:row.result?'done':'waiting',received:row.received,total:row.size,unit:'bytes',result:row.result,finishedAt:row.result?new Date().toISOString():null}))]}};
    if(method==='POST'){
      const source=input.path||input.paths?.[0]||input.dest||input.parent,rule=typeof source==='string'&&managed(source);
      if(rule&&input.unlock!==rule.root)return error('locked','This location is managed.',{managed:rule});
      if(route==='/files/mkdir'){
        const target=path.join(input.parent,input.name);if(files.has(target))return error('exists','This name is already here. Choose another name.');add(input.parent,input.name,'folder',0);revision++;return {body:{ok:true,path:target}};
      }
      if(route==='/files/rename'){
        if(!files.has(input.path))return error('missing','This item is no longer here.');const dest=path.join(path.dirname(input.path),input.name);if(files.has(dest))return error('exists','This name is already here.');const old=capture(input.path);remove(input.path);publish(old,input.path,dest);revision++;return {body:{ok:true,path:dest}};
      }
      if(route==='/files/write'){
        if(input.mode==='save'&&input.etag!==etag(input.path))return error('changed','This file changed on disk while you were editing.',{current:{text:texts.get(input.path),etag:etag(input.path),modified:new Date().toISOString(),kind:'text'}});
        const target=input.mode==='copy'?path.join(path.dirname(input.path),unique(path.dirname(input.path),path.basename(input.path),'copy')):input.path;
        if(input.mode==='create'&&files.has(target))return error('exists','This name is already here.');
        if(!files.has(target))add(path.dirname(target),path.basename(target),/\.env/.test(target)?'secret':'text',0);
        texts.set(target,input.text);files.get(target).bytes=Buffer.byteLength(input.text);revision++;return {body:{ok:true,path:target,etag:etag(target),bytes:Buffer.byteLength(input.text)}};
      }
      if(route==='/files/to-trash'){const ids=input.paths.map(stash);revision++;return {body:{ok:true,ids,undo:'batch_'+(revision-1)}};}
      if(route==='/files/trash/restore'){
        const items=input.undo?[...trash.values()].filter(row=>row.batch===input.undo):(input.ids||[]).map(id=>trash.get(id)).filter(Boolean),restored=[];
        for(const row of items){const target=path.join(path.dirname(row.from),unique(path.dirname(row.from),row.name,'restored'));publish(row.entries,row.from,target);trash.delete(row.id);restored.push({id:row.id,path:target});}revision++;return {body:{ok:true,restored}};
      }
      if(route==='/files/trash/empty'){for(const id of input.ids||[...trash.keys()])trash.delete(id);revision++;return {body:{ok:true}};}
      if(route==='/files/move'){
        if(input.undo){const plans=undos.get(input.undo)||[];for(const [from,to]of plans){const rows=capture(to);remove(to);publish(rows,to,from);}revision++;return {body:{ok:true}};}
        const conflicts=input.paths.filter(from=>files.has(path.join(input.dest,path.basename(from)))&&!input.choices?.[path.basename(from)]&&input.onConflict!=='keep-both').map(from=>({name:path.basename(from),existing:{bytes:files.get(path.join(input.dest,path.basename(from))).bytes,modified}}));if(conflicts.length)return error('conflicts','Some names are already here.',{conflicts});
        const done=[];for(const from of input.paths){let name=path.basename(from),target=path.join(input.dest,name),choice=input.choices?.[name]||input.onConflict;if(choice==='skip')continue;if(input.duplicate||choice==='keep-both'){name=unique(input.dest,name,input.duplicate?'copy':'');target=path.join(input.dest,name);}if(files.has(target))stash(target);const old=capture(from);if(!input.copy)remove(from);publish(old,from,target);done.push([from,target]);}revision++;const undo='undo_'+crypto.randomUUID();undos.set(undo,done);return {body:{ok:true,instant:true,paths:done.map(row=>row[1]),undo}};
      }
      if(route==='/files/upload/start'){
        const results=[];for(const item of input.items){const id='u_'+crypto.randomUUID(),target=path.join(input.dest,item.path);if(item.directory){if(!folders.has(target))add(path.dirname(target),path.basename(target),'folder',0);results.push({directory:true,result:{path:target}});continue;}
          const prior=[...uploads.values()].find(row=>!row.result&&row.path===item.path&&row.dest===input.dest&&row.size===item.size&&row.lastModified===item.lastModified),row=prior||{...item,id,dest:input.dest,received:0,chunks:[]};uploads.set(row.id,row);results.push({id:row.id,path:row.path,size:row.size,received:row.received,...(files.has(target)?{conflict:{existing:{bytes:files.get(target).bytes,modified,revision:etag(target)}}}:{})});}
        return {body:{ok:true,uploads:results,chunkBytes:8*1024*1024}};
      }
      if(route==='/files/upload/chunk'){const row=uploads.get(url.searchParams.get('id'));if(!row)return error('missing','This upload no longer exists.');if(Number(url.searchParams.get('offset'))!==row.received)return error('changed','Continue from the saved offset.',{received:row.received});const bytes=Buffer.isBuffer(input)?input:Buffer.from(input.raw||'');row.chunks.push(bytes);row.received+=bytes.length;return {body:{ok:true,received:row.received}};}
      if(route==='/files/upload/finish'){
        const row=uploads.get(input.id);if(!row)return error('missing','This upload no longer exists.');if(row.result)return {body:{ok:true,...row.result}};let target=path.join(row.dest,row.path);if(files.has(target)){if(!input.onConflict||input.onConflict==='ask')return error('conflicts','This name is already here.',{conflicts:[{name:row.path,existing:{bytes:files.get(target).bytes,modified,revision:etag(target)}}]});if(input.onConflict==='keep-both')target=path.join(path.dirname(target),unique(path.dirname(target),path.basename(target)));else if(input.onConflict==='replace')stash(target);else{row.result={path:target,skipped:true};return {body:{ok:true,...row.result}};}}
        add(path.dirname(target),path.basename(target),'text',row.size);texts.set(target,Buffer.concat(row.chunks).toString());row.result={path:target};revision++;return {body:{ok:true,...row.result}};
      }
      if(route==='/files/upload/cancel'){for(const id of input.ids)uploads.delete(id);return {body:{ok:true}};}
      if(route==='/files/jobs/cancel')return {body:{ok:true}};
    }
    return {status:404,body:{ok:false,code:'missing',error:'This Files action is not available in the browse preview.'}};
  };
  folders.set('/usr',[]);
  return {respond,places,projects:()=>clone(projects)};
}
module.exports={createFilesFixtures};
