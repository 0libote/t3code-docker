// Global skill inventory only. No installs, configuration writes or skill execution.
import path from "node:path";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { parseDocument, isMap, isScalar } from "./vendor/yaml.mjs";
import { listCodexSkills } from "./skills/codex.mjs";

const PROVIDERS = Object.freeze({ claude: "Claude Code", codex: "Codex", opencode: "OpenCode", cursor: "Cursor", grok: "Grok Build", muse: "Muse Code" });
const DEFAULT_LIMITS = { entries: 2048, skills: 256, depth: 8, bytes: 4 * 1024 * 1024, fileBytes: 64 * 1024, milliseconds: 3000 };
const problem = (code, message) => Object.assign(new Error(message), { code });
const summaryError = (error) => String(error?.message || error).slice(0, 240);
const idFor = (provider, file) => createHash("sha256").update(provider + "\0" + file).digest("hex").slice(0, 32);

export function skillProviders() { return Object.entries(PROVIDERS).map(([id, name]) => ({ id, name })); }

export function skillRoots(provider, { home, env = {} }) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw problem("invalid", "Unknown skill provider.");
  const override = (key, fallback) => path.resolve(home, String(env[key] || "").trim() || fallback);
  const claude = override("CLAUDE_CONFIG_DIR", ".claude"), codex = override("CODEX_HOME", ".codex");
  const config = override("XDG_CONFIG_HOME", ".config"), shared = path.join(home, ".agents/skills");
  const own = (directory) => ({ path: path.join(directory, "skills"), source: "Provider", scope: "user" });
  const compat = (directory, source) => ({ path: directory, source, scope: "user" });
  const common = compat(shared, "Shared .agents");
  const roots = {
    claude: [own(claude)],
    codex: [own(codex), common, { path: path.join(codex, "skills/.system"), source: "System", scope: "system" }, { path: "/etc/codex/skills", source: "Admin", scope: "admin" }],
    opencode: [own(path.join(config, "opencode")), compat(path.join(claude, "skills"), "Claude compatibility"), common],
    cursor: [own(path.join(home, ".cursor")), common, compat(path.join(claude, "skills"), "Claude compatibility"), compat(path.join(codex, "skills"), "Codex compatibility")],
    grok: [own(override("GROK_HOME", ".grok")), compat(path.join(claude, "skills"), "Claude compatibility"), common],
    muse: [own(path.join(config, "muse")), common, compat(path.join(claude, "skills"), "Claude compatibility"), compat(path.join(codex, "skills"), "Codex compatibility")],
  }[provider];
  return roots.filter((root, index) => roots.findIndex((other) => other.path === root.path) === index);
}

// Stat before opening, stat the opened descriptor, then read at most limit + 1.
// Nonblocking open prevents a raced-in FIFO from hanging the setup service.
export async function readSkillFile(file, maxBytes = DEFAULT_LIMITS.fileBytes, io = fs) {
  const check = (stat) => {
    if (!stat.isFile()) throw problem("invalid", "The skill must be a regular Markdown file.");
    if (stat.size > maxBytes) throw problem("too_large", "This skill exceeds the 64 KiB viewer limit.");
  };
  check(await io.stat(file));
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); check(stat);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > maxBytes) throw problem("too_large", "This skill exceeds the 64 KiB viewer limit.");
    return { content: buffer.toString("utf8", 0, bytes), bytes };
  } finally { await handle.close(); }
}

