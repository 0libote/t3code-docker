// A compact view of the du results Storage already collected. Never traverses
// a directory or starts a process; a bad or missing cache is simply a cold index.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip), decompress = promisify(gunzip);
const MAX_PACKED = 8 * 1024 * 1024, MAX_JSON = 16 * 1024 * 1024, MAX_ENTRIES = 100_000;
const inside = (root, value) => value === root || value.startsWith(root === '/' ? '/' : root + path.sep);

export function createFilesSizesIndex({ file, home, workspace, io = fs, now = Date.now, maxEntries = MAX_ENTRIES } = {}) {
  let entries = new Map(), children = new Map(), at = null, partial = false;
  const allowed = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && Buffer.byteLength(value) <= 4096
    && path.resolve(value) === value && [home, workspace].some(root => inside(root, value));
  const install = (values, timestamp, incomplete) => {
    const next = new Map(); let bytes = 0, capped = false;
    for (const [value, size] of values) {
      if (!allowed(value) || !Number.isSafeInteger(size) || size < 0) continue;
      bytes += Buffer.byteLength(JSON.stringify([value, size])) + 1;
      if (next.size >= Math.min(maxEntries, MAX_ENTRIES) || bytes > MAX_JSON - 2048) { capped = true; break; }
      next.set(value, size);
    }
    const grouped = new Map();
    for (const [value, size] of next) {
      const parent = path.dirname(value);
      if (value !== parent) { if (!grouped.has(parent)) grouped.set(parent, []); grouped.get(parent).push({ path: value, bytes: size }); }
    }
    entries = next; children = grouped; at = timestamp; partial = Boolean(incomplete || capped);
  };
  const packed = async () => {
    // A file descriptor bounds the read even if a damaged cache grows between
    // stat and read. The readFile fallback exists for Storage's injected I/O.
    if (!io.open) return Buffer.from(await io.readFile(file));
    const handle = await io.open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      if (size > MAX_PACKED) throw new Error('Oversized sizes cache');
      const buffer = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > size) throw new Error('Sizes cache changed while being read');
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  };
  const ready = (async () => {
    try {
      const bytes = await packed(); if (bytes.length > MAX_PACKED) return;
      const saved = JSON.parse(await decompress(bytes, { maxOutputLength: MAX_JSON }));
      if (saved.schema !== 1 || saved.home !== home || saved.workspace !== workspace || !Array.isArray(saved.entries)
        || saved.entries.length > MAX_ENTRIES || !Number.isFinite(saved.at) || saved.at < 0 || saved.at > now() + 60_000) return;
      if (saved.entries.some(item => !Array.isArray(item) || item.length !== 2 || !allowed(item[0]) || !Number.isSafeInteger(item[1]) || item[1] < 0)) return;
      install(saved.entries, saved.at, saved.partial);
    } catch { /* absent, stale, truncated or corrupt: the next Storage scan warms it */ }
  })();
  let persistence = Promise.resolve();
  const replace = async (sizes, { at: measuredAt = now(), partial: incomplete = false } = {}) => {
    await ready;
    install(Object.entries(sizes), measuredAt, incomplete);
    const json = JSON.stringify({ schema: 1, home, workspace, at, partial, entries: [...entries] });
    persistence = persistence.catch(() => {}).then(async () => {
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        const bytes = await compress(json, { level: 3 });
        if (bytes.length > MAX_PACKED) return false;
        await io.mkdir(path.dirname(file), { recursive: true });
        await io.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await io.rename(temporary, file);
        return true;
      } catch { return false; }
      finally { await io.unlink(temporary).catch(() => {}); }
    });
    return persistence;
  };
  const snapshot = () => {
    const current = entries, groups = children;
    return { at, partial, bytesOf: value => current.get(value) ?? null,
      childrenOf: value => (groups.get(value) || []).map(entry => ({ ...entry })), entries: () => current.entries() };
  };
  return { ready, replace, snapshot };
}
