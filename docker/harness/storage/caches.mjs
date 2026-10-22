// Cache catalogue and command scope. Labels, policy fields and execution share
// one definition; API clients receive presentation metadata, never argv/env.
import path from "node:path";
import { inside, checkCachePath } from "./system.mjs";

export const CACHES = Object.freeze([
  { id: "go", label: "Go build cache", icon: "go", budgetKey: "goBudgetBytes", defaultGB: 10,
    description: "Compiled Go packages", cleanupHint: "Rebuilt on the next build", effect: "Clears compiled packages. Your next build recreates them." },
  { id: "gomod", label: "Go modules", icon: "go", budgetKey: "gomodBudgetBytes", defaultGB: 2,
    description: "Downloaded Go dependencies", cleanupHint: "Downloaded again when needed", effect: "Clears downloaded modules. Your next build downloads them again." },
  { id: "npm", label: "npm downloads", icon: "download", budgetKey: "npmBudgetBytes", defaultGB: 2,
    description: "Downloaded JavaScript packages", cleanupHint: "Installed packages stay in place", effect: "Clears package downloads. Installed packages and npx tools stay in place." },
  { id: "uv", label: "uv cache", icon: "uv", budgetKey: "uvBudgetBytes", defaultGB: 2,
    description: "Unused Python cache entries", cleanupHint: "Only unused entries are pruned", effect: "Prunes unused entries. Packages still referenced by the cache are kept; the cache may not become empty." },
  { id: "bun", label: "Bun downloads", icon: "bun", budgetKey: "bunBudgetBytes", defaultGB: 2,
    description: "Downloaded JavaScript packages", cleanupHint: "Shared dependencies are protected", effect: "Clears downloads only when no shared package store is present." },
  { id: "mise", label: "mise metadata", icon: "wrench", budgetKey: "miseBudgetBytes", defaultGB: 5,
    description: "Tool metadata and downloads", cleanupHint: "Installed tools stay in place", effect: "Clears this metadata cache. Installed tools and external task and environment caches stay in place." },
  { id: "deno", label: "Deno modules", icon: "deno", budgetKey: "denoBudgetBytes", defaultGB: 1,
    description: "Downloaded Deno dependencies", cleanupHint: "Downloaded again on the next run", effect: "Clears downloaded modules. The next run downloads them again." },
]);
export const CACHE_IDS = Object.freeze(CACHES.map(({ id }) => id));
export const cacheLabel = (id) => CACHES.find((cache) => cache.id === id)?.label || id;
export const cacheTarget = (id, detected) => !detected?.[id]?.path ? null
  : id === "npm" ? path.join(detected.npm.path, "_cacache") : detected[id].path;
export const validCacheIds = (ids) => Array.isArray(ids) && ids.length > 0 && ids.length <= CACHE_IDS.length
  && new Set(ids).size === ids.length && ids.every((id) => CACHE_IDS.includes(id));

const intersects = (a, b) => inside(a, b) || inside(b, a);
const blocked = (reason, detail) => ({ safe: false, reason, detail });

/** A native command must own a separate cache subtree. A configured path may
 * not swallow another cache, installed tools, state, a project, or a cache root.
 * All comparisons use resolved paths; ancestor symlinks fail closed separately. */
