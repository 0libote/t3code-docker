import { execFile } from 'node:child_process';

// No shell, ever. Both the process deadline and captured output are bounded.
// CLIs that consume paths must put -- before them at their call site.
export function createCommandRunner(env = process.env) {
  return (file, args, { cwd, timeout = 5000, maxBuffer = 4 * 1024 * 1024, input, signal, env: extra = {} } = {}) => new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, timeout, maxBuffer, env: { ...env, ...extra }, encoding: 'utf8', signal }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
    // A handled broken pipe is an ordinary failed CLI, not a server crash.
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : input);
  });
}

export function createLimiter(concurrency) {
  let active = 0; const waiting = [];
  const pump = () => {
    while (active < concurrency && waiting.length) {
      const { work, resolve, reject } = waiting.shift(); active++;
      Promise.resolve().then(work).then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return work => new Promise((resolve, reject) => { waiting.push({ work, resolve, reject }); pump(); });
}

export async function mapLimit(values, limit, work) {
  const result = new Array(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; result[index] = await work(values[index], index); }
  }));
  return result;
}
