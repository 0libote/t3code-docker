// Explicit local file operations. Native settings and package installations are separate.
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";

const writableProviders = new Set(["claude", "codex", "opencode"]);
const fail = (code, message) => Object.assign(new Error(message), { code });
const inside = (parent, file) => { const relative = path.relative(parent, file); return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative); };
const stamp = (stat) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs].join(":");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const queues = new Map();
async function serialized(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(work); queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
export const skillRevision = (row, file) => digest([row.path, row.resolvedPath, file.mode, file.stamp, file.content].join("\0"));

async function packageNames(io, home, env) {
  const lock = env.XDG_STATE_HOME ? path.join(path.resolve(home, env.XDG_STATE_HOME), "skills/.skill-lock.json") : path.join(home, ".agents/.skill-lock.json");
  let handle;
  try {
    const initial = await io.stat(lock);
    if (!initial.isFile() || initial.size > 65536) return null;
    handle = await io.open(await io.realpath(lock), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 65536) return null;
    const buffer = Buffer.alloc(65537); let bytes = 0;
    while (bytes < buffer.length) { const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!read.bytesRead) break; bytes += read.bytesRead; }
    if (bytes > 65536) return null;
    const value = JSON.parse(buffer.toString("utf8", 0, bytes));
    if (!value.skills || typeof value.skills !== "object" || Array.isArray(value.skills)) return null;
    return new Set(Object.keys(value.skills));
  } catch (error) { return error.code === "ENOENT" ? new Set() : null; }
  finally { await handle?.close(); }
}

export async function localSkillPolicy({ provider, roots, home, env, io }) {
  const root = roots[0], packages = await packageNames(io, home, env);
  const shared = await io.realpath(path.join(home, ".agents/skills")).catch(() => path.join(home, ".agents/skills"));
  const pluginRoots = await Promise.all([
    path.join(path.resolve(home, env.CLAUDE_CONFIG_DIR || ".claude"), "plugins"),
    path.join(path.resolve(home, env.CODEX_HOME || ".codex"), "plugins"),
  ].map((file) => io.realpath(file).catch(() => path.resolve(file))));
  const supported = writableProviders.has(provider);
  const resolvedRoot = await io.realpath(root.path).catch((error) => error.code === "ENOENT" ? root.path : null);
  const canCreate = supported && packages !== null && resolvedRoot !== null && resolvedRoot !== shared && !inside(shared, resolvedRoot)
    && !resolvedRoot.split(path.sep).includes(".system") && !pluginRoots.some((directory) => directory === resolvedRoot || inside(directory, resolvedRoot));
  const capabilities = (row) => {
    let reason = null;
    if (!supported) reason = "Local file management is currently available for Claude Code, Codex and OpenCode.";
    else if (row.scope !== "user" || row.source === "Plugin" || !inside(root.path, row.path)) reason = "Manage this installation through its source provider or package manager.";
    else if (!row.resolvedPath) reason = "The skill's linked target is unavailable.";
    else if (inside(shared, row.resolvedPath) || row.resolvedPath === shared) reason = "Shared .agents installations are read-only until shared storage management is available.";
    else if (row.resolvedPath.split(path.sep).includes(".system") || pluginRoots.some((directory) => inside(directory, row.resolvedPath))) reason = "System and plugin skill files are read-only.";
    else if (!packages) reason = "The skills package lock could not be checked; local changes are unavailable.";
    else if (packages.has(row.name) || packages.has(path.basename(path.dirname(row.path)))) reason = "This skill is tracked by the skills package manager.";
    return { canEdit: !reason && !row.error, canRemove: !reason && !row.error, readOnlyReason: reason || row.error || null };
  };
  return { root, canCreate, capabilities };
}

function validate(content, metadata, slug) {
  if (typeof content !== "string" || !content.trim()) throw fail("invalid", "Skill Markdown is empty.");
  if (Buffer.byteLength(content) > 65536) throw fail("too_large", "Skill Markdown exceeds the 64 KiB limit.");
  const parsed = metadata(content, slug || "skill");
  if (parsed.metadataError) throw fail("invalid", parsed.metadataError);
  if (slug && parsed.name !== slug) throw fail("invalid", "The frontmatter name must match the folder name.");
}

async function publish(io, file, content, mode, exclusive = false) {
  const temp = path.join(path.dirname(file), ".t3-skill-write-" + randomBytes(12).toString("hex"));
  let handle, created = false;
  try {
    handle = await io.open(temp, "wx", mode); created = true;
    await handle.writeFile(content, "utf8"); await handle.chmod(mode); await handle.close(); handle = null;
    if (exclusive) await io.link(temp, file);
    else await io.rename(temp, file);
  } finally { await handle?.close(); if (created) await io.rm(temp, { force: true }); }
}

// Fingerprint supporting files without following their links or reading their bodies.
async function removalPlan(io, row, root) {
  const parent = path.dirname(row.path);
  const fileEntry = await io.lstat(row.path), parentEntry = await io.lstat(parent);
  const kind = fileEntry.isSymbolicLink() || parent === root.path || path.basename(row.path) !== "SKILL.md" ? "file"
    : parentEntry.isSymbolicLink() ? "link" : "directory";
  const entry = kind === "file" ? row.path : parent;
  const actual = path.join(await io.realpath(path.dirname(entry)), path.basename(entry));
  const parts = [];
  let count = 0;
  const walk = async (file, relative, depth) => {
    if (++count > 1024 || depth > 12) throw fail("unsupported", "This skill contains too many files to remove through the console.");
    const stat = await io.lstat(file);
    parts.push([relative, stamp(stat), stat.isSymbolicLink() ? await io.readlink(file) : ""]);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for await (const child of await io.opendir(file)) {
      if (child.name === "SKILL.md" && relative !== "") throw fail("unsupported", "This folder contains another skill. Remove it directly to preserve the nested installation.");
      await walk(path.join(file, child.name), path.join(relative, child.name), depth + 1);
    }
  };
  await walk(actual, "", 0);
  parts.sort((a, b) => a[0].localeCompare(b[0]));
  return { kind, linked: kind === "link" || fileEntry.isSymbolicLink(), path: entry, actual, revision: digest(JSON.stringify(parts)), files: count };
}

