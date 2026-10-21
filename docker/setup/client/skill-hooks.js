// Hook consent belongs to the person reviewing the exact native definition.
const T3SkillHooks = (() => {
  'use strict';
  const { html, raw, icon } = Kit;
  const disabled = value => value ? raw(' disabled') : '';
  const label = event => event.replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase());
  const create = ({ api }) => {
    let active = null;
    const close = () => {
      if (active?.saving || active?.confirming) return false;
      active?.layer.close('close'); return true;
    };
    const open = pluginId => {
      if (!close()) return;
      const view = { pluginId, data: null, loading: false, saving: false, confirming: false, error: null, message: '', layer: null };
      active = view;
      const busy = () => view.loading || view.saving || view.confirming;
      const paint = () => { if (active === view) view.layer.render(); };
      const beforeUnload = event => { if (view.saving) { event.preventDefault(); event.returnValue = ''; } };
      const load = async () => {
        if (busy()) return;
        view.loading = true; view.error = null; view.message = ''; paint();
        const response = await api('/context/skills/hooks');
        if (active !== view) return;
        view.loading = false; view.data = response.ok ? response.data : null;
        view.error = response.ok ? null : response.error; paint();
      };
      const change = async (id, action) => {
        if (busy()) return;
        const hook = view.data?.hooks.find(row => row.id === id);
        if (!hook || hook.readOnlyReason) return;
        if (action === 'trust' || action === 'enable') {
          view.confirming = true; paint();
          const yes = await Kit.confirm({ title: action === 'trust' ? 'Trust this plugin hook?' : 'Enable this plugin hook?',
            body: html`Allow this command to run automatically for ${label(hook.eventName)} in Codex?<code class="tc-hook-command">${hook.command}</code>`,
            consequences: [{ icon: 'info', text: 'Runs with your container user’s access. Applies to the plugin, including all its skills.' },
              ...(action === 'trust' && !hook.enabled ? [{ icon: 'info', text: 'This hook stays disabled until you enable it separately.' }] : [])],
            confirm: action === 'trust' ? 'Trust this hook' : 'Enable hook', tone: 'primary' });
          if (active !== view) return;
          view.confirming = false;
          if (!yes) { paint(); view.layer.panel.querySelector('[data-hook-id="' + CSS.escape(id) + '"][data-hook-action="' + action + '"]')?.focus(); return; }
        }
        view.saving = true; view.error = null; view.message = ''; paint();
        const response = await api('/context/skills/hooks/state', { body: { id, revision: hook.revision, action } });
        if (active !== view) return;
        view.saving = false;
        if (response.ok) {
          view.data = response.data; view.message = action === 'trust' ? 'Hook trusted. Start a new Codex session to use the updated settings.' : action === 'enable' ? 'Hook enabled for new Codex sessions.' : 'Hook disabled for new Codex sessions.';
          Kit.announce(view.message);
        } else { view.data = null; view.error = response.error; }
        paint();
        view.layer.panel.querySelector(view.error ? '[role=alert]' : '[data-hook="' + CSS.escape(id) + '"]')?.focus({ preventScroll: false });
      };
      const renderHooks = () => {
        const hooks = (view.data?.hooks || []).filter(hook => !view.pluginId || hook.pluginId === view.pluginId);
        const plugins = [...new Set(hooks.map(hook => hook.pluginId))];
        return html`${plugins.map(plugin => html`<section class="tc-insp-section"><h3 class="tc-insp-label">${plugin}</h3>${hooks.filter(hook => hook.pluginId === plugin).map(hook => html`
          <div class="tc-group tc-hook" data-hook="${hook.id}" tabindex="-1"><div class="tc-hook-head"><strong>${label(hook.eventName)}</strong><span class="tc-spacer"></span><span class="tc-badge${['untrusted', 'modified'].includes(hook.trustStatus) ? ' tc-badge--warn' : ''}">${hook.trustStatus === 'modified' ? 'Changed · needs review' : hook.trustStatus === 'untrusted' ? 'Needs review' : hook.trustStatus === 'managed' ? 'Managed' : 'Trusted'}</span><span class="tc-hint">${!hook.enabled ? 'Disabled' : ['trusted', 'managed'].includes(hook.trustStatus) ? 'Enabled' : 'Blocked until trusted'}</span></div>
            ${hook.command ? html`<pre class="tc-hook-command" tabindex="0" aria-label="Hook command">${hook.command}</pre>` : html`<p class="tc-hint">${hook.handlerType} hook</p>`}
            <dl class="tc-pathlist"><dt>Source</dt><dd><code>${hook.sourcePath}</code></dd><dt>Matches</dt><dd>${hook.matcher || 'All occurrences'}</dd><dt>Timeout</dt><dd>${hook.timeoutSec} seconds${hook.async ? ' · Runs in the background' : ''}</dd></dl>
            ${hook.readOnlyReason ? html`<p class="tc-hint">${hook.readOnlyReason}</p>` : html`<div class="tc-hook-actions">${hook.trustStatus !== 'trusted' ? html`<button class="tc-btn tc-btn--primary tc-btn--sm" type="button" data-hook-action="trust" data-hook-id="${hook.id}"${disabled(busy())}>Review and trust…</button>` : ''}${hook.enabled ? html`<button class="tc-btn tc-btn--sm" type="button" data-hook-action="disable" data-hook-id="${hook.id}"${disabled(busy())}>Disable hook</button>` : html`<button class="tc-btn tc-btn--sm" type="button" data-hook-action="enable" data-hook-id="${hook.id}"${disabled(busy() || hook.trustStatus !== 'trusted')}>Enable hook…</button>`}</div>`}
          </div>`)}</section>`)}${!hooks.length && view.data ? html`<p class="tc-hint">${view.pluginId ? 'No hooks found for this installed plugin.' : 'No installed Codex plugins with hooks were found.'} Importing skill folders adds instructions; lifecycle hooks come from a full plugin installation.</p>` : ''}`;
      };
      view.layer = Kit.open({ kind: 'sheet', returnTo: document.activeElement,
        panel: { class: 'tc-sheet tc-skill-inspector tc-skill-hooks' + (Kit.isPhone() ? ' tc-sheet--bottom' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-hooks-title' },
        focus: '[data-hooks-close]', backdrop: 'ignore', onEscape: close,
        onClose: () => { window.removeEventListener('beforeunload', beforeUnload); if (active === view) active = null; },
        render: () => html`<div class="tc-insp-head"><span class="tc-tile tc-tile--icon">${icon('shield-check')}</span><div class="tc-insp-title"><h2 id="skill-hooks-title">Codex plugin hooks</h2><div class="tc-insp-meta">Review automatic commands</div></div><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-hooks-close aria-label="Close plugin hooks"${disabled(view.saving || view.confirming)}>${icon('x')}</button></div>
          <div class="tc-insp-body" aria-busy="${String(view.loading || view.saving)}"><p class="tc-hint">Hooks run at events such as starting a session. Trust is separate from skill availability. Changed definitions need another review. Only installed Codex plugins in the setup environment are listed here.</p>
            ${view.error ? html`<div class="tc-notice tc-notice--danger" role="alert" tabindex="-1"><div class="tc-notice-body"><span class="tc-notice-title">Couldn’t read or save plugin hooks</span><span class="tc-notice-desc">${view.error} Refresh to review their current state.</span></div></div>` : ''}
            ${view.message ? html`<p class="tc-hint" role="status">${view.message}</p>` : ''}${view.loading ? html`<p class="tc-hint" role="status">Reading plugin hooks…</p>` : renderHooks()}
            ${(view.data?.warnings || []).map(warning => html`<p class="tc-hint">${warning}</p>`)}
          </div><div class="tc-sheet-foot tc-insp-foot">${view.pluginId ? html`<button class="tc-btn tc-btn--ghost" type="button" data-hooks-all${disabled(busy())}>All plugins</button>` : ''}<span class="tc-spacer"></span><button class="tc-btn" type="button" data-hooks-refresh${disabled(busy())}>${icon('refresh-cw')}Refresh</button><button class="tc-btn tc-btn--primary" type="button" data-hooks-close${disabled(view.saving || view.confirming)}>Done</button></div>` });
      window.addEventListener('beforeunload', beforeUnload);
      view.layer.panel.addEventListener('click', event => {
        const button = event.target.closest('button'); if (!button || button.disabled) return;
        if (button.hasAttribute('data-hooks-close')) close();
        else if (button.hasAttribute('data-hooks-refresh')) void load();
        else if (button.hasAttribute('data-hooks-all')) { view.pluginId = null; paint(); }
        else if (button.dataset.hookAction) void change(button.dataset.hookId, button.dataset.hookAction);
      });
      void load();
    };
    return { open, close };
  };
  return { create };
})();
