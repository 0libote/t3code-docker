import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createFilesSizesIndex } from '../docker/harness/storage/files-sizes.mjs';
import { countProjects } from '../docker/harness/storage/system.mjs';

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-files-sizes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { file: path.join(root, 'state/files-sizes.json.gz'), home: path.join(root, 'home'), workspace: path.join(root, 'workspace'), ...extra };
  return { root, options, index: createFilesSizesIndex(options) };
}

test('sizes reuse collected results, persist privately, and restore without traversing user files', async (t) => {
  const { options, index } = await fixture(t), { home, workspace } = options;
  await index.ready; assert.equal(index.snapshot().at, null);
  const values = { [workspace]: 1000, [workspace + '/project']: 900, [workspace + '/project/src']: 800, [home]: 200, [home + '/.cache']: 120, '/etc': 100 };
  assert.equal(await index.replace(values, { at: 1234 }), true);
  const old = index.snapshot();
  assert.equal(old.bytesOf(workspace + '/project'), 900); assert.equal(old.bytesOf('/etc'), null);
  assert.deepEqual(old.childrenOf(workspace), [{ path: workspace + '/project', bytes: 900 }]);
  assert.equal((await fs.stat(options.file)).mode & 0o777, 0o600);
  const restored = createFilesSizesIndex(options); await restored.ready;
  assert.equal(restored.snapshot().at, 1234); assert.equal(restored.snapshot().bytesOf(home), 200);
  await index.replace({ [workspace]: 2000 }, { at: 2345, partial: true });
  assert.equal(old.bytesOf(workspace), 1000, 'a request keeps its consistent snapshot across background scans');
  assert.equal(index.snapshot().bytesOf(workspace), 2000); assert.equal(index.snapshot().partial, true);
  assert.deepEqual((await fs.readdir(path.dirname(options.file))).sort(), ['files-sizes.json.gz']);
});

test('corrupt, oversized, foreign and malformed cached metadata become a cold index', async (t) => {
  const { options } = await fixture(t);
  await fs.mkdir(path.dirname(options.file), { recursive: true });
  const base = { schema: 1, home: options.home, workspace: options.workspace, at: 100, entries: [[options.home, 10]] };
  for (const bytes of [Buffer.from('bad gzip'), gzipSync(JSON.stringify({ ...base, home: '/another-user' })), gzipSync(JSON.stringify({ ...base, entries: [null] })), gzipSync(JSON.stringify({ ...base, at: '100' })), gzipSync('x'.repeat(16 * 1024 * 1024 + 1))]) {
    await fs.writeFile(options.file, bytes);
    const index = createFilesSizesIndex(options); await index.ready;
    assert.equal(index.snapshot().at, null);
  }
});

test('bounded indexes are explicitly partial and reject invalid paths and sizes', async (t) => {
  const { index, options } = await fixture(t, { maxEntries: 2 });
  await index.replace({ '/outside': 100, [options.home]: 10, [options.home + '/negative']: -1, [options.workspace]: 20, [options.workspace + '/extra']: 30 });
  assert.equal(index.snapshot().partial, true); assert.equal(index.snapshot().bytesOf('/outside'), null);
  assert.equal(index.snapshot().bytesOf(options.home + '/negative'), null); assert.equal(index.snapshot().bytesOf(options.workspace + '/extra'), null);
});

test('project counts use all visible top-level directories, exclude links, and recognize a repository workspace', async (t) => {
  const { root } = await fixture(t), workspace = path.join(root, 'projects');
  for (const name of ['repo/.git', 'scratch', '.hidden', 'data']) await fs.mkdir(path.join(workspace, name), { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), 'hello');
  await fs.symlink(path.join(workspace, 'repo'), path.join(workspace, 'link'));
  assert.equal(await countProjects(workspace), 3);
  await fs.writeFile(path.join(workspace, '.git'), 'gitdir: ../somewhere');
  assert.equal(await countProjects(workspace), 1);
});
