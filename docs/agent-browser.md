# Giving agents a browser

Recent T3 Code releases, including Nightly, have a **server-hosted browser**:
open the Browser panel to see the same tabs as your agents, from web, desktop
or mobile. T3 downloads its headless Chrome into the persistent home on first
use. The `browser` image supplies the libraries it needs.

The `browser` image sets `T3CODE_SERVER_BROWSER_SANDBOX=0`, T3's supported
option for hosts that cannot run Chrome's sandbox. Container and host policies
can block the kernel namespaces it needs, so the browser relies on the
container's isolation, just like our browser MCP launchers. This needs no
privileged container or host AppArmor changes. Set the variable to `1` only if
you have configured the host and container to support Chrome's own sandbox.

On an existing container, add `T3CODE_SERVER_BROWSER_SANDBOX=0` to its
environment and recreate it with the same volumes. Running `t3 browser setup`
inside the container cannot change the host's AppArmor policy. See
[T3's browser host setup](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md#browser-host-setup).

Stable 0.0.45 uses the older client-hosted preview: its server relays
`preview_open`, `preview_snapshot`, `preview_click`, and the other browser
tools to a web or desktop client. A phone alone cannot host that browser.

The `browser` image also includes separate headless browser MCP servers:

```bash
docker compose exec t3code t3-browser-mcp              # playwright, all agents
docker compose exec t3code t3-browser-mcp --server chrome-devtools --harness claude
docker compose exec t3code t3-browser-mcp --remove
```

This registers headless Chromium as an MCP server with the installed Claude
Code, Codex and OpenCode, so agents can navigate, take screenshots, click and
read the browser console, whichever client you use. The console's
**Instructions & skills → MCP servers** tab can define these commands and
apply them per provider, with the same restart rule. `t3-browser-mcp` writes
provider entries directly without creating shared definitions. Run either after the first
start has installed those agents (the setup page shows when), then start a new
thread, because agents read their MCP configuration when a session starts.

Playwright is the default. `chrome-devtools-mcp` officially supports Google
Chrome rather than Debian's Chromium. It works here (`t3-browser-mcp` passes
the sandbox flags it needs), but it is less tested.
