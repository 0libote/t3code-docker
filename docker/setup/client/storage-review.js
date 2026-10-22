// A fresh, server-owned cleanup plan. Closing a review never starts work;
// accepted jobs continue in Storage and can be inspected without resubmitting.
const T3StorageReview = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const disabled = (value) => value ? raw(' disabled') : '';
  const mark = (row) => row.icon && T3C.agentMarks[row.icon] ? raw(T3C.agentMark(row.icon)) : icon(T3C.icons[row.icon] ? row.icon : 'hard-drive');
  const create = ({ api, run, view, isBusy }) => {
    let active = null;
    const open = (ids, { operation = null } = {}) => {
      if (active && !active.layer.closed) { active.layer.panel.focus(); return; }
      if (isBusy() && !operation) return;
      const state = { ids: [...ids], plan: null, selected: new Set(), loading: true, failure: null, sequence: 0,
        submitting: false, operation, expiry: null, expired: false, layer: null };
      if (operation) { state.loading = false; state.plan = { caches: view().cacheRows }; }
      active = state;
      const selected = () => state.plan?.caches.filter((cache) => cache.eligible && state.selected.has(cache.id)) || [];
      const rows = () => state.plan?.caches || [];
      const closeLabel = () => state.operation?.state === 'running' ? 'Continue in background' : state.operation ? 'Done' : 'Cancel';
      const contents = () => {
        const op = state.operation, running = op?.state === 'running', finished = op && !running;
        const choice = selected(), bytes = choice.reduce((sum, row) => sum + row.bytes, 0);
        const ordered = [...rows()].sort((a, b) => Number(b.eligible) - Number(a.eligible));
        const completed = op?.completedIds?.length || 0, total = op?.ids?.length || 0;
        const success = op?.state === 'succeeded';
        return html`
          <div class="tc-storage-dialog-head"><div><h2 class="tc-dialog-title" id="storage-cleanup-title">${finished ? success ? 'Cleanup finished' : 'Cleanup needs attention' : running ? 'Cleaning up caches' : 'Review cache cleanup'}</h2>
            <p class="tc-dialog-desc" id="storage-cleanup-help">${op ? running ? 'You can close this review. Cleanup will continue in the background.' : success ? 'Your projects, installed dependencies and sign-ins are kept.' : 'Completed caches are kept in the result. Review the remaining caches before trying again.' : 'Choose the cached data to remove. Locations and tool activity are checked again before cleanup.'}</p></div>
            <button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-cleanup-close aria-label="Close cleanup review"${disabled(state.submitting)}>${icon('x')}</button></div>
          <div class="tc-storage-dialog-scroll">
            ${state.loading ? html`<div class="tc-storage-plan-loading" role="status"><span class="tc-spinner" aria-hidden="true"></span><div><strong>Checking your caches</strong><span>Reading current sizes, locations and tool activity…</span></div></div>` : ''}
            ${state.failure ? html`<div class="tc-storage-notice tc-storage-notice--danger" role="alert" tabindex="-1" data-cleanup-error>${icon('triangle-alert')}<div><strong>Couldn’t finish this review</strong><p>${state.failure}</p></div></div>` : ''}
            ${state.plan && !op ? html`
              <div class="tc-storage-plan-summary"><div><span class="tc-small tc-muted">Cached data selected</span><strong>${T3Model.formatBytes(bytes)}</strong></div><span class="tc-small tc-muted">${T3Model.plural(choice.length, 'cache')} selected</span></div>
              <p class="tc-storage-plan-note">Space recovered can be smaller when cached files are shared with installed projects.</p>
              <div class="tc-storage-plan-list" role="group" aria-label="Caches to clean">${ordered.map((row, index) => html`
                ${!row.eligible && (index === 0 || ordered[index - 1].eligible) ? html`<div class="tc-storage-plan-kept">Kept automatically</div>` : ''}
                <div class="tc-storage-plan-row" data-key="cleanup-row-${row.id}"${row.eligible ? '' : raw(' data-kept')}>
                  <div class="tc-storage-plan-choice">
                    ${row.eligible ? html`<input class="tc-checkbox" type="checkbox" id="cleanup-${row.id}" data-cleanup-id="${row.id}" aria-labelledby="cleanup-label-${row.id}"${state.selected.has(row.id) ? raw(' checked') : ''}${disabled(state.submitting)}>` : html`<span class="tc-storage-plan-lock" aria-hidden="true">${icon(row.status === 'empty' ? 'check' : row.status === 'busy' ? 'clock' : 'shield-check', 'tc-icon--sm')}</span>`}
                    <span class="tc-tile tc-tile--sm" aria-hidden="true">${mark(row)}</span>
                    ${row.eligible ? html`<label class="tc-storage-plan-main tc-storage-plan-label" for="cleanup-${row.id}"><span class="tc-row-name" id="cleanup-label-${row.id}">${row.label}</span><span class="tc-small tc-muted">${row.cleanupHint || row.effect}</span></label>` : html`<div class="tc-storage-plan-main"><span class="tc-row-name" id="cleanup-label-${row.id}">${row.label}</span><span class="tc-small tc-muted">${row.reason}</span></div>`}
                    <span class="tc-storage-size">${T3Model.formatBytes(row.bytes)}</span>
                  </div>
                  ${!row.eligible && row.status !== 'empty' ? html`<p class="tc-storage-plan-effect">${row.detail}</p>` : ''}
                </div>`)}</div>
              <details class="tc-storage-technical tc-storage-plan-locations" data-key="cleanup-locations"><summary>Locations and cleanup behavior</summary>${rows().map((row) => html`<div class="tc-storage-location-item"><strong>${row.label}</strong><p>${row.effect}</p><code>${row.path || 'Location unavailable'}</code></div>`)}</details>
              ${state.expired && !state.failure ? html`<div class="tc-storage-notice" role="status">${icon('clock')}<div><strong>This review has expired</strong><p>Check the current locations and tool activity before continuing.</p></div></div>` : !choice.length && !state.failure ? html`<p class="tc-storage-plan-note" role="status">${rows().some((row) => row.eligible) ? 'Choose at least one cache to continue.' : 'Nothing can be cleaned in this review. The reasons above explain what is being kept.'}</p>` : ''}
            ` : ''}
            ${op ? html`
              <div class="tc-storage-result-summary" role="status"><span class="tc-storage-result-mark"${!running && !success ? raw(' data-danger') : ''}>${running ? html`<span class="tc-spinner" aria-hidden="true"></span>` : icon(success ? 'circle-check' : 'triangle-alert')}</span>
                <div><strong>${running ? 'Working through your selection' : success ? T3Model.formatBytes(op.removedCacheBytes ?? 0) + ' of cached data removed' : T3Model.plural(completed, 'cache') + ' cleaned before stopping'}</strong>
                  <span>${running ? completed + ' of ' + total + ' caches complete' : success ? 'Check the disk meter for current available space.' : op.error || 'Refresh storage, then review the remaining caches.'}</span></div></div>
              <ol class="tc-storage-cleanup-steps" aria-label="Cleanup progress">${(op.ids || []).map((id) => {
                const row = rows().find((cache) => cache.id === id), done = op.completedIds?.includes(id), current = running && op.phase === id;
                return html`<li data-key="cleanup-step-${id}"><span aria-hidden="true">${done ? icon('check', 'tc-icon--sm') : current ? html`<span class="tc-spinner" aria-hidden="true"></span>` : icon('clock', 'tc-icon--sm')}</span><span>${row?.label || id}</span><span class="tc-small tc-muted">${done ? 'Cleaned' : current ? 'Cleaning…' : running ? 'Waiting' : 'Not completed'}</span></li>`;
              })}</ol>
              ${success && Object.values(op.cacheResults || {}).some((size) => size > 0) ? html`<p class="tc-storage-plan-note">Some cache data remains. Pruning keeps entries that are still needed; there is no need to run the same cleanup again.</p>` : ''}
            ` : ''}
          </div>
          <div class="tc-storage-dialog-foot"><button class="tc-btn tc-btn--ghost" type="button" data-cleanup-close${disabled(state.submitting)}>${closeLabel()}</button>
            ${op && !running && !success ? html`<button class="tc-btn tc-btn--primary" type="button" data-cleanup-remaining>Review remaining</button>` : !op && (state.expired || state.failure) ? html`<button class="tc-btn tc-btn--primary" type="button" data-cleanup-recheck>${state.failure ? 'Try again' : 'Check again'}</button>` : !op ? html`<button class="tc-btn tc-btn--primary" type="button" data-cleanup-confirm${disabled(state.loading || state.submitting || !choice.length)}>${state.submitting ? html`<span class="tc-spinner" aria-hidden="true"></span>Starting cleanup…` : 'Clean up ' + (choice.length === 1 ? 'cache' : choice.length + ' caches')}</button>` : ''}</div>`;
      };
      const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-storage-cleanup', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'storage-cleanup-title', 'aria-describedby': 'storage-cleanup-help' },
        focus: '[data-cleanup-close]', backdrop: 'ignore', render: contents,
        onEscape: () => { if (!state.submitting) layer.close('escape'); },
        onClose: () => { clearTimeout(state.expiry); if (active === state) active = null; } });
      state.layer = layer;
      const revealFailure = () => {
        const notice = layer.panel.querySelector('[data-cleanup-error]');
        notice?.scrollIntoView({ block: 'nearest' }); notice?.focus({ preventScroll: true });
      };
      const check = async () => {
        const seq = ++state.sequence, prior = state.plan;
        clearTimeout(state.expiry); state.loading = true; state.failure = null; state.expired = false; state.plan = null; layer.render();
        const result = await api('/storage/clean/preview', { body: { ids: state.ids } });
        if (layer.closed || seq !== state.sequence) return;
        state.loading = false;
        if (!result.ok || !Array.isArray(result.data?.caches) || !/^[a-f0-9]{64}$/.test(result.data?.token || '') || !Number.isFinite(result.data?.expiresAt)) {
          state.failure = result.error || 'Cache information could not be checked. Try again.';
        } else {
          state.plan = result.data;
          state.selected = new Set(result.data.caches.filter((row) => row.eligible && (!prior || state.selected.has(row.id))).map((row) => row.id));
          // A phone's wall clock can differ from the server's. The server still
          // owns expiry; the UI uses the returned duration for its reminder.
          const left = Number.isFinite(result.data.expiresInMs) ? Math.min(result.data.expiresInMs, 5 * 60 * 1000) : result.data.expiresAt - Date.now();
          state.expired = left <= 0;
          if (left > 0) state.expiry = setTimeout(() => { if (!layer.closed && !state.operation) { state.expired = true; layer.render(); } }, Math.min(left, 2147483647));
        }
        layer.render();
        if (state.failure) revealFailure();
      };
      layer.panel.addEventListener('change', (event) => {
        if (!event.target.matches('[data-cleanup-id]') || state.submitting) return;
        const id = event.target.dataset.cleanupId;
        if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
        layer.render();
      });
      layer.panel.addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.target.closest('[data-cleanup-confirm]')) event.preventDefault(); });
      layer.panel.addEventListener('click', async (event) => {
        if (event.target.closest('[data-cleanup-close]') && !state.submitting) layer.close('close');
        if (event.target.closest('[data-cleanup-recheck]') && !state.submitting) void check();
        if (event.target.closest('[data-cleanup-remaining]')) {
          state.ids = state.operation.remainingIds?.length ? [...state.operation.remainingIds] : [...state.operation.ids];
          state.operation = null; state.plan = null; state.selected = new Set(); void check();
        }
        if (!event.target.closest('[data-cleanup-confirm]') || state.submitting || state.loading || state.expired || !selected().length) return;
        const chosen = selected().map((row) => row.id), token = state.plan.token;
        state.submitting = true; layer.render();
        const result = await run('/storage/clean', { ids: chosen, token });
        if (layer.closed) return;
        state.submitting = false;
        if (!result.ok) {
          state.failure = result.error || 'The cleanup result could not be confirmed. Check again before trying to clean these caches.';
          state.expired = true;
        } else {
          state.operation = result.data.operation || { ...result.data, ids: chosen, state: 'succeeded', completedIds: chosen, remainingIds: [] };
          clearTimeout(state.expiry);
          observe(view());
        }
        layer.render();
        if (state.failure) revealFailure();
      });
      if (!operation) void check();
    };
    const observe = (storage) => {
      const state = active;
      if (!state?.operation?.id || state.layer.closed) return;
      const latest = storage?.operation;
      const op = latest?.id === state.operation.id ? latest : latest?.recent?.find((item) => item.id === state.operation.id);
      if (op) { state.operation = op; state.layer.render(); }
    };
    return { open, observe, inspect: (operation) => { if (operation?.ids?.length) open(operation.ids, { operation }); } };
  };
  return { create };
})();
