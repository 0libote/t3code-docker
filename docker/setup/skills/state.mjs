// Conflict tokens for native settings; settings contents never leave this module.
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const stamp = (stat) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
export const codexConfigPath = (home, env) => path.join(path.resolve(home, env.CODEX_HOME || ".codex"), "config.toml");

export async function configSnapshot(file, io) {
  let handle;
  const limit = 1024 * 1024;
  const check = (stat) => {
    if (!stat.isFile() || stat.size > limit) throw new Error("Native settings are not a regular file within the 1 MiB limit.");
  };
  try {
    check(await io.stat(file));
    const resolved = await io.realpath(file);
    handle = await io.open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const before = await handle.stat(); check(before);
    const buffer = Buffer.alloc(limit + 1); let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > limit || stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await io.stat(file)) || resolved !== await io.realpath(file)) {
      throw new Error("Native settings changed while being read. Refresh the list.");
    }
    return digest(JSON.stringify([file, resolved, stamp(before), digest(buffer.subarray(0, bytes))]));
  } catch (error) {
    if (error.code === "ENOENT" && !handle) {
      // A dangling settings link must not be mistaken for an absent file.
      try { await io.lstat(file); } catch (missing) { if (missing.code === "ENOENT") return digest(file + "\0missing"); }
    }
    throw new Error("Native settings could not be checked. " + (error.code ? "Refresh after checking file access." : error.message));
  } finally { await handle?.close(); }
}

export const stateRevision = (config, row) => digest(JSON.stringify([config, row.path, row.resolvedPath, row.scope, row.source, row.name, row.state]));

// All skills share one provider settings file, including across service instances.
const queues = new Map();
export async function serializeState(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(work); queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
