// Provider-owned visibility/permission policies. Preserve richer states and JSONC.
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parse, parseTree, modify, applyEdits } from "../vendor/jsonc.mjs";
import { configSnapshot, stateRevision, serializeState } from "./state.mjs";
import { inspectClaudeSkills, inspectOpenCodeSkills } from "./native.mjs";

const fail = (code, message) => Object.assign(new Error(message), { code });
const effects = ["allow", "ask", "deny"];
const labels = { on: "On", "name-only": "Name only", "user-invocable-only": "Manual only", off: "Off", allow: "Allowed", ask: "Ask before use", deny: "Denied" };
const wildcard = (value, pattern) => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".") + "$", "s").test(value);
const matches = (rules, name) => rules.filter((rule) => wildcard("skill", rule.action) && wildcard(name, rule.resource)).at(-1)?.effect;
export function parseSettings(content, strict = false) {
  const errors = [], tree = parseTree(content, errors, { allowTrailingComma: !strict, disallowComments: strict });
  if (errors.length || tree?.type !== "object") throw fail("unsupported", "Native settings contain invalid JSON/JSONC. Repair them before changing skill policies.");
  const inspect = (node, depth = 0) => {
    if (depth > 100) throw fail("unsupported", "Native settings exceed the nesting limit.");
    if (node.type === "object") {
      const keys = node.children.map((item) => item.children[0].value);
      if (new Set(keys).size !== keys.length) throw fail("unsupported", "Native settings contain duplicate keys. Repair them before changing skill policies.");
    }
    for (const child of node.children || []) inspect(child, depth + 1);
  };
  inspect(tree);
  return parse(content, [], { allowTrailingComma: !strict, disallowComments: strict });
}
function v1Rules(permission) {
  if (permission === undefined) return [];
  if (typeof permission === "string" && effects.includes(permission)) return [{ action: "*", resource: "*", effect: permission }];
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) throw fail("unsupported", "Unsupported OpenCode V1 permission shape.");
  const rules = [];
  for (const [action, value] of Object.entries(permission)) {
    if (typeof value === "string" && effects.includes(value)) rules.push({ action, resource: "*", effect: value });
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [resource, effect] of Object.entries(value)) {
        if (!effects.includes(effect)) throw fail("unsupported", "Unsupported OpenCode V1 permission value.");
        rules.push({ action, resource, effect });
      }
    } else throw fail("unsupported", "Unsupported OpenCode V1 permission value.");
  }
  return rules;
}
function v2Rules(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((rule) => !rule || typeof rule.action !== "string" || typeof rule.resource !== "string" || !effects.includes(rule.effect))) throw fail("unsupported", "Unsupported OpenCode V2 permissions. Existing rules were preserved.");
  return value;
}
export const userPolicy = (provider, config, major, name) => provider === "claude" ? (Object.hasOwn(config.skillOverrides || {}, name) ? config.skillOverrides[name] : "on")
  : matches(major === 1 ? v1Rules(config.permission) : v2Rules(config.permissions), name) || "allow";
function changePolicy(provider, content, major, name, state) {
  const config = parseSettings(content, provider === "claude"), formattingOptions = { insertSpaces: true, tabSize: 2, eol: content.includes("\r\n") ? "\r\n" : "\n" };
  const edit = (keys, value) => { content = applyEdits(content, modify(content, keys, value, { formattingOptions })); };
  if (provider === "claude") edit(["skillOverrides", name], state);
  else if (major === 2) {
    // Append an exact rule. Keep every existing wildcard, effect and rule order.
    const rules = v2Rules(config.permissions);
    const index = rules.findLastIndex((rule) => wildcard("skill", rule.action) && wildcard(name, rule.resource));
    if (index >= 0 && rules[index].action === "skill" && rules[index].resource === name) edit(["permissions", index, "effect"], state);
    else edit(["permissions", -1], { action: "skill", resource: name, effect: state });
  } else {
    v1Rules(config.permission);
    if (typeof config.permission === "string") edit(["permission"], { "*": config.permission });
    const skill = config.permission?.skill;
    if (typeof skill === "string") edit(["permission", "skill"], { "*": skill });
    // Remove/re-add an existing exact key so later wildcard rules cannot shadow it.
    const current = parseSettings(content).permission?.skill;
    if (current && typeof current === "object" && Object.hasOwn(current, name)) edit(["permission", "skill", name], undefined);
    edit(["permission", "skill", name], state);
  }
  if (Buffer.byteLength(content) > 1024 * 1024) throw fail("too_large", "Native settings would exceed the 1 MiB limit.");
  return content;
}

