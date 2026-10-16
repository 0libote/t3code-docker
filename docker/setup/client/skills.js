// On-demand, read-only skill inventory. Status polling never starts a scan.
const T3SkillsUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const providers = [['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['cursor', 'Cursor'], ['grok', 'Grok Build'], ['muse', 'Muse Code']];
  const stateOf = (skill) => skill.error ? { text: 'Unavailable', tone: 'warn' }
    : skill.native && skill.state === 'enabled' ? { text: 'Enabled', tone: 'ok' }
      : skill.native && skill.state === 'disabled' ? { text: 'Disabled', tone: '' }
        : { text: 'Unverified', tone: '' };
  const create = ({ api, getStatus, render }) => {
    let provider = null, inventory = null, loading = false, error = null, generation = 0, viewer = null;
    const chooseDefault = () => {
      const installed = (getStatus()?.harnesses || []).filter((row) => row.installed).map((row) => row.id);
      return providers.find(([id]) => installed.includes(id))?.[0] || 'claude';
    };
    const load = async (refresh = false) => {
      if (loading) return;
      provider ||= chooseDefault();
      const selected = provider, current = ++generation;
      loading = true; error = null; render();
      const response = await api('/context/skills?provider=' + encodeURIComponent(selected) + (refresh ? '&refresh=1' : ''));
      if (current !== generation) return;
      loading = false;
      if (response.ok) inventory = response.data;
      else error = response.error;
      render();
    };
    const content = () => html`<div class="tc-group tc-skills">
      <div class="tc-skill-toolbar"><label class="tc-label" for="skill-provider">Provider</label><select class="tc-input" id="skill-provider">${providers.map(([id, name]) => html`<option value="${id}"${(provider || chooseDefault()) === id ? raw(' selected') : ''}>${name}</option>`)}</select><span class="tc-hint">Global skills · read-only preview</span></div>
      <div aria-live="polite" aria-busy="${String(loading)}">
        ${loading ? html`<p class="tc-skill-message tc-muted"><span class="tc-spinner" aria-hidden="true"></span>Reading skills…</p>` : ''}
        ${error ? html`<p class="tc-skill-message tc-danger" role="alert">Could not read skills: ${error}</p>` : ''}
        ${!loading && !error && inventory ? html`
          <p class="tc-skill-message tc-hint">${inventory.coverageText}</p>
          ${inventory.nativeError ? html`<p class="tc-skill-message tc-hint">Native inventory unavailable: ${inventory.nativeError}</p>` : ''}
          ${(inventory.warnings || []).map((warning) => html`<p class="tc-skill-message tc-warning" role="status">${warning}</p>`)}
          <div class="tc-list">${(inventory.skills || []).map((skill) => {
            const status = stateOf(skill);
            return html`<div class="tc-row tc-skill-row" data-key="skill-${skill.id}"><div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">${skill.name}</span><span class="tc-badge${status.tone ? ' tc-badge--' + status.tone : ''}">${status.text}</span></div>
              ${skill.description ? html`<p class="tc-small tc-muted tc-skill-description">${skill.description}</p>` : ''}
              <span class="tc-hint">${skill.source}${skill.metadataError ? ' · Metadata needs attention' : ''}</span></div>
              <div class="tc-row-actions"><button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.view" data-id="${skill.id}" aria-label="View ${skill.name}">${icon('book-open')}View</button></div></div>`;
          })}</div>
          ${!inventory.skills?.length ? html`<p class="tc-skill-message tc-muted">${inventory.warnings?.length ? 'No skill entries could be shown. Review the scan messages above.' : 'No skills found in the checked global locations.'}</p>` : ''}
          ${inventory.roots?.length ? html`<details class="tc-skill-locations" data-key="skill-locations"><summary>Checked global folders</summary>${inventory.roots.map((root) => html`<code>${root.path}</code>`)}</details>` : ''}
        ` : ''}
      </div>
      <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Refresh after changing skills outside the console. Project and session settings can change what an agent can use. Custom provider environments may use different locations.</span></div>
    </div>`;
    const actions = () => html`<button class="tc-btn tc-btn--sm tc-btn--ghost" type="button" data-cmd="skills.refresh"${loading ? raw(' disabled') : ''}>${icon('refresh-cw')}Refresh skills</button>`;
    const view = async (id) => {
      const row = inventory?.skills?.find((skill) => skill.id === id);
      if (!row) return;
      viewer?.layer.close('replace');
      const current = { provider, row, loading: true, data: null, error: null, layer: null };
      viewer = current;
      current.layer = Kit.open({ kind: 'center', panel: { class: 'tc-sheet tc-context-sheet tc-skill-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-view-title' }, focus: '[data-skill-close]',
        onClose: () => { if (viewer === current) viewer = null; },
        render: () => html`<div class="tc-sheet-head"><div class="tc-sheet-head-text"><h3 class="tc-sheet-title" id="skill-view-title">${row.name}</h3><span class="tc-small tc-muted">${providers.find(([key]) => key === current.provider)?.[1]} · ${row.source}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-skill-close aria-label="Close">${icon('x')}</button></div>
          <div class="tc-sheet-body">
            <div class="tc-skill-meta"><span class="tc-hint">Location</span><code>${current.data?.path || row.path}</code>${(current.data?.resolvedPath || row.resolvedPath) && (current.data?.resolvedPath || row.resolvedPath) !== row.path ? html`<span class="tc-hint">Linked target</span><code>${current.data?.resolvedPath || row.resolvedPath}</code>` : ''}</div>
            <p class="tc-hint">${stateOf(row).text}${row.invocation === 'manual' ? ' · Manual invocation requested by the skill' : row.invocation === 'model-only' ? ' · User invocation disabled in frontmatter' : ''}. ${row.native ? 'Listed by Codex in the managed setup environment.' : 'File found on disk; provider availability is unverified.'}</p>
            ${row.metadataError ? html`<p class="tc-hint tc-warning">${row.metadataError}</p>` : ''}
            ${current.loading ? html`<p class="tc-muted" role="status">Reading Markdown…</p>` : current.error ? html`<p class="tc-danger" role="alert">${current.error}</p>` : html`<label class="tc-label" for="skill-content">Markdown · ${current.data.bytes} bytes</label><textarea id="skill-content" class="tc-input tc-input--area" readonly spellcheck="false" rows="14">${current.data.content}</textarea>`}
          </div><div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-skill-close>Close</button><button class="tc-btn" type="button" data-skill-copy${current.data ? '' : raw(' disabled')}>${icon('copy')}Copy Markdown</button><button class="tc-btn" type="button" data-skill-download${current.data ? '' : raw(' disabled')}>${icon('download')}Download .md</button></div>`,
      });
      current.layer.panel.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        if (button.hasAttribute('data-skill-close')) current.layer.close('close');
        else if (button.hasAttribute('data-skill-copy') && current.data) Kit.copy(current.data.content, button, 'Skill Markdown copied');
        else if (button.hasAttribute('data-skill-download') && current.data) {
          const url = URL.createObjectURL(new Blob([current.data.content], { type: 'text/markdown;charset=utf-8' }));
          const link = document.createElement('a'); link.href = url; link.download = (row.name.replace(/[^a-z0-9-]/gi, '-').slice(0, 64) || 'skill') + '.md';
          link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
        }
      });
      const response = await api('/context/skills/read?provider=' + encodeURIComponent(current.provider) + '&id=' + encodeURIComponent(id));
      if (viewer !== current) return;
      current.loading = false;
      if (response.ok) current.data = response.data;
      else current.error = response.error;
      current.layer.render();
    };
    return { content, actions, view,
      activate: () => { if (!inventory && !loading && !error) load(); },
      refresh: () => load(true),
      select: (id) => {
        if (!providers.some(([key]) => key === id) || id === provider) return;
        viewer?.layer.close('provider');
        provider = id; inventory = null; loading = false; error = null; generation++;
        load();
      },
    };
  };
  return { create, stateOf };
})();
