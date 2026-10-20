// On-demand inventory and explicit local file management. Polling never scans skills.
const T3SkillsUI = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const M = T3Model;
  const providers = [['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'], ['cursor', 'Cursor'], ['grok', 'Grok Build'], ['muse', 'Muse Code'], ['antigravity', 'Antigravity']];
  const stateOf = (skill) => skill.error ? { text: 'Unavailable', tone: 'warn' }
    : skill.stateAuthority === 'user-policy' ? { text: skill.stateLabel, tone: skill.state === 'off' || skill.state === 'deny' ? '' : 'ok' }
    : skill.native && skill.state === 'enabled' ? { text: 'Enabled', tone: 'ok' }
      : skill.native && skill.state === 'disabled' ? { text: 'Disabled', tone: '' }
        : { text: 'Unverified', tone: '' };
  const create = ({ api, getStatus, render, readMarkdown, downloadMarkdown }) => {
    let provider = null, inventory = null, loading = false, error = null, generation = 0, viewer = null, changing = null, checking = false;
    const filterKey = 't3-console-hide-bundled-skills';
    let hideBundled = false;
    try { hideBundled = localStorage.getItem(filterKey) === 'true'; } catch { /* this session only */ }
    const visibleSkills = () => (inventory?.skills || []).filter((skill) => !hideBundled || skill.scope !== 'system');
    const importer = T3SkillImport.create({ api, providers, refresh: () => load(true) });
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
    const providerName = (id) => providers.find(([key]) => key === id)?.[1] || 'this agent';
    const coverageSummary = () => !inventory || loading ? ''
      : M.plural(visibleSkills().length, 'skill') + (hideBundled && inventory.skills?.some((skill) => skill.scope === 'system') ? ' · ' + (inventory.skills.length - visibleSkills().length) + ' hidden' : '');
    // What a skill's availability means for this agent, said once under the list.
    const coverageText = () => !inventory ? 'Refresh after changing skills outside the console.'
      : inventory.coverage === 'policy' ? 'These settings are ' + providerName(provider) + '’s own, for every project. A project’s settings can still turn a skill off. A change applies to new conversations.'
        : inventory.coverage === 'native' && provider === 'codex' ? 'Codex reports which it loads. A change applies to new conversations.'
          : 'Skill files found on disk. ' + providerName(provider) + ' doesn’t say here which it loads.';
    /** The one control a skill row has: a policy, a switch, or what it is. */
    const control = (skill) => {
      if (skill.canSetState) {
        const label = provider === 'claude' ? 'Visibility' : 'Permission';
        return html`<select class="tc-select tc-select--sm tc-skill-policy" data-skill-policy="${skill.id}" aria-label="${label} for ${skill.name}"${changing ? raw(' disabled') : ''}>${skill.stateOptions.map((option) => html`<option value="${option.value}"${option.value === skill.state ? raw(' selected') : ''}>${option.label}</option>`)}</select>`;
      }
      if (skill.canToggle) {
        const busy = changing?.id === skill.id && changing.provider === provider;
        return html`<label class="tc-switch-hit" for="skill-switch-${skill.id}"><button class="tc-switch" id="skill-switch-${skill.id}" type="button" role="switch" aria-checked="${String(skill.state === 'enabled')}" aria-label="${skill.name} for Codex" data-cmd="skills.state" data-id="${skill.id}"${changing ? raw(' disabled') : ''}${busy ? raw(' aria-busy="true"') : ''}></button></label>`;
      }
      const status = stateOf(skill);
      return html`<span class="tc-badge${status.tone ? ' tc-badge--' + status.tone : ''}">${status.text}</span>`;
    };
    /** A skill in a line: its name and what it is for, opening to the whole of it, and its control. */
    const row = (skill) => {
      const flag = skill.error ? { tone: 'warn', text: 'Unavailable' } : skill.metadataError ? { tone: 'warn', text: 'Check its metadata' } : null;
      return html`<div class="tc-row tc-row--compact tc-skill-row" data-key="skill-${skill.id}">
        <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('sparkles')}</span>
        <button class="tc-row-main tc-skill-open" type="button" data-cmd="skills.view" data-id="${skill.id}" aria-label="View ${skill.name}">
          <span class="tc-row-title"><span class="tc-row-name">${skill.name}</span>${skill.update ? html`<span class="tc-badge${skill.update.status === 'available' ? ' tc-badge--ok' : skill.update.status === 'error' ? ' tc-badge--warn' : ''}">${skill.update.status === 'available' ? 'Update available' : skill.update.status === 'error' ? 'Update check failed' : 'Up to date'}</span>` : ''}${flag ? html`<span class="tc-badge tc-badge--${flag.tone}">${flag.text}</span>` : ''}</span>
          ${skill.description ? html`<span class="tc-skill-description" title="${skill.description}">${skill.description}</span>` : ''}
        </button>
        <div class="tc-row-actions">${control(skill)}</div>
      </div>`;
    };
    const content = () => html`<div class="tc-group tc-skills"${inventory ? raw(' data-provider="' + inventory.provider + '"') : ''}>
      <div class="tc-skill-toolbar"><label class="tc-label" for="skill-provider">Agent</label><select class="tc-select tc-select--sm" id="skill-provider">${providers.map(([id, name]) => html`<option value="${id}"${(provider || chooseDefault()) === id ? raw(' selected') : ''}>${name}</option>`)}</select><span class="tc-hint tc-skill-count">${coverageSummary()}</span><span class="tc-spacer"></span><div class="tc-skill-actions">${actions()}</div></div>
      <div class="tc-skill-filter"><label for="skill-hide-bundled">Hide bundled skills</label><button class="tc-switch" id="skill-hide-bundled" type="button" role="switch" aria-label="Hide bundled skills" aria-describedby="skill-filter-help" aria-checked="${String(hideBundled)}" data-cmd="skills.filter"></button><span class="tc-hint" id="skill-filter-help">Hide skills included with the agent from this list.</span></div>
      <div class="tc-skill-body" aria-live="polite" aria-busy="${String(loading)}">
        ${loading ? html`<p class="tc-skill-message tc-muted"><span class="tc-spinner" aria-hidden="true"></span>Reading skills…</p>` : ''}
        ${error ? html`<p class="tc-skill-message tc-danger" role="alert">${icon('circle-alert')}<span>Couldn’t read skills: ${error}</span></p>` : ''}
        ${!loading && !error && inventory ? html`
          ${inventory.nativeError ? html`<p class="tc-skill-message tc-warning" role="status">${icon('triangle-alert')}<span>${providerName(provider)} couldn’t be asked which skills it loads: ${inventory.nativeError}</span></p>` : ''}
          ${(inventory.warnings || []).map((warning) => html`<p class="tc-skill-message tc-warning" role="status">${icon('triangle-alert')}<span>${warning}</span></p>`)}
          ${visibleSkills().length ? html`<div class="tc-list">${visibleSkills().map(row)}</div>` : ''}
          ${!visibleSkills().length ? html`<div class="tc-empty tc-empty--compact tc-skill-empty"><span class="tc-empty-media" aria-hidden="true"><span class="tc-empty-icon">${icon('sparkles')}</span></span><span class="tc-empty-title">${inventory.skills?.length ? 'All skills are hidden' : inventory.warnings?.length ? 'No skills could be shown' : 'No skills yet'}</span><span class="tc-empty-desc">${inventory.skills?.length ? 'Turn off Hide bundled skills to show them.' : inventory.warnings?.length ? 'The messages above say why.' : 'Nothing in ' + providerName(provider) + '’s global skill folders. Add one here, or install one from a source.'}</span></div>` : ''}
          ${inventory.roots?.length ? html`<details class="tc-skill-locations" data-key="skill-locations"><summary>Looked in ${M.plural(inventory.roots.length, 'folder')}</summary>${inventory.roots.map((root) => html`<code>${root.path}</code>`)}</details>` : ''}
          ${inventory.adapter && !inventory.adapter.detected ? html`<p class="tc-skill-message tc-muted" role="status">${icon('info', 'tc-icon--sm')}<span>${providerName(provider)} isn’t detected here, so these are plain files until it is installed. Adding, editing and importing still work.</span></p>` : ''}
        ` : ''}
      </div>
      <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>${coverageText()}</span></div>
    </div>`;
    const actions = () => html`${inventory?.skills?.some((skill) => skill.origin) ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.check-updates"${loading || changing || checking ? raw(' disabled') : ''}>${checking ? 'Checking updates…' : 'Check for updates'}</button>` : ''}<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-cmd="skills.refresh" aria-label="Refresh skills" title="Refresh skills"${loading || changing || checking ? raw(' disabled') : ''}>${icon('refresh-cw')}</button><button class="tc-btn tc-btn--sm" type="button" data-cmd="skills.import">${icon('download')}Install from source</button>${inventory?.canCreate ? html`<button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="skills.add">${icon('plus')}Add skill</button>` : ''}`;
    const checkUpdates = async () => {
      if (loading || changing || checking) return;
      const selected = provider, current = generation, rows = (inventory?.skills || []).filter((skill) => skill.origin);
      checking = true; render();
      try {
        for (const skill of rows) {
          if (provider !== selected || generation !== current) break;
          const response = await api('/context/skills/check-update', { body: { provider: selected, id: skill.id } });
          if (provider !== selected || generation !== current) break;
          if (response.ok) skill.update = response.data.update;
          else skill.update = { status: 'error', error: response.error };
          render();
        }
      } finally { checking = false; render(); }
    };
    const setState = async (id, state) => {
      const row = inventory?.skills?.find((skill) => skill.id === id);
      if ((!row?.canToggle && !row?.canSetState) || loading || changing) return;
      const selected = provider, enabled = selected === 'codex' ? row.state !== 'enabled' : undefined;
      if (row.canSetState && (!row.stateOptions.some((option) => option.value === state) || state === row.state)) return;
      changing = { provider: selected, id }; render();
      const response = await api('/context/skills/state', { body: { provider: selected, id, stateRevision: row.stateRevision, enabled, state } });
      changing = null;
      if (response.ok) Kit.toast(selected === 'codex' ? enabled ? 'Enabled skill for Codex' : 'Disabled skill for Codex' : 'Saved native skill policy');
      else Kit.toast('Could not change skill policy', { tone: 'danger', detail: response.error });
      if (provider !== selected) { render(); return; }
      // Supersede any inventory fetched while the settings write was in flight.
      generation++; loading = false;
      if (response.ok) { inventory = response.data.inventory; error = null; render(); }
      else { inventory = null; await load(true); }
    };
    const open = async (id, editing = false, creating = false) => {
      const row = creating ? { name: 'Add skill', source: 'Provider', canEdit: true } : inventory?.skills?.find((skill) => skill.id === id);
      if (!row || (editing && !creating && !row.canEdit)) return;
      if (viewer?.saving) return;
      viewer?.layer.close('replace');
      const template = (slug) => '---\nname: ' + JSON.stringify(slug || 'my-skill') + '\ndescription: Describe when to use this skill.\n---\n\nWrite the skill instructions here.\n';
      const current = { provider, row, loading: !creating, data: null, error: null, layer: null, editing, creating, saving: false, slug: '', target: inventory?.creationTargets?.[0]?.id || 'provider', draft: creating ? template('') : '', original: '', generated: true };
      const formatBytes = (bytes) => bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
      const isDirty = () => creating || current.draft !== current.original;
      const editorMeta = () => formatBytes(new TextEncoder().encode(current.draft).length) + ' · ' + (creating ? 'New skill' : isDirty() ? 'Unsaved changes' : 'Saved');
      const fileName = () => (creating ? current.slug : row.name).replace(/[^a-z0-9-]/gi, '-').slice(0, 64) || 'skill';
      const download = () => downloadMarkdown(fileName() + '.md', current.draft);
      const disabled = (condition) => condition ? raw(' disabled') : '';
      viewer = current;
      current.layer = Kit.open({ kind: 'center', panel: { class: 'tc-sheet tc-context-sheet tc-skill-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-view-title' }, focus: '[data-skill-close]',
        backdrop: 'ignore', onEscape: () => { if (!current.saving) current.layer.close('escape'); },
        onClose: () => { if (viewer === current) viewer = null; },
        render: () => html`<div class="tc-sheet-head"><span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('book-open')}</span><div class="tc-sheet-head-text"><h3 class="tc-sheet-title" id="skill-view-title">${row.name}</h3><span class="tc-small tc-muted">${providers.find(([key]) => key === current.provider)?.[1]} · ${row.source}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-skill-close aria-label="Close"${disabled(current.saving)}>${icon('x')}</button></div>
          <div class="tc-sheet-body">
            ${creating ? html`${inventory?.creationTargets?.length > 1 ? html`<label class="tc-label" for="skill-target">Location</label><select class="tc-select" id="skill-target"${disabled(current.saving)}>${inventory.creationTargets.map((target) => html`<option value="${target.id}"${current.target === target.id ? raw(' selected') : ''}>${target.name}</option>`)}</select><p class="tc-hint">Shared skills can be used by multiple providers. Editing or removing them affects every provider using the same files.</p>` : ''}<label class="tc-label" for="skill-slug">Folder name</label><input class="tc-input" id="skill-slug" data-key="skill-slug" value="${current.slug}" placeholder="my-skill" maxlength="64" autocapitalize="none" spellcheck="false"${disabled(current.saving)}><p class="tc-hint">Use lowercase letters, numbers and hyphens. The frontmatter name must match.</p>` : html`<div class="tc-skill-meta"><span class="tc-hint">Location</span><code>${current.data?.path || row.path}</code>${(current.data?.resolvedPath || row.resolvedPath) && (current.data?.resolvedPath || row.resolvedPath) !== row.path ? html`<span class="tc-hint">Linked target</span><code>${current.data?.resolvedPath || row.resolvedPath}</code>` : ''}</div>
            <p class="tc-hint">${stateOf(row).text}${row.invocation === 'manual' ? ' · Manual invocation requested by the skill' : row.invocation === 'model-only' ? ' · User invocation disabled in frontmatter' : ''}. ${row.stateAuthority === 'user-policy' ? 'Native user policy checked by the managed provider. ' + row.effectiveStateText + '. Session rules can differ.' : row.native ? 'Listed by Codex in the managed setup environment.' : 'File found on disk; provider availability is unverified.'}</p>`}
            ${!creating && row.origin ? html`<div class="tc-skill-meta"><span class="tc-hint">Installed from</span><code>${row.origin.source}</code></div><p class="tc-hint">${row.update?.status === 'available' ? 'An update is available. Review the source before replacing this installation, including any local edits.' : row.update?.status === 'current' ? 'Installed source snapshot is up to date. Local edits are preserved until you explicitly replace this folder.' : row.update?.status === 'error' ? 'Could not check for updates: ' + row.update.error : 'Use Check for updates in the skill list to check this repository.'}</p>` : ''}
            ${!creating && row.stateReadOnlyReason ? html`<p class="tc-hint">${row.stateReadOnlyReason}</p>` : ''}
            ${row.metadataError ? html`<p class="tc-hint tc-warning">${row.metadataError}</p>` : ''}
            ${current.error ? html`<p class="tc-danger" role="alert">${current.error}</p>` : ''}
            <div class="tc-editor-toolbar"><label class="tc-label" for="skill-content">Markdown${current.data && !current.editing ? ' · ' + formatBytes(current.data.bytes) : ''}</label><div class="tc-editor-tools">${current.editing ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-skill-upload title="Replace this draft from a Markdown file"${disabled(current.loading || current.saving || (!creating && !current.data))}>${icon('upload')}Upload</button>` : ''}<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-skill-download title="Download, including unsaved edits"${disabled(current.loading || current.saving || (!current.data && !creating))}>${icon('download')}Download</button><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-skill-copy${disabled(current.loading || current.saving || (!current.data && !creating))}>${icon('copy')}Copy</button></div>${current.editing ? html`<input id="skill-file" type="file" accept=".md,text/markdown" hidden>` : ''}</div>
            ${current.loading ? html`<p class="tc-muted" role="status">Reading Markdown…</p>` : current.data || creating ? html`
              <textarea id="skill-content" data-key="skill-content" class="tc-input tc-input--area tc-editor-area"${current.editing ? raw(' aria-describedby="skill-editor-meta"') : raw(' readonly')}${disabled(current.saving)} spellcheck="false" rows="14">${current.draft}</textarea>
              ${current.editing ? html`<div class="tc-editor-meta"><span id="skill-editor-meta" data-key="skill-editor-meta">${editorMeta()}</span><span>${creating ? 'Creates the skill in the selected location.' : 'Saving updates this file wherever it is used. Supporting files and symlinks stay in place.'}<span class="tc-desk-only"> Ctrl/⌘ S to save.</span></span></div>` : (current.data?.readOnlyReason || current.data?.removalError) ? html`<p class="tc-hint">${current.data.readOnlyReason || current.data.removalError}</p>` : ''}
            ` : ''}
          </div><div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-skill-close${disabled(current.saving)}>Close</button>
          ${current.editing ? html`<button class="tc-btn tc-btn--primary" type="button" data-skill-save${disabled(current.loading || current.saving || (!creating && !current.data) || !isDirty() || (creating && !current.slug))}>${current.saving ? 'Saving…' : creating ? 'Add skill' : 'Save'}</button>` : html`${current.data?.canRemove ? html`<button class="tc-btn tc-btn--danger" type="button" data-skill-remove${disabled(current.saving)}>Remove…</button>` : ''}${row.origin && current.data?.canEdit ? html`<button class="tc-btn" type="button" data-skill-update>Review ${row.update?.status === 'available' ? 'update' : 'source'}</button>` : ''}${current.data?.canEdit ? html`<button class="tc-btn tc-btn--primary" type="button" data-skill-edit>Edit Markdown</button>` : ''}`}</div>`,
      });
      const syncEditor = () => {
        const meta = current.layer.panel.querySelector('#skill-editor-meta');
        if (meta) meta.textContent = editorMeta();
        const save = current.layer.panel.querySelector('[data-skill-save]');
        if (save) save.disabled = current.loading || current.saving || (!creating && !current.data) || !isDirty() || (creating && !current.slug);
      };
      current.layer.panel.addEventListener('input', (event) => {
        if (event.target.id === 'skill-content') { current.draft = event.target.value; current.generated = false; syncEditor(); }
        if (event.target.id === 'skill-slug') {
          current.slug = event.target.value;
          if (current.generated) { current.draft = template(current.slug); current.layer.panel.querySelector('#skill-content').value = current.draft; }
          syncEditor();
        }
      });
      current.layer.panel.addEventListener('keydown', (event) => {
        if (event.target.id === 'skill-content' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          current.layer.panel.querySelector('[data-skill-save]')?.click();
        }
      });
      current.layer.panel.addEventListener('change', async (event) => {
        if (event.target.id === 'skill-target') { current.target = event.target.value; return; }
        if (event.target.id !== 'skill-file' || !event.target.files?.[0]) return;
        const file = event.target.files[0]; event.target.value = ''; current.loading = true; current.error = null; current.layer.render();
        try { const text = await readMarkdown(file); if (viewer !== current) return; current.draft = text; current.generated = false; }
        catch (error) { if (viewer !== current) return; current.error = error.message; }
        current.loading = false; current.layer.render();
      });
      current.layer.panel.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        if (button.hasAttribute('data-skill-close')) current.layer.close('close');
        else if (button.hasAttribute('data-skill-copy')) Kit.copy(current.draft, button, 'Skill Markdown copied');
        else if (button.hasAttribute('data-skill-download')) download();
        else if (button.hasAttribute('data-skill-upload')) current.layer.panel.querySelector('#skill-file').click();
        else if (button.hasAttribute('data-skill-update')) { current.layer.close('update'); importer.open(current.provider, { source: row.origin.source, name: row.origin.name }); }
        else if (button.hasAttribute('data-skill-edit')) { current.editing = true; current.layer.render(); current.layer.panel.querySelector('#skill-content').focus(); }
        else if (button.hasAttribute('data-skill-save') || button.hasAttribute('data-skill-remove')) {
          const removing = button.hasAttribute('data-skill-remove');
          if (current.saving || current.loading) return;
          if (removing) {
            const yes = await Kit.confirm({ title: 'Remove ' + row.name + '?', body: current.data.removalKind === 'directory' ? 'Removes this local skill folder and its supporting files. Other providers using this folder will lose it too.' : current.data.removalLinkedTarget ? 'Removes this installation entry. Linked target files are kept.' : 'Removes this skill Markdown file. Other files in the folder stay in place.', consequences: [{ icon: 'trash-2', text: current.data.removalPath }], confirm: 'Remove skill', tone: 'danger' });
            if (!yes || viewer !== current || current.saving) return;
          }
          current.saving = true; current.error = null; current.layer.render();
          const response = await api('/context/skills/' + (removing ? 'remove' : creating ? 'create' : 'save'), { body: { provider: current.provider, id, slug: current.slug, target: current.target, content: current.draft, revision: current.data?.revision, removalRevision: current.data?.removalRevision } });
          current.saving = false;
          if (!response.ok) {
            if (viewer === current) { current.error = response.error; current.layer.render(); }
            else Kit.toast('Skill change failed', { tone: 'danger', detail: response.error, action: { label: 'Download draft', run: download } });
            return;
          }
          if (viewer === current) current.layer.close('saved');
          Kit.toast(removing ? 'Removed local skill installation' : 'Saved skill');
          await load(true);
        }
      });
      if (creating) return;
      const response = await api('/context/skills/read?provider=' + encodeURIComponent(current.provider) + '&id=' + encodeURIComponent(id));
      if (viewer !== current) return;
      current.loading = false;
      if (response.ok) { current.data = response.data; current.draft = response.data.content; current.original = response.data.content; current.editing = editing && Boolean(response.data.canEdit); }
      else current.error = response.error;
      current.layer.render();
    };
    return { content, actions, checkUpdates, setState, install: () => importer.open(provider || chooseDefault()), view: (id, editing = false) => open(id, editing), add: () => { if (inventory?.canCreate) return open(null, true, true); },
      activate: () => { if (!inventory && !loading && !error) load(); },
      refresh: () => load(true),
      toggleBundled: () => {
        hideBundled = !hideBundled;
        try { localStorage.setItem(filterKey, String(hideBundled)); } catch { /* this session only */ }
        render();
      },
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
