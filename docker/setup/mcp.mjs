// Shared MCP servers: canonical store plus per-provider link state derived
// by comparison (no new manifest format). No MCP execution here.
import path from "node:path";
import { mcpStorePathFor, readMcpStore, createMcpServer, saveMcpServer, removeMcpServer, redactMcpServer, validateMcpServer, MCP_PROVIDERS, UNSUPPORTED_MCP_PROVIDERS } from "./mcp/store.mjs";
import { readProviderMcp, writeProviderMcpEntry, toClaudeEntry, toCodexEntry, toOpenCodeEntry, toCursorEntry, toGeminiEntry, isSupportedMcpProvider } from "./mcp/adapters.mjs";

const problem = (code, message) => Object.assign(new Error(message), { code });
const summaryError = (error) => String(error?.message || error).slice(0, 240);

export function mcpProviders() {
  return [...Object.entries(MCP_PROVIDERS).map(([id, name]) => ({ id, name })), ...Object.entries(UNSUPPORTED_MCP_PROVIDERS).map(([id, reason]) => ({ id, name: id === "grok" ? "Grok Build" : "Muse Code", unsupported: reason }))];
}

const toEntryFor = (provider, server) =>
  provider === "claude" ? toClaudeEntry(server)
  : provider === "codex" ? toCodexEntry(server)
  : provider === "opencode" ? toOpenCodeEntry(server)
  : provider === "cursor" ? toCursorEntry(server)
  : toGeminiEntry(server);

const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
};
const canonicalEqual = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
// Native `enabled` exists for Codex and OpenCode only. Other providers link
// by content; a disabled shared server stays unlinked there with a reason.
const linkable = (provider, server) => server.enabled !== false || provider === "codex" || provider === "opencode";

