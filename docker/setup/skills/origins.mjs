// Import provenance travels atomically with the installed folder. Inventory never fetches sources.
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { parseSkillSource } from "./sources.mjs";

export const ORIGIN_FILE = ".t3-skill-source.json";
export const fingerprintEntries = entries => {
  const files = [...entries];
  files.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
};
export const skillFingerprint = skill => fingerprintEntries(skill.files.map(file => [file.name, Boolean(file.mode & 0o100), createHash("sha256").update(file.data).digest("hex")]));
export async function readSkillOrigin(io, row, home) {
  if (!row.resolvedPath || row.scope !== "user" || row.source === "Plugin" || path.basename(row.path) !== "SKILL.md") return null;
  let handle;
  try {
    // Refuse a retargeted skill before reading its adjacent metadata.
    if (await io.realpath(row.path) !== row.resolvedPath) return null;
    handle = await io.open(path.join(path.dirname(row.resolvedPath), ORIGIN_FILE), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8192) return null;
    const buffer = Buffer.alloc(8193), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) return null;
    const value = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    if (value.version !== 1 || typeof value.source !== "string" || parseSkillSource(value.source, home).type !== "git" || typeof value.name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value.name) || value.name.length > 64 || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return null;
    return { source: value.source, name: value.name, fingerprint: value.fingerprint };
  } catch { return null; }
  finally { await handle?.close(); }
}
