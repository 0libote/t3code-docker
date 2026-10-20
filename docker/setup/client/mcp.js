// Shared MCP servers: one canonical list, linked per provider. Status polls
// carry redacted summaries; secrets load only in the editor.
const T3McpUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const M = T3Model;
  const providers = [['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['cursor', 'Cursor'], ['grok', 'Grok Build'], ['muse', 'Muse Code'], ['antigravity', 'Antigravity']];
  const providerName = (id) => providers.find(([key]) => key === id)?.[1] || id;

  const create = ({ api, getStatus, render }) => {
    let provider = null, shared = null, loading = false, error = null, generation = 0, viewer = null, linking = null;
    const snapshot = () => ({ ...getStatus(), context: { ...getStatus()?.context, mcp: shared || getStatus()?.context?.mcp } });

    const chooseDefault = () => {
      const installed = (getStatus()?.harnesses || []).filter((row) => row.installed).map((row) => row.id);
      return providers.find(([id]) => installed.includes(id))?.[0] || 'claude';
    };

    const load = async (refresh = false) => {
      if (loading) return;
      provider ||= chooseDefault();
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

    const serverRow = (server, selected) => {
      const differs = selected?.diverged?.includes(server.name);
      const linked = differs || selected?.linked?.includes(server.name);
      const managed = selected?.supported && !selected.error;
      const canApply = server.enabled !== false || ['codex', 'opencode'].includes(provider);
      const busy = loading || Boolean(linking);
      const detail = server.type === 'local' ? (server.command || []).join(' ') : server.url;
      return html`<div class="tc-row tc-row--compact tc-skill-row" data-key="mcp-${server.name}">
        <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('plug')}</span>
        <button class="tc-row-main tc-skill-open" type="button" data-cmd="mcp.view" data-id="${server.name}" aria-label="Edit ${server.name}">
          <span class="tc-row-title"><span class="tc-row-name">${server.name}</span>
            <span class="tc-badge">${server.type === 'local' ? 'Local' : 'Remote'}</span>
            ${server.enabled === false ? html`<span class="tc-badge" title="Disabled when applied to Codex or OpenCode">Disabled</span>` : ''}
            ${differs ? html`<span class="tc-badge tc-badge--warn">Differs</span>` : ''}</span>
          ${detail ? html`<span class="tc-skill-description" title="${detail}">${detail}</span>` : ''}
        </button>
        <div class="tc-row-actions">
          ${managed ? html`${differs && canApply ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="mcp.apply" data-provider="${provider}" data-id="${server.name}"${busy ? raw(' disabled') : ''}>Apply</button>` : ''}
            <label class="tc-switch-hit" title="${linked ? differs ? 'This copy differs from shared. Apply to replace it, or switch off to unlink.' : 'Matches the shared definition. Switch off to unlink.' : canApply ? 'Link this server to ' + providerName(provider) : 'Enable the shared definition before linking to ' + providerName(provider)}"><button class="tc-switch" type="button" role="switch" aria-checked="${String(Boolean(linked))}" aria-label="${providerName(provider)} configured for ${server.name}" data-cmd="mcp.link" data-provider="${provider}" data-id="${server.name}"${busy || (!linked && !canApply) ? raw(' disabled') : ''}${linking ? raw(' aria-busy="true"') : ''}></button></label>` : ''}
        </div>
      </div>`;
    };

    const content = () => {
      const view = M.mcpView(snapshot());
      const selected = shared?.providers?.find((row) => row.provider === (provider || chooseDefault()));
      const servers = shared?.shared?.servers || [];
      const unavailable = selected?.supported && selected.error;
      return html`<div class="tc-group tc-skills tc-mcp">
        <div class="tc-skill-toolbar"><label class="tc-label" for="mcp-provider">Agent</label><select class="tc-select tc-select--sm" id="mcp-provider"${linking ? raw(' disabled') : ''}>${providers.map(([id, name]) => html`<option value="${id}"${(provider || chooseDefault()) === id ? raw(' selected') : ''}>${name}</option>`)}</select><span class="tc-hint tc-skill-count">${shared && !loading ? M.plural(servers.length, 'shared server') : ''}</span><span class="tc-spacer"></span><div class="tc-skill-actions">
          <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cmd="mcp.refresh" aria-label="Refresh MCP servers" title="Refresh MCP servers"${loading || linking ? raw(' disabled') : ''}>${icon('refresh-cw')}</button>
          <button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="mcp.add">${icon('plus')}Add server</button></div></div>
        <div class="tc-skill-body" aria-live="polite" aria-busy="${String(loading)}">
          ${loading ? html`<p class="tc-skill-message tc-muted"><span class="tc-spinner" aria-hidden="true"></span>Reading MCP servers…</p>` : ''}
          ${error ? html`<p class="tc-skill-message tc-danger" role="alert">${icon('circle-alert')}<span>Couldn’t read MCP servers: ${error}</span></p>` : ''}
          ${view.error && !loading ? html`<p class="tc-skill-message tc-warning" role="status">${icon('triangle-alert')}<span>${view.error}</span></p>` : ''}
          ${!loading && !error && shared ? html`
            ${selected && (!selected.supported || selected.error) ? html`<p class="tc-skill-message${unavailable ? ' tc-warning' : ' tc-muted'}" role="status">${icon(unavailable ? 'triangle-alert' : 'info')}<span>${unavailable ? 'Couldn’t read ' + providerName(provider) + ' settings: ' : ''}${selected.error || 'MCP settings for this agent are not managed here.'} You can still edit shared definitions.</span></p>` : ''}
            ${selected?.warning ? html`<p class="tc-skill-message tc-warning" role="status">${icon('triangle-alert')}<span>${selected.warning}</span></p>` : ''}
            ${servers.length ? html`<div class="tc-list">${servers.map((server) => serverRow(server, selected))}</div>` : html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-media" aria-hidden="true"><span class="tc-empty-icon">${icon('plug')}</span></span><span class="tc-empty-title">No shared servers yet</span><span class="tc-empty-desc">Add a server, then choose which agents should use it.</span></div>`}
            ${selected?.path ? html`<details class="tc-skill-locations" data-key="mcp-location-${provider}"><summary>${providerName(provider)} settings${selected.ownCount ? ' · ' + M.plural(selected.ownCount, 'other server') : ''}</summary><code>${selected.path}</code><p class="tc-hint">${selected.ownCount ? 'Other servers in this file: ' + (selected.own?.join(', ') || selected.ownCount) + '. They stay unchanged.' : 'Only same-name entries are changed when you link, apply or unlink.'}</p></details>` : ''}
            <details class="tc-skill-locations" data-key="mcp-support"><summary>How sharing works</summary><p class="tc-hint">Definitions are shared across agents. Saving leaves existing agent copies unchanged; choose Apply to update a copy marked Differs. Switches show saved entries, including disabled ones. They do not show live connection status.</p><p class="tc-hint">This page manages global settings. Project settings and custom T3 agent profiles can differ. Codex and OpenCode support disabled definitions here; unlink for Claude and Cursor. Start a new session to load changes.</p><p class="tc-hint">Remote servers use Streamable HTTP. Sign in through your agent when required: claude mcp login, codex mcp login, opencode mcp auth or cursor-agent mcp login.</p></details>
          ` : ''}
        </div>
        <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Choose an agent, then link the shared servers it should use. After editing a definition, Apply updates that agent’s copy.</span></div>
      </div>`;
    };

    const open = async (name = null) => {
      if (viewer?.saving) return;
      viewer?.layer.close('replace');
      const creating = !name;
      const current = { creating, name: name || '', loading: !creating, data: null, revision: null, error: null, layer: null, saving: false,
        draft: { name: name || '', type: 'local', command: '', url: '', env: '{}', headers: '{}', enabled: true }, original: '' };
      current.original = JSON.stringify(current.draft);
      const dirty = () => JSON.stringify(current.draft) !== current.original;
      const cannotSave = () => current.saving || current.loading || (!creating && !current.data) || !current.draft.name.trim() || (!creating && !dirty());
      const requestClose = async () => {
        if (current.saving || current.closing) return;
        if (dirty()) {
          current.closing = true;
          const yes = await Kit.confirm({ title: 'Discard changes?', body: 'Your edits to this shared server have not been saved.', confirm: 'Discard changes', tone: 'danger' });
          current.closing = false;
          if (!yes || viewer !== current || current.saving) return;
        }
        current.layer.close('close');
      };
      const title = creating ? 'Add shared MCP server' : 'Edit ' + name;
      current.layer = Kit.open({ kind: 'center',
        panel: { tag: 'div', class: 'tc-sheet tc-context-sheet tc-mcp-editor ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mcp-title' },
        backdrop: 'ignore', onEscape: requestClose,
        onClose: () => { if (viewer === current) viewer = null; },
        render: () => html`<div class="tc-sheet-head"><span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('plug')}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="mcp-title">${title}</h2><span class="tc-small tc-muted">Shared definition for all agents</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-mcp="close" aria-label="Close"${current.saving ? raw(' disabled') : ''}>${icon('x')}</button></div>
          <div class="tc-sheet-body">
            ${current.error ? html`<p class="tc-danger" role="alert">${current.error}</p>` : ''}
            ${current.loading ? html`<p class="tc-muted" role="status">Reading server…</p>` : creating || current.data ? html`
            <label class="tc-label" for="mcp-name">Name</label>
            <input class="tc-input tc-mono" id="mcp-name" data-key="mcp-name" value="${current.draft.name}" maxlength="64" autocapitalize="none" spellcheck="false"${current.saving || !creating ? raw(' disabled') : ''}>
            <p class="tc-hint">Use lowercase letters, numbers and single hyphens. To rename a server, remove it and add it again.</p>
            <label class="tc-label" for="mcp-type">Type</label>
            <select class="tc-select" id="mcp-type"${current.saving ? raw(' disabled') : ''}><option value="local"${current.draft.type === 'local' ? raw(' selected') : ''}>Local command</option><option value="remote"${current.draft.type === 'remote' ? raw(' selected') : ''}>Remote URL</option></select>
            ${current.draft.type === 'local' ? html`<label class="tc-label" for="mcp-command">Command and arguments (JSON array)</label><textarea class="tc-input tc-input--mono" id="mcp-command" placeholder='["npx", "-y", "package-name"]' rows="3" spellcheck="false"${current.saving ? raw(' disabled') : ''}>${current.draft.command}</textarea>` : html`<label class="tc-label" for="mcp-url">URL</label><input class="tc-input tc-mono" id="mcp-url" value="${current.draft.url}" placeholder="https://…" spellcheck="false"${current.saving ? raw(' disabled') : ''}>`}
            <label class="tc-label" for="mcp-pairs">${current.draft.type === 'local' ? 'Environment (JSON object)' : 'Headers (JSON object)'}</label>
            <textarea class="tc-input tc-input--mono" id="mcp-pairs" data-key="mcp-pairs-${current.draft.type}" rows="3" spellcheck="false"${current.saving ? raw(' disabled') : ''}>${current.draft.type === 'local' ? current.draft.env : current.draft.headers}</textarea>
            <label class="tc-switch-hit" for="mcp-enabled"><button class="tc-switch" id="mcp-enabled" type="button" role="switch" aria-checked="${String(current.draft.enabled)}" aria-label="Enabled"${current.saving ? raw(' disabled') : ''}></button><span class="tc-small">Enabled for Codex and OpenCode</span></label>
            <p class="tc-hint">For Claude and Cursor, unlink to disable. Saving does not change existing agent copies.</p>
            <p class="tc-hint">Put secrets in environment values or headers; commands are visible in the list. Variable references follow each agent’s own rules.</p>
            ` : ''}
          </div><div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-mcp="close"${current.saving ? raw(' disabled') : ''}>Cancel</button>
          ${!creating ? html`<button class="tc-btn tc-btn--danger" type="button" data-mcp="remove"${current.saving || current.loading || !current.data ? raw(' disabled') : ''}>Remove…</button>` : ''}
          <button class="tc-btn tc-btn--primary" type="button" data-mcp="save"${cannotSave() ? raw(' disabled') : ''}>${current.saving ? 'Saving…' : creating ? 'Add server' : 'Save'}</button></div>`,
      });
      viewer = current;
      const panel = current.layer.panel;
      const sync = () => current.layer.render();
      const syncSave = () => { panel.querySelector('[data-mcp=save]').disabled = cannotSave(); };
      panel.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault(); panel.querySelector('[data-mcp=save]').click();
        }
      });
      panel.addEventListener('input', (event) => {
        if (event.target.id === 'mcp-name') current.draft.name = event.target.value;
        if (event.target.id === 'mcp-url') current.draft.url = event.target.value;
        if (event.target.id === 'mcp-command') current.draft.command = event.target.value;
        if (event.target.id === 'mcp-pairs') current.draft[current.draft.type === 'local' ? 'env' : 'headers'] = event.target.value;
        syncSave();
      });
      panel.addEventListener('change', (event) => {
        if (event.target.id === 'mcp-type') { current.draft.type = event.target.value; sync(); }
      });
      panel.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        if (button.hasAttribute('data-mcp') && button.getAttribute('data-mcp') === 'close') { await requestClose(); return; }
        if (button.id === 'mcp-enabled') { current.draft.enabled = !current.draft.enabled; button.setAttribute('aria-checked', String(current.draft.enabled)); syncSave(); return; }
        if (button.getAttribute('data-mcp') === 'remove') {
          const yes = await Kit.confirm({ title: 'Remove ' + current.name + '?', body: 'Unlink this server from every agent first. Removing it here deletes the shared definition. Existing sessions and compatibility imports can still use their own copies.', confirm: 'Remove server', tone: 'danger' });
          if (!yes || viewer !== current || current.saving) return;
          current.saving = true; current.error = null; current.layer.render();
          const response = await api('/context/mcp/remove', { body: { name: current.name, revision: current.revision } });
          current.saving = false;
          if (!response.ok) { if (viewer === current) { current.error = response.error; current.layer.render(); } return; }
          if (viewer === current) current.layer.close('saved');
          Kit.toast('Removed shared MCP server');
          generation++; loading = false;
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
            generation++; loading = false;
            await load(true);
          } catch (err) {
            current.saving = false; current.error = err.message; current.layer.render();
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
      current.original = JSON.stringify(current.draft);
      current.layer.render();
    };

    const setLink = async (provider, name, apply = false) => {
      if (linking) return;
      if (loading || error) return;
      const current = shared?.providers?.find((row) => row.provider === provider);
      const sharedRevision = shared?.shared?.revision;
      if (!current?.revision) return;
      const differs = (current.diverged || []).includes(name);
      const linked = apply || ![...(current.linked || []), ...(current.diverged || [])].includes(name);
      if (differs || !linked) {
        const yes = await Kit.confirm({ title: linked ? 'Apply shared ' + name + '?' : 'Unlink ' + name + '?', body: linked ? 'Replaces the complete ' + providerName(provider) + ' entry, including its agent-specific options. A private backup is kept beside the settings file.' : 'Removes this entry from ' + providerName(provider) + ' global settings. A private backup is kept. Existing sessions, project settings and compatibility imports can still use the server.', confirm: linked ? 'Apply shared' : 'Unlink', tone: linked ? 'primary' : 'danger' });
        if (!yes || linking) return;
      }
      linking = provider; render();
      const response = await api('/context/mcp/link', { body: { provider, name, linked, sharedRevision, providerRevision: current.revision } });
      linking = null;
      if (!response.ok) Kit.toast('Could not change MCP link', { tone: 'danger', detail: response.error });
      else Kit.toast(linked ? 'Applied ' + name + ' to ' + providerName(provider) : 'Removed ' + name + ' from ' + providerName(provider) + ' global config');
      generation++; loading = false;
      await load(true);
    };

    return { content, load, refresh: () => load(true), add: () => open(null), view: (id) => open(id),
      activate: () => { if (!shared && !loading && !error) load(); },
      toggle: (provider, name) => setLink(provider, name),
      apply: (provider, name) => setLink(provider, name, true),
      select: (id) => { if (!linking && providers.some(([key]) => key === id)) { provider = id; render(); } },
    };
  };
  return { create };
})();