export function createMcpService({ home, env = process.env, io, baseDir, ttlMs = 15000 } = {}) {
  if (!io) throw new Error("mcp service needs an fs implementation");
  home = path.resolve(home || env.HOME || "/home/t3");
  baseDir = baseDir || process.env.T3CODE_HOME || path.join(home, ".t3");
  const statusCache = { at: 0, promise: null };

  const linkState = async (provider, shared) => {
    if (UNSUPPORTED_MCP_PROVIDERS[provider]) return { provider, supported: false, error: UNSUPPORTED_MCP_PROVIDERS[provider], linked: [], unlinked: shared.map((s) => s.name), own: 0 };
    if (!isSupportedMcpProvider(provider)) throw problem("invalid", "Unknown MCP provider.");
    try {
      const read = await readProviderMcp(io, provider, { home, env });
      const byName = new Map(read.servers.map((row) => [row.name, row]));
      const linked = [], unlinked = [], diverged = [];
      for (const server of shared) {
        const row = byName.get(server.name);
        if (!row) { unlinked.push(server.name); continue; }
        if (row.canonical && canonicalEqual(row.canonical, server)) { linked.push(server.name); continue; }
        if (!linkable(provider, server)) { unlinked.push(server.name); continue; }
        // Content differs: a provider-side edit, or a shared edit not yet applied.
        diverged.push(server.name);
      }
      const sharedNames = new Set(shared.map((server) => server.name));
      const own = read.servers.filter((row) => !sharedNames.has(row.name)).map((row) => row.name);
      return { provider, supported: true, path: read.path, present: read.present, linked, unlinked, diverged,
        own, ownCount: own.length, error: null,
        warning: read.servers.some((row) => !row.canonical) ? "One or more provider entries use an unsupported shape and are left in place." : null };
    } catch (error) {
      return { provider, supported: true, path: null, linked: [], unlinked: shared.map((s) => s.name), own: [], ownCount: 0, error: summaryError(error), code: error?.code };
    }
  };

  const status = async ({ refresh = false } = {}) => {
    if (!refresh && statusCache.promise && Date.now() - statusCache.at < ttlMs) return statusCache.promise;
    const promise = (async () => {
      const store = await readMcpStore(io, baseDir);
      const providers = [];
      for (const provider of ["claude", "codex", "opencode", "cursor", "antigravity", "grok", "muse"]) {
        providers.push(await linkState(provider, store.servers));
      }
      return { ok: !store.error, shared: { present: store.present, count: store.servers.length, revision: store.revision, bytes: store.bytes, error: store.error ?? null,
          servers: store.servers.map(redactMcpServer) }, providers, scannedAt: Date.now() };
    })();
    statusCache.promise = promise;
    statusCache.at = Date.now();
    promise.then(() => {}, () => { statusCache.promise = null; });
    return promise;
  };
  const invalidate = () => { statusCache.promise = null; statusCache.at = 0; };

  const list = async (provider) => {
    if (UNSUPPORTED_MCP_PROVIDERS[provider]) throw problem("unsupported", UNSUPPORTED_MCP_PROVIDERS[provider]);
    if (!isSupportedMcpProvider(provider)) throw problem("invalid", "Unknown MCP provider.");
    const store = await readMcpStore(io, baseDir);
    const state = await linkState(provider, store.servers);
    if (state.error) throw problem(state.code || "unavailable", state.error);
    let detail = null;
    try { detail = await readProviderMcp(io, provider, { home, env }); }
    catch (error) { throw problem(error?.code || "unavailable", summaryError(error)); }
    return { ok: true, provider, path: detail.path, sharedRevision: store.revision,
      shared: store.servers.map((server) => {
        const row = detail.servers.find((entry) => entry.name === server.name);
        const linked = Boolean(row?.canonical && canonicalEqual(row.canonical, server));
        return { ...redactMcpServer(server),
          linked,
          diverged: Boolean(row && !linked),
          linkable: linkable(provider, server),
          providerEntry: row && !linked ? "(differs from shared)" : row ? "(matches shared)" : "(not present)",
        };
      }),
      own: detail.servers.filter((row) => !store.servers.some((server) => server.name === row.name)).map((row) => ({ name: row.name, recognized: Boolean(row.canonical) })),
      unsupported: detail.servers.filter((row) => !row.canonical).map((row) => row.name),
    };
  };

  const read = async (name) => {
    const store = await readMcpStore(io, baseDir);
    if (store.error) throw problem(store.code || "unavailable", store.error);
    const server = store.servers.find((entry) => entry.name === name);
    if (!server) throw problem("missing", "This shared MCP server no longer exists. Refresh the list.");
    return { ok: true, server, revision: store.revision };
  };

  const setLink = async (provider, name, linked, sharedRevision) => {
    if (UNSUPPORTED_MCP_PROVIDERS[provider]) throw problem("unsupported", UNSUPPORTED_MCP_PROVIDERS[provider]);
    if (!isSupportedMcpProvider(provider)) throw problem("invalid", "Unknown MCP provider.");
    if (typeof linked !== "boolean") throw problem("invalid", "Expected a boolean linked value.");
    const base = baseDir;
    const store = await readMcpStore(io, base);
    if (store.error) throw problem(store.code || "unavailable", store.error);
    if (store.revision !== sharedRevision) throw problem("conflict", "Shared MCP servers changed. Refresh the list before changing links.");
    const server = store.servers.find((entry) => entry.name === name);
    if (!server) throw problem("missing", "This shared MCP server no longer exists. Refresh the list.");
    if (linked && !linkable(provider, server)) {
      throw problem("unsupported", "This provider has no native enabled flag; disable is represented by unlinking. Unlink instead.");
    }
    await writeProviderMcpEntry(io, provider, { home, env }, name, linked ? toEntryFor(provider, server) : null);
    invalidate();
    return { ok: true, provider, name, linked };
  };

  return {
    status, list, read, setLink, providers: mcpProviders,
    create: async (...args) => { const result = await createMcpServer(io, baseDir, ...args); invalidate(); if (!result.ok && !result.code) throw problem("invalid", result.error); if (!result.ok) throw problem(result.code || "invalid", result.error); return { ok: true, ...result }; },
    save: async (...args) => { const result = await saveMcpServer(io, baseDir, ...args); invalidate(); if (!result.ok && !result.code) throw problem("invalid", result.error); if (!result.ok) throw problem(result.code || "invalid", result.error); return { ok: true, ...result }; },
    remove: async (...args) => { const result = await removeMcpServer(io, baseDir, ...args); invalidate(); if (!result.ok) throw problem(result.code || "invalid", result.error); return { ok: true, ...result }; },
    validate: validateMcpServer,
  };
}

export { mcpStorePathFor };
