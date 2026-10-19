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
    const snapshot = () => ({ ...getStatus(), context: { ...getStatus()?.context, mcp: shared || getStatus()?.context?.mcp } });

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

    const parseJson = (text, array) => {
      let out;
      try { out = JSON.parse(text); } catch { throw new Error(array ? 'Enter the command as a JSON array of strings.' : 'Enter values as a JSON object of strings.'); }
      if (!out || typeof out !== 'object' || Array.isArray(out) !== array || !Object.values(out).every((value) => typeof value === 'string')) throw new Error(array ? 'Enter a JSON array of strings.' : 'Enter a JSON object of strings.');
      return out;
    };

    const serverRow = (server) => {
      const detail = server.type === 'local'
        ? (server.command || []).join(' ')
        : server.url;
      return html`<div class="tc-row tc-row--compact" data-key="mcp-${server.name}">
        <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('plug')}</span>
        <button class="tc-row-main tc-skill-open" type="button" data-cmd="mcp.view" data-id="${server.name}" aria-label="Edit ${server.name}">
          <span class="tc-row-title"><span class="tc-row-name tc-mono">${server.name}</span>
            <span class="tc-badge">${server.type === 'local' ? 'Local' : 'Remote'}</span>
            ${server.enabled === false ? html`<span class="tc-badge">Definition disabled</span>` : ''}
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
            ${!row.supported || row.error ? html`<span class="tc-badge tc-badge--warn">${row.supported ? 'Unavailable' : 'Not managed'}</span>` : ''}</div>
          <span class="tc-status"><span class="tc-status-text">${!row.supported || row.error ? (row.error || 'Unsupported') : 'Matches: ' + (row.linked?.join(', ') || 'none') + (row.diverged?.length ? ' · Needs review: ' + row.diverged.join(', ') : '') + (row.ownCount ? ' · +' + row.ownCount + ' own' : '')}</span></span>
          ${row.path ? html`<span class="tc-hint tc-mono tc-wrap">${row.path}</span>` : ''}
          ${row.note ? html`<span class="tc-hint">${row.note}</span>` : ''}
        </div>
        <div class="tc-row-actions tc-row-actions--wrap">
          ${(!row.supported || row.error ? [] : names).map((name) => {
            const differs = (row.diverged || []).includes(name);
            const on = differs || (row.linked || []).includes(name);
            const server = shared?.shared?.servers?.find((s) => s.name === name);
            const canApply = server?.enabled !== false || ['codex', 'opencode'].includes(row.id);
            return html`<div class="tc-mcp-control"><label class="tc-switch-hit" title="${providerName(row.id)} ${on ? 'has a configuration for' : 'has no configuration for'} ${name}${differs ? ' (differs from shared)' : ''}"><button class="tc-switch" type="button" role="switch" aria-checked="${String(on)}" aria-label="${providerName(row.id)} configured for ${name}" data-cmd="mcp.link" data-provider="${row.id}" data-id="${name}"${busy || (!on && !canApply) ? raw(' disabled') : ''}></button><span class="tc-small tc-mono">${name}</span></label>${differs ? html`<span class="tc-badge tc-badge--warn">Differs</span>${canApply ? html`<button class="tc-btn tc-btn--sm" data-cmd="mcp.apply" data-provider="${row.id}" data-id="${name}"${busy ? raw(' disabled') : ''}>Apply</button>` : html`<span class="tc-hint">Unlink to disable</span>`}` : ''}</div>`;
          })}
        </div>
      </div>`;
    };

    const content = () => {
      const view = M.mcpView(snapshot());
      const rows = M.mcpProviderRows(snapshot());
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
            ${rows.length ? html`<div class="tc-mcp-providers"><div class="tc-label">Global provider configurations</div><div class="tc-list">${rows.map(providerRow)}</div></div>` : ''}
            <details class="tc-skill-locations"><summary>Provider support and authentication</summary><p class="tc-hint">Manages default global config files, not custom T3 provider-instance homes or project overrides. A matching configuration does not establish a live connection. Codex and OpenCode support disabled definitions; unlink for Claude and Cursor. Antigravity, Grok and Muse are not managed here. Grok may inherit Claude/Cursor servers through its compatibility imports.</p><p class="tc-hint">Remote servers use Streamable HTTP. OAuth sign-in stays with each provider: use claude mcp login, codex mcp login, opencode mcp auth or cursor-agent mcp login when required.</p></details>
          ` : ''}
        </div>
        <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Save a definition, then apply it to each provider. Existing copies stay unchanged until you apply or unlink. Switches show configuration presence, including disabled entries. Start a new provider session to load changes.</span></div>
      </div>`;
    };

    const open = async (name = null) => {
      if (viewer?.saving) return;
      viewer?.layer.close('replace');
      const creating = !name;
      const current = { creating, name: name || '', loading: !creating, data: null, revision: null, error: null, layer: null, saving: false,
        draft: { name: name || '', type: 'local', command: '', url: '', env: '{}', headers: '{}', enabled: true }, original: '' };
      const title = creating ? 'Add shared MCP server' : 'Edit ' + name;
      current.layer = Kit.open({ kind: 'center',
        panel: { tag: 'div', class: 'tc-sheet tc-context-sheet tc-mcp-editor ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mcp-title' },
        onClose: () => { if (viewer === current) viewer = null; },
        render: () => html`<div class="tc-sheet-head"><span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('plug')}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="mcp-title">${title}</h2><span class="tc-small tc-muted">Save here, then apply per provider</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-mcp="close" aria-label="Close">${icon('x')}</button></div>
          <div class="tc-sheet-body">
            ${current.error ? html`<p class="tc-danger" role="alert">${current.error}</p>` : ''}
            ${current.loading ? html`<p class="tc-muted" role="status">Reading server…</p>` : html`
            <label class="tc-label" for="mcp-name">Name</label>
            <input class="tc-input tc-mono" id="mcp-name" data-key="mcp-name" value="${current.draft.name}" maxlength="64" autocapitalize="none" spellcheck="false"${current.saving || !creating ? raw(' disabled') : ''}>
            <p class="tc-hint">Lowercase letters, numbers, hyphens. Renaming is remove + add.</p>
            <label class="tc-label" for="mcp-type">Type</label>
            <select class="tc-select" id="mcp-type"${current.saving ? raw(' disabled') : ''}><option value="local"${current.draft.type === 'local' ? raw(' selected') : ''}>Local command</option><option value="remote"${current.draft.type === 'remote' ? raw(' selected') : ''}>Remote URL</option></select>
            ${current.draft.type === 'local' ? html`<label class="tc-label" for="mcp-command">Command and arguments (JSON array)</label><textarea class="tc-input tc-input--mono" id="mcp-command" placeholder='["npx", "-y", "package-name"]' rows="3" spellcheck="false"${current.saving ? raw(' disabled') : ''}>${current.draft.command}</textarea>` : html`<label class="tc-label" for="mcp-url">URL</label><input class="tc-input tc-mono" id="mcp-url" value="${current.draft.url}" placeholder="https://…" spellcheck="false"${current.saving ? raw(' disabled') : ''}>`}
            <label class="tc-label" for="mcp-pairs">${current.draft.type === 'local' ? 'Environment (JSON object)' : 'Headers (JSON object)'}</label>
            <textarea class="tc-input tc-input--mono" id="mcp-pairs" rows="3" spellcheck="false"${current.saving ? raw(' disabled') : ''}>${current.draft.type === 'local' ? current.draft.env : current.draft.headers}</textarea>
            <label class="tc-switch-hit" for="mcp-enabled"><button class="tc-switch" id="mcp-enabled" type="button" role="switch" aria-checked="${String(current.draft.enabled)}" aria-label="Enabled"${current.saving ? raw(' disabled') : ''}></button><span class="tc-small">Enabled (honored by Codex and OpenCode; other providers link by presence)</span></label>
            `}<p class="tc-hint">Environment and header values load only here. URL paths and queries are hidden in lists. Commands are shown in lists: put secrets in Environment or Headers. Provider-native variable interpolation rules still apply.</p>
          </div><div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-mcp="close"${current.saving ? raw(' disabled') : ''}>Cancel</button>
          ${!creating ? html`<button class="tc-btn tc-btn--danger" type="button" data-mcp="remove"${current.saving || current.loading ? raw(' disabled') : ''}>Remove…</button>` : ''}
          <button class="tc-btn tc-btn--primary" type="button" data-mcp="save"${current.saving || current.loading || (!creating && !current.data) ? raw(' disabled') : ''}>${current.saving ? 'Saving…' : creating ? 'Add server' : 'Save'}</button></div>`,
      });
      viewer = current;
      const panel = current.layer.panel;
      const sync = () => current.layer.render();
      panel.addEventListener('input', (event) => {
        if (event.target.id === 'mcp-name') current.draft.name = event.target.value;
        if (event.target.id === 'mcp-url') current.draft.url = event.target.value;
        if (event.target.id === 'mcp-command') current.draft.command = event.target.value;
        if (event.target.id === 'mcp-pairs') current.draft[current.draft.type === 'local' ? 'env' : 'headers'] = event.target.value;
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
          const yes = await Kit.confirm({ title: 'Remove ' + current.name + '?', body: 'Unlink this server from all supported providers first. Removing the definition does not remove unmanaged compatibility copies or existing sessions.', confirm: 'Remove server', tone: 'danger' });
          if (!yes || viewer !== current || current.saving) return;
          current.saving = true; current.error = null; current.layer.render();
          const response = await api('/context/mcp/remove', { body: { name: current.name, revision: current.revision } });
          current.saving = false;
          if (!response.ok) { if (viewer === current) { current.error = response.error; current.layer.render(); } return; }
          if (viewer === current) current.layer.close('saved');
          Kit.toast('Removed shared MCP server');
          await load(true);
          return;
        }
        if (button.getAttribute('data-mcp') === 'save') {
          try {
            const pairs = parseJson(current.draft[current.draft.type === 'local' ? 'env' : 'headers'], false);
            const server = current.draft.type === 'local'
              ? { name: (current.draft.name || '').trim(), type: 'local', enabled: current.draft.enabled,
                  command: parseJson(current.draft.command, true), env: pairs }
              : { name: (current.draft.name || '').trim(), type: 'remote', enabled: current.draft.enabled,
                  url: (current.draft.url || '').trim(), headers: pairs };
            current.saving = true; current.error = null; current.layer.render();
            const response = creating
              ? await api('/context/mcp/create', { body: { server } })
              : await api('/context/mcp/save', { body: { name: current.name, revision: current.revision, server } });
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
      current.revision = response.data.revision;
      current.data = server;
      current.draft = { name: server.name, type: server.type, enabled: server.enabled !== false,
        command: JSON.stringify(server.command || [], null, 2), url: server.url || '',
        env: JSON.stringify(server.env || {}, null, 2), headers: JSON.stringify(server.headers || {}, null, 2) };
      current.layer.render();
    };

    const setLink = async (provider, name, apply = false) => {
      if (linking) return;
      const current = shared?.providers?.find((row) => row.provider === provider);
      const sharedRevision = shared?.shared?.revision;
      if (!current?.revision) return;
      const differs = (current.diverged || []).includes(name);
      const linked = apply || ![...(current.linked || []), ...(current.diverged || [])].includes(name);
      if (differs || !linked) {
        const yes = await Kit.confirm({ title: linked ? 'Apply shared ' + name + '?' : 'Unlink ' + name + '?', body: linked ? 'Replaces this provider’s complete entry, including any provider-only options. A private backup of its config is kept beside the file.' : 'Removes this entry from the provider’s global config. A private backup is kept. Existing sessions and project or compatibility definitions can still use the server.', confirm: linked ? 'Apply shared' : 'Unlink', tone: linked ? 'primary' : 'danger' });
        if (!yes || linking) return;
      }
      linking = provider; render();
      const response = await api('/context/mcp/link', { body: { provider, name, linked, sharedRevision, providerRevision: current.revision } });
      linking = null;
      if (!response.ok) Kit.toast('Could not change MCP link', { tone: 'danger', detail: response.error });
      else Kit.toast(linked ? 'Applied ' + name + ' to ' + providerName(provider) : 'Removed ' + name + ' from ' + providerName(provider) + ' global config');
      await load(true);
    };

    return { content, load, refresh: () => load(true), add: () => open(null), view: (id) => open(id),
      activate: () => { if (!shared && !loading && !error) load(); },
      toggle: (provider, name) => setLink(provider, name),
      apply: (provider, name) => setLink(provider, name, true),
      select: () => {},
    };
  };
  return { create };
})();