export function createSkillFileManager({ home, env, io, rootsFor, metadata, read, invalidate }) {
  const policyFor = (provider) => localSkillPolicy({ provider, roots: rootsFor(provider), home, env, io });
  const current = async (provider, id, revision) => {
    const row = await read(provider, id);
    const policy = await policyFor(provider), caps = policy.capabilities(row);
    if (!caps.canEdit) throw fail("unsupported", caps.readOnlyReason);
    if (!revision || row.revision !== revision) throw fail("conflict", "This skill changed since you opened it. Download your draft and reopen the file.");
    return { row, policy };
  };
  const create = async (provider, slug, content) => {
    if (typeof slug !== "string" || slug.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw fail("invalid", "Use a folder name of 1–64 lowercase letters, numbers and single hyphens.");
    validate(content, metadata, slug);
    const policy = await policyFor(provider);
    if (!policy.canCreate) throw fail("unsupported", "New skills are currently supported for Claude Code, Codex and OpenCode.");
    // A provider's whole skills root can itself be linked to the shared store.
    await io.mkdir(policy.root.path, { recursive: true });
    const root = await io.realpath(policy.root.path);
    const shared = await io.realpath(path.join(home, ".agents/skills")).catch(() => path.join(home, ".agents/skills"));
    if (root === shared || inside(shared, root)) throw fail("unsupported", "This provider's skills folder points at shared .agents storage, which is read-only in this version.");
    const caps = policy.capabilities({ path: path.join(policy.root.path, slug, "SKILL.md"), resolvedPath: path.join(root, slug, "SKILL.md"), name: slug, scope: "user", source: "Provider" });
    if (!caps.canEdit) throw fail("unsupported", caps.readOnlyReason);
    return serialized(path.join(root, slug), async () => {
      const directory = path.join(root, slug);
      try { await io.mkdir(directory); }
      catch (error) { if (error.code === "EEXIST") throw fail("conflict", "A skill with that folder name already exists. Edit it or choose another name."); throw error; }
      try { await publish(io, path.join(directory, "SKILL.md"), content, 0o600, true); }
      catch (error) { await io.rmdir(directory).catch(() => {}); throw error; }
      invalidate(); return { ok: true, path: path.join(policy.root.path, slug, "SKILL.md") };
    });
  };
  const save = async (provider, id, revision, content) => {
    validate(content, metadata);
    const initial = await current(provider, id, revision);
    return serialized(initial.row.resolvedPath, async () => {
      const { row } = await current(provider, id, revision);
      // The resolved file is replaced; directory and file symlink chains stay intact.
      await publish(io, row.resolvedPath, content, row.mode);
      invalidate(); return { ok: true, path: row.path };
    });
  };
  const removal = async (provider, row) => {
    const policy = await policyFor(provider);
    if (!policy.capabilities(row).canRemove) return {};
    try {
      const plan = await removalPlan(io, row, policy.root);
      return { removalRevision: plan.revision, removalPath: plan.path, removalKind: plan.kind, removalFiles: plan.files, removalLinkedTarget: plan.linked };
    } catch (error) { return { canRemove: false, removalError: error.message }; }
  };
  const remove = async (provider, id, revision, removalRevision) => {
    const initial = await current(provider, id, revision);
    return serialized(initial.row.resolvedPath, async () => {
      const { row, policy } = await current(provider, id, revision);
      const plan = await removalPlan(io, row, policy.root);
      if (!removalRevision || removalRevision !== plan.revision) throw fail("conflict", "This skill or its supporting files changed. Reopen the skill before removing it.");
      const parked = path.join(path.dirname(plan.actual), ".t3-skill-remove-" + randomBytes(12).toString("hex"));
      await io.rename(plan.actual, parked);
      try {
        // Verify the moved entry too; a concurrent writer must not lose new files.
        const moved = { ...row, path: plan.kind === "directory" || plan.kind === "link" ? path.join(parked, "SKILL.md") : parked };
        let same;
        if (plan.kind === "file") {
          const stat = await io.lstat(parked);
          const parts = [["", stamp(stat), stat.isSymbolicLink() ? await io.readlink(parked) : ""]];
          same = digest(JSON.stringify(parts)) === plan.revision;
        } else same = (await removalPlan(io, moved, policy.root)).revision === plan.revision;
        if (!same) throw fail("conflict", "This skill changed while it was being removed.");
      } catch (error) {
        const occupied = await io.lstat(plan.actual).then(() => true, (check) => check.code !== "ENOENT");
        if (!occupied) await io.rename(parked, plan.actual);
        else throw fail("conflict", "The installation changed. Its preserved entry is at " + parked);
        invalidate(); throw error;
      }
      try { await io.rm(parked, { recursive: plan.kind === "directory" }); }
      catch { invalidate(); throw fail("unavailable", "Removal could not complete. Remaining files are preserved at " + parked); }
      invalidate(); return { ok: true, removed: plan.path, keptLinkedTarget: plan.kind === "link" || (await io.lstat(row.resolvedPath).then(() => true, () => false)) };
    });
  };
  return { create, save, remove, removal, policyFor };
}
