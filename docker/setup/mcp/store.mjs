// Shared MCP server store. Canonical JSON on the state volume; provider
// files are only touched by explicit link/unlink saves.
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const MCP_PROVIDERS = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  antigravity: "Antigravity",
});
export const SUPPORTED_MCP_PROVIDERS = Object.freeze(["claude", "codex", "opencode", "cursor", "antigravity"]);
// Grok Build and Muse Code MCP layouts are unverified against the pinned
// CLIs (see docs/context-management.md). They stay out until verified.
export const UNSUPPORTED_MCP_PROVIDERS = Object.freeze({
  grok: "Grok Build MCP layout is unverified against the pinned CLI; not managed here yet.",
  muse: "Muse Code MCP layout is unverified against the pinned CLI; not managed here yet.",
});

const MAX_STORE_BYTES = 256 * 1024;
const MAX_SERVERS = 128;
export const mcpDirFor = (baseDir) => path.join(baseDir, "setup", "mcp");
export const mcpStorePathFor = (baseDir) => path.join(mcpDirFor(baseDir), "servers.json");

export const MCP_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const problem = (code, message) => Object.assign(new Error(message), { code });

export function validateMcpServer(input) {
  const value = input && typeof input === "object" ? input : null;
  if (!value) return { ok: false, error: "Expected an MCP server object." };
  const name = String(value.name ?? "").trim();
  if (!MCP_NAME_RE.test(name) || name.length > 64) return { ok: false, error: "Use a server name of 1–64 lowercase letters, numbers and single hyphens." };
  const type = value.type === "remote" ? "remote" : value.type === "local" ? "local" : null;
  if (!type) return { ok: false, error: "Choose a local or remote server type." };
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") return { ok: false, error: "Expected enabled to be a boolean." };
  const out = { name, type, enabled };
  if (type === "local") {
    const command = Array.isArray(value.command) ? value.command : null;
    if (!command || command.length < 1 || command.length > 32 || !command.every((part) => typeof part === "string" && part.length >= 1 && part.length <= 1024)) {
      return { ok: false, error: "A local server needs a command of 1–32 entries, each 1–1024 characters." };
    }
    if (command.some((part) => part.includes("\0"))) return { ok: false, error: "Command entries must not contain NUL bytes." };
    out.command = [...command];
    const env = value.env === undefined ? {} : value.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) return { ok: false, error: "Expected env to be an object." };
    const keys = Object.keys(env);
    if (keys.length > 64) return { ok: false, error: "A server holds at most 64 environment entries." };
    for (const key of keys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > 128) return { ok: false, error: `Invalid environment name: ${key}` };
      if (typeof env[key] !== "string" || env[key].length > 8192 || env[key].includes("\0")) return { ok: false, error: `Invalid environment value for ${key}.` };
    }
    out.env = Object.fromEntries(keys.sort().map((key) => [key, String(env[key])]));
  } else {
    const url = String(value.url ?? "").trim();
    if (!/^https?:\/\/.{1,2048}$/.test(url)) return { ok: false, error: "A remote server needs an http(s) URL of at most 2048 characters." };
    out.url = url;
    const headers = value.headers === undefined ? {} : value.headers;
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return { ok: false, error: "Expected headers to be an object." };
    const keys = Object.keys(headers);
    if (keys.length > 64) return { ok: false, error: "A server holds at most 64 header entries." };
    for (const key of keys) {
      if (!/^[A-Za-z0-9-]+$/.test(key) || key.length > 128) return { ok: false, error: `Invalid header name: ${key}` };
      if (typeof headers[key] !== "string" || headers[key].length > 8192 || /[\r\n\0]/.test(headers[key])) return { ok: false, error: `Invalid header value for ${key}.` };
    }
    out.headers = Object.fromEntries(keys.sort().map((key) => [key, String(headers[key])]));
  }
  return { ok: true, server: out };
}

const canonicalServer = (server) => JSON.stringify(server);
export const mcpRevision = (servers) => createHash("sha256").update(JSON.stringify([...servers].sort((a, b) => a.name.localeCompare(b.name)))).digest("hex");

async function readStoreFile(fs, file) {
  let stat;
  try { stat = await fs.stat(file); }
  catch (error) { if (error?.code === "ENOENT") return { present: false }; throw error; }
  if (!stat.isFile()) throw problem("invalid", "The shared MCP store must be a regular file.");
  if (stat.size > MAX_STORE_BYTES) throw problem("too_large", "The shared MCP store exceeds the 256 KiB limit. Reduce it directly on disk.");
  const raw = await fs.readFile(file, "utf8");
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw problem("invalid", "The shared MCP store is not valid JSON. Repair it directly on disk."); }
  const list = Array.isArray(parsed) ? parsed : parsed?.servers;
  if (!Array.isArray(list)) throw problem("invalid", "The shared MCP store must hold a server list.");
  if (list.length > MAX_SERVERS) throw problem("too_large", "The shared MCP store holds too many servers.");
  const servers = [];
  for (const entry of list) {
    const checked = validateMcpServer(entry);
    if (!checked.ok) throw problem("invalid", "The shared MCP store holds an invalid server: " + checked.error);
    servers.push(checked.server);
  }
  const names = servers.map((server) => server.name);
  if (new Set(names).size !== names.length) throw problem("invalid", "The shared MCP store holds duplicate server names.");
  return { present: true, servers, bytes: Buffer.byteLength(raw, "utf8") };
}

