// Native revisions bind every decision to the exact command on screen. Trust
// never enables a hook; the server's complete answer supplies the next revisions.
const T3SkillHooks = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const S = T3SkillModel, M = T3Model;
  const disabled = value => value ? raw(' disabled') : '';
  const create = ({ api, getInventory = () => api('/context/skills/hooks'), getLibrary = () => ({ rows: [] }), onChange = () => {}, onClose = () => {} }) => {
    let active = null;
    const close = () => {
      if (active?.pending) { Kit.announce('Wait for the hook setting to finish saving'); return false; }
      active?.layer.close('close'); return true;
    };
    const open = pluginId => {
      if (!close()) return;
      const media = matchMedia('(max-width: 639.98px)');
      const view = { pluginId, data: null, loading: false, pending: null, error: null, errors: new Map(), expanded: new Set(), collapsed: new Set(), stale: false, layer: null };
      active = view;
      const alive = () => active === view && !view.layer.closed;
      const panelClass = () => 'tc-sheet tc-sheet--hooks' + (media.matches ? ' tc-sheet--bottom tc-sheet--full' : '');
      const paint = () => { if (alive()) { view.layer.panel.className = panelClass(); view.layer.render(); } };
      const beforeUnload = event => { if (view.pending) { event.preventDefault(); event.returnValue = ''; } };
      const expanded = hook => view.expanded.has(hook.id) || S.hookNeedsReview(hook) && !view.collapsed.has(hook.id);
      const hookSelector = id => '[data-hook="' + CSS.escape(id) + '"]';
      const focusHook = (id, selector = '[data-hook-toggle]') => {
        if (alive()) view.layer.panel.querySelector(hookSelector(id) + ' ' + selector)?.focus({ preventScroll: true });
      };
      const read = async (force = false) => {
        if (view.loading || view.pending) return;
        view.loading = true; view.error = null; paint();
        const response = await getInventory(force);
        if (!alive()) return;
        view.loading = false;
        if (response.ok) { view.data = response.data; view.stale = false; }
        else { view.error = response.error; view.stale = true; }
        paint();
        return response;
      };
      const change = async (id, action) => {
        if (view.loading || view.pending || view.stale) return;
        const hook = view.data?.hooks.find(row => row.id === id), status = hook && S.hookStatus(hook);
        if (!hook || status.readOnly || action === 'enable' && hook.trustStatus !== 'trusted') return;
        view.pending = { id, action }; view.errors.delete(id); paint();
        let response;
        try { response = await api('/context/skills/hooks/state', { body: { id, revision: hook.revision, action } }); }
        catch (error) { response = { ok: false, status: 0, error: error.message || 'The connection was interrupted.' }; }
        if (!alive()) return;
        view.pending = null;
        if (response.ok) {
          view.data = response.data; onChange(response.data);
          const saved = view.data.hooks.find(row => row.id === id);
          if (action === 'trust') {
            view.expanded.delete(id); view.collapsed.add(id);
            Kit.toast(saved?.enabled ? 'Codex will run this hook in new sessions' : 'Trusted. Turn it on to run it.');
          } else Kit.toast(action === 'enable' ? 'Hook on for new Codex sessions' : 'Hook off for new Codex sessions');
          Kit.announce(action === 'trust' ? 'Hook trusted' : action === 'enable' ? 'Hook turned on' : 'Hook turned off');
          paint(); focusHook(id, '[data-hook-switch]');
        } else {
          const conflict = response.status === 409;
          view.expanded.add(id); view.collapsed.delete(id);
          view.errors.set(id, conflict ? 'This hook changed. Review the new command.' : 'Couldn’t save this setting. ' + response.error + ' Refresh to check its current state.');
          // A lost reply may have saved a setting. Re-read before accepting another
          // action; no optimistic trust or toggle state is retained on failure.
          view.stale = true; paint();
          await read(true);
          if (!alive()) return;
          const exists = view.data?.hooks.some(row => row.id === id);
          if (!exists) view.error = 'That hook is no longer in the installed plugin. Refresh to review its current hooks.';
          paint(); focusHook(id, '[data-hook-error]');
          Kit.announce(conflict ? 'This hook changed. Review the new command.' : 'Couldn’t save the hook setting');
        }
      };
      const matcher = hook => { const phrase = S.hookMatcher(hook); return html`${phrase.text}${phrase.code ? html`<code>${phrase.code}</code>` : ''}`; };
      const eventName = hook => html`<span class="tc-hk-event"><button class="tc-hk-label" type="button" data-hook-toggle="${hook.id}" aria-expanded="${String(expanded(hook))}">${S.hookLabel(hook.eventName)}</button><span><code>${hook.eventName}</code>${S.hookMatcher(hook).text ? html` · ${matcher(hook)}` : ''}</span></span>`;
      const statusLabel = hook => { const status = S.hookStatus(hook); return html`<span class="tc-hk-state" data-tone="${status.tone}" title="${hook.readOnlyReason || ''}">${status.icon ? icon(status.icon, 'tc-icon--sm') : status.tone === 'warn' || status.tone === 'ok' ? html`<span class="tc-dot${status.tone === 'warn' ? ' tc-dot--warn' : ' tc-dot--ok'}"></span>` : ''}${status.label}</span>`; };
      const switchControl = hook => {
        const status = S.hookStatus(hook), busy = Boolean(view.pending || view.loading || view.stale), pending = view.pending?.id === hook.id;
        return html`<span class="tc-hk-switch"${status.readOnly || hook.trustStatus !== 'trusted' ? raw(' data-disabled') : ''}>${pending && view.pending.action !== 'trust' ? html`<span class="tc-spinner" aria-hidden="true"></span>` : ''}<button class="tc-switch tc-switch--sm" type="button" role="switch" data-key="hook-switch-${hook.id}" data-hook-switch="${hook.id}" aria-label="${S.hookLabel(hook.eventName)} for ${S.pluginName(hook.pluginId)}" aria-checked="${String(Boolean(hook.enabled))}"${disabled(busy || status.readOnly || hook.trustStatus !== 'trusted')}></button></span>`;
      };
      const card = hook => {
        const status = S.hookStatus(hook), full = expanded(hook), pending = view.pending?.id === hook.id, problem = view.errors.get(hook.id);
        const canTrust = !status.readOnly && hook.trustStatus !== 'trusted', busy = Boolean(view.pending || view.loading || view.stale);
        const hint = hook.trustStatus === 'modified' && hook.enabled ? 'Paused: the plugin changed it after you trusted it.' : !hook.enabled && canTrust ? 'Trusting doesn’t turn it on. Use the switch afterwards.' : 'If the plugin changes this command, it waits for review again.';
        return html`<div class="tc-hk${full ? '' : ' tc-hk--compact'}" data-hook="${hook.id}" data-key="hook-${hook.id}" aria-busy="${String(pending)}">
          ${full ? html`<div class="tc-hk-head">${eventName(hook)}${statusLabel(hook)}${!canTrust ? switchControl(hook) : ''}</div>` : html`${eventName(hook)}${statusLabel(hook)}${switchControl(hook)}`}
          ${problem ? html`<div class="tc-notice tc-notice--danger tc-hk-error" role="alert" tabindex="-1" data-hook-error>${icon('circle-alert')}<div class="tc-notice-body"><span class="tc-notice-desc">${problem}</span></div></div>` : ''}
          ${full ? html`${hook.handlerType === 'command' && hook.command ? html`<pre class="tc-hk-cmd" tabindex="0" aria-label="Command for ${S.hookLabel(hook.eventName)}">${hook.command}</pre>` : html`<p class="tc-hint">${hook.readOnlyReason || 'Review this hook in Codex.'}</p>`}
            <dl class="tc-hk-facts"><dt>Defined in</dt><dd><code>${S.displayPath(hook.sourcePath, getLibrary().home)}</code></dd><dt>Time limit</dt><dd>${S.hookTimeout(hook)}</dd><dt>Runs as</dt><dd>Your container user, for every ${S.pluginName(hook.pluginId)} skill</dd></dl>
            ${canTrust ? html`<div class="tc-hk-actions"><span>${hint}</span>${hook.enabled ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-hook-id="${hook.id}" data-hook-action="disable"${disabled(busy)}>${pending && view.pending.action === 'disable' ? 'Turning off…' : 'Turn off'}</button>` : ''}<button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-key="hook-trust-${hook.id}" data-hook-id="${hook.id}" data-hook-action="trust"${disabled(busy)}>${pending && view.pending.action === 'trust' ? html`<span class="tc-spinner" aria-hidden="true"></span>Trusting…` : html`${icon('shield-check')}${hook.trustStatus === 'modified' && hook.enabled ? 'Trust new command' : 'Trust command'}`}</button></div>` : hook.readOnlyReason ? html`<p class="tc-hint">${hook.readOnlyReason}</p>` : ''}`
          : html`<span class="tc-hk-line" title="${hook.command || hook.readOnlyReason || hook.handlerType}">${hook.command || hook.readOnlyReason || hook.handlerType}</span>`}
        </div>`;
      };
      const filtered = () => (view.data?.hooks || []).filter(hook => !view.pluginId || hook.pluginId === view.pluginId);
      const meta = () => {
        const summary = S.hooksSummary(filtered());
        if (!view.data) return view.loading ? 'Reading installed plugins…' : 'Installed Codex plugins';
        return html`${view.pluginId ? S.pluginName(view.pluginId) + ' · ' + M.plural(summary.total, 'hook') : M.plural(summary.total, 'hook') + ' from ' + M.plural(summary.plugins.length, 'installed plugin')}${summary.waiting.length ? html`<span class="tc-warning"><span class="tc-dot tc-dot--warn"></span>${summary.waiting.length} waiting for review</span>` : ''}`;
      };
      const groups = () => {
        const summary = S.hooksSummary(filtered());
        return html`${summary.plugins.map(plugin => {
          const count = getLibrary().rows.filter(row => row.byProvider.codex?.pluginId === plugin.id).length;
          return html`<section class="tc-hk-plugin" data-key="hook-plugin-${plugin.id}" aria-label="${plugin.name}"><div class="tc-hk-plugin-head">${icon('puzzle')}<strong>${plugin.name}</strong><code title="${plugin.id}">${plugin.id}</code><span class="tc-spacer"></span><span>${count ? M.plural(count, 'skill') : 'No skills'} · ${M.plural(plugin.hooks.length, 'hook')}</span></div><div class="tc-group">${[...plugin.hooks].sort((a, b) => S.hookStatus(a).rank - S.hookStatus(b).rank || S.hookLabel(a.eventName).localeCompare(S.hookLabel(b.eventName)) || a.id.localeCompare(b.id)).map(card)}</div></section>`;
        })}${!summary.total && view.data ? html`<div class="tc-empty tc-hk-empty"><span class="tc-empty-icon">${icon('shield-check')}</span><span class="tc-empty-title">${view.pluginId ? 'This installed Codex plugin has no hooks.' : 'No installed Codex plugins have hooks.'}</span><span class="tc-empty-desc">Importing skill folders adds instructions; hooks come from a full plugin install.</span></div>` : ''}`;
      };
      view.layer = Kit.open({ kind: 'sheet', returnTo: document.activeElement,
        panel: { class: panelClass(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-hooks-title' }, focus: '[data-hooks-close]', backdrop: 'ignore', onEscape: close,
        onClose: () => { window.removeEventListener('beforeunload', beforeUnload); media.removeEventListener('change', paint); if (active === view) active = null; onClose(); },
        render: () => html`<div class="tc-insp-head"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('shield-check')}</span><div class="tc-insp-title"><h2 id="skill-hooks-title">Codex plugin hooks</h2><div class="tc-insp-meta">${meta()}</div></div><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-hooks-close aria-label="Close plugin hooks"${disabled(Boolean(view.pending))}>${icon('x')}</button></div>
          <div class="tc-insp-body tc-hk-body" aria-busy="${String(view.loading)}"><p class="tc-hk-intro">Hooks are commands a plugin runs on its own, like when a session starts. Codex runs a hook only after you trust its exact command, and only while it’s on. Both are saved in Codex’s settings.</p>
          ${view.error ? html`<div class="tc-notice tc-notice--danger" role="alert">${icon('circle-alert')}<div class="tc-notice-body"><span class="tc-notice-title">Couldn’t read plugin hooks</span><span class="tc-notice-desc">${view.error}</span></div><div class="tc-notice-actions"><button class="tc-btn tc-btn--sm" type="button" data-hooks-refresh${disabled(view.loading)}>Refresh</button></div></div>` : ''}
          ${view.loading && !view.data ? html`<div class="tc-group" role="status" aria-label="Reading plugin hooks">${[1, 2, 3].map(i => html`<div class="tc-hk tc-hk-skeleton" data-key="hook-skeleton-${i}"><span class="tc-skeleton"></span><span class="tc-skeleton"></span><span class="tc-sr">Reading plugin hooks…</span></div>`)}</div>` : groups()}
          ${(view.data?.warnings || []).map(warning => html`<p class="tc-hint">${warning}</p>`)}<p class="tc-hint tc-hk-footnote">Project and session hooks stay in Codex’s own <code>/hooks</code> view.</p></div>
          <div class="tc-sheet-foot tc-hk-foot"><span class="tc-hint">${icon('info', 'tc-icon--sm')}Applies to new Codex sessions.</span>${view.pluginId ? html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-hooks-all${disabled(Boolean(view.pending))}>All plugins</button>` : ''}<span class="tc-spacer"></span><button class="tc-btn tc-btn--sm" type="button" data-hooks-refresh${disabled(Boolean(view.pending || view.loading))}>${view.loading ? html`<span class="tc-spinner" aria-hidden="true"></span>` : icon('refresh-cw')}Refresh</button><button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-hooks-close${disabled(Boolean(view.pending))}>Done</button></div>` });
      window.addEventListener('beforeunload', beforeUnload); media.addEventListener('change', paint);
      view.layer.panel.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (button?.disabled) return;
        if (button?.hasAttribute('data-hooks-close')) close();
        else if (button?.hasAttribute('data-hooks-refresh')) void read(true);
        else if (button?.hasAttribute('data-hooks-all')) { view.pluginId = null; paint(); }
        else if (button?.dataset.hookAction) void change(button.dataset.hookId, button.dataset.hookAction);
        else if (button?.dataset.hookSwitch) { const hook = view.data?.hooks.find(row => row.id === button.dataset.hookSwitch); if (hook) void change(hook.id, hook.enabled ? 'disable' : 'enable'); }
        else {
          const id = button?.dataset.hookToggle || (!event.target.closest('pre, a, [data-hook-error]') && event.target.closest('.tc-hk--compact')?.dataset.hook);
          const hook = view.data?.hooks.find(row => row.id === id);
          if (!hook || view.pending) return;
          if (expanded(hook)) { view.expanded.delete(id); view.collapsed.add(id); } else { view.collapsed.delete(id); view.expanded.add(id); }
          paint(); focusHook(id);
        }
      });
      void read().then(() => {
        if (!alive()) return;
        const first = filtered().find(S.hookNeedsReview);
        if (first) view.layer.panel.querySelector(hookSelector(first.id))?.scrollIntoView({ block: 'nearest' });
      });
    };
    return { open, close };
  };
  return { create };
})();
