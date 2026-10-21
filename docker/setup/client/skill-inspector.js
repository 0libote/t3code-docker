// On-demand text/file inspector. Drafts and async reads belong to one layer.
const T3SkillInspector = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const S = T3SkillModel;
  const disabled = value => value ? raw(' disabled') : '';
  const bytes = value => T3Model.formatBytes(value || 0);
  const code = text => html`<pre class="tc-code" tabindex="0" aria-label="SKILL.md contents">${String(text).split('\n').map(line => html`<span>${line || '\n'}</span>`)}</pre>`;
  const create = ({ api, getLibrary, getStatus, availability, refresh, readMarkdown, downloadMarkdown }) => {
    let active = null;
    const repaint = () => { if (active && !active.layer.closed) active.layer.render(); };
    const open = async (key, editing = false, creating = false) => {
      if (active && !await active.close('replaced')) return;
      const library = getLibrary(), skill = creating ? null : library.rows.find(row => row.key === key);
      if (!creating && !skill) return;
      const targets = S.providers.flatMap(provider => (library.inventories[provider.id]?.creationTargets || []).map(target => ({ ...target, provider: provider.id, value: provider.id + ':' + target.id })));
      if (creating && !targets.length) return;
      const initial = '---\nname: my-skill\ndescription: Describe when to use this skill.\n---\n\nWrite the skill instructions here.\n';
      const view = { key, skill, data: null, creating, editing: editing || creating, draft: creating ? initial : '', original: creating ? initial : '', slug: '',
        target: targets.find(target => library.installed.includes(target.provider))?.value || targets[0]?.value,
        generated: true, loading: !creating, saving: false, error: null, layer: null };
      active = view;
      const row = () => getLibrary().rows.find(row => row.key === key) || skill;
      const detail = () => view.data || row();
      const dirty = () => view.draft !== view.original || (creating && Boolean(view.slug));
      const beforeUnload = event => { if (view.saving || view.editing && dirty()) { event.preventDefault(); event.returnValue = ''; } };
      const filename = () => ((creating ? view.slug : skill.name) || 'skill').replace(/[^a-z0-9-]/gi, '-').slice(0, 64) + '.md';
      const download = () => downloadMarkdown(filename(), view.draft);
      view.close = async reason => {
        if (view.saving) return false;
        if (view.editing && dirty()) {
          const yes = await Kit.confirm({ title: 'Discard this skill draft?', body: 'Your unsaved changes will be lost. You can keep editing and download a copy first.', confirm: 'Discard draft', tone: 'danger' });
          if (!yes || active !== view) return false;
        }
        view.layer.close(reason); return true;
      };
      const renderLocations = () => {
        const file = detail(), status = getStatus(), target = file.resolvedPath || file.path;
        const stateVolume = status?.paths?.stateKind === 'durable' && S.contains(status.paths.state, target);
        const homeVolume = status?.paths?.volumeKind === 'durable' && S.contains(status.paths.volume, target);
        const folder = S.directory(file.path);
        return html`<section class="tc-insp-section"><div class="tc-insp-label">Where it lives</div><dl class="tc-group tc-pathlist">
          <dt>Folder</dt><dd><code>${S.displayPath(folder, library.home)}</code><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-inspect-copy-path aria-label="Copy skill folder path">${icon('copy')}</button></dd>
          ${file.resolvedPath && file.resolvedPath !== file.path ? html`<dt>Linked to</dt><dd><code>${S.displayPath(S.directory(file.resolvedPath), library.home)}</code></dd>` : ''}
          ${stateVolume || homeVolume ? html`<dt>Kept on</dt><dd>${icon('hard-drive', 'tc-icon--sm')}<span>${stateVolume ? 'State volume' : 'Home volume'}, survives a recreate</span></dd>` : ''}
        </dl></section>`;
      };
      const renderOrigin = () => {
        const current = row();
        if (!current?.origin) return '';
        return html`<section class="tc-insp-section"><div class="tc-insp-label">Installed from</div><code class="tc-skill-origin">${current.origin.source}</code><p class="tc-hint">${current.update?.status === 'available' ? 'An update is available. Review the source before replacing this folder, including local edits.' : current.update?.status === 'current' ? 'Installed source snapshot is up to date. Local edits stay in place until you replace this folder.' : current.update?.status === 'error' ? 'Could not check for updates: ' + current.update.error : 'Use Check for updates in the library to check this repository.'}</p><button class="tc-btn tc-btn--sm" type="button" data-inspect-review-source${disabled(view.loading || view.saving)}>${current.update?.status === 'available' ? 'Review update' : 'Review source'}</button></section>`;
      };
      const renderFiles = () => html`<section class="tc-insp-section"><div class="tc-insp-label">Files<span class="tc-spacer"></span><span class="tc-hint">${view.data?.files ? T3Model.plural(view.data.files.length, 'file') : ''}</span></div>
        ${view.loading ? html`<p class="tc-hint">Reading file details…</p>` : view.data?.files ? html`<div class="tc-group"><ul class="tc-files">${view.data.files.map(file => html`<li data-depth="${Math.min(4, file.name.split('/').length - 1)}" title="${file.name}">${icon(file.linked ? 'link' : file.executable ? 'terminal' : 'file-text')}<span class="tc-file-name">${file.name}</span><span class="tc-files-size">${bytes(file.bytes)}</span></li>`)}</ul><div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Scripts are never run here.</span></div></div>` : html`<p class="tc-hint">${view.data?.filesError || (view.data?.removalFiles ? T3Model.plural(view.data.removalFiles, 'file') : 'File details are unavailable.')}</p>`}
      </section>`;
      const renderAvailability = () => {
        const current = row(), installed = getLibrary().installed;
        return html`<section class="tc-insp-section"><div class="tc-insp-label">Available to<span class="tc-spacer"></span><span class="tc-hint">${installed.filter(id => !getLibrary().errors[id] && S.available(current.byProvider[id])).length} of ${installed.length} agents</span></div>
          <div class="tc-group tc-avail">${S.providers.filter(provider => installed.includes(provider.id)).sort((a, b) => Number(Boolean(current.byProvider[b.id])) - Number(Boolean(current.byProvider[a.id]))).map(provider => {
            const found = current.byProvider[provider.id], unavailable = getLibrary().errors[provider.id];
            return html`<div class="tc-avail-row" data-reach="${unavailable ? 'unknown' : found ? 'found' : 'none'}"><span class="tc-tile tc-tile--mark" aria-hidden="true">${raw(T3C.agentMark(provider.id))}</span><div class="tc-row-main"><span class="tc-avail-name">${provider.name}</span>${unavailable ? html`<span class="tc-avail-note">Couldn’t check this agent’s skills</span>` : !found ? html`<span class="tc-avail-note">Not in a folder ${provider.name} reads</span>` : found.effectiveStateText ? html`<span class="tc-avail-note">${found.effectiveStateText}</span>` : ''}</div>
              ${unavailable ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-inspect-rescan${disabled(view.loading || view.saving)}>Rescan</button>` : found ? availability(current, provider.id, true) : html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-inspect-copy-to="${provider.id}"${disabled(view.loading || view.saving)}>Copy to ${provider.name}</button>`}</div>`;
          })}</div><p class="tc-hint">Each setting is the agent’s own and applies to new sessions.</p></section>`;
      };
      const renderEditor = () => html`<section class="tc-insp-section"><div class="tc-editor-toolbar"><label class="tc-insp-label" for="skill-content">SKILL.md</label><div class="tc-editor-tools">
        ${view.editing ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-inspect-upload${disabled(view.loading || view.saving)}>Upload</button><input id="skill-file" type="file" accept=".md,text/markdown" hidden>` : ''}
        <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-inspect-copy aria-label="Copy SKILL.md"${disabled(view.loading || !view.data && !creating)}>${icon('copy')}</button>
        <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-inspect-download aria-label="Download SKILL.md"${disabled(view.loading || !view.data && !creating)}>${icon('download')}</button></div></div>
        ${view.loading ? html`<p class="tc-hint" role="status">Reading SKILL.md…</p>` : view.data || creating ? view.editing ? html`<textarea id="skill-content" data-key="skill-content" class="tc-input tc-input--area tc-editor-area" spellcheck="false" rows="16" aria-describedby="skill-editor-meta"${disabled(view.saving)}>${view.draft}</textarea><div class="tc-editor-meta" id="skill-editor-meta"><span data-editor-bytes>${bytes(new TextEncoder().encode(view.draft).length)}</span><span data-editor-dirty>${dirty() ? 'Unsaved changes' : 'Saved'}</span></div>` : code(view.draft) : ''}</section>`;
      const footer = () => {
        const file = detail();
        if (!creating && !view.data) return html`<span class="tc-hint">${view.loading ? 'Reading skill details…' : 'Rescan to load the current installation.'}</span><span class="tc-spacer"></span><button class="tc-btn" type="button" data-inspect-rescan${disabled(view.loading)}>Rescan library</button>`;
        if (view.editing) return html`<button class="tc-btn tc-btn--ghost" type="button" data-inspect-cancel${disabled(view.saving)}>Cancel</button><span class="tc-spacer"></span><button class="tc-btn tc-btn--primary" type="button" data-inspect-save${disabled(view.loading || view.saving || !creating && !file?.canEdit || creating && !view.slug.trim())}>${view.saving ? 'Saving' : creating ? 'Create skill' : 'Save changes'}</button>`;
        if (file?.readOnlyReason) return html`<span class="tc-hint">${icon('lock', 'tc-icon--sm')}${file.readOnlyReason}</span>`;
        if (Kit.isPhone()) return html`<button class="tc-btn tc-btn--icon" type="button" data-inspect-menu aria-label="Skill actions"${disabled(view.loading)}>${icon('ellipsis')}</button><span class="tc-spacer"></span>${file?.canEdit ? html`<button class="tc-btn" type="button" data-inspect-edit${disabled(view.loading)}>Open SKILL.md</button>` : ''}`;
        return html`${file?.canRemove ? html`<button class="tc-btn tc-btn--danger" type="button" data-inspect-remove${disabled(view.loading || view.saving)}>Remove…</button>` : ''}<span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-inspect-reinstall${disabled(view.loading || view.saving)}>Reinstall from source…</button>${file?.canEdit ? html`<button class="tc-btn tc-btn--primary" type="button" data-inspect-edit${disabled(view.loading || view.saving)}>${Kit.isPhone() ? 'Open SKILL.md' : 'Edit SKILL.md'}</button>` : ''}`;
      };
      view.layer = Kit.open({ kind: 'sheet', returnTo: document.activeElement,
        panel: { class: 'tc-sheet tc-skill-inspector' + (Kit.isPhone() ? ' tc-sheet--bottom' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-view-title' },
        focus: '[data-inspect-close]', backdrop: 'ignore', onEscape: () => { void view.close('escape'); },
        onClose: () => { window.removeEventListener('beforeunload', beforeUnload); if (active === view) active = null; },
        render: () => html`<div class="tc-insp-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('file-text')}</span><div class="tc-insp-title"><h2 id="skill-view-title">${creating ? 'New skill' : skill.name}</h2><div class="tc-insp-meta">${creating ? 'Write instructions for your agents' : html`${skill.groupLabel}<span>·</span>${detail()?.canEdit ? 'Editable' : 'Read-only'}${view.data?.files ? html`<span>·</span>${T3Model.plural(view.data.files.length, 'file')}` : ''}${view.data ? html`<span>·</span>${bytes(view.data.bytes)}` : ''}`}</div></div><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-inspect-close aria-label="Close skill inspector"${disabled(view.saving)}>${icon('x')}</button></div>
          <div class="tc-insp-body" aria-busy="${String(view.loading || view.saving)}">
            ${view.error ? html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div><strong>${view.data || creating ? 'Couldn’t complete this change' : 'Couldn’t read this skill'}</strong><p>${view.error}</p></div></div>` : ''}
            ${creating ? html`<section class="tc-insp-section"><label class="tc-label" for="skill-target">Location</label><select class="tc-select" id="skill-target"${disabled(view.saving)}>${targets.map(target => html`<option value="${target.value}"${target.value === view.target ? raw(' selected') : ''}>${S.nameOf(target.provider)} · ${target.name}</option>`)}</select><p class="tc-hint">Other agents may read this folder too. Shared file changes affect everyone using it.</p><label class="tc-label" for="skill-slug">Folder name</label><input class="tc-input tc-mono" id="skill-slug" data-key="skill-slug" value="${view.slug}" placeholder="my-skill" maxlength="64" spellcheck="false" autocapitalize="none"${disabled(view.saving)}><p class="tc-hint">Lowercase letters, numbers and hyphens. The frontmatter name must match.</p></section>` : html`<p class="tc-insp-desc">${skill.description}</p>${renderAvailability()}${renderOrigin()}${renderLocations()}${renderFiles()}`}
            ${renderEditor()}
          </div><div class="tc-sheet-foot tc-insp-foot">${footer()}</div>` });
      window.addEventListener('beforeunload', beforeUnload);
      const syncEditor = () => {
        const save = view.layer.panel.querySelector('[data-inspect-save]');
        if (save) save.disabled = view.loading || view.saving || (creating && !view.slug.trim());
        const size = view.layer.panel.querySelector('[data-editor-bytes]'); if (size) size.textContent = bytes(new TextEncoder().encode(view.draft).length);
        const changed = view.layer.panel.querySelector('[data-editor-dirty]'); if (changed) changed.textContent = dirty() ? 'Unsaved changes' : 'Saved';
      };
      view.layer.panel.addEventListener('input', event => {
        if (event.target.id === 'skill-content') { view.draft = event.target.value; view.generated = false; }
        if (event.target.id === 'skill-slug') {
          view.slug = event.target.value;
          if (view.generated) { view.draft = initial.replace('name: my-skill', 'name: ' + JSON.stringify(view.slug || 'my-skill')); const field = view.layer.panel.querySelector('#skill-content'); if (field) field.value = view.draft; }
        }
        syncEditor();
      });
      view.layer.panel.addEventListener('change', async event => {
        if (event.target.id === 'skill-target') view.target = event.target.value;
        if (event.target.id !== 'skill-file' || !event.target.files?.[0]) return;
        const file = event.target.files[0]; event.target.value = '';
        view.loading = true; view.error = null; repaint();
        try { const text = await readMarkdown(file); if (active !== view) return; view.draft = text; view.generated = false; }
        catch (error) { if (active !== view) return; view.error = error.message; }
        view.loading = false; repaint();
        const field = view.layer.panel.querySelector('#skill-content'); if (field) field.value = view.draft;
      });
      view.layer.panel.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && view.editing) { event.preventDefault(); view.layer.panel.querySelector('[data-inspect-save]')?.click(); }
      });
      const act = async (action, button) => {
        if (action === 'data-inspect-rescan') { if (await view.close('refresh')) await refresh(); return; }
        if (action === 'data-inspect-menu') {
          Kit.menu(button, { label: 'Skill actions', items: [
            { label: 'Copy path', icon: 'copy', run: () => act('data-inspect-copy-path') },
            { label: 'Download SKILL.md', icon: 'download', run: download },
            { label: 'Reinstall from source…', icon: 'download', run: () => act('data-inspect-reinstall') },
            ...(detail()?.canRemove ? [{ sep: true }, { label: 'Remove…', icon: 'trash-2', danger: true, run: () => act('data-inspect-remove') }] : []),
          ] }); return;
        }
        if ((action === 'data-inspect-close') || (action === 'data-inspect-cancel')) { await view.close('close'); return; }
        if ((action === 'data-inspect-copy')) { Kit.copy(view.draft, button, 'Skill Markdown copied'); return; }
        if ((action === 'data-inspect-download')) { download(); return; }
        if ((action === 'data-inspect-copy-path')) { Kit.copy(S.directory(detail().path), button, 'Skill folder path copied'); return; }
        if ((action === 'data-inspect-upload')) { view.layer.panel.querySelector('#skill-file').click(); return; }
        if ((action === 'data-inspect-edit')) { view.editing = true; repaint(); view.layer.panel.querySelector('#skill-content')?.focus(); return; }
        if (action === 'data-inspect-review-source') {
          const current = row();
          if (await view.close('review-source')) getLibrary().install({ source: current.origin.source, names: [current.origin.name], agents: [current.provider], step: 2, mode: 'each' });
          return;
        }
        if ((action === 'data-inspect-copy-to') || (action === 'data-inspect-reinstall')) {
          const agent = action === 'data-inspect-copy-to' ? button.getAttribute('data-inspect-copy-to') : null;
          if (!await view.close('copy')) return;
          getLibrary().install({ source: agent ? S.directory(detail().path) : detail().packageSource || '', names: agent ? [skill.name] : undefined, agents: agent ? [agent] : undefined, step: agent ? 2 : 1 }); return;
        }
        const remove = (action === 'data-inspect-remove');
        if (!remove && !(action === 'data-inspect-save') || view.saving || view.loading) return;
        if (remove) {
          const yes = await Kit.confirm({ title: 'Remove ' + skill.name + '?', body: view.data.removalKind === 'directory' ? 'Removes this local skill folder and its supporting files. Other agents using this folder lose it too.' : view.data.removalLinkedTarget ? 'Removes this installation entry. Linked target files are kept.' : 'Removes this Markdown file. Other files stay in place.', consequences: [{ icon: 'trash-2', text: view.data.removalPath }], confirm: 'Remove skill', tone: 'danger' });
          if (!yes || active !== view) return;
        }
        view.saving = true; view.error = null; repaint();
        const [provider, target] = creating ? view.target.split(':') : [skill.provider];
        const response = await api('/context/skills/' + (remove ? 'remove' : creating ? 'create' : 'save'), { body: { provider, id: creating ? undefined : skill.byProvider[provider].id, target, slug: view.slug, content: view.draft, revision: view.data?.revision, removalRevision: view.data?.removalRevision } });
        view.saving = false;
        if (!response.ok) { view.error = response.error; repaint(); return; }
        view.editing = false; view.layer.close('saved');
        Kit.toast(remove ? 'Removed local skill installation' : creating ? 'Created skill' : 'Saved SKILL.md');
        await refresh();
      };
      view.layer.panel.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const action = Array.from(button.attributes).find(attribute => attribute.name.startsWith('data-inspect-'))?.name;
        if (action) void act(action, button);
      });
      if (creating) return;
      const response = await api('/context/skills/read?provider=' + encodeURIComponent(skill.provider) + '&id=' + encodeURIComponent(skill.byProvider[skill.provider].id));
      if (active !== view || view.layer.closed) return;
      view.loading = false;
      if (response.ok) { view.data = response.data; view.draft = view.original = response.data.content; view.editing = editing && Boolean(response.data.canEdit); }
      else { view.error = response.error; view.editing = false; }
      repaint();
      if (view.editing) view.layer.panel.querySelector('#skill-content')?.focus();
    };
    return { open, repaint, close: reason => active ? active.close(reason) : true };
  };
  return { create, code };
})();