async function writeFileAtomic(fs, file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

const storeQueues = new Map();
async function withStore(file, work) {
  const key = path.resolve(file);
  const previous = storeQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  storeQueues.set(key, current);
  try { return await current; }
  finally { if (storeQueues.get(key) === current) storeQueues.delete(key); }
}

export async function readMcpStore(fs, baseDir) {
  const file = mcpStorePathFor(baseDir);
  try {
    const read = await readStoreFile(fs, file);
    if (!read.present) return { present: false, path: file, servers: [], revision: mcpRevision([]), bytes: 0, error: null };
    return { present: read.servers.length > 0, path: file, servers: read.servers, revision: mcpRevision(read.servers), bytes: read.bytes, error: null };
  } catch (error) {
    return { present: error?.code === "too_large", path: file, servers: [], revision: null, bytes: 0,
      code: error?.code, error: String(error?.message ?? error) };
  }
}

const changedStore = () => ({ ok: false, code: "conflict", error: "Shared MCP servers changed since you opened them. Reopen the editor to load the current list." });

export async function createMcpServer(fs, baseDir, input) {
  const checked = validateMcpServer(input);
  if (!checked.ok) return checked;
  const file = mcpStorePathFor(baseDir);
  return withStore(file, async () => {
    const read = await readMcpStore(fs, baseDir);
    if (read.error) return { ok: false, error: read.error };
    if (read.servers.some((server) => server.name === checked.server.name)) {
      return { ok: false, code: "conflict", error: "A shared MCP server with that name already exists." };
    }
    const servers = [...read.servers, checked.server];
    await writeFileAtomic(fs, file, JSON.stringify({ version: 1, servers }, null, 2) + "\n");
    return { ok: true, path: file, created: !read.present && read.servers.length === 0, revision: mcpRevision(servers), server: checked.server };
  });
}

export async function saveMcpServer(fs, baseDir, name, revision, input) {
  const checked = validateMcpServer({ ...(input ?? {}), name });
  if (!checked.ok) return checked;
  if (checked.server.name !== String(name ?? "").trim()) return { ok: false, error: "The server name cannot be changed. Remove it and add a new one." };
  const file = mcpStorePathFor(baseDir);
  return withStore(file, async () => {
    const read = await readMcpStore(fs, baseDir);
    if (read.error) return { ok: false, error: read.error };
    if (read.revision !== revision) return changedStore();
    const at = read.servers.findIndex((server) => server.name === checked.server.name);
    if (at < 0) return { ok: false, code: "missing", error: "This shared MCP server no longer exists. Refresh the list." };
    const servers = read.servers.map((server, index) => index === at ? checked.server : server);
    await writeFileAtomic(fs, file, JSON.stringify({ version: 1, servers }, null, 2) + "\n");
    return { ok: true, path: file, revision: mcpRevision(servers), server: checked.server };
  });
}

export async function removeMcpServer(fs, baseDir, name, revision) {
  const file = mcpStorePathFor(baseDir);
  return withStore(file, async () => {
    const read = await readMcpStore(fs, baseDir);
    if (read.error) return { ok: false, error: read.error };
    if (read.revision !== revision) return changedStore();
    if (!read.servers.some((server) => server.name === name)) return { ok: true, path: file, deleted: false, revision: read.revision };
    const servers = read.servers.filter((server) => server.name !== name);
    if (servers.length === 0) await fs.rm(file, { force: true });
    else await writeFileAtomic(fs, file, JSON.stringify({ version: 1, servers }, null, 2) + "\n");
    return { ok: true, path: file, deleted: true, removed: name, revision: mcpRevision(servers) };
  });
}

export function redactMcpServer(server) {
  const { env, headers, ...rest } = server;
  return { ...rest,
    envKeys: Object.keys(env ?? {}),
    envCount: Object.keys(env ?? {}).length,
    headerKeys: Object.keys(headers ?? {}),
    headerCount: Object.keys(headers ?? {}).length,
    secretCount: Object.keys(env ?? {}).length + Object.keys(headers ?? {}).length,
  };
}

// Fingerprint of the translated provider entry, so link state is derived by
// comparison instead of a new manifest format.
export const mcpFingerprint = (value) => createHash("sha256").update(canonicalServer(value)).digest("hex");
