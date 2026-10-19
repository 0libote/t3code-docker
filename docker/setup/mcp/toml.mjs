// Minimal TOML handling for Codex `[mcp_servers.*]` sections only. The rest
// of config.toml is opaque text and is preserved byte-for-byte.
const problem = (code, message) => Object.assign(new Error(message), { code });

const sectionHead = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
const stripComment = (value) => {
  let out = "", quote = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === "\\") { out += value.slice(i, i + 2); i++; continue; }
      if (char === quote) quote = null;
      out += char;
    } else if (char === '"' || char === "'") { quote = char; out += char; }
    else if (char === "#") break;
    else out += char;
  }
  return out.trim();
};
const unquote = (raw) => {
  const text = stripComment(raw).trim();
  if (/^"""/.test(text) || /^'''/.test(text)) throw problem("unsupported", "Multiline TOML strings are not supported in MCP sections.");
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const inner = text.slice(1, -1);
    if (text.startsWith("'")) {
      if (inner.includes("'")) throw problem("unsupported", "Unsupported TOML string in MCP sections.");
      return inner;
    }
    return inner.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\(.)/g, (_, char) => ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" }[char] ?? char));
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[+-]?\d+$/.test(text)) return Number(text);
  if (/^\[.*\]$/.test(text)) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    const parts = [];
    let current = "", quote = null, depth = 0;
    for (let i = 0; i < inner.length; i++) {
      const char = inner[i];
      if (quote) { current += char; if (char === "\\") { current += inner[++i] ?? ""; continue; } if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'") { quote = char; current += char; continue; }
      if (char === "[") depth++;
      if (char === "]") depth--;
      if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
      current += char;
    }
    if (current.trim() || parts.length) parts.push(current.trim());
    return parts.filter((part) => part !== "").map(unquote);
  }
  if (/^\{.*\}$/.test(text)) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return {};
    const out = {};
    for (const pair of inner.split(",").map((part) => part.trim()).filter(Boolean)) {
      const match = /^([^=]+)=(.*)$/.exec(pair);
      if (!match) throw problem("unsupported", "Unsupported TOML table in MCP sections.");
      out[unquote(match[1].trim())] = unquote(match[2].trim());
    }
    return out;
  }
  const bare = /^[A-Za-z0-9_.-]+$/.test(text) ? text : null;
  if (bare !== null) return bare;
  throw problem("unsupported", "Unsupported TOML value in MCP sections.");
};

const tomlString = (value) => JSON.stringify(String(value));
const tomlValue = (value) => {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (Array.isArray(value)) return "[ " + value.map(tomlValue).join(", ") + " ]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, entry]) => `${tomlString(key)} = ${tomlValue(entry)}`);
    return "{ " + entries.join(", ") + " }";
  }
  throw problem("invalid", "Unsupported MCP value for TOML output.");
};

/** Parse only `[mcp_servers.<name>]` tables; everything else stays opaque. */
export function parseMcpToml(text) {
  const lines = String(text ?? "").split("\n");
  const servers = new Map();
  let current = null;
  let currentName = null;
  for (const line of lines) {
    const head = sectionHead.exec(line);
    if (head) {
      const table = head[1].trim();
      const match = /^mcp_servers\.(.+)$/.exec(table);
      if (match) {
        currentName = match[1].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
        if (!currentName || servers.has(currentName)) throw problem("unsupported", `Duplicate Codex MCP server: ${currentName || "(unnamed)"}.`);
        current = {};
        servers.set(currentName, current);
      } else {
        current = null;
        currentName = null;
      }
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([^=]+)=(.*)$/.exec(line);
    if (!match) throw problem("unsupported", "Unsupported TOML line in Codex MCP sections.");
    current[unquote(match[1].trim())] = unquote(match[2]);
  }
  return servers;
}

/** Replace/add/remove one `[mcp_servers.<name>]` section, preserving the rest. */
export function applyMcpToml(text, name, entry) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  let skipping = false;
  let replaced = false;
  const pushEntry = () => {
    if (!entry) return;
    out.push(`[mcp_servers.${name}]`);
    if (entry.command !== undefined) out.push(`command = ${tomlValue(entry.command)}`);
    if (entry.args !== undefined) out.push(`args = ${tomlValue(entry.args)}`);
    if (entry.env !== undefined) out.push(`env = ${tomlValue(entry.env)}`);
    if (entry.url !== undefined) out.push(`url = ${tomlValue(entry.url)}`);
    if (entry.http_headers !== undefined) out.push(`http_headers = ${tomlValue(entry.http_headers)}`);
    if (entry.enabled !== undefined) out.push(`enabled = ${tomlValue(entry.enabled)}`);
    if (entry.startup_timeout_ms !== undefined) out.push(`startup_timeout_ms = ${tomlValue(entry.startup_timeout_ms)}`);
  };
  for (const line of lines) {
    const head = sectionHead.exec(line);
    if (head) {
      if (skipping) { skipping = false; }
      const table = head[1].trim();
      const match = /^mcp_servers\.(.+)$/.exec(table);
      const target = match && match[1].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1") === name;
      if (target) {
        skipping = true;
        replaced = true;
        continue;
      }
      out.push(line);
      continue;
    }
    if (skipping) continue;
    out.push(line);
  }
  if (!replaced && entry) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    pushEntry();
  } else if (replaced && entry) {
    // Re-insert at end to keep output deterministic; the marker order does
    // not matter to Codex. Existing unrelated sections keep their bytes.
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    out.push("");
    pushEntry();
  }
  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  return result;
}
