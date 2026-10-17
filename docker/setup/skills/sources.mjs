// Read-only source discovery. Git blobs are read without checkout, hooks or filters.
import path from "node:path";
import os from "node:os";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";

const fail = (code, message) => Object.assign(new Error(message), { code });
export const SOURCE_LIMITS = Object.freeze({ entries: 2048, skills: 128, bytes: 25 * 1024 * 1024, fileBytes: 4 * 1024 * 1024, markdownBytes: 65536, depth: 12 });
const portable = (name) => typeof name === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 64;
const safeRelative = (file) => file && !file.includes("\\") && !file.includes("\0") && !path.posix.isAbsolute(file) && file.split("/").every((part) => part && part !== "." && part !== "..");

// Bound clone storage as well as output/time. Kill the complete Git/SSH process
// group on Linux so a stalled credential helper or lazy fetch cannot outlive it.
async function checkStorage(directory) {
  let bytes = 0, entries = 0;
  const walk = async (folder, depth = 0) => {
    if (depth > 16) throw fail("too_large", "The Git source exceeds its storage limit.");
    for await (const entry of await fs.opendir(folder)) {
      if (++entries > 8192) throw fail("too_large", "The Git source has too many objects.");
      const file = path.join(folder, entry.name);
      let stat; try { stat = await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024) throw fail("too_large", "The Git download exceeds 64 MiB. Use a smaller source.");
      if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(file, depth + 1);
    }
  };
  await walk(directory);
}
export async function runSourceGit(command, args, { env, signal, maxBuffer, directory }) {
  await checkStorage(directory);
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { env, detached: grouped, stdio: ["ignore", "pipe", "ignore"] });
    let failure = null, bytes = 0, checking = false;
    const chunks = [];
    const stop = (error) => { failure ||= error; try { if (grouped) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} };
    const abort = () => stop(fail("unavailable", "Reading the Git source timed out."));
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > maxBuffer) stop(fail("too_large", "The Git source exceeds its output or file limit.")); else chunks.push(chunk); });
    const timer = setInterval(async () => {
      if (checking) return; checking = true;
      try { await checkStorage(directory); } catch (error) { stop(error); } finally { checking = false; }
    }, 250);
    const clear = () => { clearInterval(timer); signal.removeEventListener("abort", abort); };
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    child.once("error", (error) => { clear(); reject(error); });
    child.once("close", async (code) => {
      clear();
      try { if (failure) throw failure; if (code !== 0) throw new Error("Git source failed"); await checkStorage(directory); resolve({ stdout: Buffer.concat(chunks) }); }
      catch (error) { reject(error); }
    });
  });
}

