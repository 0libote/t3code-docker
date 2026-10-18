// One credential contract for harness probes, setup actions and diagnostics.
// V2 auth commands use private servers, without starting a background service.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { withNativeProcess } from './native-process.mjs';

const MAX_OUTPUT = 1024 * 1024;
export function openCodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version ?? '').trim());
  return match ? Number(match[1]) : null;
}
export const isOpenCodeProviderId = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(value);
export function parseAuthList(text) {
  const source = String(text ?? '').trim();
  if (Buffer.byteLength(source) > MAX_OUTPUT) throw new Error('OpenCode returned too many saved sign-ins.');
  // A bracketed log prefix is not a JSON array. Only complete JSON beginning
  // at a line boundary can provide a sign-in verdict.
  let list, attempts = 0;
  for (const start of source.matchAll(/^\s*\[(?=\s*(?:\{|\]|$))/gm)) {
    if (++attempts > 16) break;
    try { list = JSON.parse(source.slice(start.index)); break; } catch {}
  }
  if (!Array.isArray(list) || list.length > 2048) throw new Error('OpenCode returned an unreadable saved-sign-in list.');
  for (const integration of list) {
    if (!integration || typeof integration.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(integration.id) || !Array.isArray(integration.connections)) throw new Error('OpenCode returned an invalid saved-sign-in list.');
    for (const connection of integration.connections) {
      if (!connection || typeof connection.type !== 'string' || (connection.type === 'credential' &&
        (typeof connection.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(connection.id)))) throw new Error('OpenCode returned an invalid saved account.');
    }
  }
  return list;
}
export function storedCredentials(list) {
  return list.flatMap((integration) => integration.connections.filter((connection) => connection.type === 'credential').map((connection) => ({
    integration: integration.id, id: connection.id, label: connection.label ?? null,
  })));
}
export const storedIntegrationIds = (list) => [...new Set(storedCredentials(list).map((entry) => entry.integration))].sort();
export const hasStoredCredentials = (list) => storedCredentials(list).length > 0;
export const legacyAuthFile = (home, env) => path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'opencode/auth.json');

export async function readLegacyAuth({ home, env, io = fs }) {
  let text;
  try {
    if (typeof io.open !== 'function') text = await io.readFile(legacyAuthFile(home, env), 'utf8');
    else {
      const handle = await io.open(legacyAuthFile(home, env), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > MAX_OUTPUT) throw new Error();
        const buffer = Buffer.alloc(Math.min(before.size + 1, MAX_OUTPUT + 1)); let bytes = 0;
        while (bytes < buffer.length) {
          const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
          if (!read.bytesRead) break; bytes += read.bytesRead;
        }
        const after = await handle.stat();
        if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error();
        text = buffer.subarray(0, bytes).toString('utf8');
      } finally { await handle.close(); }
    }
  }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('OpenCode saved sign-ins could not be read.'); }
  if (Buffer.byteLength(text) > MAX_OUTPUT) throw new Error('OpenCode credential file is too large.');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error('OpenCode credential file is unreadable. Repair it with OpenCode before changing keys.'); }
}

/** Bound the complete process group, output and stdin failure. CLI diagnostics
 * stay private because schema errors can echo an imported secret verbatim. */
export function runAuthCommand({ executable, home, env, timeoutMs = 20000 }, args, { input = null } = {}) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(executable, args, { cwd: home, env, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, failure = null, closed = false;
    const stop = (message) => {
      if (closed) return;
      failure ||= new Error(message);
      try { if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
    };
    const onExit = () => stop('Setup stopped before the credential command finished.');
    process.once('exit', onExit);
    const timer = setTimeout(() => stop('OpenCode did not finish the credential command in time. Try again.'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) stop('OpenCode credential output exceeded its limit.');
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_OUTPUT) stop('OpenCode credential output exceeded its limit.'); });
    child.stdin.on('error', () => stop('OpenCode closed its credential input before finishing. Try again.'));
    child.once('error', () => { closed = true; clearTimeout(timer); process.removeListener('exit', onExit); reject(new Error('OpenCode could not start the credential command.')); });
    child.once('close', (code) => {
      closed = true; clearTimeout(timer); process.removeListener('exit', onExit);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('OpenCode could not complete the credential command. Check its configuration and try again.'));
      else resolve({ stdout });
    });
    child.stdin.end(input ?? undefined);
  });
}