export function skillMetadata(content, fallback) {
  const result = { name: fallback, description: "", invocation: null, metadataError: null };
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { ...result, metadataError: "No YAML frontmatter; showing the file's directory name." };
  if (Buffer.byteLength(match[1]) > 16 * 1024) return { ...result, metadataError: "Skill frontmatter exceeds the 16 KiB metadata limit." };
  try {
    const doc = parseDocument(match[1], { schema: "core", stringKeys: true, logLevel: "silent", prettyErrors: false });
    if (doc.errors.length || !isMap(doc.contents)) throw new Error("Invalid YAML frontmatter.");
    const scalar = (key) => { const node = doc.get(key, true); return isScalar(node) ? node.value : undefined; };
    const name = scalar("name"), description = scalar("description");
    if (typeof name === "string" && name.trim()) result.name = name.trim().slice(0, 256);
    if (typeof description === "string") result.description = description.trim().slice(0, 2048);
    if (!result.description || typeof name !== "string" || !name.trim()) result.metadataError = "Name or description is missing or is not text. Provider handling may vary.";
    if (scalar("disable-model-invocation") === true) result.invocation = "manual";
    if (scalar("user-invocable") === false) result.invocation = "model-only";
    if (doc.warnings.length) result.metadataError ||= "Frontmatter includes unsupported YAML tags.";
  } catch { result.metadataError = "Could not parse YAML frontmatter. Open the file to inspect it."; }
  return result;
}

export async function scanSkillFiles(provider, options) {
  const { home, env = {}, io = fs } = options;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const roots = skillRoots(provider, { home, env }), rows = new Map(), warnings = new Set();
  const budget = { entries: 0, bytes: 0, start: Date.now() };
  const stopped = () => {
    if (budget.entries < limits.entries && rows.size < limits.skills && budget.bytes < limits.bytes && Date.now() - budget.start < limits.milliseconds) return false;
    warnings.add("The local scan reached its safety limit; some skills may be missing."); return true;
  };
  const add = async (file, root, initialError = null) => {
    if (rows.has(file) || stopped()) return;
    const fallback = path.basename(file) === "SKILL.md" ? path.basename(path.dirname(file)) : path.basename(file, ".md");
    const row = { id: idFor(provider, file), path: file, resolvedPath: null, name: fallback, description: "", source: root.source, scope: root.scope, state: "unknown", native: false, bytes: null, error: initialError, metadataError: null, invocation: null };
    rows.set(file, row);
    if (initialError) return;
    try {
      row.resolvedPath = await io.realpath(file);
      // Spend the entire possible read before opening, including malformed files.
      if (budget.bytes + limits.fileBytes + 1 > limits.bytes) { warnings.add("The local scan reached its byte limit; some metadata is unavailable."); return; }
      budget.bytes += limits.fileBytes + 1;
      const read = await readSkillFile(row.resolvedPath, limits.fileBytes, io);
      budget.bytes -= limits.fileBytes + 1 - read.bytes;
      Object.assign(row, skillMetadata(read.content, fallback), { bytes: read.bytes });
    } catch (error) {
      row.error = error?.code === "ENOENT" ? "The skill file or its linked target is missing." : summaryError(error);
    }
  };
  const walk = async (directory, root, depth, ancestors) => {
    if (stopped()) return;
    let resolved, handle;
    try {
      resolved = await io.realpath(directory);
      if (ancestors.has(resolved)) { warnings.add("A directory link cycle was skipped."); return; }
      if (depth > limits.depth) { warnings.add("The local scan reached its directory depth limit."); return; }
      handle = await io.opendir(directory);
      const nextAncestors = new Set([...ancestors, resolved]);
      for await (const entry of handle) {
        if (stopped()) break;
        budget.entries++;
        if (entry.name.startsWith(".")) continue;
        const file = path.join(directory, entry.name);
        if (entry.name === "SKILL.md" || (provider === "opencode" && depth === 0 && entry.name.endsWith(".md") && !entry.isDirectory())) {
          await add(file, root); continue;
        }
        let directoryEntry = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try { directoryEntry = (await io.stat(file)).isDirectory(); }
          catch (error) {
            if (error?.code === "ENOENT" || error?.code === "ELOOP") await add(path.join(file, "SKILL.md"), root, "This skill directory link is broken or cyclic.");
            else warnings.add("A linked skill directory could not be inspected.");
          }
        }
        if (directoryEntry) await walk(file, root, depth + 1, nextAncestors);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") warnings.add("Could not scan " + directory + ": " + summaryError(error));
    }
  };
  for (const root of roots) await walk(root.path, root, 0, new Set());
  return { skills: [...rows.values()], roots, warnings: [...warnings] };
}

