// Review installed Codex plugin hooks through native metadata, never by running them.
import path from "node:path";
import { createHash } from "node:crypto";
import { listCodexHooks, writeCodexHookConfig } from "./codex.mjs";
import { codexConfigPath, configSnapshot, serializeState } from "./state.mjs";

const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = value => createHash("sha256").update(value).digest("hex");
const text = (value, limit) => typeof value === "string" && value.length <= limit;

export function createPluginHookService({ home, env, io, getHarness, nativeList = listCodexHooks, nativeWrite = writeCodexHookConfig }) {
  const settings = codexConfigPath(home, env);
  const load = async () => {
    const harness = await getHarness("codex");
    if (!harness?.runnable || !harness.executable) throw fail("unsupported", "Install Codex to review its plugin hooks.");
    const before = await configSnapshot(settings, io, true);
    const options = { executable: harness.executable, home, env, configPath: settings, resolvedConfigPath: before.resolvedPath };
    const native = await nativeList(options);
    if (before.revision !== await configSnapshot(settings, io)) throw fail("conflict", "Codex settings changed while reading hooks. Refresh and review them again.");
    if (!Array.isArray(native.hooks) || native.hooks.length > 256 || !text(native.configVersion, 256) || !Array.isArray(native.errors) || !Array.isArray(native.warnings)) throw fail("unavailable", "Codex returned an incomplete or oversized hook inventory.");
    // A partial inventory cannot authorize writes: a source may have failed to load.
    if (native.errors.length) throw fail("unavailable", "Codex reported hook discovery errors. Resolve them in Codex before reviewing plugin hooks here.");
    const hooks = [], seen = new Set();
    for (const hook of native.hooks) {
      if (hook.source !== "plugin") continue;
      if (!text(hook.pluginId, 256) || !hook.pluginId || !text(hook.key, 8192) || !hook.key || !text(hook.eventName, 128)
        || !text(hook.sourcePath, 8192) || !path.isAbsolute(hook.sourcePath) || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash)
        || !["trusted", "untrusted", "modified", "managed"].includes(hook.trustStatus) || typeof hook.enabled !== "boolean" || typeof hook.isManaged !== "boolean"
        || !["command", "mcpTool", "prompt", "agent"].includes(hook.handlerType) || hook.handlerType === "command" && (!text(hook.command, 65536) || !hook.command.trim())
        || hook.matcher !== null && !text(hook.matcher, 8192) || !Number.isSafeInteger(hook.timeoutSec) || hook.timeoutSec < 0
        || hook.handlerType === "command" && typeof hook.async !== "boolean" || seen.has(hook.key)) throw fail("unavailable", "Codex returned unrecognized plugin hook metadata.");
      seen.add(hook.key);
      const row = { id: digest(hook.key).slice(0, 32), pluginId: hook.pluginId, eventName: hook.eventName, sourcePath: hook.sourcePath,
        handlerType: hook.handlerType, command: hook.handlerType === "command" ? hook.command : null, matcher: hook.matcher,
        timeoutSec: hook.timeoutSec, async: hook.async === true, enabled: hook.enabled, trustStatus: hook.trustStatus, isManaged: hook.isManaged,
        readOnlyReason: hook.isManaged || hook.trustStatus === "managed" ? "Managed by Codex policy." : hook.handlerType !== "command" ? "Review this hook type in Codex; its full definition is not available here." : null };
      row.revision = digest(JSON.stringify([before.revision, hook]));
      hooks.push({ ...row, key: hook.key, currentHash: hook.currentHash });
    }
    return { hooks, options, configVersion: native.configVersion, configRevision: before.revision,
      warnings: native.warnings.filter(warning => text(warning, 2048)).slice(0, 30) };
  };
  const publicInventory = inventory => ({ ok: true, provider: "codex", hooks: inventory.hooks.map(({ key, currentHash, ...hook }) => hook), warnings: inventory.warnings });
  const listHooks = async () => publicInventory(await load());
  const setHook = async (id, revision, action) => {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id) || !["trust", "enable", "disable"].includes(action)) throw fail("invalid", "Choose a discovered plugin hook and a supported action.");
    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) throw fail("conflict", "Refresh and review the hook before changing it.");
    const resolved = await io.realpath(settings).catch(() => settings);
    return serializeState(resolved, async () => {
      const fresh = await load(), hook = fresh.hooks.find(row => row.id === id);
      if (!hook) throw fail("missing", "This plugin hook is no longer installed. Refresh the list.");
      if (hook.revision !== revision) throw fail("conflict", "The hook or Codex settings changed. Refresh and review the new definition.");
      if (hook.readOnlyReason) throw fail("unsupported", hook.readOnlyReason);
      if (action === "enable" && hook.trustStatus !== "trusted") throw fail("conflict", "Review and trust the current definition before enabling this hook.");
      if (fresh.configRevision !== await configSnapshot(settings, io)) throw fail("conflict", "Codex settings changed. Refresh and review the hook again.");
      await nativeWrite({ ...fresh.options, configVersion: fresh.configVersion, key: hook.key, currentHash: hook.currentHash, action });
      const verified = await load(), updated = verified.hooks.find(row => row.id === id);
      if (!updated || updated.currentHash !== hook.currentHash || (action === "trust" ? updated.trustStatus !== "trusted" || updated.enabled !== hook.enabled : updated.enabled !== (action === "enable") || action === "enable" && updated.trustStatus !== "trusted")) {
        throw fail("conflict", "The setting may have been saved, but the hook changed or its state could not be verified. Refresh before continuing.");
      }
      return publicInventory(verified);
    });
  };
  return { listHooks, setHook };
}