export function createSkillPolicies({ home, env, io, getHarness, invalidate, inspectClaude = inspectClaudeSkills, inspectOpenCode = inspectOpenCodeSkills }) {
  const fileFor = async (provider) => {
    if (provider === "claude") return path.join(path.resolve(home, env.CLAUDE_CONFIG_DIR || ".claude"), "settings.json");
    const root = path.resolve(home, env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || ".config", "opencode"));
    // JSONC loads after JSON in both supported release lines.
    const jsonc = path.join(root, "opencode.jsonc");
    return await io.lstat(jsonc).then(() => jsonc, (error) => { if (error.code !== "ENOENT") throw error; return path.join(root, "opencode.json"); });
  };
  const inspect = async (provider, skills, retry = true) => {
    const file = await fileFor(provider), before = await configSnapshot(file, io, true), config = parseSettings(before.content, provider === "claude");
    const harness = await getHarness(provider);
    if (!harness?.runnable || !harness.executable) throw fail("unsupported", "A managed " + (provider === "claude" ? "Claude Code" : "OpenCode") + " executable is not available.");
    const native = await (provider === "claude" ? inspectClaude : inspectOpenCode)({ executable: harness.executable, home, env });
    if (before.revision !== await configSnapshot(file, io)) {
      // V1 can add its schema URL on first use. Reinspect once from the new
      // snapshot; never issue a revision for a mixed before/after policy.
      if (retry) return inspect(provider, skills, false);
      throw fail("conflict", "Native settings changed during discovery. Refresh the list.");
    }
    const options = (provider === "claude" ? ["on", "name-only", "user-invocable-only", "off"] : effects).map((value) => ({ value, label: labels[value] }));
    if (provider === "claude" && config.skillOverrides !== undefined && (!config.skillOverrides || typeof config.skillOverrides !== "object" || Array.isArray(config.skillOverrides))) throw fail("unsupported", "Claude skillOverrides must be an object. Existing settings were preserved.");
    const rows = skills.map((row) => {
      const nativeRow = provider === "opencode" ? native.skills.find((entry) => (entry.path || entry.location) === row.path || (entry.path || entry.location) === row.resolvedPath) : null;
      const key = provider === "claude" ? row.name : native.major === 2 ? nativeRow?.id || (path.basename(row.path) === "SKILL.md" ? path.basename(path.dirname(row.path)) : path.basename(row.path, ".md")) : nativeRow?.name || row.name;
      const state = userPolicy(provider, config, native.major, key);
      let reason = row.error || row.metadataError || (row.scope !== "user" || row.source === "Plugin" ? "Plugin and system policies are managed through their source." : null);
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key)) reason ||= "This skill name cannot be managed through the basic policy controls.";
      if (provider === "opencode" && !nativeRow) reason ||= "This installation is not selected by the native OpenCode inventory.";
      if (!options.some((option) => option.value === state)) reason ||= "This skill uses an unrecognized native visibility state.";
      const effective = provider === "claude" ? native.commands.includes(key) ? "Manual command listed" : "Manual command hidden"
        : "Build agent: " + labels[matches(native.agent.permissions || native.agent.permission || [], nativeRow?.id || key) || "ask"];
      const result = { ...row, state, stateAuthority: "user-policy", stateLabel: "User policy: " + (labels[state] || "Unknown"), policyKey: key, effectiveStateText: effective,
        canToggle: false, canSetState: !reason, stateReadOnlyReason: reason, stateOptions: options, nativePolicyVersion: native.version };
      return { ...result, stateRevision: !reason ? stateRevision(before.revision, result) : null };
    });
    return { file, configRevision: before.revision, native, skills: rows };
  };
  const set = async (provider, skillsFor, id, revision, state) => {
    if (!(provider === "claude" ? ["on", "name-only", "user-invocable-only", "off"] : effects).includes(state)) throw fail("invalid", "Unknown native skill policy state.");
    const file = await fileFor(provider), initialKey = await io.realpath(file).catch(() => file);
    return serializeState(initialKey, async () => {
      invalidate();
      const inventory = await skillsFor(), row = inventory.skills.find((entry) => entry.id === id);
      if (!row) throw fail("missing", "This skill is no longer in the provider inventory. Refresh the list.");
      if (!row.canSetState) throw fail("unsupported", row.stateReadOnlyReason || "Native policy controls are unavailable.");
      if (!revision || revision !== row.stateRevision) throw fail("conflict", "Native settings or this skill changed. Review the refreshed inventory before trying again.");
      if (!row.stateOptions.some((option) => option.value === state)) throw fail("invalid", "Unknown native skill policy state.");
      const currentFile = await fileFor(provider);
      if (currentFile !== file) throw fail("conflict", "The native configuration source changed. Refresh the list.");
      const before = await configSnapshot(file, io, true);
      if (revision !== stateRevision(before.revision, row) || await io.realpath(row.path).catch(() => null) !== row.resolvedPath) throw fail("conflict", "Native settings or this skill link changed. Refresh before trying again.");
      const content = changePolicy(provider, before.content, provider === "opencode" ? Number(row.nativePolicyVersion.split(".")[0]) : null, row.policyKey, state);
      await io.mkdir(path.dirname(before.resolvedPath), { recursive: true });
      const temp = path.join(path.dirname(before.resolvedPath), ".t3-skill-policy-" + randomBytes(12).toString("hex"));
      let created = false;
      try {
        const handle = await io.open(temp, "wx", before.mode); created = true;
        try { await handle.writeFile(content, "utf8"); await handle.chmod(before.mode); } finally { await handle.close(); }
        if (before.revision !== await configSnapshot(file, io)) throw fail("conflict", "Native settings changed just before saving. Refresh the list.");
        if (before.exists) await io.rename(temp, before.resolvedPath); else await io.link(temp, before.resolvedPath);
      } finally { if (created) await io.rm(temp, { force: true }); invalidate(); }
      // Fresh native metadata must accept the resulting config. Keep a committed
      // policy on verification failure; reverting could overwrite another writer.
      try {
        const verified = await skillsFor(), updated = verified.skills.find((entry) => entry.id === id);
        if (updated?.stateAuthority !== "user-policy" || updated.state !== state) throw new Error();
        return { ok: true, provider, id, state, inventory: verified };
      } catch { throw fail("unavailable", "The user policy may have been saved, but native verification failed. Refresh to check its current state."); }
      finally { invalidate(); }
    });
  };
  return { inspect, set };
}