// Accept copied installation commands as data, never shell code. Only the source
// and --skill selector are meaningful here; destination flags belong to the UI.
export function parseSkillSource(value, home) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw fail("invalid", "Enter a repository, skill URL or absolute folder path.");
  let source = value.trim(), filter = null;
  if (/^(?:npx\s+(?:--yes\s+|-y\s+)?skills(?:@[\w.-]+)?|pnpm\s+dlx\s+skills|bunx\s+skills)\s+add\s+/.test(source)) {
    const words = source.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g).map((word) => word.replace(/^(['"])(.*)\1$/, "$2"));
    const add = words.indexOf("add"); source = words[add + 1];
    const rest = words.slice(add + 2);
    for (let i = 0; i < rest.length; i++) {
      if (["--skill", "-s"].includes(rest[i]) && rest[i + 1] && !filter) filter = rest[++i];
      else if (!["--global", "-g", "--yes", "-y"].includes(rest[i])) throw fail("invalid", "Paste the source URL, or an install command with a single --skill name. Choose providers below.");
    }
  }
  if (filter === "*") filter = null;
  if (!source || source.startsWith("-")) throw fail("invalid", "The source cannot be a command option.");
  if (source.startsWith("~/")) source = path.join(home, source.slice(2));
  if (path.isAbsolute(source)) return { type: "local", source, filter };
  if (/^[\w.-]+\/[\w.-]+(?:@[\w.-]+)?$/.test(source)) {
    const parts = source.split("@"); source = "https://github.com/" + parts[0]; filter ||= parts[1] || null;
  }
  if (/^git@[a-zA-Z0-9.-]+:[\w./-]+(?:\.git)?$/.test(source)) return { type: "git", source, filter, subpath: "", ref: null };
  let url;
  try { url = new URL(source); } catch { throw fail("invalid", "Use an HTTPS/SSH repository URL, owner/repo, or an absolute path inside the container."); }
  if (!["https:", "http:", "ssh:"].includes(url.protocol) || url.password || (url.username && url.protocol !== "ssh:")) throw fail("invalid", "Use HTTP(S) or SSH without embedded credentials.");
  if (url.hostname === "skills.sh") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || parts.length > 3) throw fail("invalid", "Open a skill on skills.sh and copy its skill link or install command.");
    return parseSkillSource(parts.slice(0, 2).join("/") + (parts[2] ? "@" + parts[2] : ""), home);
  }
  let parts; try { parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); } catch { throw fail("invalid", "The URL contains invalid encoding."); }
  let ref = null, subpath = "";
  if (url.hostname === "github.com" && parts.length >= 2 && !["raw", "blob"].includes(parts[2])) {
    if (parts[2] === "tree") { ref = parts[3]; subpath = parts.slice(4).join("/"); if (!ref) throw fail("invalid", "A tree link must include a branch, tag or commit."); }
    else if (parts.length > 2) throw fail("invalid", "Use a repository URL or a /tree/ref/skill-folder link.");
    url.pathname = "/" + parts.slice(0, 2).join("/").replace(/\.git$/, "") + ".git";
    url.search = ""; url.hash = "";
    if (ref?.startsWith("-") || (subpath && !safeRelative(subpath))) throw fail("invalid", "The repository ref or folder is invalid.");
    return { type: "git", source: url.href, filter, ref, subpath };
  }
  const gitlabTree = parts.indexOf("-");
  if (url.hostname === "gitlab.com" && gitlabTree > 0 && ["blob", "raw"].includes(parts[gitlabTree + 1])) {
    if (!parts[gitlabTree + 2] || !parts[gitlabTree + 3]) throw fail("invalid", "A GitLab file link must include a ref and file path.");
    const raw = [...parts]; raw[gitlabTree + 1] = "raw";
    url.pathname = "/" + raw.map(encodeURIComponent).join("/");
    return { type: "url", source: url.href, filter };
  }
  if (url.hostname === "gitlab.com" && gitlabTree > 0 && parts[gitlabTree + 1] === "tree") {
    ref = parts[gitlabTree + 2]; subpath = parts.slice(gitlabTree + 3).join("/");
    if (!ref) throw fail("invalid", "A tree link must include a branch, tag or commit.");
    url.pathname = "/" + parts.slice(0, gitlabTree).join("/") + ".git"; url.search = ""; url.hash = "";
  }
  if (url.protocol === "ssh:" || /\.git$/.test(url.pathname) || (url.hostname === "gitlab.com" && parts.length >= 2)) {
    if (ref?.startsWith("-") || (subpath && !safeRelative(subpath))) throw fail("invalid", "The repository ref or folder is invalid.");
    return { type: "git", source: url.href, filter, ref, subpath };
  }
  if (url.hostname === "github.com" && ["blob", "raw"].includes(parts[2])) {
    url = new URL("https://raw.githubusercontent.com/" + [...parts.slice(0, 2), ...parts.slice(3)].map(encodeURIComponent).join("/"));
  }
  return { type: "url", source: url.href, filter };
}

async function download(url, limit, fetcher, signal) {
  const response = await fetcher(url, { signal, headers: { accept: "text/markdown, application/json, text/html;q=0.5" } });
  if (!response.ok) { await response.body?.cancel(); throw fail("unavailable", "The source returned HTTP " + response.status + ". Check the link and access permissions."); }
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw fail("too_large", "The source exceeds the download limit."); }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > limit) { await response.body.cancel().catch(() => {}); throw fail("too_large", "The source exceeds the download limit."); } chunks.push(chunk); }
  return { data: Buffer.concat(chunks), type: response.headers.get("content-type") || "" };
}

