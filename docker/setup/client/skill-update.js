// Review and replace one existing installation. The server owns its target,
// source snapshot and conflict token; the UI never chooses a replacement path.
const T3SkillUpdate = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const disabled = value => value ? raw(' disabled') : '';
  const create = ({ api, refresh, home, showInLibrary }) => {
    let active = null;
    const close = () => {
      if (active?.saving) { Kit.announce('Wait for the skill update to finish'); return false; }
      active?.layer.close('close'); return true;
    };
    const open = (provider, id) => {
      if (active && !active.layer.closed) { active.layer.panel.focus(); return; }
      const view = { provider, id, data: null, loading: false, saving: false, consent: false, error: null, retryResult: false, result: null, expired: false, timer: null, layer: null };
      active = view;
      const busy = () => view.loading || view.saving;
      const done = () => view.result?.status === 'installed';
      const paint = () => { if (active === view) view.layer.render(); };
      const discard = previewId => previewId && api('/context/skills/discard', { body: { previewId } });
      const beforeUnload = event => { if (view.saving) { event.preventDefault(); event.returnValue = ''; } };
      const displayPath = value => T3SkillModel.displayPath(value, home());
      const focusError = () => view.layer.panel.querySelector('[data-update-error]')?.focus();
      const load = async () => {
        if (busy()) return;
        const prior = view.data?.previewId;
        clearTimeout(view.timer);
        view.loading = true; view.data = null; view.error = null; view.result = null; view.consent = false; view.retryResult = false; view.expired = false; paint();
        await discard(prior);
        if (active !== view) return;
        const response = await api('/context/skills/update/preview', { body: { provider, id } });
        if (active !== view) { await discard(response.data?.previewId); return; }
        view.loading = false;
        if (!response.ok) view.error = response.error;
        else {
          view.data = response.data;
          const duration = Math.max(0, Math.min(600000, response.data.expiresAt - response.data.createdAt));
          view.expired = duration === 0;
          view.timer = setTimeout(() => { if (active === view && !view.saving && !done() && !view.retryResult) { view.expired = true; view.consent = false; paint(); } }, duration);
        }
        paint(); if (view.error) focusError();
      };
      const compare = () => {
        if (!view.data || busy()) return;
        let side = 'after';
        const layer = Kit.open({ kind: 'center', panel: { class: 'tc-sheet tc-sheet--inset tc-context-sheet tc-skill-compare', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-compare-title' },
          backdrop: 'close', render: () => html`<div class="tc-sheet-head"><h3 class="tc-sheet-title" id="skill-compare-title">SKILL.md</h3><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-compare-close aria-label="Close instruction comparison">${icon('x')}</button></div>
            <div class="tc-sheet-body"><div class="tc-seg" role="group" aria-label="Instruction version"><button type="button" data-compare-side="before" aria-pressed="${String(side === 'before')}">Installed</button><button type="button" data-compare-side="after" aria-pressed="${String(side === 'after')}">Incoming</button></div>${T3SkillInspector.code(view.data.markdown[side], side === 'before' ? 'Installed instructions' : 'Incoming instructions')}</div>` });
        layer.panel.addEventListener('click', event => {
          const button = event.target.closest('button'); if (!button) return;
          if (button.hasAttribute('data-compare-close')) layer.close('close');
          else if (button.dataset.compareSide) { side = button.dataset.compareSide; layer.render(); }
        });
      };
      const renderTarget = () => {
        const target = view.data.target, readers = target.readers.map(T3SkillModel.nameOf);
        return html`<section class="tc-update-section"><h3 class="tc-insp-label">Update in place</h3><div class="tc-group tc-update-target"><div class="tc-update-location">${icon(target.linked ? 'link' : 'folder')}<div><code>${displayPath(target.directory)}</code>${target.linked ? html`<span class="tc-hint">Linked to <code>${displayPath(target.resolvedDirectory)}</code>. The link is kept.</span>` : ''}</div></div>
          <div class="tc-update-readers"><span class="tc-small tc-muted">Global folders read by</span><div>${target.readers.map(agent => html`<span class="tc-update-agent"><span class="tc-tile tc-tile--mark tc-tile--xs" aria-hidden="true">${raw(T3C.agentMark(agent))}</span>${T3SkillModel.nameOf(agent)}</span>`)}</div></div></div><p class="tc-plan-note">${readers.length > 1 ? 'Every agent reading this folder receives the same update. ' : ''}Availability settings are kept. Changes apply to new sessions.</p></section>`;
      };
      const renderChanges = () => {
        const data = view.data, summary = data.summary, changed = data.changes.filter(file => file.status !== 'unchanged');
        const row = file => html`<li data-update-status="${file.status}"><span class="tc-update-file-icon" aria-hidden="true">${icon(file.status === 'removed' ? 'trash-2' : file.status === 'added' ? 'plus' : 'file-text')}</span><div><code>${file.name}</code>${file.before?.linked ? html`<span class="tc-hint">Linked file · target contents are kept</span>` : file.before && file.after && file.before.executable !== file.after.executable ? html`<span class="tc-hint">${file.after.executable ? 'Becomes executable' : 'No longer executable'}</span>` : ''}</div><span class="tc-update-file-status">${{ added: 'Added', modified: 'Changed', removed: 'Removed', unchanged: 'Unchanged' }[file.status]}</span></li>`;
        return html`<section class="tc-update-section"><div class="tc-insp-label">File changes<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-update-compare${disabled(busy())}>${icon('file-text')}Compare instructions</button></div>
          <div class="tc-update-counts" aria-label="Change summary">${[['modified', 'changed'], ['added', 'added'], ['removed', 'removed']].map(([key, label]) => html`<span data-change-kind="${key}"><strong>${summary[key]}</strong>${label}</span>`)}</div>
          ${changed.length ? html`<ul class="tc-group tc-update-files" aria-label="Files that will change" tabindex="0">${changed.map(row)}</ul>` : html`<p class="tc-hint">${data.canUpdate ? 'Your files already match this repository snapshot.' : 'This skill already matches its repository source.'}</p>`}
          ${summary.unchanged ? html`<details class="tc-update-unchanged" data-key="update-unchanged"><summary>${T3Model.plural(summary.unchanged, 'unchanged file')}</summary><ul class="tc-group tc-update-files" aria-label="Unchanged files" tabindex="0">${data.changes.filter(file => file.status === 'unchanged').map(row)}</ul></details>` : ''}</section>`;
      };
      const contents = () => html`<div class="tc-sheet-head tc-update-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(done() ? 'circle-check' : 'refresh-cw')}</span><div><h2 class="tc-sheet-title" id="skill-update-title">${done() ? 'Skill updated' : 'Review skill update'}</h2><p class="tc-hint">${view.data?.name || 'Check the source before replacing an installed skill.'}</p></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-update-close aria-label="Close skill update"${disabled(view.saving)}>${icon('x')}</button></div>
        <div class="tc-sheet-body tc-update-body" aria-busy="${String(busy())}">
          ${view.loading ? html`<div class="tc-update-loading" role="status"><span class="tc-spinner" aria-hidden="true"></span><div><strong>Checking the repository</strong><span>Comparing its files with this installation…</span></div></div>` : ''}
          ${view.error ? html`<div class="tc-notice tc-notice--danger" role="alert" tabindex="-1" data-update-error>${icon('triangle-alert')}<div class="tc-notice-body"><span class="tc-notice-title">${view.retryResult ? 'The update result isn’t confirmed' : 'Couldn’t complete this update'}</span><span class="tc-notice-desc">${view.error}</span></div></div>` : ''}
          ${view.data ? html`${done() ? html`<div class="tc-update-success" role="status">${icon('circle-check')}<div><strong>The reviewed files are now installed</strong><span>The skill stayed in its existing folder.${view.result.warning ? ' ' + view.result.warning : ''}</span></div></div>` : html`<div class="tc-update-source"><span class="tc-small tc-muted">Repository source</span><code>${view.data.source}</code>${view.data.sourceInfo?.commit ? html`<span class="tc-hint">${view.data.sourceInfo.ref || 'HEAD'} · <code title="${view.data.sourceInfo.commit}">${view.data.sourceInfo.commit.slice(0, 7)}</code></span>` : ''}</div>`}
            ${renderTarget()}${!done() ? html`${renderChanges()}${(view.data.warnings || []).map(warning => html`<p class="tc-hint tc-warning">${warning}</p>`)}
              ${view.data.localChanges ? html`<div class="tc-notice tc-notice--warn" role="status">${icon('triangle-alert')}<div class="tc-notice-body"><span class="tc-notice-title">Local edits will be replaced</span><span class="tc-notice-desc">This folder differs from its installed source snapshot. Keep a copy of any changes you want before updating.</span></div></div>` : ''}
              ${view.expired ? html`<p class="tc-hint" role="status">This review expired. Review again to check the current files.</p>` : ''}
              ` : ''}` : ''}
        </div><div class="tc-sheet-foot tc-update-foot">${view.data?.canUpdate && !done() && !view.expired && !view.error ? html`<label class="tc-update-consent"><input class="tc-checkbox" type="checkbox" data-update-consent${view.consent ? raw(' checked') : ''}${disabled(busy())}><span><strong>Replace this skill folder</strong><span>Incoming files replace its contents, including local edits and removed files.</span></span></label>` : ''}<div class="tc-update-foot-actions"><button class="tc-btn tc-btn--ghost" type="button" data-update-close${disabled(view.saving)}>${done() ? 'Done' : 'Cancel'}</button><span class="tc-spacer"></span>
          ${done() ? html`<button class="tc-btn tc-btn--primary" type="button" data-update-show>Show in library</button>` : view.error || view.expired ? html`<button class="tc-btn tc-btn--primary" type="button" ${view.retryResult ? raw('data-update-retry') : raw('data-update-review')}${disabled(busy())}>${view.retryResult ? 'Check result' : 'Review again'}</button>` : view.data?.canUpdate ? html`<button class="tc-btn tc-btn--primary" type="button" data-update-save${disabled(busy() || !view.consent)}>${view.saving ? html`<span class="tc-spinner" aria-hidden="true"></span>Updating…` : 'Update skill'}</button>` : view.data ? html`<button class="tc-btn" type="button" data-update-review>Check again</button>` : ''}</div></div>`;
      view.layer = Kit.open({ kind: 'center', returnTo: document.activeElement,
        panel: { class: 'tc-sheet tc-sheet--inset tc-context-sheet tc-skill-update', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-update-title' },
        focus: '[data-update-close]', backdrop: 'ignore', onEscape: close, render: contents,
        onClose: () => { clearTimeout(view.timer); window.removeEventListener('beforeunload', beforeUnload); if (active === view) active = null; void discard(view.data?.previewId); } });
      window.addEventListener('beforeunload', beforeUnload);
      const save = async () => {
        if (busy() || done() || !view.data || !view.retryResult && (!view.consent || view.expired || view.error)) return;
        view.saving = true; view.error = null; clearTimeout(view.timer); paint();
        const response = await api('/context/skills/update', { body: { previewId: view.data.previewId, planId: view.data.planId, replace: true } });
        if (active !== view) return;
        view.saving = false; view.retryResult = false;
        const result = response.data?.results?.[0];
        if (response.ok && result?.status === 'installed') {
          view.result = result; Kit.announce('Updated ' + view.data.name); paint();
          await refresh();
        } else {
          view.error = response.error || result?.error || 'The update could not be verified. Review the current installation before continuing.';
          view.retryResult = !response.ok && (!response.status || response.status >= 500);
          view.consent = false; paint(); focusError();
        }
      };
      view.layer.panel.addEventListener('change', event => { if (event.target.hasAttribute('data-update-consent') && !busy() && !view.error) { view.consent = event.target.checked; paint(); } });
      view.layer.panel.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.hasAttribute('data-update-close')) close();
        else if (button.hasAttribute('data-update-review')) void load();
        else if (button.hasAttribute('data-update-save') || button.hasAttribute('data-update-retry')) void save();
        else if (button.hasAttribute('data-update-compare')) compare();
        else if (button.hasAttribute('data-update-show') && done()) { const key = view.data.target.resolvedDirectory + '/SKILL.md'; view.layer.close('library'); showInLibrary(key); }
      });
      void load();
    };
    return { open, close };
  };
  return { create };
})();
