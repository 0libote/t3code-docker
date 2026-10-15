// Linux filesystem/process adapters. No shell interpolation, no commands in
// polling responses, and no arbitrary paths accepted by cleanup endpoints.
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

export function coveringMount(target, mountinfo) {
  let best = null;
  for (const line of String(mountinfo || "").split("\n")) {
    const fields = line.split(" ");
    const point = fields[4];
    if (!point || point === "/") continue;
    if (inside(point, target) && (!best || point.length > best.point.length)) best = { point, root: fields[3] };
  }
  return best;
}

export function mountKind(target, mountinfo) {
  const mount = coveringMount(target, mountinfo);
  if (!mount) return "none";
  const volume = /\/var\/lib\/docker\/volumes\/([^/]+)\/_data/.exec(mount.root);
  return volume && /^[0-9a-f]{64}$/.test(volume[1]) ? "anonymous" : "durable";
}

export async function countProjects(workspace) {
  const isRepo = async (directory) => fs.stat(path.join(directory, ".git")).then(() => true, () => false);
  if (await isRepo(workspace)) return 1;
  const entries = await fs.readdir(workspace, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) if (entry.isDirectory() && await isRepo(path.join(workspace, entry.name))) count += 1;
  return count;
}

export async function filesystemUsage(target) {
  const info = await fs.statfs(target, { bigint: true });
  const totalBytes = Number(info.blocks * info.bsize);
  const availableBytes = Number(info.bavail * info.bsize);
  const usedBytes = Number((info.blocks - info.bfree) * info.bsize);
  const usedPercent = totalBytes ? Math.min(100, Math.round(usedBytes / totalBytes * 100)) : null;
  return { totalBytes, availableBytes, usedBytes, usedPercent,
    severity: usedPercent === null ? "unknown" : usedPercent >= 90 ? "critical" : usedPercent >= 80 ? "warning" : "ok" };
}

/** One bounded traversal. Descendant sizes come from that same traversal,
 * so category subtraction cannot count a file twice through nested folders. */
