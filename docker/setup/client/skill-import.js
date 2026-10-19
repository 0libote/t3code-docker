// Source content remains text. Only the reviewed server snapshot can be installed.
const T3SkillImport = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const create = ({ api, providers, refresh }) => {
    let active = null;
    const open = (provider, initial = null) => {
      if (active) return;
      const view = { source: '', catalogSearch: '', preview: null, plan: null, result: null, skills: new Set(), providers: new Set([provider]), busy: null, error: null, replace: false, layer: null };
      active = view;
      const disabled = (value) => value ? raw(' disabled') : '';
      const checked = (value) => value ? raw(' checked') : '';
      const bytes = (size) => size < 1024 ? size + ' B' : (size / 1024).toFixed(1) + ' KiB';
      const discard = async (previewId) => {
        if (previewId) await api('/context/skills/discard', { body: { previewId } });
      };
      const render = (step = false) => {
        if (view.layer.closed) return;
        view.layer.render();
        if (step) {
          view.layer.panel.querySelector('.tc-sheet-body').scrollTop = 0;
          view.layer.panel.querySelector(view.error ? '#skill-import-error' : '#skill-import-title').focus({ preventScroll: true });
        } else if (!view.layer.panel.contains(document.activeElement) || document.activeElement.matches(':disabled')) {
          // Disabling the initiating control must not leave focus outside the dialog.
          view.layer.panel.focus({ preventScroll: true });
        }
      };
      const close = () => { if (view.busy !== 'install') view.layer.close('close'); };
      const request = async (route, body, discardId) => {
        if (view.busy || view.layer.closed) return null;
        view.busy = route; view.error = null; render();
        try {
          await discard(discardId);
          if (view.layer.closed) return null;
          const response = await api('/context/skills/' + route, { body });
          if (view.layer.closed) {
            // A dismissed read may finish later. Release its snapshot without
            // updating a newer dialog or stealing its keyboard focus.
            await discard(route === 'source' ? response.data?.previewId : view.preview?.previewId);
            return null;
          }
          if (!response.ok) view.error = response.error;
          return response.ok ? response.data : null;
        } finally { view.busy = null; }
      };
      const preview = async (source) => {
        if (view.busy || view.layer.closed) return;
        const previous = view.preview?.previewId;
        view.source = source; view.catalogSearch = ''; view.preview = null; view.plan = null; view.result = null;
        view.skills.clear();
        // Kit preserves typed input values during renders. An explicit catalog
        // or example selection must also update that live value.
        const input = view.layer.panel.querySelector('#skill-source');
        if (input && input.value !== source) input.value = source;
        const result = await request('source', { source }, previous);
        if (result) { view.preview = result; view.skills = new Set(initial?.name ? result.skills.filter((skill) => skill.name === initial.name).map((skill) => skill.name) : result.skills.length === 1 ? result.skills.map((skill) => skill.name) : []); }
        render(true);
      };
      view.layer = Kit.open({ kind: 'center', panel: { class: 'tc-sheet tc-context-sheet tc-skill-sheet tc-skill-import ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-import-title' }, focus: '#skill-source', backdrop: 'ignore', onEscape: close,
        onClose: () => { active = null; void discard(view.preview?.previewId); },
        render: () => html`<div class="tc-sheet-head"><span class="tc-tile tc-tile--icon tc-tile--lg" aria-hidden="true">${icon('download')}</span><div class="tc-sheet-head-text"><h3 class="tc-sheet-title" id="skill-import-title" tabindex="-1">${view.result ? 'Installation results' : view.plan ? 'Review destinations' : 'Install from source'}</h3><span class="tc-small tc-muted">${view.result ? 'Check each destination below' : view.plan ? 'Confirm where skills will be installed' : view.preview?.skills?.length ? 'Choose skills and providers' : 'Preview skills before installing'}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-import-close aria-label="Close"${disabled(view.busy === 'install')}>${icon('x')}</button></div>
          <div class="tc-sheet-body" aria-busy="${String(Boolean(view.busy))}">
            ${view.error ? html`<p class="tc-danger" role="alert" id="skill-import-error" tabindex="-1">${view.error}</p>` : ''}
            ${!view.plan && !view.result ? html`<label class="tc-label" for="skill-source">Repository, skill link or folder</label><input class="tc-input" id="skill-source" data-key="skill-source" value="${view.source}" placeholder="owner/repo or https://…" maxlength="2048" autocapitalize="none" spellcheck="false"${disabled(view.busy)}>
              <p class="tc-hint">GitHub/GitLab, SSH Git URLs, skills.sh links, direct SKILL.md links, or an absolute folder path inside the container. You can also paste a skills add command.</p>
              <p class="tc-hint">Find skills on <a href="https://agenticskills.io/skills" target="_blank" rel="noopener noreferrer">AgenticSkills</a>, <a href="https://skills.sh" target="_blank" rel="noopener noreferrer">skills.sh</a> or <button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-import-example${disabled(view.busy)}>vercel-labs/skills</button>.</p>
              ${(view.preview?.warnings || []).map((warning) => html`<p class="tc-hint tc-warning">${warning}</p>`)}
              ${view.preview?.links?.length ? html`<label class="tc-label" for="skill-catalog-search">Find a skill or repository</label><input class="tc-input" id="skill-catalog-search" data-key="skill-catalog-search" value="${view.catalogSearch}" type="search" placeholder="Search these links…"${disabled(view.busy)}><div class="tc-import-options">${view.preview.links.map((link, index) => ({ ...link, index })).filter((link) => link.label.toLowerCase().includes(view.catalogSearch.toLowerCase())).map((link) => html`<button class="tc-btn tc-btn--ghost" type="button" data-import-link="${link.index}"${disabled(view.busy)}>${link.label}</button>`)}</div>` : ''}
              ${view.preview?.skills?.length ? html`<fieldset class="tc-import-options"${disabled(view.busy)}><legend class="tc-label">Skills to install</legend>${view.preview.skills.map((skill) => html`<div class="tc-import-skill"><label><input type="checkbox" data-import-skill="${skill.name}"${checked(view.skills.has(skill.name))}> <strong>${skill.name}</strong></label><p class="tc-hint">${skill.description}</p><details><summary class="tc-hint">Review ${skill.files.length} ${skill.files.length === 1 ? 'file' : 'files'} · ${bytes(skill.bytes)}</summary><ul class="tc-hint">${skill.files.map((file) => html`<li><code>${file.name}</code> · ${bytes(file.bytes)}${file.executable ? ' · executable' : ''}</li>`)}</ul><pre class="tc-import-markdown">${skill.content}</pre></details></div>`)}</fieldset>
                <fieldset class="tc-import-options tc-import-providers"${disabled(view.busy)}><legend class="tc-label">Providers</legend>${providers.map(([id, name]) => html`<label><input type="checkbox" data-import-provider="${id}"${checked(view.providers.has(id))}> ${name}</label>`)}</fieldset>
                <p class="tc-hint">Installs a local copy in each selected provider’s global folder. Compatibility discovery and shared folder links can make it visible to other providers too. Direct Markdown links import only that file; use a repository or folder for supporting files. Existing availability settings are kept. Review instructions and supporting files from sources you trust.</p>` : ''}
            ` : ''}
            ${view.plan && !view.result ? html`<p class="tc-hint">${view.source}</p><div class="tc-import-options">${view.plan.destinations.map((entry) => html`<div class="tc-import-skill"><strong>${providers.find(([id]) => id === entry.provider)?.[1]} · ${entry.name}</strong><p class="tc-hint">${entry.action === 'blocked' ? entry.error : entry.action === 'replace' ? 'Replace existing local skill folder and supporting files' : 'Add skill folder'}</p>${entry.directory ? html`<code>${entry.directory}</code>` : ''}${entry.also?.length ? html`<p class="tc-hint">Same folder also used by ${entry.also.map((id) => providers.find(([key]) => key === id)?.[1]).join(', ')}</p>` : ''}</div>`)}</div>
              ${view.plan.destinations.some((entry) => entry.action === 'replace') ? html`<label class="tc-import-confirm"><input type="checkbox" data-import-replace${checked(view.replace)}${disabled(view.busy)}> Replace the listed existing folders, including local edits and supporting files.</label>` : ''}
              <p class="tc-hint">Installs the exact previewed contents. The source is not fetched again. Start a new conversation to load changes; provider policies may still restrict use.</p>` : ''}
            ${view.result ? html`<div class="tc-import-options" role="status">${view.result.results.map((entry) => html`<div class="tc-import-skill"><strong>${entry.name} · ${providers.find(([id]) => id === entry.provider)?.[1]}</strong><p class="${entry.status === 'failed' ? 'tc-danger' : 'tc-hint'}">${entry.status === 'failed' ? entry.error : 'Installed'}${entry.warning ? ' · ' + entry.warning : ''}</p><code>${entry.directory}</code></div>`)}</div><p class="tc-hint">Start a new conversation to load installed skills. Availability is checked in the provider inventory where supported. Repository installs remember their source. Use Check for updates in the skill list, then review the source before replacing an installation.</p>` : ''}
            ${view.busy ? html`<p class="tc-muted" role="status"><span class="tc-spinner" aria-hidden="true"></span>${view.busy === 'install' ? 'Installing…' : view.busy === 'plan' ? 'Checking destinations…' : 'Reading source… You can close this dialog while it finishes.'}</p>` : ''}
          </div><div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-import-close${disabled(view.busy === 'install')}>${view.result ? 'Done' : 'Close'}</button>${view.plan && !view.result ? html`<button class="tc-btn" type="button" data-import-back${disabled(view.busy)}>Back</button><button class="tc-btn tc-btn--primary" type="button" data-import-install${disabled(view.busy || !view.plan.canInstall || (view.plan.destinations.some((entry) => entry.action === 'replace') && !view.replace))}>${view.busy ? 'Installing…' : 'Install skills'}</button>` : !view.result ? html`<button class="tc-btn" type="button" data-import-preview${disabled(view.busy || !view.source.trim())}>Preview source</button>${view.preview?.skills?.length ? html`<button class="tc-btn tc-btn--primary" type="button" data-import-review${disabled(view.busy || !view.skills.size || !view.providers.size)}>Review destinations</button>` : ''}` : ''}</div>`,
      });
      const syncButtons = () => {
        const previewButton = view.layer.panel.querySelector('[data-import-preview]'); if (previewButton) previewButton.disabled = view.busy || !view.source.trim();
        const review = view.layer.panel.querySelector('[data-import-review]'); if (review) review.disabled = view.busy || !view.skills.size || !view.providers.size;
        const install = view.layer.panel.querySelector('[data-import-install]'); if (install) install.disabled = view.busy || !view.plan.canInstall || (view.plan.destinations.some((entry) => entry.action === 'replace') && !view.replace);
      };
      view.layer.panel.addEventListener('input', (event) => {
        if (event.target.id === 'skill-catalog-search') { view.catalogSearch = event.target.value; view.layer.render(); }
        if (event.target.id === 'skill-source') {
          view.source = event.target.value;
          // A changed source must be previewed again before it can be reviewed.
          if (view.preview) { const old = view.preview.previewId; view.preview = null; view.skills.clear(); if (old) void api('/context/skills/discard', { body: { previewId: old } }); view.layer.render(); }
          syncButtons();
        }
      });
      view.layer.panel.addEventListener('change', (event) => {
        for (const [attribute, selected] of [['data-import-skill', view.skills], ['data-import-provider', view.providers]]) if (event.target.hasAttribute(attribute)) {
          const key = event.target.getAttribute(attribute); event.target.checked ? selected.add(key) : selected.delete(key);
        }
        if (event.target.hasAttribute('data-import-replace')) view.replace = event.target.checked;
        syncButtons();
      });
      view.layer.panel.addEventListener('keydown', (event) => { if (event.target.id === 'skill-source' && event.key === 'Enter') { event.preventDefault(); if (view.source.trim() && !view.busy) void preview(view.source); } });
      view.layer.panel.addEventListener('click', async (event) => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.hasAttribute('data-import-close')) { close(); return; }
        if (view.busy) return;
        if (button.hasAttribute('data-import-back')) { view.plan = null; view.replace = false; view.error = null; render(true); }
        else if (button.hasAttribute('data-import-example')) await preview('https://github.com/vercel-labs/skills');
        else if (button.hasAttribute('data-import-link')) await preview(view.preview.links[Number(button.getAttribute('data-import-link'))].source);
        else if (button.hasAttribute('data-import-preview')) await preview(view.source);
        else if (button.hasAttribute('data-import-review')) { view.plan = await request('plan', { previewId: view.preview.previewId, skills: [...view.skills], providers: [...view.providers] }); view.replace = false; render(true); }
        else if (button.hasAttribute('data-import-install')) {
          view.result = await request('install', { previewId: view.preview.previewId, planId: view.plan.planId, replace: view.replace });
          render(true); if (view.result) await refresh();
        }
      });
      if (initial?.source) void preview(initial.source);
    };
    return { open };
  };
  return { create };
})();
