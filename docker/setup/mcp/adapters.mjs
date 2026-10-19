// Per-provider MCP file adapters. File-based only (no harness CLI): the
// console reads bounded JSON/TOML, merges one server entry, and preserves
// every unrelated key, comment and section.
import path from "node:path";
import { parse, parseTree, modify, applyEdits } from "../vendor/jsonc.mjs";
import { parseMcpToml, applyMcpToml } from "./toml.mjs";

const MAX_FILE_BYTES = 1024 * 1024;
const problem = (code, message) => Object.assign(new Error(message), { code });

const homeOf = (home, env) => path.resolve(home || env.HOME || "/home/t3");
const readBounded = async (io, file) => {
  const stat = await io.stat(file);
  if (!stat.isFile()) throw problem("invalid", "The MCP configuration must be a regular file.");
  if (stat.size > MAX_FILE_BYTES) throw problem("too_large", "The MCP configuration exceeds the 1 MiB limit.");
  return io.readFile(file, "utf8");
};
const readJsonFile = async (io, file) => {
  let raw;
  try { raw = await readBounded(io, file); }
  catch (error) { if (error?.code === "ENOENT") return { present: false, raw: null, value: {} }; throw error; }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw problem("unsupported", "The MCP configuration is not valid JSON. Repair it before changing MCP servers."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw problem("unsupported", "The MCP configuration must be a JSON object.");
  return { present: true, raw, value };
};
const jsoncKeys = (file, strict) => {
  try {
    const errors = [];
    const tree = parseTree(file.raw, errors, { allowTrailingComma: !strict, disallowComments: strict });
    if (errors.length || tree?.type !== "object") throw new Error("invalid");
    return parse(file.raw, [], { allowTrailingComma: !strict, disallowComments: strict });
  } catch { throw problem("unsupported", "The MCP configuration contains invalid JSON/JSONC. Repair it before changing MCP servers."); }
};

// --- config paths ------------------------------------------------------------
export const claudeMcpPath = (home, env) => path.join(homeOf(home, env), ".claude.json");
export const codexMcpPath = (home, env) => path.join(path.resolve(homeOf(home, env), env.CODEX_HOME || ".codex"), "config.toml");
export const openCodeConfigPath = async (io, home, env) => {
  const root = path.resolve(homeOf(home, env), env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || ".config", "opencode"));
  const jsonc = path.join(root, "opencode.jsonc");
  try { await io.lstat(jsonc); return { file: jsonc, jsonc: true }; }
  catch (error) { if (error?.code !== "ENOENT") throw error; return { file: path.join(root, "opencode.json"), jsonc: false }; }
};
export const cursorMcpPath = (home, env) => path.join(homeOf(home, env), ".cursor", "mcp.json");
export const geminiMcpPath = (home, env) => path.join(homeOf(home, env), ".gemini", "settings.json");

