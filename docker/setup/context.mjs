// Shared global instructions for the setup console. All filesystem operations
// take explicit paths so tests can use disposable homes. Provider-owned files
// and links are preserved; existing files change only on an explicit save.
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

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
    await fs.chmod(tmp, mode);
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

/** Read a known provider's existing file, following its symlinks. */
export async function readProviderAgentsMd(fs, provider, { home = "/home/t3", env = {} } = {}) {
  const target = agentsMdTargets(env, home).find((entry) => entry.provider === provider);
  if (!target) return { ok: false, code: "invalid", error: "Unknown instruction provider" };
  try {
    const resolvedPath = await fs.realpath(target.path);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) return { ok: false, code: "invalid", error: "Instructions must be a regular file" };
    const content = await fs.readFile(resolvedPath, "utf8");
    const revision = createHash("sha256").update(resolvedPath).update("\0").update(content).digest("hex");
    return { ok: true, ...target, resolvedPath, content, revision, bytes: Buffer.byteLength(content), mode: stat.mode & 0o777 };
  } catch (error) {
    return { ok: false, ...target, code: error?.code === "ENOENT" ? "missing" : "unavailable", error: error?.code === "ENOENT" ? "The instruction file or its linked target no longer exists" : String(error?.message ?? error) };
  }
}

// Serialize saves to the same target so two editors cannot both overwrite the
// revision they opened. Provider links can point at the same external file.
const providerWrites = new Map();
export async function writeProviderAgentsMd(fs, provider, content, revision, options = {}) {
  const validation = validateAgentsMd(content);
  if (!validation.ok) return validation;
  const initial = await readProviderAgentsMd(fs, provider, options);
  if (!initial.ok) return initial;
  const key = initial.resolvedPath;
  const previous = providerWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const read = await readProviderAgentsMd(fs, provider, options);
    if (!read.ok) return read;
    if (!revision || read.revision !== revision) {
      return { ok: false, code: "conflict", error: "Instructions changed since you opened them. Download your draft, then reopen the editor to load the current file." };
    }
    // Rename the resolved file, leaving the provider's symlink chain intact.
    await writeFileAtomic(fs, read.resolvedPath, String(content), read.mode);
    return { ok: true, provider, path: read.path, bytes: validation.bytes };
  });
  providerWrites.set(key, current);
  try { return await current; }
  finally { if (providerWrites.get(key) === current) providerWrites.delete(key); }
}

/** Local metadata only: instruction text is fetched when the editor opens. */
export async function contextStatus(fs, { baseDir, home = "/home/t3", env = {} } = {}) {
  const read = await readAgentsMd(fs, baseDir);
  const providers = [];
  for (const target of agentsMdTargets(env, home)) {
    try {
      await fs.lstat(target.path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      providers.push({ ...target, error: String(error?.message ?? error) });
      continue;
    }
    const file = await readProviderAgentsMd(fs, target.provider, { home, env });
    // Shared links are edited via the single global row, avoiding duplicates.
    if (file.ok && file.resolvedPath === path.resolve(agentsMdPathFor(baseDir))) continue;
    providers.push({ ...target, bytes: file.bytes ?? 0, error: file.error ?? null });
  }
  return { agentsMd: { present: read.present, bytes: read.bytes, updatedAt: read.updatedAt ?? null, error: read.error }, providers };
}
