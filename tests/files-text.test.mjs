import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { readText, rawFile, parseRange, PREVIEW_BYTES, EDIT_BYTES } from '../docker/setup/files/text.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 't3-files-text-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const bytesOf = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

test('previews and complete editor reads are UTF-8 bounded and carry real version fingerprints', async (t) => {
  const root = await fixture(t), file = path.join(root, '.env.local');
  await fs.writeFile(file, 'TOKEN=private fixture\r\n');
  const first = await readText(file); assert.equal(first.secret, true); assert.equal(first.eol, 'crlf'); assert.equal(first.editable, true);
  await fs.writeFile(file, 'TOKEN=another fixture\r\n'); assert.notEqual((await readText(file)).etag, first.etag);
  await fs.writeFile(file, Buffer.concat([Buffer.alloc(PREVIEW_BYTES - 1, 97), Buffer.from('語') ]));
  const short = await readText(file); assert.equal(short.kind, 'text'); assert.equal(short.truncated, true); assert.equal(short.text.includes('\ufffd'), false);
  assert.equal(short.editable, true, 'preview truncation does not hide the 5 MiB editor');
  assert.equal((await readText(file, { edit: true })).text.endsWith('語'), true);
  await fs.writeFile(file, Buffer.alloc(EDIT_BYTES + 1, 97));
  await assert.rejects(readText(file, { edit: true }), { code: 'too-large' });
});

test('binary and malformed text never become an editable file', async (t) => {
  const root = await fixture(t), file = path.join(root, 'data');
  for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe]), Buffer.concat([Buffer.alloc(9000, 97), Buffer.from([0])])]) {
    await fs.writeFile(file, bytes); const read = await readText(file); assert.equal(read.kind, 'binary'); assert.equal(read.editable, false); assert.equal(read.text, undefined);
  }
  await assert.rejects(readText(root), { code: 'invalid' });
});

test('raw downloads stream bytes, sandbox active types and implement single byte ranges', async (t) => {
  const root = await fixture(t), file = path.join(root, 'page "日本語".html'), content = Buffer.from('<script>not executed</script>');
  await fs.writeFile(file, content);
  const whole = await rawFile(file);
  assert.equal(whole.status, 200); assert.deepEqual(await bytesOf(whole.stream), content);
  assert.equal(whole.headers['content-type'], 'application/octet-stream'); assert.equal(whole.headers['x-content-type-options'], 'nosniff');
  assert.equal(whole.headers['content-security-policy'], "sandbox; default-src 'none'"); assert(whole.headers['content-disposition'].startsWith("attachment; filename*=UTF-8''"));
  const part = await rawFile(file, { range: 'bytes=3-7' }); assert.equal(part.status, 206); assert.deepEqual(await bytesOf(part.stream), content.subarray(3, 8));
  assert.equal(part.headers['content-range'], `bytes 3-7/${content.length}`);
  const stale = await rawFile(file, { range: 'bytes=3-7', ifRange: 'old' }); assert.equal(stale.status, 200); await bytesOf(stale.stream);
});

test('range parsing rejects multipart, unsafe offsets and unsatisfiable requests', () => {
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 }); assert.deepEqual(parseRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepEqual(parseRange('bytes=0-99', 10), { start: 0, end: 9 });
  for (const value of ['bytes=0-1,3-4', 'bytes=-0', 'bytes=10-', 'bytes=3-1', 'bytes=9007199254740992-', 'wrong']) assert.throws(() => parseRange(value, 10), { code: 'range' });
  assert.throws(() => parseRange('bytes=0-', 0), { code: 'range' });
});

test('read follows an explicitly opened file link while preserving the download name', async (t) => {
  const root = await fixture(t), target = path.join(root, 'file.txt'), link = path.join(root, 'alias.txt');
  await fs.writeFile(target, 'hello'); await fs.symlink(target, link);
  assert.equal((await readText(link)).text, 'hello'); const raw = await rawFile(link);
  assert(raw.headers['content-disposition'].endsWith('alias.txt')); assert.equal((await bytesOf(raw.stream)).toString(), 'hello');
});

test('stream framing stays correct when a file grows, and empty files finish cleanly', async (t) => {
  const root = await fixture(t), file = path.join(root, 'growing');
  await fs.writeFile(file, 'first'); const raw = await rawFile(file); await fs.appendFile(file, 'second');
  assert.equal((await bytesOf(raw.stream)).toString(), 'first'); assert.equal(raw.headers['content-length'], '5');
  await fs.writeFile(file, ''); const empty = await rawFile(file);
  assert.equal(empty.headers['content-length'], '0'); assert.equal((await bytesOf(empty.stream)).length, 0);
});
