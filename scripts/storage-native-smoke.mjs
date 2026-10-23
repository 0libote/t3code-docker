#!/usr/bin/env node
// Real cleanup commands in disposable homes. Requires the image's installed
// Go, uv, Bun and Deno plus mise and Python; never installs or updates any tool.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
const harness = process.env.T3_STORAGE_HARNESS_ROOT || fileURLToPath(new URL('../docker/harness/', import.meta.url));
const { createStorageManager } = await import(pathToFileURL(path.join(harness,'storage/manager.mjs')));
const { createRunner } = await import(pathToFileURL(path.join(harness,'io.mjs')));
const { executableOnPath } = await import(pathToFileURL(path.join(harness,'storage/system.mjs')));
const run = createRunner(), exists = file => fs.access(file).then(()=>true,()=>false);
const execute = async (argv, options, label) => {
  const result = await run(argv,{...options,timeoutMs:30000});
  assert.equal(result.code,0,label + ': native command must finish successfully');
  assert.equal(result.error,null,label + ': native command must not time out');
  return result;
};
const bins = {};
for (const tool of ['mise','go','uv','bun','deno']) {
  const override = process.env['T3_STORAGE_' + tool.toUpperCase() + '_BIN'];
  if (override) { bins[tool] = await fs.realpath(override); continue; }
  if (tool === 'mise') {
    const executable = await executableOnPath('mise',process.env); assert(executable,'mise must be installed');
    bins.mise = await fs.realpath(executable); continue;
  }
  const result = await execute([bins.mise,'which',tool],{env:{...process.env,MISE_AUTO_INSTALL:'false'},cwd:os.homedir()},'resolve '+tool);
  bins[tool] = await fs.realpath(result.stdout.trim());
}
const root = await fs.mkdtemp(path.join(os.tmpdir(),'t3-storage-native-'));
const fixture = async name => {
  const dir = path.join(root,name),home = path.join(dir,'home'),workspace = path.join(dir,'workspace'),temporary = path.join(dir,'tmp');
  await Promise.all([home,workspace,temporary].map(p=>fs.mkdir(p,{recursive:true})));
  const env = {HOME:home,PATH:[path.dirname(process.execPath),...Object.values(bins).map(p=>path.dirname(p)),'/usr/bin','/bin'].join(':'),LANG:'C.UTF-8',
    T3CODE_HOME:path.join(home,'.t3'),MISE_CONFIG_DIR:path.join(home,'.config/mise'),MISE_DATA_DIR:path.join(home,'.local/share/mise'),
    MISE_STATE_DIR:path.join(home,'.local/state/mise'),MISE_CACHE_DIR:path.join(home,'.cache/mise'),
    UV_CACHE_DIR:path.join(home,'.cache/uv'),UV_PYTHON_DOWNLOADS:'never',UV_OFFLINE:'1',UV_NO_CONFIG:'1',
    BUN_INSTALL_CACHE_DIR:path.join(home,'.bun/install/cache'),GOCACHE:path.join(home,'.cache/go-build'),GOTOOLCHAIN:'local'};
  const managers=[];
  const manager = detected => {
    const service=createStorageManager({home,workspace,temporary,env,intervalMs:0,refreshAfterCleanup:false,
      processes:async()=>({complete:true,processes:[]}),detectCaches:async()=>detected});
    managers.push(service);return service;
  };
  return {dir,home,workspace,temporary,env,manager,stop:()=>managers.forEach(service=>service.stop())};
};
const put = async (file,data='keep') => {await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);return file;};
let checks=0;
try {
  const f=await fixture('go-boundary');
  try {
    const npm=path.join(f.home,'.npm'),tool=await put(path.join(npm,'_npx/tool/index.js'),'installed npx tool');
    const unsafe=f.manager({gomod:{path:npm,executable:bins.go}});
    assert.equal((await unsafe.clean(['gomod'])).ok,false);
    assert.equal(await fs.readFile(tool,'utf8'),'installed npx tool');checks++;
    const own=path.join(f.home,'go/pkg/mod'),download=await put(path.join(own,'example.com/module@v1.0.0/go.mod'),'module example.com/module\n');
    const safe=f.manager({gomod:{path:own,executable:bins.go}});
    assert.equal((await safe.clean(['gomod'])).ok,true);
    assert.equal(await exists(download),false);assert.equal(await exists(tool),true);checks++;
    console.log('PASS native Go: cache ownership and installed npx tools');
  } finally {f.stop();}

  const m=await fixture('mise-scope');
  try {
    const external=path.join(m.workspace,'task-cache');m.env.MISE_TASK_CACHE_DIR=external;
    const task=await put(path.join(external,'v2/keep'),'external task cache');
    const state=await put(path.join(m.env.MISE_STATE_DIR,'env-cache/keep'),'environment cache');
    await put(path.join(m.env.MISE_CACHE_DIR,'node/metadata'),'cache');
    const service=m.manager({mise:{path:m.env.MISE_CACHE_DIR,executable:bins.mise}});
    const plan=await service.previewClean(['mise']);assert.equal(plan.caches[0].eligible,true);
    assert.equal((await service.clean(['mise'],{token:plan.token})).ok,true);
    assert.equal(await fs.readFile(task,'utf8'),'external task cache');assert.equal(await fs.readFile(state,'utf8'),'environment cache');checks+=2;
    console.log('PASS native mise: external task and environment caches stay untouched');
  } finally {m.stop();}

  const b=await fixture('bun-dependencies');
  try {
    const target=b.env.BUN_INSTALL_CACHE_DIR,store=path.join(target,'links/probe/node_modules/t3-storage-probe');
    await put(path.join(store,'package.json'),'{"name":"t3-storage-probe","main":"index.js"}');
    await put(path.join(store,'index.js'),'exports.value=42;\n');
    await fs.mkdir(path.join(b.workspace,'node_modules'),{recursive:true});
    await fs.symlink(store,path.join(b.workspace,'node_modules/t3-storage-probe'));
    const load=[process.execPath,'-e','if(require("t3-storage-probe").value!==42)process.exit(1)'];
    await execute(load,{env:b.env,cwd:b.workspace},'shared dependency before cleanup');
    const protectedCache=b.manager({bun:{path:target,executable:bins.bun}});
    assert.equal((await protectedCache.previewClean(['bun'])).caches[0].eligible,false);
    assert.equal((await protectedCache.clean(['bun'])).ok,false);
    await execute(load,{env:b.env,cwd:b.workspace},'shared dependency after cleanup');checks++;
    console.log('PASS native Bun: shared-store project dependencies remain usable');
  } finally {b.stop();}

  const p=await fixture('bun-pinned');
  try {
    const target=p.env.BUN_INSTALL_CACHE_DIR,foreign=await put(path.join(p.dir,'outside/keep'),'foreign cache');
    const data=await put(path.join(target,'download'),'disposable');p.env.BUN_INSTALL_CACHE_DIR=path.dirname(foreign);
    const service=p.manager({bun:{path:target,executable:bins.bun}});
    assert.equal((await service.clean(['bun'])).ok,true);assert.equal(await exists(data),false);
    assert.equal(await fs.readFile(foreign,'utf8'),'foreign cache');checks++;
    console.log('PASS native Bun: scratch project and explicit cache target');
  } finally {p.stop();}

  const d=await fixture('deno-pinned');
  try {
    const target=path.join(d.home,'.cache/deno'),data=await put(path.join(target,'remote/download'),'disposable');
    const foreign=await put(path.join(d.dir,'outside/keep'),'foreign cache'),project=await put(path.join(d.workspace,'main.ts'),'console.log(42);\n');
    d.env.DENO_DIR=path.dirname(foreign);
    const service=d.manager({deno:{path:target,executable:bins.deno}});
    const plan=await service.previewClean(['deno']);assert.equal(plan.caches[0].eligible,true);
    assert.equal((await service.clean(['deno'],{token:plan.token})).ok,true);
    assert.equal(await exists(data),false);assert.equal(await fs.readFile(foreign,'utf8'),'foreign cache');assert.equal(await exists(project),true);checks++;
    console.log('PASS native Deno: explicit cache target; projects and foreign caches stay untouched');
  } finally {d.stop();}

  const u=await fixture('uv-links');
  try {
    const wheel=path.join(u.dir,'t3_storage_probe-0.0.1-py3-none-any.whl'),python=process.env.T3_STORAGE_PYTHON || '/usr/bin/python3';
    const program=`import sys,zipfile,csv,io\nfiles={'t3_storage_probe/__init__.py':'VALUE=42\\n','t3_storage_probe/payload.dat':'X'*65536,'t3_storage_probe-0.0.1.dist-info/METADATA':'Metadata-Version: 2.1\\nName: t3-storage-probe\\nVersion: 0.0.1\\n','t3_storage_probe-0.0.1.dist-info/WHEEL':'Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'}\nr=io.StringIO();w=csv.writer(r,lineterminator='\\n')\nfor name,data in files.items():w.writerow([name,'',len(data.encode())])\nw.writerow(['t3_storage_probe-0.0.1.dist-info/RECORD','','']);files['t3_storage_probe-0.0.1.dist-info/RECORD']=r.getvalue()\nwith zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:\n for name,data in files.items():z.writestr(name,data)\n`;
    await execute([python,'-c',program,wheel],{env:u.env,cwd:u.dir},'local wheel');
    const environments=[];
    for(const mode of ['hardlink','symlink']){
      const venv=path.join(u.workspace,mode);
      await execute([bins.uv,'venv','--python',python,venv],{env:u.env,cwd:u.workspace},'uv venv '+mode);
      await execute([bins.uv,'pip','install','--python',path.join(venv,'bin/python'),'--link-mode',mode,wheel],{env:u.env,cwd:u.workspace},'uv install '+mode);
      environments.push(path.join(venv,'bin/python'));
    }
    const service=u.manager({uv:{path:u.env.UV_CACHE_DIR,executable:bins.uv}});
    const plan=await service.previewClean(['uv']),result=await service.clean(['uv'],{token:plan.token});
    assert.equal(result.ok,true);assert.equal(result.reclaimedBytes,null);assert.equal(result.byteMeaning,'cache-data');
    for(const interpreter of environments)await execute([interpreter,'-c','import t3_storage_probe;assert t3_storage_probe.VALUE==42'],{env:u.env,cwd:u.workspace},'installed Python package after pruning');
    checks+=3;console.log('PASS native uv: hardlinked and symlinked environments survive; no false freed-space claim');
  } finally {u.stop();}
  console.log(`PASS ${checks} native Storage safety checks (no network or production data)`);
} finally {await fs.rm(root,{recursive:true,force:true});}