export async function cacheSafety(id, detected, context) {
  const { userHome, env, stateRoot, workspace, io, checkPath = checkCachePath } = context;
  const target = cacheTarget(id, detected), cache = detected?.[id];
  if (!target || !path.isAbsolute(target)) return blocked("Location unavailable", "Refresh storage to read this tool’s cache location.");
  const guard = await checkPath(target, { userHome, cacheHome: env.XDG_CACHE_HOME, stateRoot, workspace, io });
  if (!guard.safe) return blocked("Custom or linked location", guard.reason);
  const normalized = path.resolve(target);
  const aggregate = [path.join(userHome, ".cache"), path.join(userHome, ".npm"), env.XDG_CACHE_HOME].filter(Boolean).map((p) => path.resolve(p));
  if (aggregate.includes(normalized)) return blocked("Shared cache location", "This folder contains more than one tool’s data. Give this tool its own cache folder before cleaning it here.");
  const protectedRoots = [stateRoot, workspace, path.join(userHome, ".npm/_npx"), path.join(userHome, ".bun/bin"),
    path.join(userHome, "go/bin"), path.join(userHome, "go/src"),
    env.MISE_DATA_DIR || path.join(userHome, ".local/share/mise"),
    env.MISE_CONFIG_DIR || path.join(userHome, ".config/mise"),
    env.MISE_STATE_DIR || path.join(userHome, ".local/state/mise"),
    env.UV_TOOL_DIR || path.join(userHome, ".local/share/uv/tools")].map((p) => path.resolve(p));
  if (protectedRoots.some((root) => intersects(root, normalized))) return blocked("Contains protected data", "This cache overlaps a project, installed tool, or settings folder. Its files are kept.");
  // Include ordinary defaults even when a detector fixture/tool is unavailable.
  const cacheHome = env.XDG_CACHE_HOME || path.join(userHome, ".cache");
  const defaults = { go: path.join(cacheHome, "go-build"), gomod: path.join(userHome, "go/pkg/mod"), npm: path.join(userHome, ".npm/_cacache"),
    uv: path.join(cacheHome, "uv"), bun: path.join(userHome, ".bun/install/cache"), mise: path.join(cacheHome, "mise"), deno: path.join(cacheHome, "deno") };
  for (const other of CACHE_IDS.filter((candidate) => candidate !== id)) {
    const roots = [defaults[other], cacheTarget(other, detected)].filter(Boolean).map((p) => path.resolve(p));
    if (roots.some((root) => intersects(root, normalized))) return blocked("Overlapping cache locations", "Two tools share this cache location. Separate their cache folders before cleaning them here.");
  }
  if (!cache?.executable) return blocked("Tool unavailable", cache?.unavailable || "Install or select this tool before cleaning its cache.");
  if (id === "bun") {
    try {
      const store = path.join(normalized, "links"), info = await io.lstat(store);
      if (info.isSymbolicLink() || !info.isDirectory() || (await io.readdir(store)).length) {
        return blocked("Shared dependencies kept", "Bun’s shared store can be used by installed project dependencies. This cache is kept so those projects continue to work.");
      }
    } catch (error) { if (error.code !== "ENOENT") return blocked("Could not verify dependencies", "Bun’s shared store could not be checked. Its files are kept; refresh to try again."); }
  }
  let identity = null;
  try { const stat = await io.lstat(normalized); identity = [stat.dev, stat.ino]; }
  catch (error) { if (error.code !== "ENOENT") return blocked("Could not check location", "Refresh storage before trying again."); }
  return { safe: true, target: normalized, identity };
}

/** Pin every directory the native command can delete. mise's whole-cache
 * command normally also clears task caches and state; those are redirected to
 * the checked cache or this operation's private scratch state. */
export function cacheCommand(id, detected, scratch) {
  const cache = detected[id], target = cacheTarget(id, detected);
  switch (id) {
    case "go": return { argv: [cache.executable, "clean", "-cache"], env: { GOCACHE: target } };
    case "gomod": return { argv: [cache.executable, "clean", "-modcache"], env: { GOMODCACHE: target } };
    case "npm": return { argv: [cache.executable, ...(cache.argsPrefix || []), "cache", "clean", "--force", "--cache", cache.path] };
    case "uv": return { argv: [cache.executable, "cache", "prune", "--cache-dir", target, "--no-config"], env: { UV_CACHE_DIR: target } };
    case "bun": return { argv: [cache.executable, "pm", "cache", "rm"], cwd: scratch, env: { BUN_INSTALL_CACHE_DIR: target } };
    case "mise": return { argv: [cache.executable, "-y", "cache", "clear"],
      env: { MISE_CACHE_DIR: target, MISE_TASK_CACHE_DIR: path.join(target, "task-artifacts"), MISE_STATE_DIR: path.join(scratch, "mise-state") } };
    case "deno": return { argv: [cache.executable, "clean"], env: { DENO_DIR: target } };
    default: throw new Error("Unknown cache.");
  }
}

export const cacheFingerprint = (id, detected, guard) => JSON.stringify({ id, path: guard.target, identity: guard.identity,
  executable: detected[id]?.executable, argsPrefix: detected[id]?.argsPrefix || [], command: id === "uv" ? "prune" : "clean" });