// --- canonical translation ---------------------------------------------------
// The shared store is the source of truth; each function maps it to the
// provider's own shape. Secrets are carried (the editor needs them); status
// polling must use redacted summaries instead.
export function toClaudeEntry(server) {
  if (server.type === "local") {
    const entry = { command: server.command[0], args: server.command.slice(1) };
    if (Object.keys(server.env).length) entry.env = { ...server.env };
    return entry;
  }
  return { type: "http", url: server.url, ...(Object.keys(server.headers).length ? { headers: { ...server.headers } } : {}) };
}
export function fromClaudeEntry(name, entry) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.url === "string" && /^https?:\/\//.test(entry.url)) {
    return { name, type: "remote", url: entry.url, headers: { ...(entry.headers ?? {}) }, enabled: true };
  }
  if (typeof entry.command === "string" && entry.command) {
    return { name, type: "local", command: [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])], env: { ...(entry.env ?? {}) }, enabled: true };
  }
  return null;
}
export function toCodexEntry(server) {
  if (server.type === "local") {
    const entry = { command: server.command[0], args: server.command.slice(1) };
    if (Object.keys(server.env).length) entry.env = { ...server.env };
    if (server.enabled === false) entry.enabled = false;
    return entry;
  }
  const entry = { url: server.url };
  if (Object.keys(server.headers).length) entry.http_headers = { ...server.headers };
  if (server.enabled === false) entry.enabled = false;
  return entry;
}
export function fromCodexEntry(name, entry) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.url === "string" && entry.url) {
    return { name, type: "remote", url: entry.url, headers: { ...(entry.http_headers ?? {}) }, enabled: entry.enabled !== false };
  }
  if (typeof entry.command === "string" && entry.command) {
    return { name, type: "local", command: [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])], env: { ...(entry.env ?? {}) }, enabled: entry.enabled !== false };
  }
  return null;
}
export function toOpenCodeEntry(server) {
  if (server.type === "local") {
    return { type: "local", command: [...server.command], ...(Object.keys(server.env).length ? { environment: { ...server.env } } : {}), enabled: server.enabled !== false };
  }
  return { type: "remote", url: server.url, ...(Object.keys(server.headers).length ? { headers: { ...server.headers } } : {}), enabled: server.enabled !== false };
}
export function fromOpenCodeEntry(name, entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "remote" && typeof entry.url === "string") {
    return { name, type: "remote", url: entry.url, headers: { ...(entry.headers ?? {}) }, enabled: entry.enabled !== false };
  }
  if ((entry.type === "local" || entry.type === undefined) && Array.isArray(entry.command)) {
    return { name, type: "local", command: [...entry.command], env: { ...(entry.environment ?? entry.env ?? {}) }, enabled: entry.enabled !== false };
  }
  return null;
}
export function toCursorEntry(server) {
  return toClaudeEntry(server);
}
export function fromCursorEntry(name, entry) {
  return fromClaudeEntry(name, entry);
}
export function toGeminiEntry(server) {
  if (server.type === "local") {
    const entry = { command: server.command[0], args: server.command.slice(1) };
    if (Object.keys(server.env).length) entry.env = { ...server.env };
    return entry;
  }
  return { httpUrl: server.url, ...(Object.keys(server.headers).length ? { headers: { ...server.headers } } : {}) };
}
export function fromGeminiEntry(name, entry) {
  if (!entry || typeof entry !== "object") return null;
  const url = typeof entry.httpUrl === "string" ? entry.httpUrl : typeof entry.url === "string" ? entry.url : null;
  if (url && /^https?:\/\//.test(url)) return { name, type: "remote", url, headers: { ...(entry.headers ?? {}) }, enabled: true };
  if (typeof entry.command === "string" && entry.command) {
    return { name, type: "local", command: [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])], env: { ...(entry.env ?? {}) }, enabled: true };
  }
  return null;
}

export const ADAPTERS = Object.freeze({
  claude: { file: claudeMcpPath, toEntry: toClaudeEntry, fromEntry: fromClaudeEntry, containerKey: "mcpServers" },
  cursor: { file: cursorMcpPath, toEntry: toCursorEntry, fromEntry: fromCursorEntry, containerKey: "mcpServers" },
  antigravity: { file: geminiMcpPath, toEntry: toGeminiEntry, fromEntry: fromGeminiEntry, containerKey: "mcpServers" },
});
export const isSupportedMcpProvider = (provider) => ["claude", "codex", "opencode", "cursor", "antigravity"].includes(provider);

// --- JSON container helpers (claude/cursor/gemini) ---------------------------
const listJsonServers = (value, containerKey) => {
  const container = value?.[containerKey];
  if (container === undefined) return { servers: new Map(), present: false };
  if (!container || typeof container !== "object" || Array.isArray(container)) throw problem("unsupported", "The MCP configuration has an unsupported server section.");
  return { servers: new Map(Object.entries(container)), present: true };
};

