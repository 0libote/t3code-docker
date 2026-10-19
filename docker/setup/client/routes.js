// The console's pages, in one table.
//
// The shell (page.mjs, on the server) draws the sidebar and the phone's tab
// bar from it; app.js routes, titles and heads each page with it; the view
// model offers it in the command palette; the shortcuts are its keys. A page
// is added, renamed or moved here and nowhere else.
//
// Like model.js this is a classic script with no DOM: the server and the tests
// run it under Node, and the page inlines it before model.js.
const T3Routes = (() => {
  'use strict';

  // Each page: its route (the address's #hash), its title, the icon beside it
  // in the sidebar, the second key of its G shortcut (G A for Agents), the
  // sidebar group it sits in, a one-line summary for its header, and the guide
  // in docs/ that explains it.
  const PAGES = [
    { route: 'overview', title: 'Overview', icon: 'layout-dashboard', key: 'o', group: 'main',
      summary: 'Setup progress, and anything on this server that needs you.', doc: 'setup-page.md' },
    { route: 'devices', title: 'Devices', icon: 'smartphone', key: 'd', group: 'main',
      summary: 'Pair a phone or browser with this server, and manage the ones that can reach it.', doc: 'remote-access.md' },
    { route: 'agents', title: 'Agents', icon: 'bot', key: 'a', group: 'main',
      summary: 'Install, sign in and update your coding agents.', doc: 'agents.md' },
    { route: 'context', title: 'Context', icon: 'book-open', key: 'c', group: 'main',
      summary: 'Instructions and skills your agents load at the start of every session.', doc: 'context-management.md' },
    { route: 'toolchains', title: 'Toolchains', icon: 'wrench', key: 't', group: 'main',
      summary: 'Languages and tools on every agent’s path, at exact versions.', doc: 'toolchains.md' },
    { route: 'sourcecontrol', title: 'Source control', icon: 'git-pull-request', key: 's', group: 'main',
      summary: 'The CLIs T3 Code uses to open pull requests.', doc: 'source-control.md' },
    { route: 'ports', title: 'Ports', icon: 'ethernet-port', key: 'p', group: 'main',
      summary: 'Give a dev server running here a public HTTPS address.', doc: 'ports.md' },
    { route: 'environment', title: 'Environment', icon: 'settings-2', key: 'e', group: 'main',
      summary: 'T3 Code, this container and the setup console itself.', doc: 'configuration.md' },
  ];

  // Sidebar groups, in order; a group without a label draws no heading.
  const GROUPS = [
    { id: 'main', label: null },
  ];

  // The phone's tab bar. Every other page lives under More, which lists them
  // in the sidebar's groups.
  const TABS = [
    { route: 'overview', title: 'Overview', icon: 'layout-dashboard' },
    { route: 'devices', title: 'Devices', icon: 'smartphone' },
    { route: 'agents', title: 'Agents', icon: 'bot' },
    { route: 'ports', title: 'Ports', icon: 'ethernet-port' },
    { route: 'more', title: 'More', icon: 'ellipsis' },
  ];
  const MORE = { route: 'more', title: 'More', icon: 'ellipsis', key: null, group: null, summary: 'Everything else on this server.', doc: null };

  // Addresses a page had before it moved, so an old bookmark or a link from an
  // older T3 Code still lands where it meant to.
  const ALIASES = {};

  const BY_ROUTE = new Map([...PAGES, MORE].map((page) => [page.route, page]));
  const page = (route) => BY_ROUTE.get(route) || null;
  /** The page an address names, through its aliases; null when it names none. */
  const resolve = (name) => (BY_ROUTE.has(name) ? name : ALIASES[name] || null);
  /** The tab that holds a page on a phone. */
  const tabOf = (route) => (TABS.some((tab) => tab.route === route) ? route : 'more');
  /** Pages in their sidebar groups, each group with its label. */
  const grouped = () => GROUPS.map((group) => ({ ...group, pages: PAGES.filter((p) => p.group === group.id) }));

  /**
   * A guide's address on GitHub, at the release this image was built from so
   * it describes what is running; a branch build or an unknown one reads main.
   */
  const REPO = 'https://github.com/dizys/t3code-docker/blob/';
  const docUrl = (doc, imageVersion) => {
    const release = /^v?(\d+\.\d+\.\d+)$/.exec(String(imageVersion || '').trim());
    return REPO + (release ? 'v' + release[1] : 'main') + '/docs/' + doc;
  };

  return { PAGES, GROUPS, TABS, ALIASES, page, resolve, tabOf, grouped, docUrl };
})();
