// Pure shared model for the library, inspector and placement planner. No DOM or IO.
const T3SkillModel = (() => {
  'use strict';
  const providers = Object.freeze([
    { id: 'claude', name: 'Claude Code', control: 'Visibility' },
    { id: 'codex', name: 'Codex', control: 'On or off' },
    { id: 'opencode', name: 'OpenCode', control: 'Permission' },
    { id: 'cursor', name: 'Cursor', control: 'Not reported' },
    { id: 'grok', name: 'Grok Build', control: 'Not reported' },
    { id: 'muse', name: 'Muse Code', control: 'Not reported' },
    { id: 'antigravity', name: 'Antigravity', control: 'Not reported' },
  ]);
  const nameOf = id => providers.find(p => p.id === id)?.name || id;
  const clean = value => String(value || '').replace(/\/+$/, '') || '/';
  const contains = (root, file) => Boolean(root && file && (clean(root) === clean(file) || file.startsWith(clean(root) === '/' ? '/' : clean(root) + '/')));
  const directory = file => String(file || '').slice(0, String(file || '').lastIndexOf('/')) || '/';
  const displayPath = (file, home) => home && contains(home, file) ? '~' + file.slice(clean(home).length) : file;
  const available = row => Boolean(row && !row.error && !['off', 'deny', 'disabled'].includes(row.state));
  const attention = skill => Object.values(skill.byProvider || {}).some(row => row.error || row.metadataError);
  const state = row => {
    if (!row) return { kind: 'missing', label: 'Not found', available: false };
    if (row.error) return { kind: 'error', label: 'Unavailable', reason: row.error, available: false };
    const labels = { on: 'On', 'name-only': 'Name only', 'user-invocable-only': 'Manual only', off: 'Off', allow: 'Allowed', ask: 'Ask', deny: 'Denied', enabled: 'On', disabled: 'Off' };
    const controlled = row.canSetState || row.canToggle;
    const native = row.native || row.stateAuthority === 'user-policy';
    return { kind: row.canSetState ? 'policy' : row.canToggle ? 'switch' : native ? 'locked' : 'found',
      label: native || controlled ? labels[row.state] || 'Unknown' : 'Found',
      reason: row.stateReadOnlyReason, muted: ['off', 'deny', 'disabled'].includes(row.state), available: available(row) };
  };
  const deriveReach = inventories => {
    const roots = new Map();
    for (const provider of providers) for (const entry of inventories[provider.id]?.roots || []) {
      const key = entry.resolvedPath || entry.path;
      if (!key) continue;
      if (!roots.has(key)) roots.set(key, { ...entry, path: entry.path, resolvedPath: key, paths: [], readers: [], owners: [], writableOwners: [], writable: false });
      const root = roots.get(key);
      if (!root.paths.includes(entry.path)) root.paths.push(entry.path);
      if (!root.readers.includes(provider.id)) root.readers.push(provider.id);
      if (entry.source === 'Provider') {
        root.owners.push(provider.id); root.owner ||= provider.id;
        if (inventories[provider.id]?.creationTargets?.some(target => target.id === 'provider')) { root.writableOwners.push(provider.id); root.writable = true; }
      }
    }
    return [...roots.values()];
  };
  const rootsFor = (inventories, reach) => reach?.roots?.length ? reach.roots : deriveReach(inventories);
  const rootLabel = root => root.scope === 'system' ? 'Codex system skills' : root.scope === 'admin' ? 'Codex admin skills'
    : root.owner ? nameOf(root.owner) + ' folder' : root.source === 'Shared .agents' ? 'Shared .agents folder'
      : root.source === 'Plugin' ? 'Plugin skills' : root.source || 'Skill folder';
  const join = (inventories, reach) => {
    const roots = rootsFor(inventories, reach), physical = new Map();
    for (const provider of providers) for (const row of inventories[provider.id]?.skills || []) {
      const key = row.resolvedPath || row.path;
      if (!key) continue;
      if (!physical.has(key)) physical.set(key, { key, byProvider: {}, aliases: [] });
      const skill = physical.get(key), previous = skill.byProvider[provider.id];
      // Native inventory can repeat a filesystem entry through another alias.
      if (!previous || (row.native && !previous.native) || (!previous.canSetState && row.canSetState)) skill.byProvider[provider.id] = row;
      if (row.path && !skill.aliases.includes(row.path)) skill.aliases.push(row.path);
    }
    const rows = [...physical.values()].map(skill => {
      const entries = providers.filter(p => skill.byProvider[p.id]).map(p => [p.id, skill.byProvider[p.id]]);
      const [provider, row] = entries.find(([, row]) => row.canEdit) || entries[0];
      const matches = roots.filter(root => [root.resolvedPath, root.path, ...(root.paths || [])].some(path => contains(path, skill.key) || skill.aliases.some(alias => contains(path, alias))));
      matches.sort((a, b) => Math.max(...[b.resolvedPath, b.path].filter(Boolean).map(p => p.length)) - Math.max(...[a.resolvedPath, a.path].filter(Boolean).map(p => p.length)));
      const root = matches[0] || { path: directory(row.path), resolvedPath: directory(skill.key), readers: entries.map(([id]) => id), source: row.source, scope: row.scope, owner: row.source === 'Plugin' ? null : provider };
      return { ...skill, ...row, key: skill.key, byProvider: skill.byProvider, aliases: skill.aliases, provider, root,
        groupKey: root.resolvedPath || root.path, groupLabel: rootLabel(root), attention: attention(skill) };
    });
    return rows.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  };
  const groups = rows => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.groupKey)) map.set(row.groupKey, { key: row.groupKey, root: row.root, label: row.groupLabel, rows: [] });
      map.get(row.groupKey).rows.push(row);
    }
    const order = root => root.scope === 'system' ? 9 : root.scope === 'admin' ? 10 : root.owner ? providers.findIndex(p => p.id === root.owner) : 8;
    return [...map.values()].sort((a, b) => order(a.root) - order(b.root) || a.key.localeCompare(b.key));
  };
  const filter = (rows, { query = '', agent = '', needsAttention = false } = {}) => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(row => words.every(word => (row.name + ' ' + row.description).toLocaleLowerCase().includes(word))
      && (!agent || available(row.byProvider[agent])) && (!needsAttention || row.attention));
  };
  const placement = (selected, installed, roots, mode = 'fewest') => {
    const agents = providers.map(p => p.id).filter(id => selected.includes(id));
    const own = id => roots.find(root => (root.owners || [root.owner]).includes(id));
    const readers = id => own(id)?.readers || [id];
    let choices = [];
    if (mode === 'each') choices = agents;
    else {
      const candidates = providers.map(p => p.id).filter(id => installed.includes(id) && own(id)?.writable
        && (!own(id).writableOwners || own(id).writableOwners.includes(id)));
      let best = null;
      for (let mask = 1; mask < 2 ** candidates.length; mask++) {
        const chosen = candidates.filter((id, index) => mask & (1 << index));
        const copies = new Set(chosen.map(id => own(id).resolvedPath || own(id).path));
        // One physical folder is one copy even when two agent homes alias it.
        const distinct = chosen.filter((id, index) => chosen.findIndex(other => (own(other).resolvedPath || own(other).path) === (own(id).resolvedPath || own(id).path)) === index);
        const counts = agents.map(agent => distinct.filter(id => readers(id).includes(agent)).length);
        if (counts.some(n => !n)) continue;
        const score = [copies.size, counts.filter(n => n > 1).length, agents.filter(agent => !chosen.includes(agent)).length, mask];
        if (!best || score.some((value, index) => value !== best.score[index] && score.slice(0, index).every((v, i) => v === best.score[i]) && value < best.score[index])) best = { score, chosen: distinct };
      }
      choices = best?.chosen || [];
    }
    const destinations = [];
    for (const id of choices) {
      const root = own(id), key = root?.resolvedPath || root?.path || id;
      const shared = destinations.find(destination => destination.key === key);
      if (shared) {
        shared.also.push(id);
        shared.readers = [...new Set([...shared.readers, ...readers(id)])];
      } else destinations.push({ key, provider: id, also: [], root, readers: readers(id) });
    }
    const coverage = agent => destinations.filter(d => d.readers.includes(agent));
    return { providers: choices, destinations, uncovered: agents.filter(agent => !coverage(agent).length),
      duplicates: agents.filter(agent => coverage(agent).length > 1),
      counts: Object.fromEntries(agents.map(agent => [agent, coverage(agent).length])),
      also: providers.map(p => p.id).filter(id => !agents.includes(id) && coverage(id).length),
      assignments: Object.fromEntries(agents.map(agent => [agent, (coverage(agent).find(d => d.provider === agent || d.also.includes(agent)) || coverage(agent)[0])?.provider || null])) };
  };
  return { providers, nameOf, contains, directory, displayPath, available, state, attention, rootsFor, rootLabel, join, groups, filter, placement };
})();