// Use the same key connection API as OpenCode's own UI, available from 2.0.18.
// A private authenticated server keeps keys out of argv and temporary files.
async function saveNativeKey(options, provider, key) {
  const password = randomBytes(24).toString('hex');
  let saved = false;
  try { return await withNativeProcess({ ...options, timeoutMs: 20000,
    env: { ...options.env, OPENCODE_PASSWORD: password, OPENCODE_USERNAME: 'opencode', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1' } },
  ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], async ({ nextLine, signal }) => {
    const ready = JSON.parse(await nextLine()), url = new URL(ready.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
    const request = async (route, body) => {
      const response = await fetch(new URL(route, url), { method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error',
        headers: { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      // Native error bodies may echo a key. Never expose them to setup clients.
      if (!response.ok) { await response.body?.cancel(); return null; }
      if (response.status === 204) return true;
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.length; if (bytes > MAX_OUTPUT) throw new Error();
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    const route = '/api/integration/' + encodeURIComponent(provider);
    // Built-in providers load asynchronously after the private server is ready.
    let integration;
    for (;;) {
      integration = (await request(route))?.data;
      if (integration?.methods?.some((method) => method.type === 'key')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (signal.aborted) throw signal.reason;
    }
    const previous = new Set(storedCredentials(parseAuthList(JSON.stringify([integration]))).map((entry) => entry.id));
    if (await request(route + '/connect/key', { key, label: 'API key' }) !== true) throw new Error();
    saved = true;
    const connected = (await request(route))?.data;
    const added = storedCredentials(parseAuthList(JSON.stringify([connected]))).filter((entry) => !previous.has(entry.id));
    if (added.length !== 1 || added[0].integration !== provider) throw new Error();
    if (await request('/api/credential/' + encodeURIComponent(added[0].id) + '/activate', {}) !== true) throw new Error();
    return added[0].id;
  }); } catch {
    throw new Error(saved ? 'OpenCode saved the key but could not confirm the selected account. Refresh saved sign-ins before retrying.'
      : 'OpenCode could not save the key. Check that this provider supports an API key in your OpenCode configuration, then try again.');
  }
}

export function createOpenCodeAuth({ resolve, home, env, io = fs, run = runAuthCommand, onChange = async () => {} }) {
  let pending = Promise.resolve();
  const serial = (work) => { const current = pending.then(work); pending = current.catch(() => {}); return current; };
  const store = async () => {
    let facts;
    try { facts = await resolve(); } catch { throw new Error('OpenCode’s managed installation could not be checked. Refresh the agent and try again.'); }
    if (!facts?.runnable || !facts.executable) throw new Error('OpenCode is not available. Finish its installation or update first.');
    const major = openCodeMajor(facts.installedVersion ?? facts.recordedVersion);
    if (major === null) throw new Error('OpenCode’s version could not be checked. Refresh the agent before changing sign-ins.');
    return { executable: facts.executable, major };
  };
  const command = (state, args, input) => run({ ...state, home, env }, ['auth', ...args, '--standalone'], { input });
  const nativeList = async (state) => parseAuthList((await command(state, ['list', '--format', 'json'])).stdout);
  const accounts = async (state) => state.major >= 2 ? storedCredentials(await nativeList(state))
    : Object.keys(await readLegacyAuth({ home, env, io })).sort().map((integration) => ({ integration, id: null, label: null }));
  const writeLegacy = async (value) => {
    const file = legacyAuthFile(home, env), temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { await io.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await io.rename(temporary, file); }
    finally { await io.rm(temporary, { force: true }).catch(() => {}); }
  };
  const validate = (provider) => { if (!isOpenCodeProviderId(provider)) throw new Error('Choose a provider (e.g. anthropic, openai, deepseek).'); };
  return {
    async list() { return accounts(await store()); },
    saveKey(provider, key) {
      validate(provider);
      if (typeof key !== 'string' || !key.trim() || key.length > 500) throw new Error('Enter a key of at most 500 characters.');
      return serial(async () => {
        const state = await store();
        try {
          if (state.major < 2) {
            const auth = await readLegacyAuth({ home, env, io }); auth[provider] = { type: 'api', key }; await writeLegacy(auth);
          } else {
            const id = await saveNativeKey({ ...state, home, env }, provider, key);
            try {
              if (!(await accounts(state)).some((account) => account.integration === provider && account.id === id)) throw new Error();
            } catch {
              throw new Error('OpenCode saved the key but could not list the new account. Check custom provider configuration and refresh saved sign-ins before retrying.');
            }
          }
          return { ok: true };
        } finally { await onChange(); }
      });
    },
    removeProvider(provider) {
      validate(provider);
      return serial(async () => {
        const state = await store();
        try {
          if (state.major < 2) {
            const auth = await readLegacyAuth({ home, env, io }), removed = Object.hasOwn(auth, provider);
            if (removed) { delete auth[provider]; await writeLegacy(auth); }
            return { ok: true, removed };
          }
          const targets = (await accounts(state)).filter((account) => account.integration === provider);
          for (const target of targets) await command(state, ['logout', provider, target.id]);
          const remaining = await accounts(state);
          if (targets.some((target) => remaining.some((account) => account.id === target.id))) throw new Error('OpenCode could not confirm removal. Refresh saved sign-ins before retrying.');
          return { ok: true, removed: targets.length > 0 };
        } finally { await onChange(); }
      });
    },
  };
}