/** Read one provider's own servers without secrets leaving redacted summaries. */
export async function readProviderMcp(io, provider, { home, env = {} }) {
  const resolvedHome = homeOf(home, env);
  if (provider === "codex") {
    const file = codexMcpPath(resolvedHome, env);
    let raw;
    try { raw = await readBounded(io, file); }
    catch (error) { if (error?.code === "ENOENT") return { provider, path: file, present: false, servers: [] }; throw error; }
    let parsed;
    try { parsed = parseMcpToml(raw); }
    catch (error) { throw problem(error?.code || "unsupported", "Codex config.toml MCP sections are unsupported: " + (error?.message || "parse error")); }
    return { provider, path: file, present: true, raw, servers: [...parsed.entries()].map(([name, entry]) => ({ name, entry, canonical: fromCodexEntry(name, entry) })) };
  }
  if (provider === "opencode" || provider === "antigravity") {
    // OpenCode uses JSONC; Gemini settings tolerate comments too. Parse with
    // the same vendored parser as skill policies so comments survive reads.
    const file = provider === "opencode" ? (await openCodeConfigPath(io, resolvedHome, env)).file : ADAPTERS.antigravity.file(resolvedHome, env);
    let raw;
    try { raw = await readBounded(io, file); }
    catch (error) { if (error?.code === "ENOENT") return { provider, path: file, present: false, servers: [] }; throw error; }
    let value;
    try {
      value = parse(raw, [], { allowTrailingComma: true, disallowComments: false });
    } catch { throw problem("unsupported", "The MCP configuration contains invalid JSON/JSONC. Repair it before changing MCP servers."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw problem("unsupported", "The MCP configuration must be a JSON object.");
    if (provider === "opencode") {
      const container = value?.mcp;
      if (container !== undefined && (!container || typeof container !== "object" || Array.isArray(container))) {
        throw problem("unsupported", "The OpenCode MCP section has an unsupported shape.");
      }
      return { provider, path: file, present: true, raw, value,
        servers: Object.entries(container ?? {}).map(([name, entry]) => ({ name, entry, canonical: fromOpenCodeEntry(name, entry) })) };
    }
    const { servers } = listJsonServers(value, "mcpServers");
    return { provider, path: file, present: true, raw, value,
      servers: [...servers.entries()].map(([name, entry]) => ({ name, entry, canonical: fromGeminiEntry(name, entry) })) };
  }
  const adapter = ADAPTERS[provider];
  if (!adapter) throw problem("invalid", "Unknown MCP provider.");
  const file = adapter.file(resolvedHome, env);
  const read = await readJsonFile(io, file).catch((error) => {
    if (error?.code === "ENOENT") return { present: false, raw: null, value: {} };
    throw error;
  });
  const { servers } = listJsonServers(read.value, adapter.containerKey);
  return { provider, path: file, present: read.present, raw: read.raw, value: read.value,
    servers: [...servers.entries()].map(([name, entry]) => ({ name, entry, canonical: adapter.fromEntry(name, entry) })) };
}

/** Merge one translated entry into the provider file, preserving the rest. */
export async function writeProviderMcpEntry(io, provider, { home, env = {} }, name, entryOrNull) {
  const resolvedHome = homeOf(home, env);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw problem("invalid", "Invalid MCP server name.");
  if (provider === "codex") {
    const file = codexMcpPath(resolvedHome, env);
    await io.mkdir(path.dirname(file), { recursive: true });
    let raw = "";
    try { raw = await readBounded(io, file); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const next = applyMcpToml(raw, name, entryOrNull);
    await io.writeFile(file + `.tmp.${process.pid}`, next, { encoding: "utf8", mode: 0o600 }).catch(async () => {
      await io.mkdir(path.dirname(file), { recursive: true });
      await io.writeFile(file + `.tmp.${process.pid}`, next, { encoding: "utf8", mode: 0o600 });
    });
    await io.chmod(file + `.tmp.${process.pid}`, 0o600);
    await io.rename(file + `.tmp.${process.pid}`, file);
    return { ok: true, path: file };
  }
  if (provider === "opencode") {
    const { file } = await openCodeConfigPath(io, resolvedHome, env);
    await io.mkdir(path.dirname(file), { recursive: true });
    let raw = "";
    try { raw = await readBounded(io, file); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (!raw.trim()) raw = '{}\n';
    const value = jsoncKeys({ raw }, false);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw problem("unsupported", "The OpenCode MCP configuration must be a JSON object.");
    if (value.mcp !== undefined && (!value.mcp || typeof value.mcp !== "object" || Array.isArray(value.mcp))) {
      throw problem("unsupported", "The OpenCode MCP section has an unsupported shape.");
    }
    const formatting = { insertSpaces: true, tabSize: 2, eol: raw.includes("\r\n") ? "\r\n" : "\n" };
    let content = raw;
    if (entryOrNull) content = applyEdits(content, modify(content, ["mcp", name], entryOrNull, { formattingOptions: formatting }));
    else if (value.mcp && Object.hasOwn(value.mcp, name)) content = applyEdits(content, modify(content, ["mcp", name], undefined, { formattingOptions: formatting }));
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw problem("too_large", "The MCP configuration would exceed the 1 MiB limit.");
    const tmp = file + `.tmp.${process.pid}`;
    await io.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await io.chmod(tmp, 0o600);
    await io.rename(tmp, file);
    return { ok: true, path: file };
  }
  const adapter = ADAPTERS[provider];
  if (!adapter) throw problem("invalid", "Unknown MCP provider.");
  const file = adapter.file(resolvedHome, env);
  await io.mkdir(path.dirname(file), { recursive: true });
  let raw = "";
  try { raw = await readBounded(io, file); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (!raw.trim()) raw = '{}\n';
  if (provider === "antigravity") {
    // settings.json tolerates comments; preserve them like opencode does.
    const value = jsoncKeys({ raw }, false);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw problem("unsupported", "The MCP configuration must be a JSON object.");
    if (value.mcpServers !== undefined && (!value.mcpServers || typeof value.mcpServers !== "object" || Array.isArray(value.mcpServers))) {
      throw problem("unsupported", "The MCP configuration has an unsupported server section.");
    }
    const formatting = { insertSpaces: true, tabSize: 2, eol: raw.includes("\r\n") ? "\r\n" : "\n" };
    let content = raw;
    if (entryOrNull) content = applyEdits(content, modify(content, ["mcpServers", name], entryOrNull, { formattingOptions: formatting }));
    else if (value.mcpServers && Object.hasOwn(value.mcpServers, name)) content = applyEdits(content, modify(content, ["mcpServers", name], undefined, { formattingOptions: formatting }));
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw problem("too_large", "The MCP configuration would exceed the 1 MiB limit.");
    const tmp = file + `.tmp.${process.pid}`;
    await io.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await io.chmod(tmp, 0o600);
    await io.rename(tmp, file);
    return { ok: true, path: file };
  }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw problem("unsupported", "The MCP configuration is not valid JSON. Repair it before changing MCP servers."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw problem("unsupported", "The MCP configuration must be a JSON object.");
  if (value[adapter.containerKey] !== undefined && (!value[adapter.containerKey] || typeof value[adapter.containerKey] !== "object" || Array.isArray(value[adapter.containerKey]))) {
    throw problem("unsupported", "The MCP configuration has an unsupported server section.");
  }
  const next = { ...value, [adapter.containerKey]: { ...(value[adapter.containerKey] ?? {}) } };
  if (entryOrNull) next[adapter.containerKey][name] = entryOrNull;
  else delete next[adapter.containerKey][name];
  const content = JSON.stringify(next, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw problem("too_large", "The MCP configuration would exceed the 1 MiB limit.");
  const tmp = file + `.tmp.${process.pid}`;
  await io.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await io.chmod(tmp, 0o600);
  await io.rename(tmp, file);
  return { ok: true, path: file };
}