export async function measureStorage(roots, { timeout = 120_000 } = {}) {
  const targets = [...new Set(roots)];
  const existing = [];
  for (const target of targets) {
    try { if ((await fs.lstat(target)).isDirectory()) existing.push(target); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!existing.length) return { sizes: {}, partial: false };
  let stdout = "", partial = false;
  try {
    ({ stdout } = await exec("du", ["-x", "-B1", "--max-depth=5", "--", ...existing], {
      timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
    }));
  } catch (error) {
    // Permission errors still produce useful totals. A timeout or truncated
    // output has no reliable root totals and must not replace the last scan.
    if (error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || !error.stdout) throw new Error("Storage measurement did not finish. Try again later.");
    stdout = error.stdout; partial = true;
  }
  const sizes = {};
  for (const line of stdout.split("\n")) {
    const match = /^(\d+)\t(.+)$/.exec(line);
    if (match) sizes[match[2]] = Number(match[1]);
  }
  return { sizes, partial };
}

export async function executableOnPath(name, env) {
  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try { await fs.access(candidate, 1); if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

/** Read cache configuration without installing a tool or changing versions. */
export async function detectCaches({ env, userHome, run }) {
  const safeEnv = { ...env, MISE_AUTO_INSTALL: "false", MISE_NOT_FOUND_SYSTEM_FALLBACK: "false", GOTOOLCHAIN: "local" };
  const goBin = await executableOnPath("go", env);
  // npm is part of the image. Run it through the infrastructure Node rather
  // than a user-selected Node shim that may have no selection yet.
  const nodeBin = env.T3_INFRA_NODE || process.execPath;
  const builtinNpm = path.join(path.dirname(nodeBin), "npm");
  const npmBin = await fs.access(builtinNpm, 1).then(() => builtinNpm, () => executableOnPath("npm", env));
  const query = async (bin, args) => {
    if (!bin) return null;
    const result = await run([bin, ...args], { env: safeEnv, cwd: userHome, timeoutMs: 15_000 });
    const value = result.code === 0 && !result.error ? result.stdout.trim() : "";
    return path.isAbsolute(value) ? path.resolve(value) : null;
  };
  const [go, npm] = await Promise.all([
    query(goBin, ["env", "GOCACHE"]), query(npmBin ? nodeBin : null, [npmBin, "config", "get", "cache"]),
  ]);
  return {
    go: { path: go || path.join(env.XDG_CACHE_HOME || path.join(userHome, ".cache"), "go-build"), executable: go ? goBin : null,
      unavailable: !goBin ? "Install Go to clean this cache." : !go ? "Go cache settings could not be read. Refresh or check your Go configuration." : null },
    npm: { path: npm || path.join(userHome, ".npm"), executable: npm ? nodeBin : null, argsPrefix: npmBin ? [npmBin] : [],
      unavailable: !npmBin ? "Install Node/npm to clean this cache." : !npm ? "npm cache settings could not be read. Refresh or check your npm configuration." : null },
  };
}

/** Only ordinary cache directories under known cache roots can be cleaned.
 * Symlink components and custom locations are visible but never auto-cleaned. */
export async function checkCachePath(target, { userHome, cacheHome, stateRoot, workspace, io = fs }) {
  if (!path.isAbsolute(target)) return { safe: false, reason: "This cache has a custom location. Clean it from a terminal." };
  const cacheRoots = [cacheHome, path.join(userHome, ".cache"), path.join(userHome, ".npm")].filter((p) => p && inside(userHome, p));
  if (!cacheRoots.some((root) => inside(root, target)) || target === userHome
      || inside(stateRoot, target) || inside(workspace, target)) {
    return { safe: false, reason: "This cache is outside the managed cache locations. Clean it from a terminal." };
  }
  // Check every component, including the home itself: resolving just the final
  // directory misses an ancestor symlink redirected into credentials or work.
  let current = path.parse(target).root;
  for (const segment of target.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await io.lstat(current);
      if (info.isSymbolicLink()) return { safe: false, reason: "This cache uses a linked directory. Clean it from a terminal." };
      if (!info.isDirectory()) return { safe: false, reason: "This cache location is not a directory." };
    } catch (error) {
      if (error.code === "ENOENT") return { safe: true, exists: false };
      return { safe: false, reason: "This cache location could not be checked." };
    }
  }
  return { safe: true, exists: true };
}

/** Arguments stay internal; UI/status receive only a generic activity verdict.
 * Unreadable processes owned by this user make cleanup fail closed. */
export async function processSnapshot({ pid = process.pid, uid = process.getuid?.(), proc = "/proc" } = {}) {
  const entries = await fs.readdir(proc).catch(() => null);
  if (!entries) return { complete: false, processes: [] };
  const processes = [];
  let complete = true;
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === pid) continue;
    const directory = path.join(proc, name);
    let owner;
    try { owner = await fs.stat(directory); } catch { continue; }
    try {
      const raw = await fs.readFile(path.join(directory, "cmdline"));
      const args = raw.toString().split("\0").filter(Boolean);
      if (!args.length) continue;
      const executable = await fs.readlink(path.join(directory, "exe")).catch(() => null);
      const cwd = await fs.readlink(path.join(directory, "cwd")).catch(() => null);
      processes.push({ pid: Number(name), args, executable, cwd });
    } catch (error) { if (owner.uid === uid && error.code !== "ENOENT" && error.code !== "ESRCH") complete = false; }
  }
  return { complete, processes };
}

export function buildsOrInstallsRunning(snapshot) {
  if (!snapshot.complete) return true;
  return snapshot.processes.some(({ args, executable }) => {
    const bin = path.basename(executable || args[0] || "");
    if (["go", "compile", "link"].includes(bin)) return true;
    const packageTool = args.findIndex((arg) => /(?:^|\/)(?:npm(?:-cli\.js)?|pnpm(?:\.cjs)?|yarn(?:\.js)?|bun)$/.test(arg));
    return packageTool !== -1 && args.slice(packageTool + 1).some((arg) => /^(install|ci|add|update|upgrade|exec|dlx)$/.test(arg));
  });
}
