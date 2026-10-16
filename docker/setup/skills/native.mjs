// Bounded metadata-only provider processes. No user message, turn or inference.
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

export function nativeCommand({ executable, home, env, timeoutMs = 10000 }, args) {
  return new Promise((resolve, reject) => execFile(executable, args, { cwd: home, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(new Error("The native provider metadata command failed or timed out."));
    else resolve(stdout);
  }));
}

async function withNativeProcess(options, args, work) {
  const child = spawn(options.executable, args, { cwd: options.home, env: options.env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const abort = new AbortController(), lines = [], readers = [];
  let bytes = 0, buffer = "", failure;
  const fail = (error) => { failure ||= error; abort.abort(error); for (const reader of readers.splice(0)) reader.reject(error); };
  const timer = setTimeout(() => fail(new Error("Native skill discovery timed out.")), options.timeoutMs || 12000);
  child.on("error", () => fail(new Error("Could not start native skill discovery.")));
  child.on("close", () => fail(new Error("The native provider closed its metadata connection.")));
  child.stdin.on("error", () => fail(new Error("The native provider closed its metadata input.")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4 * 1024 * 1024) return fail(new Error("Native skill discovery exceeded its output limit."));
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (readers.length) readers.shift().resolve(line); else lines.push(line);
    }
  });
  const nextLine = () => failure ? Promise.reject(failure) : lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => readers.push({ resolve, reject }));
  try {
    return await Promise.race([
      work({ child, nextLine, signal: abort.signal }),
      new Promise((_, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true })),
    ]);
  } finally {
    clearTimeout(timer); abort.abort(); child.stdin.destroy();
    const kill = (signal) => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
    kill("SIGTERM");
    const force = setTimeout(() => kill("SIGKILL"), 1000); force.unref();
    child.once("close", () => clearTimeout(force));
  }
}

export function inspectClaudeSkills(options) {
  return withNativeProcess({ ...options, env: { ...options.env, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}',
  ], async ({ child, nextLine }) => {
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: "t3-skills", request: { subtype: "initialize" } }) + "\n");
    for (;;) {
      const item = JSON.parse(await nextLine());
      if (item.type === "control_request") throw new Error("Claude requested an unexpected action during skill discovery.");
      if (item.type !== "control_response") continue;
      const response = item.response;
      if (response?.request_id !== "t3-skills" || response.subtype !== "success" || !Array.isArray(response.response?.commands)) throw new Error("Claude could not return its native skill commands.");
      const version = response.response.claude_code_version;
      if (typeof version !== "string" || !/^2\.1\.(\d+)$/.test(version) || Number(version.split(".")[2]) < 260) throw new Error("Native visibility controls require Claude Code 2.1.260 or newer in the 2.1 release line.");
      return { version, commands: response.response.commands.filter((entry) => typeof entry.name === "string" && !entry.builtin).map((entry) => entry.name) };
    }
  });
}

export async function inspectOpenCodeSkills(options) {
  options = { ...options, env: { ...options.env, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" } };
  const version = (await nativeCommand(options, ["--version"])).match(/(?:^|\s|v)(\d+\.\d+\.\d+)\b/)?.[1] || "unknown";
  if (/^1\./.test(version)) {
    const [skills, config, agent] = await Promise.all([
      nativeCommand(options, ["debug", "skill", "--pure"]), nativeCommand(options, ["debug", "config", "--pure"]), nativeCommand(options, ["debug", "agent", "build", "--pure"]),
    ]);
    const result = { version, major: 1, skills: JSON.parse(skills), config: JSON.parse(config), agent: JSON.parse(agent) };
    if (!Array.isArray(result.skills) || !result.config || !result.agent) throw new Error("OpenCode returned an invalid native inventory.");
    result.agent.permissions = (result.agent.permission || []).map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action }));
    return result;
  }
  if (!/^2\./.test(version)) throw new Error("This OpenCode release does not have a supported native skill interface.");
  const password = randomBytes(24).toString("hex");
  return withNativeProcess({ ...options, env: { ...options.env, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1" } }, ["serve", "--stdio", "--port", "0"], async ({ nextLine, signal }) => {
    const ready = JSON.parse(await nextLine());
    const url = new URL(ready.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== "http:") throw new Error("OpenCode did not start a private loopback metadata server.");
    const get = async (route) => {
      const response = await fetch(new URL(route, url), { signal, redirect: "error", headers: { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") } });
      if (!response.ok) throw new Error("OpenCode could not read its native " + route + " metadata.");
      const reader = response.body.getReader(); let bytes = 0, text = "";
      const decoder = new TextDecoder();
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 4 * 1024 * 1024) throw new Error("OpenCode metadata exceeded its response limit."); text += decoder.decode(chunk.value, { stream: true }); }
      } finally { await reader.cancel(); }
      return JSON.parse(text + decoder.decode());
    };
    // Early HTTP responses can precede asynchronous built-in plugin activation.
    for (;;) {
      const plugins = await get("/api/plugin");
      if (!Array.isArray(plugins.data)) throw new Error("OpenCode returned invalid plugin activation metadata.");
      if (["opencode.config.skill", "opencode.config.agent"].every((id) => plugins.data.some((item) => item.id === id && item.state?.status === "active"))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (signal.aborted) throw signal.reason;
    }
    const [skills, agents, config] = await Promise.all([get("/api/skill"), get("/api/agent"), get("/api/config")]);
    const agent = agents.data?.find((entry) => entry.id === "build");
    if (!Array.isArray(skills.data) || !agent || !Array.isArray(config)) throw new Error("OpenCode returned incomplete native skill metadata.");
    return { version, major: 2, skills: skills.data, config, agent };
  });
}
