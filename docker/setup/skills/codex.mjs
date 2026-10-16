// A metadata-only App Server exchange. No thread, turn, prompt or model call.
import { spawn } from "node:child_process";

export function listCodexSkills({ executable, home, env = process.env, timeoutMs = 6000, maxBytes = 2 * 1024 * 1024, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, buffer = "", bytes = 0, stage = "initialize";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdin.destroy();
      if (child) {
        child.kill();
        const force = setTimeout(() => child.kill("SIGKILL"), 1000);
        force.unref();
        child.once("close", () => clearTimeout(force));
      }
      if (error) reject(error);
      else resolve(result);
    };
    const fail = (message) => finish(new Error(message));
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    try {
      child = spawnImpl(executable, ["app-server", "--stdio"], { cwd: home, env, stdio: ["pipe", "pipe", "ignore"] });
      timer = setTimeout(() => fail("Codex skill discovery timed out."), timeoutMs);
      child.on("error", () => fail("Could not start Codex skill discovery."));
      child.stdin.on("error", () => fail("Codex closed its discovery connection."));
      child.on("close", () => { if (!settled) fail("Codex exited before returning its skill inventory."); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) return fail("Codex skill inventory exceeded the response limit.");
        buffer += chunk;
        let end;
        while (!settled && (end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); }
          catch { return fail("Codex returned an invalid discovery response."); }
          if (!message || typeof message !== "object" || Array.isArray(message)) return fail("Codex returned an invalid discovery response.");
          if (stage === "initialize" && message.id === 1) {
            if (message.error || !message.result) return fail("This Codex version could not initialize skill discovery.");
            stage = "list";
            send({ method: "initialized" });
            send({ id: 2, method: "skills/list", params: { cwds: [home], forceReload: true } });
          } else if (stage === "list" && message.id === 2) {
            if (message.error || !Array.isArray(message.result?.data)) return fail("This Codex version could not list skills.");
            const entry = message.result.data.find((item) => item.cwd === home);
            if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors)) return fail("Codex returned an incomplete skill inventory.");
            finish(null, entry);
          } else if (message.id !== undefined && message.method) {
            // Discovery cannot approve an action or service provider tool calls.
            return fail("Codex requested an unexpected action during skill discovery.");
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "t3-setup-skills", version: "1.0.0" } } });
    } catch {
      fail("Could not start Codex skill discovery.");
    }
  });
}
