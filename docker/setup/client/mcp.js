// Shared MCP servers: one canonical list, linked per provider. Status polls
// carry redacted summaries; secrets load only in the editor.
const T3McpUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const M = T3Model;
  const providers = [['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['cursor', 'Cursor'], ['antigravity', 'Antigravity'], ['grok', 'Grok Build'], ['muse', 'Muse Code']];
  const providerName = (id) => providers.find(([key]) => key === id)?.[1] || id;

  const create = ({ api, getStatus, render }) => {
    let shared = null, loading = false, error = null, generation = 0, viewer = null, linking = null;

    const load = async (refresh = false) => {
      if (loading) return;
      const current = ++generation;
      loading = true; error = null; render();
      const response = await api('/context/mcp' + (refresh ? '?refresh=1' : ''));
      if (current !== generation) return;
      loading = false;
      if (response.ok) shared = response.data;
      else error = response.error;
      render();
    };

    const parsePairs = (text) => {
      const out = {};
      for (const line of String(text || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const at = trimmed.indexOf('=');
        if (at < 0) throw new Error('Use KEY=value, one per line: ' + trimmed);
        out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1);
      }
      return out;
    };
    const formatPairs = (obj) => Object.entries(obj || {}).map(([key, value]) => key + '=' + value).join('\n');

    const serverRow = (server) => {
      const detail = server.type === 'local'
        ? (server.command || []).join(' ')
        : server.url;
      return html`<div class="tc-row tc-row--compact" data-key="mcp-${server.name}">
        <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('plug')}</span>
        <button class="tc-row-main tc-skill-open" type="button" data-cmd="mcp.view" data-id="${server.name}" aria-label="Edit ${server.name}">
          <span class="tc-row-title"><span class="tc-row-name tc-mono">${server.name}</span>
            <span class="tc-badge">${server.type === 'local' ? 'Local' : 'Remote'}</span>
            ${server.enabled === false ? html`<span class="tc-badge">Disabled</span>` : ''}
            ${(server.secretCount || 0) ? html`<span class="tc-badge" title="Environment or header secrets are stored with this server">${server.secretCount} secret${server.secretCount === 1 ? '' : 's'}</span>` : ''}</span>
          ${detail ? html`<span class="tc-skill-description tc-truncate" title="${detail}">${detail}</span>` : ''}
        </button>
        <div class="tc-row-actions"><button class="tc-btn tc-btn--sm" type="button" data-cmd="mcp.view" data-id="${server.name}">Edit</button></div>
      </div>`;
    };

    const providerRow = (row) => {
      const busy = linking === row.id;
      const names = [...(row.linked || []), ...(row.unlinked || []), ...(row.diverged || [])];
      return html`<div class="tc-row tc-row--compact" data-key="mcp-row-${row.id}">
        <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('bot')}</span>
        <div class="tc-row-main">
          <div class="tc-row-title"><span class="tc-row-name">${providerName(row.id)}</span>
            ${!row.supported || row.error ? html`<span class="tc-badge tc-badge--warn">Unavailable</span>` : ''}</div>
          <span class="tc-status"><span class="tc-status-text">${!row.supported || row.error ? (row.error || 'Unsupported') : row.linked?.length ? 'Uses ' + row.linked.join(', ') + (row.diverged?.length ? ' · ' + row.diverged.join(', ') + ' differs' : '') + (row.ownCount ? ' · +' + row.ownCount + ' own' : '') : (row.ownCount ? row.ownCount + ' own · none shared' : 'No shared servers linked')}</span></span>
          ${row.warning ? html`<span class="tc-hint">${row.warning}</span>` : ''}
        </div>
        <div class="tc-row-actions tc-row-actions--wrap">
          ${names.map((name) => {
            const on = (row.linked || []).includes(name);
            const differs = (row.diverged || []).includes(name);
            return html`<label class="tc-switch-hit" title="${providerName(row.id)} ${on ? 'uses' : 'does not use'} ${name}${differs ? ' (differs from shared)' : ''}"><button class="tc-switch" type="button" role="switch" aria-checked="${String(on)}" aria-label="${providerName(row.id)} uses ${name}" data-cmd="mcp.link" data-provider="${row.id}" data-id="${name}"${busy || !row.supported || row.error ? raw(' disabled') : ''}></button><span class="tc-small tc-mono">${name}</span></label>`;
          })}
        </div>
      </div>`;
    };

    const content = () => {
      const view = getStatus() ? M.mcpView(getStatus()) : { present: false, error: null };
      const rows = getStatus() ? M.mcpProviderRows(getStatus()) : [];
      const servers = shared?.shared?.servers || [];
      return html`<div class="tc-group tc-mcp">
        <div class="tc-skill-toolbar"><span class="tc-label">Shared MCP servers</span><span class="tc-hint tc-skill-count">${servers.length ? M.plural(servers.length, 'server') : 'None yet'}</span><span class="tc-spacer"></span>
          <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cmd="mcp.refresh" aria-label="Refresh MCP servers" title="Refresh MCP servers"${loading ? raw(' disabled') : ''}>${icon('refresh-cw')}</button>
          <button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="mcp.add">${icon('plus')}Add server</button></div>
        <div class="tc-skill-body" aria-live="polite" aria-busy="${String(loading)}">
          ${loading ? html`<p class="tc-skill-message tc-muted"><span class="tc-spinner" aria-hidden="true"></span>Reading MCP servers…</p>` : ''}
          ${error ? html`<p class="tc-skill-message tc-danger" role="alert">${icon('circle-alert')}<span>Couldn’t read MCP servers: ${error}</span></p>` : ''}
          ${view.error && !loading ? html`<p class="tc-skill-message tc-warning" role="status">${icon('triangle-alert')}<span>${view.error}</span></p>` : ''}
          ${!loading && !error ? html`
            ${servers.length ? html`<div class="tc-list">${servers.map(serverRow)}</div>` : html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-media" aria-hidden="true"><span class="tc-empty-icon">${icon('plug')}</span></span><span class="tc-empty-title">No shared servers yet</span><span class="tc-empty-desc">Add one here, then link the providers that should use it. Provider-only servers stay where they are.</span></div>`}
            ${rows.length ? html`<div class="tc-group"><div class="tc-label">What each provider uses</div><div class="tc-list">${rows.map(providerRow)}</div></div>` : ''}
            <details class="tc-skill-locations"><summary>Provider support</summary><code>claude: ~/.claude.json mcpServers · codex: ~/.codex/config.toml [mcp_servers.*] · opencode: opencode.json[c] .mcp · cursor: ~/.cursor/mcp.json · antigravity: ~/.gemini/settings.json</code><p class="tc-hint">Grok Build and Muse Code layouts are unverified and not managed here. Codex and OpenCode honor disabled servers; other providers represent disabled by unlinking.</p></details>
          ` : ''}
        </div>
        <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Shared servers sync into each linked provider’s own config, leaving its other servers alone. Start a new session after you change links.</span></div>
      </div>`;
    };

    const open = async (name = null) => {
      if (viewer?.saving) return;
      viewer?.layer.close('replace');
      const creating = !name;
      const current = { creating, name: name || '', loading: !creating, data: null, error: null, layer: null, saving: false,
        draft: { name: name || '', type: 'local', command: '', url: '', pairs: '', enabled: true }, original: '' };
      const title = creating ? 'Add shared MCP server' : 'Edit ' + name;
      current.layer = Kit.open({ kind: 'center',
        panel: { tag: 'div', class: 'tc-sheet tc-context-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mcp-title' },
        onClose: () => { if (viewer === current) viewer = null; },
        render: () => html`<div class="tc-sheet-head"><span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('plug')}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="mcp-title">${title}</h2><span class="tc-small tc-muted">One entry every linked provider reads</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-mcp="close" aria-label="Close">${icon('x')}</button></div>
          <div class="tc-sheet-body">
            ${current.error ? html`<p class="tc-danger" role="alert">${current.error}</p>` : ''}
            ${current.loading ? html`<p class="tc-muted" role="status">Reading server…</p>` : html`
            <label class="tc-label" for="mcp-name">Name</label>
            <input class="tc-input tc-mono" id="mcp-name" data-key="mcp-name" value="${current.draft.name}" maxlength="64" autocapitalize="none" spellcheck="false"${current.saving || !creating ? raw(' disabled') : ''}>
            <p class="tc-hint">Lowercase letters, numbers, hyphens. Renaming is remove + add.</p>
            <label class="tc-label" for="mcp-type">Type</label>
            <select class="tc-select" id="mcp-type"${current.saving ? raw(' disabled') : ''}><option value="local"${current.draft.type === 'local' ? raw(' selected') : ''}>Local command</option><option value="remote"${current.draft.type === 'remote' ? raw(' selected') : ''}>Remote URL</option></select>
            ${current.draft.type === 'local' ? html`<label class="tc-label" for="mcp-command">Command (one argument per line)</label><textarea class="tc-input tc-input--area tc-mono" id="mcp-command" rows="3" spellcheck="false"${current.saving ? raw(' disabled') : ''}>${current.draft.command}</textarea>` : html`<label class="tc-label" for="mcp-url">URL</label><input class="tc-input tc-mono" id="mcp-url" value="${current.draft.url}" placeholder="https://…" spellcheck="false"${current.saving ? raw(' disabled') : ''}>`}
            <label class="tc-label" for="mcp-pairs">${current.draft.type === 'local' ? 'Environment (KEY=value, one per line)' : 'Headers (Name=value, one per line)'}</label>
            <textarea class="tc-input tc-input--area tc-mono" id="mcp-pairs" rows="3" spellcheck="false"${current.saving ? raw(' disabled') : ''}>${current.draft.pairs}</textarea>
            <label class="tc-switch-hit" for="mcp-enabled"><button class="tc-switch" id="mcp-enabled" type="button" role="switch" aria-checked="${String(current.draft.enabled)}" aria-label="Enabled"${current.saving ? raw(' disabled') : ''}></button><span class="tc-small">Enabled (honored by Codex and OpenCode; other providers link by presence)</span></label>
            `}<p class="tc-hint">Secrets are stored in the shared store (0600) and written into linked provider configs. They never appear in status polls. Put secrets in Environment/Headers, not in the command line: the command is shown in the list.</p>
          </div><div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-mcp="close"${current.saving ? raw(' disabled') : ''}>Cancel</button>
          ${!creating ? html`<button class="tc-btn tc-btn--danger" type="button" data-mcp="remove"${current.saving || current.loading ? raw(' disabled') : ''}>Remove…</button>` : ''}
          <button class="tc-btn tc-btn--primary" type="button" data-mcp="save"${current.saving || current.loading ? raw(' disabled') : ''}>${current.saving ? 'Saving…' : creating ? 'Add server' : 'Save'}</button></div>`,
      });
      viewer = current;
      const panel = current.layer.panel;
      const sync = () => current.layer.render();
      panel.addEventListener('input', (event) => {
        if (event.target.id === 'mcp-name') current.draft.name = event.target.value;
        if (event.target.id === 'mcp-url') current.draft.url = event.target.value;
        if (event.target.id === 'mcp-command') current.draft.command = event.target.value;
        if (event.target.id === 'mcp-pairs') current.draft.pairs = event.target.value;
      });
      panel.addEventListener('change', (event) => {
        if (event.target.id === 'mcp-type') { current.draft.type = event.target.value; sync(); }
      });
      panel.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        if (button.hasAttribute('data-mcp') && button.getAttribute('data-mcp') === 'close') { current.layer.close('close'); return; }
        if (button.id === 'mcp-enabled') { current.draft.enabled = !current.draft.enabled; button.setAttribute('aria-checked', String(current.draft.enabled)); return; }
        if (button.getAttribute('data-mcp') === 'remove') {
          const yes = await Kit.confirm({ title: 'Remove ' + current.name + '?', body: 'Removes the shared entry. Linked provider entries stay until you unlink them; unlink first to remove everywhere at once.', confirm: 'Remove server', tone: 'danger' });
          if (!yes || viewer !== current || current.saving) return;
          current.saving = true; current.error = null; current.layer.render();
          const response = await api('/context/mcp/remove', { body: { name: current.name, revision: shared?.shared?.revision } });
          current.saving = false;
          if (!response.ok) { if (viewer === current) { current.error = response.error; current.layer.render(); } return; }
          if (viewer === current) current.layer.close('saved');
          Kit.toast('Removed shared MCP server');
          await load(true);
          return;
        }
        if (button.getAttribute('data-mcp') === 'save') {
          try {
            const pairs = parsePairs(current.draft.pairs);
            const server = current.draft.type === 'local'
              ? { name: (current.draft.name || '').trim(), type: 'local', enabled: current.draft.enabled,
                  command: String(current.draft.command || '').split('\n').map((line) => line.trim()).filter(Boolean), env: pairs }
              : { name: (current.draft.name || '').trim(), type: 'remote', enabled: current.draft.enabled,
                  url: (current.draft.url || '').trim(), headers: pairs };
            current.saving = true; current.error = null; current.layer.render();
            const response = creating
              ? await api('/context/mcp/create', { body: { server } })
              : await api('/context/mcp/save', { body: { name: current.name, revision: shared?.shared?.revision, server } });
            current.saving = false;
            if (!response.ok) { if (viewer === current) { current.error = response.error; current.layer.render(); } return; }
            if (viewer === current) current.layer.close('saved');
            Kit.toast(creating ? 'Added shared MCP server' : 'Saved shared MCP server');
            await load(true);
          } catch (err) {
            current.error = err.message; current.layer.render();
          }
        }
      });
      if (creating) { current.loading = false; current.layer.render(); return; }
      const response = await api('/context/mcp/read?name=' + encodeURIComponent(name));
      if (viewer !== current) return;
      current.loading = false;
      if (!response.ok) { current.error = response.error; current.layer.render(); return; }
      const server = response.data.server;
      current.data = server;
      current.draft = { name: server.name, type: server.type, enabled: server.enabled !== false,
        command: (server.command || []).join('\n'), url: server.url || '',
        pairs: formatPairs(server.type === 'local' ? server.env : server.headers) };
      current.layer.render();
    };

    const setLink = async (provider, name) => {
      if (linking) return;
      const current = getStatus()?.context?.mcp?.providers?.find((row) => row.provider === provider);
      const linked = !(current?.linked || []).includes(name);
      linking = provider; render();
      const response = await api('/context/mcp/link', { body: { provider, name, linked, sharedRevision: shared?.shared?.revision } });
      linking = null;
      if (!response.ok) Kit.toast('Could not change MCP link', { tone: 'danger', detail: response.error });
      else Kit.toast(linked ? providerName(provider) + ' now uses ' + name : providerName(provider) + ' stopped using ' + name);
      await load(true);
    };

    return { content, load, refresh: () => load(true), add: () => open(null), view: (id) => open(id),
      activate: () => { if (!shared && !loading && !error) load(); },
      toggle: (provider, name) => setLink(provider, name),
      select: () => {},
    };
  };
  return { create };
})();