export function createSkillsService({ home, env = process.env, io = fs, nativeCodex = listCodexSkills, getHarness = async () => null, ttlMs = 15000, limits } = {}) {
  home = path.resolve(home || env.HOME || "/home/t3");
  const cache = new Map();
  const load = async (provider) => {
    const scanned = await scanSkillFiles(provider, { home, env, io, limits });
    let coverage = "files", nativeError = null;
    if (provider === "codex") {
      try {
        const harness = await getHarness(provider);
        if (!harness?.runnable || !harness.executable) throw new Error("A managed Codex executable is not available.");
        const native = await nativeCodex({ executable: harness.executable, home, env });
        coverage = "native";
        const byPath = new Map(scanned.skills.map((row) => [row.path, row]));
        for (const entry of native.skills) {
          if (!entry || !["user", "system", "admin"].includes(entry.scope)) continue;
          if (typeof entry.path !== "string" || !path.isAbsolute(entry.path) || typeof entry.name !== "string" || typeof entry.description !== "string" || typeof entry.enabled !== "boolean") {
            scanned.warnings.push("Codex returned an unrecognized skill entry."); continue;
          }
          if (!byPath.has(entry.path) && byPath.size >= (limits?.skills ?? DEFAULT_LIMITS.skills)) { scanned.warnings.push("The native inventory reached its skill limit."); break; }
          const previous = byPath.get(entry.path);
          const resolvedPath = await io.realpath(entry.path).catch(() => null);
          byPath.set(entry.path, { ...previous, id: idFor(provider, entry.path), path: entry.path, resolvedPath,
            name: entry.name.slice(0, 256), description: entry.description.slice(0, 2048), scope: entry.scope,
            source: entry.pluginId ? "Plugin" : entry.scope === "system" ? "System" : entry.scope === "admin" ? "Admin" : previous?.source || "Codex",
            state: entry.enabled ? "enabled" : "disabled", native: true,
            error: previous?.error || (!resolvedPath ? "This skill's local file is unavailable." : null),
          });
        }
        scanned.skills = [...byPath.values()];
        if (native.errors.length) scanned.warnings.push("Codex reported " + native.errors.length + " skill discovery error(s).");
      } catch (error) { coverage = "files"; nativeError = summaryError(error); }
    }
    return { ok: true, provider, providers: skillProviders(), skills: scanned.skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
      roots: scanned.roots, coverage, nativeError, warnings: scanned.warnings, scannedAt: Date.now(),
      coverageText: coverage === "native" ? "Managed Codex inventory in the setup environment, with known local folders included. Project skills are excluded."
        : "Known global skill folders only. Provider availability, plugins and additional configured locations are not verified.",
    };
  };
  const list = (provider, { refresh = false } = {}) => {
    if (!Object.hasOwn(PROVIDERS, provider)) return Promise.reject(problem("invalid", "Unknown skill provider."));
    const hit = cache.get(provider);
    if (hit && (hit.pending || (!refresh && Date.now() - hit.at < ttlMs))) return hit.promise;
    const entry = { pending: true, at: Date.now() };
    entry.promise = load(provider).then((result) => { entry.pending = false; entry.at = Date.now(); return result; }, (error) => { cache.delete(provider); throw error; });
    cache.set(provider, entry); return entry.promise;
  };
  const read = async (provider, id) => {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw problem("invalid", "Invalid skill identifier.");
    const inventory = await list(provider);
    const row = inventory.skills.find((skill) => skill.id === id);
    if (!row) throw problem("missing", "This skill is not in the provider inventory. Refresh the list.");
    if (!row.resolvedPath) throw problem("missing", "The skill file or its linked target is unavailable.");
    let resolved;
    try { resolved = await io.realpath(row.path); }
    catch { throw problem("missing", "The skill file or its linked target no longer exists."); }
    if (resolved !== row.resolvedPath) throw problem("conflict", "This skill link changed. Refresh the list before opening it.");
    return { ok: true, ...row, ...await readSkillFile(resolved, limits?.fileBytes ?? DEFAULT_LIMITS.fileBytes, io) };
  };
  return { list, read };
}
