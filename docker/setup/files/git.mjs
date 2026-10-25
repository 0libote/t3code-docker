import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createCommandRunner, createLimiter } from './io.mjs';

const OPTIONS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'color.ui=never',
  '-c', 'log.showSignature=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
const recordPath = (record, separators) => {
  let offset = 0;
  for (let index = 0; index < separators; index++) { offset = record.indexOf(' ', offset) + 1; if (!offset) return null; }
  return record.slice(offset);
};
export function parseGitStatus(text) {
  const result = { branch: null, upstream: null, ahead: 0, behind: 0, changed: 0, statuses: Object.create(null) };
  const records = text.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('# branch.head ')) result.branch = record.slice(14) === '(detached)' ? 'Detached HEAD' : record.slice(14);
    else if (record.startsWith('# branch.upstream ')) result.upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) { const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record); if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); } }
    else {
      const type = record[0];
      const name = type === '?' ? record.slice(2) : recordPath(record, type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : 0);
      if (!['1', '2', 'u', '?'].includes(type) || !name) continue;
      if (type === '2') index++; // the second NUL field is the old name, never a second change
      const xy = record.slice(2, 4), letter = type === '?' ? 'U' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M';
      Object.defineProperty(result.statuses, name, { value: letter, enumerable: true, configurable: true });
      result.changed++;
    }
  }
  result.uncommitted = result.changed;
  return result;
}

export function createGitService({ io = fs, env = process.env, run, now = Date.now, ttl = 15_000 } = {}) {
  // Ambient repository overrides must not redirect a request to another repo.
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_(?:KEY|VALUE)_\d+)$/.test(key)));
  Object.assign(cleanEnv, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' });
  const execute = run || createCommandRunner(cleanEnv), limit = createLimiter(2), commands=createLimiter(4), cache = new Map();
  const command = (root, args, input) => commands(()=>execute('git', ['-C', root, ...OPTIONS, ...args], { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024, input, env: cleanEnv }));
  const inspect = async root => {
    // `git status` may run clean/process filters while checking tracked files.
    // Browsing must never execute a repository's configured programs. A runtime
    // with filters degrades to unavailable facts rather than inventing a clean
    // verdict (or misleading dirty facts from disabling a content filter).
    const filters = await command(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'])
      .catch(error => { if (error.code === 1) return { stdout: '' }; throw error; });
    const drivers = [...new Set(filters.stdout.split('\0').filter(Boolean).map(key => key.replace(/\.(clean|process)$/, '')))];
    if (drivers.length > 256 || drivers.some(key => key.length > 1024)) throw new Error('Too many Git filters');
    if (drivers.length) {
      const tracked = await command(root, ['ls-files', '-z', '--']);
      if (tracked.stdout) {
        const attributes = await command(root, ['check-attr', '--stdin', '-z', 'filter'], tracked.stdout);
        const fields = attributes.stdout.split('\0');
        if (fields.some((value, index) => index % 3 === 2 && !['unspecified', 'unset'].includes(value))) throw new Error('Git filters require executable inspection');
      }
    }
    // Even unused drivers are disabled for status: an attributes-file change
    // between the probes cannot start one of those programs.
    const noFilters = drivers.flatMap(driver => ['-c', driver + '.clean=', '-c', driver + '.process=', '-c', driver + '.smudge=', '-c', driver + '.required=false']);
    const [status, remotes, commits, last] = await Promise.all([
      command(root, [...noFilters, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=dirty']),
      command(root, ['remote']), command(root, ['rev-list', '--count', '--branches', '--not', '--remotes']),
      command(root, ['log', '-1', '--format=%s%x09%cI']).catch(() => ({ stdout: '' })),
    ]);
    const result = parseGitStatus(status.stdout), line = last.stdout.trimEnd(), split = line.lastIndexOf('\t');
    return { ...result, root, available: true, loading: false, noRemote: !remotes.stdout.trim(), unpushed: Number(commits.stdout.trim()) || 0,
      lastCommit: split < 0 ? null : { subject: line.slice(0, split).slice(0, 500), at: line.slice(split + 1) }, at: now() };
  };
  const hasMarker = async root => io.lstat(path.join(root, '.git')).then(() => true, () => false);
  const rootFor = async value => {
    let directory = value;
    for (let depth = 0; depth < 256; depth++) {
      if (await hasMarker(directory)) return directory;
      const parent = path.dirname(directory); if (parent === directory) return null; directory = parent;
    }
    return null;
  };
  const get = root => {
    if (!root) return null;
    let item = cache.get(root);
    if (!item) {
      if (cache.size >= 128) {
        const key = [...cache].find(([, row]) => !row.pending)?.[0];
        if (!key) return { root, available: false, loading: false, error: 'Git status unavailable' };
        cache.delete(key);
      }
      item = { value: { root, available: false, loading: true }, at: null, pending: null }; cache.set(root, item);
    }
    if (!item.pending && (item.at === null || now() - item.at >= ttl)) {
      item.pending = limit(() => inspect(root)).then(value => { item.value = value; }, () => { item.value = { root, available: false, loading: false, error: 'Git status unavailable' }; })
        .finally(() => { item.at = now(); item.pending = null; });
    }
    return item.value;
  };
  const settled = async root => { const fallback = get(root); await cache.get(root)?.pending; return cache.get(root)?.value ?? fallback; };
  return { get, settled, rootFor, hasMarker, command, invalidate: root => cache.delete(root) };
}