async function readLocal(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw fail("too_large", "Source files must be regular files within the import limits.");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1)); let bytes = 0;
    while (bytes < buffer.length) { const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!read.bytesRead) break; bytes += read.bytesRead; }
    const after = await handle.stat();
    if (bytes !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw fail("conflict", "A source file changed during preview. Preview it again.");
    return buffer.subarray(0, bytes);
  } finally { await handle.close(); }
}

export async function resolveSkillSource(value, { home, metadata, env = process.env, fetcher = fetch, run = runSourceGit } = {}) {
  const parsed = parseSkillSource(value, home), signal = AbortSignal.timeout(45000);
  const limits = SOURCE_LIMITS, files = [], warnings = [];
  let cleanup = async () => {}, total = 0, read;
  const add = (file) => { if (files.length >= limits.entries) throw fail("too_large", "The source has too many files; use a specific skill folder."); files.push(file); };
  try {
    if (parsed.type === "git") {
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "t3-skill-source-"));
      cleanup = () => fs.rm(temporary, { recursive: true, force: true });
      const repo = path.join(temporary, "repo");
      const git = async (args, maxBuffer = 2 * 1024 * 1024) => {
        try { return (await run("git", ["--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", ...args], {
          env: { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, directory: temporary, signal, timeout: 45000, maxBuffer, encoding: "buffer", killSignal: "SIGKILL",
        })).stdout; } catch (error) { if (error.code === "too_large") throw error; throw fail("unavailable", "Could not read this Git source within 45 seconds. Check the repository/ref and configure Git or SSH credentials in the container for private sources."); }
      };
      const commit = /^[a-f0-9]{40}$/.test(parsed.ref || "");
      // Copied tree URLs do not delimit refs containing slashes. Match the
      // longest advertised branch/tag before treating the remainder as a folder.
      if (parsed.ref && parsed.subpath && !commit) {
        const combined = parsed.ref + "/" + parsed.subpath;
        const advertised = (await git(["ls-remote", "--heads", "--tags", "--", parsed.source, "refs/heads/" + parsed.ref + "*", "refs/tags/" + parsed.ref + "*"])).toString("utf8");
        const refs = advertised.split("\n").map((line) => /^[a-f0-9]+\trefs\/(?:heads|tags)\/(.+)$/.exec(line)?.[1]).filter((ref) => ref && !ref.endsWith("^{}") && (combined === ref || combined.startsWith(ref + "/"))).sort((a, b) => b.length - a.length);
        if (refs[0]) { parsed.ref = refs[0]; parsed.subpath = combined.slice(parsed.ref.length).replace(/^\//, ""); }
      }
      await git(["clone", "--depth", "1", "--no-checkout", ...(parsed.ref && !commit ? ["--branch", parsed.ref] : []), "--", parsed.source, repo]);
      if (commit) await git(["-C", repo, "fetch", "--depth", "1", "--", "origin", parsed.ref]);
      const tree = (await git(["-C", repo, "ls-tree", "-r", "-l", "-z", commit ? "FETCH_HEAD" : "HEAD", ...(parsed.subpath ? ["--", parsed.subpath] : [])])).toString("utf8");
      for (const entry of tree.split("\0").filter(Boolean)) {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry);
        if (!match) throw fail("invalid", "Unrecognized Git tree entry.");
        const [, mode, type, object, size, name] = match;
        if (type !== "blob" || !["100644", "100755"].includes(mode)) { warnings.push("Skipped a symlink or submodule: " + name); continue; }
        if (!safeRelative(name)) throw fail("invalid", "The repository contains an unsafe path.");
        add({ name, size: Number(size), mode: mode === "100755" ? 0o700 : 0o600, object });
      }
      read = (file, limit) => { if (file.size > limit) throw fail("too_large", "A source file exceeds its import limit."); return git(["-C", repo, "cat-file", "blob", file.object], limit + 1); };
    } else if (parsed.type === "local") {
      // Resolve only the explicitly supplied root. Child links are never followed.
      const root = await fs.realpath(parsed.source), initial = await fs.stat(root);
      const walk = async (directory, depth = 0) => {
        if (depth > limits.depth || signal.aborted) throw fail("too_large", "The source exceeds the depth or time limit.");
        if (await fs.realpath(directory) !== directory) throw fail("conflict", "A source directory became a link. Preview again.");
        for await (const entry of await fs.opendir(directory)) {
          if ([".git", "node_modules", ".system"].includes(entry.name)) continue;
          const full = path.join(directory, entry.name), stat = await fs.lstat(full);
          if (++total > limits.entries) throw fail("too_large", "The source has too many entries; use a specific skill folder.");
          if (stat.isSymbolicLink()) { warnings.push("Skipped a symlink: " + path.relative(root, full)); continue; }
          if (stat.isDirectory()) await walk(full, depth + 1);
          else if (stat.isFile()) add({ name: path.relative(root, full).split(path.sep).join("/"), full, size: stat.size, mode: stat.mode & 0o111 ? 0o700 : 0o600 });
          else warnings.push("Skipped a non-regular file: " + entry.name);
        }
      };
      if (initial.isDirectory()) await walk(root);
      else if (initial.isFile()) add({ name: "SKILL.md", full: root, size: initial.size, mode: 0o600 });
      else throw fail("invalid", "Choose a skill folder or Markdown file.");
      read = async (file, limit) => {
        if (await fs.realpath(file.full) !== file.full) throw fail("conflict", "A source file became a link. Preview again.");
        return readLocal(file.full, limit);
      };
    } else {
      const response = await download(parsed.source, 1024 * 1024, fetcher, signal);
      const text = response.data.toString("utf8");
      if (response.type.includes("html") || /^\s*<!doctype|^\s*<html/i.test(text)) {
        const links = new Map(), catalogHost = new URL(parsed.source).hostname;
        for (const match of text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
          let url; try { url = new URL(match[1].replace(/&amp;/g, "&"), parsed.source); } catch { continue; }
          const catalogDetail = url.hostname === catalogHost && catalogHost === "agenticskills.io" && /^\/skills\/[^/]+\/?$/.test(url.pathname);
          if (url.protocol !== "https:" || (!catalogDetail && !["github.com", "gitlab.com", "skills.sh"].includes(url.hostname)) || url.pathname.split("/").filter(Boolean).length < 2) continue;
          if (url.hostname === "github.com" && !/^\/[^/]+\/[^/]+(?:\/(?:tree|blob)\/.*)?\/?$/.test(url.pathname)) continue;
          if (links.size < 256) links.set(url.href, { source: url.href, label: catalogDetail ? url.pathname.split("/").filter(Boolean).at(-1).replaceAll("-", " ") : url.hostname + url.pathname });
        }
        if (!links.size) throw fail("invalid", "This is a web page, not a skill. Copy its repository link, direct SKILL.md URL or skills add command.");
        return { source: value, links: [...links.values()].sort((a, b) => Number(a.source.includes("/blob/")) - Number(b.source.includes("/blob/"))), skills: [], warnings: ["Choose a repository or skill link from this page to preview its contents." + (links.size === 256 ? " Showing the first 256 links; paste a specific skill page to find more." : "")] };
      }
      if (response.data.length > limits.markdownBytes) throw fail("too_large", "Skill Markdown exceeds 64 KiB.");
      add({ name: "SKILL.md", data: response.data, size: response.data.length, mode: 0o600 });
      read = async (file) => file.data;
    }
    total = 0;
    const skills = [], names = new Set(); let oversized = false;
    let candidates = files.filter((file) => path.posix.basename(file.name) === "SKILL.md"), preferredPaths = null, foundPreferred = false;
    // Match normal library discovery before falling back to arbitrary layouts.
    // Otherwise a tool repo's private workflows/examples become install picks
    // alongside its published skills. Explicit name/folder sources still work.
    if (!parsed.filter) {
      const prefix = parsed.type === "git" && parsed.subpath ? parsed.subpath + "/" : "";
      const preferred = candidates.filter((file) => {
        const relative = file.name.slice(prefix.length), parts = relative.split("/");
        return file.name.startsWith(prefix) && (parts.length <= 2 || parts[0] === "skills" || (parts[0].startsWith(".") && parts[1] === "skills"));
      });
      if (preferred.length) {
        preferredPaths = new Set(preferred.map((file) => file.name));
        candidates = [...preferred, ...candidates.filter((file) => !preferredPaths.has(file.name))];
      }
    }
    for (const entry of candidates) {
      if (foundPreferred && !preferredPaths.has(entry.name)) break;
      if (skills.length >= limits.skills) throw fail("too_large", "The source contains too many skills; use a specific folder.");
      // A large unrelated skill must not prevent selecting a portable sibling.
      // Check sizes before opening; an oversized selected folder still errors.
      if (entry.size > limits.markdownBytes) {
        oversized = true; warnings.push("Skipped " + entry.name + ": Skill Markdown exceeds 64 KiB."); continue;
      }
      const raw = await read(entry, limits.markdownBytes);
      if (raw.length > limits.markdownBytes) throw fail("too_large", "Skill Markdown exceeds 64 KiB.");
      const content = raw.toString("utf8"), info = metadata(content, path.posix.basename(path.posix.dirname(entry.name)));
      if (info.metadataError || !portable(info.name)) { warnings.push("Skipped " + entry.name + ": " + (info.metadataError || "Use a portable skill name of 1–64 lowercase letters, numbers and single hyphens.")); continue; }
      if (parsed.filter && info.name !== parsed.filter) continue;
      if (names.has(info.name)) throw fail("conflict", "The source contains duplicate skill names. Use a specific skill folder.");
      const directory = path.posix.dirname(entry.name), prefix = directory === "." ? "" : directory + "/";
      const children = files.filter((file) => file.name.startsWith(prefix));
      if (children.some((file) => file !== entry && path.posix.basename(file.name) === "SKILL.md")) { warnings.push("Skipped " + info.name + ": its folder contains another skill; use the inner skills instead."); continue; }
      const treeEntries = new Set(["."]);
      for (const file of children) {
        const relative = file.name.slice(prefix.length), parts = relative.split("/");
        for (let i = 1; i <= parts.length; i++) treeEntries.add(parts.slice(0, i).join("/"));
      }
      if (treeEntries.size > 1024) throw fail("too_large", "This skill exceeds the 1024-entry management limit. Use a smaller skill folder.");
      const copied = [];
      for (const file of children) {
        const name = file.name.slice(prefix.length);
        if (!safeRelative(name) || name.split("/").length > limits.depth) throw fail("invalid", "A skill contains an unsafe or deeply nested path.");
        if (file.size > limits.fileBytes || total + file.size > limits.bytes) throw fail("too_large", "Selected source files exceed the 4 MiB file or 25 MiB preview limit. Use a specific skill folder.");
        const data = file === entry ? Buffer.from(content) : await read(file, limits.fileBytes);
        if (data.length > limits.fileBytes || total + data.length > limits.bytes) throw fail("too_large", "Source contents grew beyond the preview limit. Preview a smaller folder.");
        total += data.length; copied.push({ name, data, mode: file.mode });
      }
      names.add(info.name); skills.push({ name: info.name, description: info.description, content, files: copied });
      if (preferredPaths?.has(entry.name)) foundPreferred = true;
    }
    if (!skills.length) throw fail(oversized ? "too_large" : "invalid", oversized ? "No matching skill could be imported. Skill Markdown must fit within 64 KiB; use a smaller skill or manage oversized skills directly." : parsed.filter ? "That skill was not found in this source." : "No valid SKILL.md files found. Choose a skill repository/folder or paste a direct Markdown link.");
    return { source: value, skills, warnings: [...new Set(warnings)].slice(0, 30) };
  } finally { await cleanup(); }
}
