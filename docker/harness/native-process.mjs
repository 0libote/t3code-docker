// Bounded private provider processes shared by metadata and credential adapters.
import { spawn } from "node:child_process";

export async function withNativeProcess(options, args, work) {
  const child = spawn(options.executable, args, { cwd: options.home, env: options.env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise((resolve) => child.once("close", resolve));
  const abort = new AbortController(), lines = [], readers = [];
  let bytes = 0, buffer = "", failure, closed = false, force = null;
  const kill = (signal) => { if (closed) return; try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
  const onExit = () => kill("SIGKILL");
  process.once("exit", onExit);
  const fail = (error) => { failure ||= error; abort.abort(error); for (const reader of readers.splice(0)) reader.reject(error); };
  const timer = setTimeout(() => fail(new Error("The native provider command timed out.")), options.timeoutMs || 12000);
  child.on("error", () => { process.removeListener("exit", onExit); fail(new Error("Could not start the native provider command.")); });
  child.on("close", () => { closed = true; clearTimeout(force); process.removeListener("exit", onExit); fail(new Error("The native provider closed its metadata connection.")); });
  child.stdin.on("error", () => fail(new Error("The native provider closed its metadata input.")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4 * 1024 * 1024) return fail(new Error("The native provider command exceeded its output limit."));
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
    kill("SIGTERM");
    if (!closed) { force = setTimeout(() => kill("SIGKILL"), 1000); force.unref(); }
    await exited;
  }
}

