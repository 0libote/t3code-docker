import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createGitService, parseGitStatus } from '../docker/setup/files/git.mjs';
import { createCommandRunner } from '../docker/setup/files/io.mjs';

test('status v2 preserves whitespace and renamed paths without counting the old name', () => {
  const text = '# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0'
    + '1 .M N... 100644 100644 100644 abc def source with spaces.js\0'
    + '2 R. N... 100644 100644 100644 abc def R100 new\nname.js\0old name.js\0? new file.md\0'
    + '1 A. N... 000000 100644 100644 abc def __proto__\0';
  const parsed = parseGitStatus(text);
  assert.equal(parsed.branch, 'main'); assert.equal(parsed.upstream, 'origin/main'); assert.equal(parsed.ahead, 2); assert.equal(parsed.behind, 3);
  assert.equal(parsed.changed, 4); assert.equal(parsed.statuses['source with spaces.js'], 'M'); assert.equal(parsed.statuses['new\nname.js'], 'M');
  assert.equal(parsed.statuses['new file.md'], 'U'); assert.equal(parsed.statuses.__proto__, 'A'); assert.equal({}.polluted, undefined);
});

test('real repository reads never run hooks or fsmonitor and distinguish no remote from no upstream', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-files-git-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const execute = createCommandRunner({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = args => execute('git', ['-C', root, ...args], { cwd: root });
  await git(['init', '-b', 'main']); await fs.writeFile(path.join(root, 'read me.md'), 'original'); await git(['add', '--', 'read me.md']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial fixture']);
  const marker = path.join(root, 'executed');
  const hook = path.join(root, 'unsafe-hook'); await fs.writeFile(hook, '#!/bin/sh\ntouch "' + marker + '"\n', { mode: 0o755 });
  await git(['config', 'core.fsmonitor', hook]); await git(['config', 'core.hooksPath', root]);
  await fs.writeFile(path.join(root, 'post-index-change'), '#!/bin/sh\ntouch "' + marker + '"\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'read me.md'), 'changed'); await fs.writeFile(path.join(root, 'untracked file'), 'new');
  const service = createGitService({ env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(service.get(root).loading, true, 'a cold listing does not wait for Git');
  const state = await service.settled(root);
  assert.equal(state.available, true); assert.equal(state.branch, 'main'); assert.equal(state.noRemote, true); assert.equal(state.unpushed, 1);
  assert.equal(state.statuses['read me.md'], 'M'); assert.equal(state.statuses['untracked file'], 'U');
  assert.equal(await fs.access(marker).then(() => true, () => false), false);
  await git(['remote', 'add', 'origin', 'https://example.invalid/repository.git']); service.invalidate(root);
  const remote = await service.settled(root); assert.equal(remote.noRemote, false); assert.equal(remote.upstream, null);
});

test('failed Git probes remain an unavailable row fact and retries are cached', async () => {
  let time = 100, calls = 0;
  const service = createGitService({ now: () => time, run: async (file, args, options) => {
    calls++; assert.equal(file, 'git'); assert(args.includes('core.fsmonitor=false')); assert(args.includes('core.hooksPath=/dev/null'));
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 4 * 1024 * 1024); throw new Error('timed out');
  } });
  const first = await service.settled('/repo'); assert.equal(first.available, false); assert.equal(first.error, 'Git status unavailable');
  const before = calls; service.get('/repo'); assert.equal(calls, before);
  time += 15_001; await service.settled('/repo'); assert(calls > before);
});

test('Git content filters are never executed as a side effect of browsing', async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'t3-files-filter-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const execute=createCommandRunner({...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}),git=args=>execute('git',['-C',root,...args]);
 await git(['init','-q']);await fs.writeFile(path.join(root,'source.txt'),'before');await git(['add','source.txt']);
 const marker=path.join(root,'filter-ran'),filter=path.join(root,'filter');
 await fs.writeFile(filter,'#!/bin/sh\ntouch "'+marker+'"\ncat\n',{mode:0o755});
 await git(['config','filter.untrusted.clean',filter]);await fs.writeFile(path.join(root,'.gitattributes'),'source.txt filter=untrusted\n');await fs.writeFile(path.join(root,'source.txt'),'after');
 const service=createGitService({env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}),facts=await service.settled(root);
 assert.equal(facts.available,false);assert.equal(facts.error,'Git status unavailable');assert.equal(await fs.access(marker).then(()=>true,()=>false),false);
});
