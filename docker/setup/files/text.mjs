// File content is data: never evaluated, rendered as HTML, or served inline.
import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { FilesError, normalizePath, canonicalEntry, isSecret } from './paths.mjs';

export const PREVIEW_BYTES = 1024 * 1024, EDIT_BYTES = 5 * 1024 * 1024;
export const statRevision = info => createHash('sha256').update([info.dev, info.ino, info.size, info.mtimeNs ?? info.mtimeMs, info.ctimeNs ?? info.ctimeMs].join(':')).digest('hex');
export function fileMode(mode) {
  mode = Number(mode);
  return [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001].map((bit, i) => mode & bit ? 'rwx'[i % 3] : '-').join('');
}
export async function openRegular(value, { io = fs } = {}) {
  const entry = await canonicalEntry(normalizePath(value), io);
  const target = await io.realpath(entry);
  const before = await io.lstat(target, { bigint: true });
  if (!before.isFile()) throw new FilesError('invalid', 'Only regular files can be previewed or downloaded.');
  const handle = await io.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || statRevision(info) !== statRevision(before)) throw new FilesError('changed', 'This file changed while it was being opened. Open it again.');
    return { handle, info, path: entry, target, etag: '"' + statRevision(info) + '"' };
  } catch (error) { await handle.close(); throw error; }
}

const readTags=new Map();
export async function readText(value, { edit = false, io = fs,ifNoneMatch } = {}) {
  const file = await openRegular(value, { io }), limit = edit ? EDIT_BYTES : PREVIEW_BYTES;
  try {
    const key=file.target+':'+edit,prior=readTags.get(key);if(ifNoneMatch&&prior?.etag===ifNoneMatch&&prior.stat===file.etag)return {ok:true,notModified:true,etag:prior.etag};
    if (edit && file.info.size > BigInt(limit)) throw new FilesError('too-large', 'This file is too large to edit here. Download it instead.');
    const chunks = []; let count = 0;
    while (count <= limit) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - count));
      const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); count += bytesRead;
    }
    const after = await file.handle.stat({ bigint: true });
    if (statRevision(after) !== statRevision(file.info)) throw new FilesError('changed', 'This file changed while it was being read. Open it again.');
    const bytes = Buffer.concat(chunks, count), truncated = count > limit || file.info.size > BigInt(count);
    if (edit && truncated) throw new FilesError('too-large', 'This file is too large to edit here. Download it instead.');
    let text;
    try {
      if (bytes.includes(0)) throw new Error('binary');
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, limit), { stream: truncated });
    } catch { return { ok: true, kind: 'binary', bytes: Number(file.info.size), editable: false, etag: file.etag }; }
    const writable = await Promise.all([io.access(file.target, constants.W_OK), io.access(path.dirname(file.target), constants.W_OK)]).then(() => true, () => false);
    const etag = '"' + createHash('sha256').update(file.etag).update(bytes).digest('hex') + '"';
    if(readTags.size>=256)readTags.delete(readTags.keys().next().value);readTags.set(key,{etag,stat:file.etag});
    return { ok: true, kind: 'text', text, truncated, bytes: Number(file.info.size), lines: text ? text.split('\n').length : 0,
      linesTruncated: truncated, encoding: 'utf-8', eol: text.includes('\r\n') ? 'crlf' : 'lf', etag,
      secret: isSecret(path.basename(file.path)) || isSecret(path.basename(file.target)), writable,
      editable: Number(file.info.size) <= EDIT_BYTES && writable };
  } finally { await file.handle.close(); }
}

export function parseRange(value, size) {
  if (value === undefined || value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new FilesError('range', 'That byte range is not available.', { size });
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if ([first, last].some(v => v !== null && !Number.isSafeInteger(v))) throw new FilesError('range', 'That byte range is not available.', { size });
  const start = first === null ? Math.max(0, size - last) : first, end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  if (start < 0 || start >= size || end < start || (first === null && last === 0)) throw new FilesError('range', 'That byte range is not available.', { size });
  return { start, end };
}

export async function rawFile(value, { range, ifRange, io = fs } = {}) {
  const file = await openRegular(value, { io });
  try {
    if (file.info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new FilesError('too-large', 'This file is too large to download in this browser.');
    const size = Number(file.info.size), selected = parseRange(ifRange && ifRange !== file.etag ? null : range, size);
    const name = encodeURIComponent(path.basename(file.path)).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase());
    const headers = { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''" + name,
      'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'cache-control': 'private, no-store',
      'accept-ranges': 'bytes', 'content-length': String(selected ? selected.end - selected.start + 1 : size), etag: file.etag };
    if (selected) headers['content-range'] = `bytes ${selected.start}-${selected.end}/${size}`;
    let stream;
    if (size === 0) {
      // procfs can report zero length for a readable, finite virtual file.
      // A probe distinguishes it from an ordinary empty file; only the former
      // uses chunked framing. Never send more bytes than Content-Length.
      const probe = await file.handle.read(Buffer.alloc(1), 0, 1, 0);
      if (probe.bytesRead) {
        delete headers['content-length']; headers['accept-ranges'] = 'none';
        stream = file.handle.createReadStream({ autoClose: true, start: 0 });
      } else { await file.handle.close(); stream = Readable.from([]); }
    } else stream = file.handle.createReadStream({ autoClose: true, ...(selected || { start: 0, end: size - 1 }) });
    return { status: selected ? 206 : 200, headers, stream };
  } catch (error) { await file.handle.close(); throw error; }
}
