// Shared global instructions for the setup console. All filesystem operations
// take explicit paths so tests can use disposable homes. Provider-owned files
// and links are preserved; only missing instruction targets are linked.
import path from "node:path";
import { randomBytes } from "node:crypto";

export function contextDirFor(baseDir) {
  return path.join(baseDir, "setup", "context");
}

export function agentsMdPathFor(baseDir) {
  return path.join(contextDirFor(baseDir), "AGENTS.md");
}

/** Native global instruction paths; other providers are deferred. */
export function agentsMdTargets(env = {}, home = "/home/t3") {
  const claudeDir = String(env.CLAUDE_CONFIG_DIR ?? "").trim() || path.join(home, ".claude");
  const codexHome = String(env.CODEX_HOME ?? "").trim() || path.join(home, ".codex");
  const configHome = String(env.XDG_CONFIG_HOME ?? "").trim() || path.join(home, ".config");
  return [
    { provider: "claude", path: path.join(claudeDir, "CLAUDE.md") },
    { provider: "codex", path: path.join(codexHome, "AGENTS.md") },
    { provider: "opencode", path: path.join(configHome, "opencode", "AGENTS.md") },
  ];
}

export function validateAgentsMd(text, maxBytes = 64 * 1024) {
  const src = String(text ?? "");
  if (!src.trim()) return { ok: false, error: "AGENTS.md is empty" };
  if (Buffer.byteLength(src, "utf8") > maxBytes) {
    return { ok: false, error: `AGENTS.md exceeds ${maxBytes} bytes` };
  }
  return { ok: true, bytes: Buffer.byteLength(src, "utf8") };
}

async function readFileSafe(fs, file) {
  try {
    return { text: await fs.readFile(file, "utf8"), error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { text: null, error: null };
    return { text: null, error: String(error?.message ?? error) };
  }
}

async function writeFileAtomic(fs, file, text, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmp, text, { encoding: "utf8", mode });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function readAgentsMd(fs, baseDir) {
  const file = agentsMdPathFor(baseDir);
  const { text, error } = await readFileSafe(fs, file);
  if (error) return { present: false, path: file, content: null, bytes: 0, error };
  if (text === null) return { present: false, path: file, content: null, bytes: 0, error: null };
  let updatedAt = null;
  try {
    updatedAt = (await fs.stat(file)).mtimeMs ?? null;
  } catch { /* ignore */ }
  return { present: true, path: file, content: text, bytes: Buffer.byteLength(text, "utf8"), updatedAt, error: null };
}

export async function writeAgentsMd(fs, baseDir, content) {
  const v = validateAgentsMd(content);
  if (!v.ok) return { ok: false, error: v.error };
  const file = agentsMdPathFor(baseDir);
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) return { ok: false, error: "Global AGENTS.md is a symlink; edit its target directly." };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeFileAtomic(fs, file, String(content));
  return { ok: true, path: file, bytes: v.bytes };
}

/** Link missing targets without replacing existing files or user symlinks. */
export async function reconcileAgentsMd(fs, baseDir, { home = "/home/t3", env = {} } = {}) {
  const canonical = agentsMdPathFor(baseDir);
  const read = await readAgentsMd(fs, baseDir);
  if (!read.present) return { ok: false, linked: [], skipped: [], error: read.error || "no global AGENTS.md yet" };
  const linked = [];
  const skipped = [];
  for (const target of agentsMdTargets(env, home)) {
    try {
      try {
        const stat = await fs.lstat(target.path);
        if (stat.isSymbolicLink() && path.resolve(path.dirname(target.path), await fs.readlink(target.path)) === path.resolve(canonical)) {
          linked.push({ ...target, state: "exists" });
        } else {
          skipped.push({ ...target, reason: "Existing instructions left in place" });
        }
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await fs.mkdir(path.dirname(target.path), { recursive: true });
      await fs.symlink(canonical, target.path);
      linked.push({ ...target, state: "linked" });
    } catch (error) {
      skipped.push({ ...target, reason: String(error?.message ?? error) });
    }
  }
  return { ok: true, linked, skipped, error: null };
}

/** Local metadata only: instruction text is fetched when the editor opens. */
export async function contextStatus(fs, { baseDir } = {}) {
  const read = await readAgentsMd(fs, baseDir);
  return { agentsMd: { present: read.present, bytes: read.bytes, updatedAt: read.updatedAt ?? null, error: read.error } };
}
