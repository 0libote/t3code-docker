import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Codex key smoke checks complete responses and native exits without closing producer pipes early', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-smoke-auth-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=await fs.readFile(new URL('../scripts/smoke-test.sh',import.meta.url),'utf8');
  const body=source.match(/^codex_key_stored\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(body);
  const fixture=path.join(root,'transport.cjs'),log=path.join(root,'audit.log');
  await fs.writeFile(fixture,`
process.stdout.on('error',()=>process.exit(81));
process.stderr.on('error',()=>process.exit(82));
const mode=process.env.SMOKE_AUTH_MODE;
if(process.argv[2]==='api'){
 if(mode==='transport-failed')process.exit(7);
 process.stdout.write(mode==='invalid-json'?'not JSON':JSON.stringify(mode==='rejected'?{ok:false,details:{ok:true}}:{ok:true,padding:'x'.repeat(262144)}));
}else{
 const out=mode==='stderr'?process.stderr:process.stdout;
 out.write(mode==='wrong-auth'?'Logged in using ChatGPT\\n':'API key configured - fixture\\n'+' '.repeat(262144));
 if(mode==='native-failed')process.exitCode=9;
}
`);
  const script=`set -euo pipefail
auth_post() { "$SMOKE_NODE" "$SMOKE_AUTH_FIXTURE" api; }
as_t3() { "$SMOKE_NODE" "$SMOKE_AUTH_FIXTURE" status; }
${body}
codex_key_stored`;
  const run=mode=>spawnSync('bash',['-c',script],{encoding:'utf8',timeout:10000,
    env:{...process.env,SMOKE_NODE:process.execPath,SMOKE_AUTH_FIXTURE:fixture,SMOKE_AUTH_MODE:mode,UI_AUDIT_LOG:log}});
  for(const mode of ['noisy','stderr']){
    const result=run(mode);
    assert.equal(result.status,0,`${mode}: ${result.stderr}`);
  }
  for(const mode of ['rejected','invalid-json','transport-failed','native-failed','wrong-auth']){
    assert.notEqual(run(mode).status,0,mode+' must fail the actual smoke check');
  }
  assert.match(await fs.readFile(log,'utf8'),/Codex/);
});
