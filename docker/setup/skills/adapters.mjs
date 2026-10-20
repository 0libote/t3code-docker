// Provider directory adapters: global/project skill locations and install
// detection hints. Table shape informed by skills-hub's tool registry (MIT,
// https://github.com/qufei1993/skills-hub); global locations stay aligned
// with skillRoots() in ../skills.mjs, which remains canonical for scanning.
// Detection is advisory only: an undetected tool stays fully manageable
// through its files, unlike registries that refuse unknown tools.
import path from "node:path";

const fail = (code, message) => Object.assign(new Error(message), { code });

// projectDir is relative to a project root; null means project scope is
// unverified for that provider. Codex, Cursor, OpenCode and Antigravity
// share the `.agents/skills` project directory, so one project's skills can
// appear in another provider's inventory.
const TABLE = Object.freeze({
  claude: Object.freeze({ label: "Claude Code", projectDir: ".claude/skills" }),
  codex: Object.freeze({ label: "Codex", projectDir: ".agents/skills" }),
  opencode: Object.freeze({ label: "OpenCode", projectDir: ".agents/skills" }),
  cursor: Object.freeze({ label: "Cursor", projectDir: ".agents/skills" }),
  grok: Object.freeze({ label: "Grok Build", projectDir: null }),
  muse: Object.freeze({ label: "Muse Code", projectDir: null }),
  antigravity: Object.freeze({ label: "Antigravity", projectDir: ".agents/skills" }),
});

export function adapterProviders() {
  return Object.entries(TABLE).map(([id, { label }]) => ({ id, name: label }));
}

// Resolve the global skills directory and the detection hint under home,
// honoring the same environment overrides as skillRoots().
export function skillAdapter(provider, { home, env = {} } = {}) {
  const entry = TABLE[provider];
  if (!entry) throw fail("invalid", "Unknown skill provider.");
  const override = (key, fallback) => path.resolve(home, String(env[key] || "").trim() || fallback);
  const config = override("XDG_CONFIG_HOME", ".config");
  const root = {
    claude: override("CLAUDE_CONFIG_DIR", ".claude"),
    codex: override("CODEX_HOME", ".codex"),
    opencode: override("OPENCODE_CONFIG_DIR", path.join(config, "opencode")),
    cursor: path.join(home, ".cursor"),
    grok: override("GROK_HOME", ".grok"),
    muse: path.join(config, "muse"),
    antigravity: path.join(home, ".gemini", "config"),
  }[provider];
  return {
    id: provider,
    label: entry.label,
    globalDir: path.join(root, "skills"),
    projectDir: entry.projectDir,
    detectDir: root,
  };
}

// Stat the detection directory. Filesystem errors mean "not detected",
// never a failure: inventory and management work regardless.
export async function adapterDetection(provider, { home, env = {}, io }) {
  const adapter = skillAdapter(provider, { home, env });
  try {
    const stat = await io.stat(adapter.detectDir);
    return { ...adapter, detected: stat.isDirectory() };
  } catch {
    return { ...adapter, detected: false };
  }
}
