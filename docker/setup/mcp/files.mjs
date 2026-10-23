// Share the native-settings queue with skill policy writers. Snapshots cover
// content, resolved target, permissions and file identity, with bounded reads.
import path from "node:path";
import { randomBytes } from "node:crypto";
import { configSnapshot, serializeState } from "../skills/state.mjs";

const conflict = () => Object.assign(new Error("Provider settings changed. Refresh MCP servers before applying this change."), { code: "conflict" });
export async function readConfig(io, file) {
  const value = await configSnapshot(file, io, true);
  if (!value.exists) {
    let ancestor = path.dirname(file), suffix = path.basename(file);
    for (;;) {
      try { value.resolvedPath = path.join(await io.realpath(ancestor), suffix); break; }
      catch (e) { if (e.code !== "ENOENT") throw e; suffix = path.join(path.basename(ancestor), suffix); ancestor = path.dirname(ancestor); }
    }
  }
  return { ...value, content: value.exists ? value.content : "" };
}

export async function changeConfig(io, file, revision, change) {
  await io.mkdir(path.dirname(file), { recursive: true });
  const initial = await readConfig(io, file);
  return serializeState(initial.resolvedPath, async () => {
    const before = await readConfig(io, file);
    if (initial.resolvedPath !== before.resolvedPath || (revision !== undefined && revision !== before.revision)) throw conflict();
    const content = change(before.content);
    if (content === before.content) return { ok: true, path: file, revision: before.revision };
    if (Buffer.byteLength(content, "utf8") > 1024 * 1024) throw Object.assign(new Error("The MCP configuration would exceed the 1 MiB limit."), { code: "too_large" });
    const suffix = `${process.pid}.${randomBytes(8).toString("hex")}`;
    const tmp = `${before.resolvedPath}.tmp.${suffix}`;
    const backupPath = before.exists ? `${before.resolvedPath}.t3-mcp-backup.${suffix}` : null;
    try {
      const mode = before.mode & 0o600;
      await io.writeFile(tmp, content, { encoding: "utf8", mode, flag: "wx" });
      await io.chmod(tmp, mode);
      if ((await readConfig(io, file)).revision !== before.revision) throw conflict();
      if (backupPath) await io.writeFile(backupPath, before.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (before.exists) {
        if ((await readConfig(io, file)).revision !== before.revision) throw conflict();
        await io.rename(tmp, before.resolvedPath);
      } else {
        try { await io.link(tmp, before.resolvedPath); }
        catch (e) { if (e.code === "EEXIST") throw conflict(); throw e; }
      }
      return { ok: true, path: file, backupPath, revision: (await readConfig(io, file)).revision };
    } finally { await io.rm(tmp, { force: true }); }
  });
}
