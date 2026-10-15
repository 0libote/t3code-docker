// Storage composition and interactions. Polling only updates the page; open
// reviews and preference drafts live in Kit's separate overlay layer.
const T3StorageUI = (() => {
  'use strict';
  const M = T3Model;
  const { html, raw, icon, cx, patch } = Kit;
  const disabled = (value) => value ? raw(' disabled') : '';
  const GB = 1_000_000_000;

  const create = ({ api, getStatus, reload, render }) => {
    let expanded = false, requesting = false, pending = null, error = null;
    let lastToast = null;
    const toast = (message, options) => {
      lastToast?.close();
      // Completed work is also shown on the card. Keep that feedback from
      // covering the controls of a storage dialog someone is editing.
      if (document.querySelector('.tc-layer:not([data-closing]) .tc-storage-settings, .tc-layer:not([data-closing]) .tc-storage-review')) return;
      lastToast = Kit.toast(message, options);
    };
    const view = () => M.storageView(getStatus(), Date.now());
    const busy = () => requesting || pending || view().busy;
    const observe = (storage) => {
      const latest = storage && storage.operation;
      const op = latest && (latest.id === pending ? latest : (latest.recent || []).find((item) => item.id === pending));
      if (!pending || !op || op.id !== pending || op.state === 'running') return;
      pending = null;
      if (op.state === 'succeeded') {
        toast(op.ids && op.ids.includes('versions') ? 'Older versions trimmed' : 'Caches cleared', {
          detail: op.removedCount !== undefined ? M.plural(op.removedCount, 'version') + ' removed. Current and required versions are kept.'
            : M.formatBytes(op.reclaimedBytes) + ' freed. Future builds and installs recreate the cache.',
        });
      } else {
        error = op.error || 'Cleanup did not finish. Refresh and try again.';
        toast('Cleanup needs attention', { tone: 'danger', detail: error });
      }
    };

    const run = async (route, body) => {
      if (busy()) return;
      requesting = true; error = null; render();
      const result = await api(route, { body });
      requesting = false;
      if (result.ok && result.status === 202) pending = result.data.operation.id;
      else if (!result.ok) { error = result.error; toast('Cleanup did not start', { tone: 'danger', detail: error }); }
      else toast('Storage updated');
      await reload(); render();
    };

    const clean = async (id) => {
      const current = view();
      const ids = id === 'all' ? current.ids : [id];
      const rows = current.cacheRows.filter((row) => ids.includes(row.id) && row.canClean);
      if (!rows.length || busy() || current.refreshing) return;
      lastToast?.close();
      const amount = rows.reduce((sum, row) => sum + row.bytes, 0);
      const title = rows.length === 1 ? 'Clear ' + (rows[0].id === 'go' ? 'Go build cache' : 'npm downloads') + '?' : 'Clear build and download caches?';
      const confirmed = await Kit.confirm({
        title, body: 'Approximately ' + M.formatBytes(amount) + ' can be freed. These files are recreated when needed.',
        consequences: [
          { icon: 'history', text: 'The next build or package install may take longer.' },
          { icon: 'shield-check', text: 'Project files, sign-ins, conversations, and installed tools are kept.' },
          { icon: 'circle-stop', text: 'Finish any build or package installation first.' },
        ], confirm: 'Clear ' + (rows.length > 1 ? 'caches' : 'cache'), tone: 'primary',
      });
      if (confirmed) await run('/storage/clean', { ids: rows.map((row) => row.id) });
    };

    const refresh = async () => {
      if (view().refreshing || busy()) return;
      error = null;
      const result = await api('/storage/refresh', { body: {} });
      if (!result.ok) error = result.error;
      await reload(); render();
    };

    const preferences = () => {
      lastToast?.close();
      const initial = view().policy;
      const draft = { ...initial };
      let saving = false;
      const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-storage-settings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'storage-settings-title' },
        focus: '[data-storage-cancel]', render: () => html`
          <form id="storage-settings-form" novalidate>
            <div class="tc-dialog-body">
              <h2 class="tc-dialog-title" id="storage-settings-title">Storage maintenance</h2>
              <p class="tc-dialog-desc">Choose what happens in the background. Your projects, conversations, and sign-ins are kept.</p>
              <div class="tc-storage-setting">
                <div><label class="tc-row-name" id="storage-auto-label">Automatic cache cleanup</label><p class="tc-hint" id="storage-auto-help">Clear Go and npm caches over their limits after 10 minutes without build or install activity.</p></div>
                <span class="tc-storage-toggle"><button type="button" class="tc-switch" role="switch" aria-labelledby="storage-auto-label" aria-describedby="storage-auto-help" aria-checked="${String(draft.automatic)}" data-storage-switch="automatic"></button></span>
              </div>
              <div class="tc-storage-budgets">
                <div class="tc-field"><label class="tc-label" for="storage-go-limit">Go cache limit</label><div class="tc-storage-input"><input class="tc-input" type="number" min="0.25" max="500" step="0.25" id="storage-go-limit" value="${draft.goBudgetBytes / GB}" inputmode="decimal" aria-describedby="storage-limit-help"><span>GB</span></div></div>
                <div class="tc-field"><label class="tc-label" for="storage-npm-limit">npm cache limit</label><div class="tc-storage-input"><input class="tc-input" type="number" min="0.25" max="500" step="0.25" id="storage-npm-limit" value="${draft.npmBudgetBytes / GB}" inputmode="decimal" aria-describedby="storage-limit-help"><span>GB</span></div></div>
              </div>
              <p class="tc-hint" id="storage-limit-help">A cache is cleared when it exceeds its limit. The next build or install may take longer.</p>
              <div class="tc-storage-setting tc-storage-setting--border">
                <div><label class="tc-row-name" id="storage-retain-label">Trim older tool versions</label><p class="tc-hint" id="storage-retain-help">After successful updates, keep the current and previous versions, plus versions required by projects, providers, or running tools.</p></div>
                <span class="tc-storage-toggle"><button type="button" class="tc-switch" role="switch" aria-labelledby="storage-retain-label" aria-describedby="storage-retain-help" aria-checked="${String(draft.retainManagedVersions)}" data-storage-switch="retainManagedVersions"></button></span>
              </div>
              <p class="tc-hint tc-hint--err" id="storage-settings-error" role="alert" hidden></p>
            </div>
            <div class="tc-dialog-foot"><button class="tc-btn tc-btn--ghost" type="button" data-storage-cancel>Cancel</button><button class="tc-btn tc-btn--primary" type="submit" data-storage-save>Save preferences</button></div>
          </form>` });
      const panel = layer.panel;
      const message = (text) => { const el = panel.querySelector('#storage-settings-error'); el.textContent = text; el.hidden = !text; };
      panel.addEventListener('click', (event) => {
        if (event.target.closest('[data-storage-cancel]') && !saving) layer.close('cancel');
        const toggle = event.target.closest('[data-storage-switch]');
        if (toggle && !saving) { const key = toggle.dataset.storageSwitch; draft[key] = !draft[key]; toggle.setAttribute('aria-checked', String(draft[key])); }
      });
      panel.querySelector('form').addEventListener('submit', async (event) => {
        event.preventDefault(); if (saving) return;
        const fields = [['#storage-go-limit', 'goBudgetBytes'], ['#storage-npm-limit', 'npmBudgetBytes']];
        for (const [selector, key] of fields) {
          const input = panel.querySelector(selector), value = Number(input.value);
          input.removeAttribute('aria-invalid');
          if (!input.value.trim() || !Number.isFinite(value) || value < 0.25 || value > 500) {
            input.setAttribute('aria-invalid', 'true'); message('Enter a cache limit between 0.25 and 500 GB.'); input.focus(); return;
          }
          draft[key] = Math.round(value * GB);
        }
        saving = true; message('');
        panel.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
        const save = panel.querySelector('[data-storage-save]'); save.textContent = 'Saving…';
        const result = await api('/storage/policy', { body: draft });
        saving = false;
        if (layer.closed) { await reload(); return; }
        if (!result.ok) {
          message(result.error); panel.querySelectorAll('button, input').forEach((el) => { el.disabled = false; }); save.textContent = 'Save preferences'; return;
        }
        layer.close('saved'); toast('Storage preferences saved'); await reload();
      });
    };

    const reviewVersions = async () => {
      if (busy()) return;
      lastToast?.close();
      let plan = null, failure = null;
      const contents = () => html`
        <div class="tc-dialog-body">
          <h2 class="tc-dialog-title" id="storage-versions-title">Review older tool versions</h2>
          <p class="tc-dialog-desc">Keep the current and previous versions. Project requirements, provider selections, and running tools are protected.</p>
          ${!plan && !failure ? html`<div class="tc-storage-review-loading" role="status"><span class="tc-spinner" aria-hidden="true"></span>Checking installed versions…</div>` : ''}
          ${failure ? html`<p class="tc-hint tc-hint--err" role="alert">${failure}</p>` : ''}
          ${plan ? html`
            <div class="tc-storage-review-summary"><strong>${plan.removableCount ? M.plural(plan.removableCount, 'older version') + ' can be removed' : 'No older versions to remove'}</strong><span class="tc-small tc-muted">${plan.removableCount ? 'Approximately ' + M.formatBytes(plan.estimatedBytes) + ' reclaimable' : 'Current, previous, and required versions are kept.'}</span></div>
            ${plan.warning ? html`<p class="tc-hint tc-hint--err" role="alert">${plan.warning}</p>` : ''}
            ${plan.items.length ? html`<div class="tc-storage-version-list" role="list" aria-label="Installed versions">${[...plan.items].sort((a, b) => Number(b.eligible) - Number(a.eligible)).map((item) => html`
              <div class="tc-storage-version" role="listitem"><div><span class="tc-row-name">${item.name}</span><span class="tc-mono tc-small">${item.version}</span></div><span class="${cx('tc-small', item.eligible ? 'tc-storage-removable' : 'tc-muted')}">${item.eligible ? 'Remove' : item.reason}</span></div>`)}</div>` : ''}` : ''}
        </div>
        <div class="tc-dialog-foot"><button class="tc-btn tc-btn--ghost" type="button" data-storage-cancel>Cancel</button><button class="tc-btn tc-btn--primary" type="button" data-storage-trim${disabled(!plan || plan.warning || !plan.removableCount)}>Trim ${plan && plan.removableCount ? M.plural(plan.removableCount, 'version') : 'older versions'}</button></div>`;
      const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-storage-review', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'storage-versions-title' }, focus: '[data-storage-cancel]', render: contents });
      layer.panel.addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.target.closest('[data-storage-trim]')) event.preventDefault(); });
      layer.panel.addEventListener('click', async (event) => {
        if (event.target.closest('[data-storage-cancel]')) layer.close('cancel');
        if (event.target.closest('[data-storage-trim]') && plan && !plan.warning && plan.removableCount) {
          layer.close('confirmed'); await run('/storage/versions/prune', { token: plan.token });
        }
      });
      const result = await api('/storage/versions');
      if (layer.closed) return;
      if (!result.ok || !result.data || result.data.ok === false || !Array.isArray(result.data.items)) {
        failure = result.error || result.data && result.data.error || 'Older versions could not be checked. Try again.';
      } else plan = result.data;
      patch(layer.panel, contents());
    };

    const content = () => {
      const current = view(), running = busy(), disk = current.disk, op = current.operation;
      const statusError = error || current.policyError || current.error;
      return html`<div class="tc-group tc-storage" data-key="storage-card">
        <div class="tc-storage-disk">
          <div class="tc-storage-disk-head"><span class="tc-row-name">${disk ? disk.title : 'Filesystem space'}</span>${disk ? html`<span class="tc-badge ${disk.tone === 'warn' || disk.tone === 'danger' ? 'tc-badge--' + disk.tone : 'tc-badge--outline'}">${disk.usedPercent}% used</span>` : ''}</div>
          <div class="tc-storage-readouts"><div><span class="tc-readout-label">Available</span><span class="tc-storage-number">${disk ? disk.available : '—'}</span></div><div><span class="tc-readout-label">Used</span><span class="tc-readout-value">${disk ? disk.used : '—'}</span></div><div><span class="tc-readout-label">Capacity</span><span class="tc-readout-value">${disk ? disk.total : '—'}</span></div></div>
          ${disk ? html`<div class="tc-progress tc-storage-meter" role="meter" aria-label="Filesystem usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${disk.usedPercent}" style="--value:${disk.usedPercent}%;--storage-tone:var(--${disk.tone === 'danger' ? 'danger' : disk.tone === 'warn' ? 'warn' : 'info'})"><span></span></div>` : ''}
          <p class="tc-hint">Filesystem usage includes other containers and host files. Folder sizes below cover this container.</p>
        </div>
        <div class="tc-storage-cache-head"><div><h3 class="tc-row-name">Build & download caches</h3><p class="tc-hint">Recreated when needed. Your project files and installed tools are kept.</p></div><button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-cmd="storage.clean" data-id="all" data-key="storage-clean-all"${disabled(running || current.loading || current.refreshing || !current.ids.length)}>${icon('trash-2')}Clear caches</button></div>
        <div class="tc-list tc-storage-cache-list">
          ${current.cacheRows.length ? current.cacheRows.map((row) => html`<div class="tc-storage-cache-row" data-key="storage-${row.id}">
            <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(row.id === 'go' ? 'wrench' : 'download')}</span><div class="tc-row-main"><span class="tc-row-name">${row.label}</span><span class="tc-status">${row.unavailable || row.description}</span></div><span class="tc-storage-size tc-mono">${row.size}</span><button class="tc-btn tc-btn--sm" type="button" data-cmd="storage.clean" data-id="${row.id}" data-key="storage-clean-${row.id}" aria-label="Clear ${row.label}"${disabled(running || current.refreshing || !row.canClean)}>Clear</button></div>`)
            : html`<div class="tc-storage-empty" role="status">${current.error ? 'Folder sizes are not available. Try refreshing.' : html`<span class="tc-spinner" aria-hidden="true"></span>Measuring storage…`}</div>`}
        </div>
        ${current.progress || requesting ? html`<div class="tc-storage-operation" role="status"><span class="tc-spinner" aria-hidden="true"></span><span>${current.progress || 'Starting cleanup…'}</span><div class="tc-progress" data-indeterminate><span></span></div></div>` : ''}
        ${statusError ? html`<div class="tc-storage-message" role="alert">${icon('triangle-alert')}<span>${statusError}</span></div>` : ''}
        ${op && op.state !== 'running' && !statusError ? html`<div class="tc-storage-last tc-hint">${icon(op.state === 'succeeded' ? 'check' : 'triangle-alert')}<span>${op.state === 'succeeded' ? op.removedCount !== undefined ? M.plural(op.removedCount, 'older version') + ' removed' : M.formatBytes(op.reclaimedBytes) + ' freed' : op.error || 'Cleanup did not finish'}${op.finishedAt ? ' · ' + M.relTime(op.finishedAt, Date.now()) : ''}</span></div>` : ''}
        <div class="tc-storage-tools"><div><span class="tc-row-name">Older tool versions</span><p class="tc-hint">${current.policy.retainManagedVersions ? 'Trimmed after successful updates. Current, previous, and required versions are kept.' : 'Automatic trimming is off. You can review older versions here.'}</p></div><button class="tc-btn tc-btn--sm" type="button" data-cmd="storage.versions" data-key="storage-review"${disabled(running)}>Review</button></div>
        <div class="tc-storage-foot"><button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-cmd="storage.preferences" data-key="storage-preferences">${icon('settings-2')}Maintenance<span class="tc-storage-auto-state">${current.policy.automatic ? 'On' : 'Manual'}</span></button><span class="tc-hint" role="status">${current.refreshing ? 'Measuring…' : current.checked}</span></div>
        <button class="tc-storage-disclosure" type="button" data-cmd="storage.details" data-key="storage-details" aria-expanded="${String(expanded)}" aria-controls="storage-data"><span>Folder usage</span>${icon('chevron-down')}</button>
        <div id="storage-data" class="tc-storage-data"${expanded ? '' : raw(' hidden')}>
          ${current.dataRows.map((row) => html`<div class="tc-storage-data-row" data-key="storage-data-${row.id}"><div><span class="tc-row-name">${row.label}</span><span class="tc-storage-path tc-mono" title="${row.path}">${row.path}</span></div><span class="tc-storage-size tc-mono">${row.size}</span></div>`)}
          <p class="tc-hint tc-storage-data-note">Projects, backups, agent profiles, and other caches are managed separately. Sizes are estimates in decimal GB.</p>
        </div>
      </div>`;
    };

    const actions = () => html`<button class="tc-btn tc-btn--xs" type="button" data-cmd="storage.refresh" data-key="storage-refresh"${disabled(view().refreshing || busy())}>${view().refreshing ? html`<span class="tc-spinner" aria-hidden="true"></span>` : icon('refresh-cw')}Refresh</button>`;
    return { content, actions, observe, clean, refresh, preferences, reviewVersions,
      toggle: () => { expanded = !expanded; render(); },
      isBusy: () => busy() || view().refreshing,
    };
  };
  return { create };
})();
