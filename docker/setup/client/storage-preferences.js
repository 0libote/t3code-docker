// Maintenance has its own draft and revision. Polls cannot replace inputs,
// concurrent saves cannot silently overwrite preferences, and dismissal guards
// preserve edits without changing Kit's shared overlay behavior.
const T3StoragePreferences = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const GB = 1_000_000_000, disabled = (value) => value ? raw(' disabled') : '';
  const create = ({ api, view, reload, saved }) => {
    let active = null;
    const open = () => {
      if (active && !active.closed) { active.panel.focus(); return; }
      const initial = view(), definitions = initial.cachePolicies;
      const draft = { ...initial.policy, automaticCaches: [...(initial.policy.automaticCaches || ['go', 'npm'])] };
      const original = JSON.stringify(draft), values = Object.fromEntries(definitions.map((row) => [row.budgetKey, String((draft[row.budgetKey] ?? row.defaultBytes) / GB)]));
      const originalValues = JSON.stringify(values);
      let saving = false, confirming = false, limitsOpen = draft.automatic, error = null, conflict = false;
      const dirty = () => JSON.stringify(draft) !== original || JSON.stringify(values) !== originalValues;
      const beforeUnload = (event) => { if (dirty() || saving) { event.preventDefault(); event.returnValue = ''; } };
      const contents = () => html`<form class="tc-storage-preferences-form" novalidate>
        <div class="tc-storage-dialog-head"><div><h2 class="tc-dialog-title" id="storage-settings-title">Storage maintenance</h2><p class="tc-dialog-desc">Keep caches and old tool versions under control. Each policy works independently.</p></div>
          <button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-storage-cancel aria-label="Close maintenance settings"${disabled(saving)}>${icon('x')}</button></div>
        <div class="tc-storage-dialog-scroll">
          <section class="tc-storage-policy-section" aria-labelledby="storage-auto-label"><div class="tc-storage-policy-heading"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('clock')}</span>
            <div><label class="tc-row-name" id="storage-auto-label">Automatic cache cleanup</label><p class="tc-hint" id="storage-auto-help">Clean the caches you choose after 10 minutes without build or tool activity.</p></div>
            <span class="tc-storage-toggle"><button type="button" class="tc-switch" role="switch" aria-labelledby="storage-auto-label" aria-describedby="storage-auto-help" aria-checked="${String(draft.automatic)}" data-storage-switch="automatic"${disabled(saving)}></button></span></div>
            <div class="tc-storage-policy-state">${icon(draft.automatic ? 'check' : 'circle-stop', 'tc-icon--sm')}<span>${draft.automatic ? draft.automaticCaches.length ? T3Model.plural(draft.automaticCaches.length, 'cache') + ' selected for maintenance' : 'Choose at least one cache below' : 'Off. Caches are cleaned only when you choose.'}</span></div>
            <button class="tc-storage-limits-trigger" type="button" data-storage-limits aria-expanded="${String(limitsOpen)}" aria-controls="storage-cache-limits"${disabled(saving)}><span>Cache selection & limits</span><span class="tc-small tc-muted">${definitions.length} tools</span>${icon('chevron-down', 'tc-icon--sm')}</button>
            <div id="storage-cache-limits" class="tc-storage-limits"${limitsOpen ? '' : raw(' hidden')}>
              <p class="tc-hint">Choose which caches can be maintained. A limit triggers cleanup; it is not a target size. Protected caches are skipped.</p>
              <div class="tc-storage-limit-list">${definitions.map((row) => html`<div class="tc-storage-limit-row" data-key="storage-limit-${row.id}">
                <label class="tc-storage-limit-label"><input class="tc-checkbox" type="checkbox" data-storage-auto-cache="${row.id}" aria-label="Automatically maintain ${row.label}"${draft.automaticCaches.includes(row.id) ? raw(' checked') : ''}${disabled(saving)}><span>${row.label}</span></label>
                <div class="tc-storage-input"><input class="tc-input tc-input--sm" type="number" min="0.25" max="500" step="any" id="storage-${row.id}-limit" data-storage-limit="${row.budgetKey}" value="${values[row.budgetKey]}" inputmode="decimal" aria-label="${row.label} limit in GB"${disabled(saving)}><span>GB</span></div></div>`)}</div>
              <p class="tc-hint">Limits apply when automatic cleanup is on. uv only prunes unused entries; Bun’s shared dependencies are always kept.</p>
            </div>
          </section>
          <section class="tc-storage-policy-section" aria-labelledby="storage-retain-label"><div class="tc-storage-policy-heading"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('history')}</span>
            <div><label class="tc-row-name" id="storage-retain-label">Trim older tool versions</label><p class="tc-hint" id="storage-retain-help">After verified updates, keep current and previous versions, plus anything required by projects, providers or running tools.</p></div>
            <span class="tc-storage-toggle"><button type="button" class="tc-switch" role="switch" aria-labelledby="storage-retain-label" aria-describedby="storage-retain-help" aria-checked="${String(draft.retainManagedVersions)}" data-storage-switch="retainManagedVersions"${disabled(saving)}></button></span></div>
            <p class="tc-storage-policy-detail">${draft.retainManagedVersions ? 'Older unneeded versions are trimmed after updates.' : 'Versions stay installed until you review and trim them.'} Removing previous versions is always a separate manual choice.</p>
          </section>
          ${error ? html`<div class="tc-storage-notice tc-storage-notice--danger" role="alert" tabindex="-1" id="storage-settings-error">${icon('triangle-alert')}<div><strong>${conflict ? 'Preferences changed elsewhere' : 'Preferences weren’t saved'}</strong><p>${error}</p>${conflict ? html`<button class="tc-btn tc-btn--sm" type="button" data-storage-reload>Reload latest preferences</button>` : ''}</div></div>` : ''}
        </div>
        <div class="tc-storage-dialog-foot"><span class="tc-storage-save-hint" role="status">${saving ? 'Saving preferences…' : 'Applies to this container'}</span><button class="tc-btn tc-btn--ghost" type="button" data-storage-cancel${disabled(saving)}>Cancel</button><button class="tc-btn tc-btn--primary" type="submit" data-storage-save${disabled(saving)}>${saving ? html`<span class="tc-spinner" aria-hidden="true"></span>Saving…` : 'Save preferences'}</button></div></form>`;
      const layer = Kit.open({ kind: 'center', panel: { class: 'tc-dialog tc-storage-settings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'storage-settings-title' },
        focus: '[data-storage-cancel]', backdrop: 'ignore', render: contents,
        onEscape: () => layer.close('escape'),
        onClose: () => { window.removeEventListener('beforeunload', beforeUnload); if (active === layer) active = null; } });
      active = layer;
      const revealError = () => {
        const notice = layer.panel.querySelector('#storage-settings-error');
        notice?.scrollIntoView({ block: 'nearest' }); notice?.focus({ preventScroll: true });
      };
      const close = layer.close;
      layer.close = async (reason) => {
        if (saving || confirming) return;
        if (['saved', 'discarded', 'replaced'].includes(reason) || !dirty()) { close(reason); return; }
        confirming = true;
        const discard = await Kit.confirm({ title: 'Discard maintenance changes?', body: 'Your unsaved preferences will be lost. Current maintenance settings stay in place.', confirm: 'Discard changes', tone: 'danger' });
        confirming = false;
        if (discard && !layer.closed) close(reason);
      };
      window.addEventListener('beforeunload', beforeUnload);
      layer.panel.addEventListener('input', (event) => {
        const input = event.target.closest('[data-storage-limit]');
        if (input && !saving) { values[input.dataset.storageLimit] = input.value; input.removeAttribute('aria-invalid'); }
      });
      layer.panel.addEventListener('change', (event) => {
        const input = event.target.closest('[data-storage-auto-cache]');
        if (!input || saving) return;
        const selected = new Set(draft.automaticCaches);
        if (input.checked) selected.add(input.dataset.storageAutoCache); else selected.delete(input.dataset.storageAutoCache);
        draft.automaticCaches = definitions.filter((row) => selected.has(row.id)).map((row) => row.id);
        layer.render();
      });
      layer.panel.addEventListener('click', async (event) => {
        if (event.target.closest('[data-storage-cancel]')) void layer.close('cancel');
        if (saving) return;
        if (event.target.closest('[data-storage-limits]')) { limitsOpen = !limitsOpen; layer.render(); }
        const toggle = event.target.closest('[data-storage-switch]');
        if (toggle) { const key = toggle.dataset.storageSwitch; draft[key] = !draft[key]; if (key === 'automatic' && draft.automatic) limitsOpen = true; layer.render(); }
        if (event.target.closest('[data-storage-reload]')) {
          confirming = true;
          const discard = await Kit.confirm({ title: 'Load the latest preferences?', body: 'Your unsaved edits will be discarded so you can review what changed.', confirm: 'Load latest', tone: 'primary' });
          confirming = false;
          if (discard && !layer.closed) { close('replaced'); await reload(); open(); }
        }
      });
      layer.panel.querySelector('form').addEventListener('submit', async (event) => {
        event.preventDefault(); if (saving) return;
        const payload = { ...draft };
        for (const row of definitions) {
          const text = values[row.budgetKey], value = Number(text);
          if (!text.trim() || !Number.isFinite(value) || value < 0.25 || value > 500 || !Number.isSafeInteger(Math.round(value * GB))) {
            limitsOpen = true; error = 'Enter a cache limit between 0.25 and 500 GB.'; conflict = false; layer.render();
            const input = layer.panel.querySelector('#storage-' + row.id + '-limit'); input.setAttribute('aria-invalid', 'true'); input.focus(); return;
          }
          payload[row.budgetKey] = Math.round(value * GB);
        }
        if (payload.automatic && !payload.automaticCaches.length) { limitsOpen = true; error = 'Choose at least one cache, or turn automatic cleanup off.'; conflict = false; layer.render(); revealError(); return; }
        saving = true; error = null; layer.render();
        const body = initial.policyRevision ? { policy: payload, revision: initial.policyRevision } : payload;
        const result = await api('/storage/policy', { body });
        saving = false;
        if (layer.closed) { await reload(); return; }
        if (!result.ok) { error = result.error || 'Try saving again. Your edits are still here.'; conflict = result.data?.code === 'stale-policy'; layer.render(); revealError(); return; }
        close('saved'); saved(); await reload();
      });
    };
    return { open };
  };
  return { create };
})();
