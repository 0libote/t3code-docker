# Global agent instructions

**Setup → Context** edits shared global instructions and existing provider
instruction files. The editor is centered
on desktop and opens as a bottom sheet on phones. Uploading a Markdown file
replaces the draft; only **Save** applies it. Downloads include unsaved edits.

The canonical file lives at `$T3CODE_HOME/setup/context/AGENTS.md`, on the state
volume. Saving writes it atomically with mode `0600`; initial creation links
missing native files:

| Provider | Native global instruction target | Environment override |
| --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/AGENTS.md` | `CODEX_HOME` |
| OpenCode | `~/.config/opencode/AGENTS.md` | `XDG_CONFIG_HOME` (config root) |

Each provider has a **Shared / Separate / None** selector:

- **Shared** uses the global file, so subsequent global edits reach that provider.
  **Edit** opens the shared editor. Switching an existing separate file to Shared
  asks for confirmation and backs up its directory entry next to the native file,
  with the suffix `.t3-context-backup`. Existing backups are never overwritten.
- **Separate** uses the provider's own file. Switching back restores its previous
  file, including the original permissions or relative symlink. If there is no
  previous file, it starts with a copy of the shared instructions; before shared
  instructions exist, it starts with a Markdown heading. The separate editor
  opens after switching. Later shared edits leave the separate file alone.
- **None** removes the native link or parks a separate file in its backup slot.
  Later global edits leave it disconnected; Separate restores the backup.
  Deleting the global file disconnects shared providers and keeps backups.
  Creating the global file again bootstraps missing native links.

Source choices are inferred from the native files and links; there is no new
manifest format. Provider IDs select fixed paths, so callers cannot supply an
arbitrary file path. A stale source selection is refused. A failed switch rolls
back the original entry when possible, and a preserved backup can be restored
with Separate after an interrupted switch.

Provider edits load the file's current contents and follow symlinks to the real
file, preserving the chain and file permissions. Other agents using the same
external file see that edit too. Shared and provider editors reject stale saves;
provider editors also detect a retargeted link. On a conflict, download the draft
and reopen the editor to load the current file. Missing or unreadable targets
cannot be saved over.

Creating shared instructions links missing native files; later saves update only
providers already using Shared. Existing separate
files stay in place until the user explicitly chooses Shared for that provider.
A symlink at the canonical shared file is refused rather than replaced.

Start a new agent session after saving: an existing session may retain the
instructions it loaded at startup. Project instructions and provider-specific
precedence still apply.

Only these three native integrations are included. Other providers, project
editing, skill management, catalogs, URL imports, saved setups and Cursor rule
translation are deferred to separate proposals.

## Validation

`node --test tests/*.test.mjs` checks file writes, existing-file discovery and
editing, shared/separate switching and restoration, symlink and permission
preservation, conflicting saves, view-model
behavior, and the authenticated HTTP boundary. The 64 KiB Markdown limit is
checked after JSON decoding, with a separate bounded allowance for encoding
overhead. Files containing escaped characters can use the full content limit. The Context API and
UI audits run against a disposable console, never a user's agent home:

```sh
node scripts/dev-console.mjs --port 23780
node scripts/context-api-audit.mjs http://127.0.0.1:23780/__setup/ dev
node scripts/context-ui-audit.js http://127.0.0.1:23780/__setup/ dev
```

Runtime discovery was checked on 2026-10-15 with Claude Code 2.1.300,
Codex 0.162.1 and OpenCode 2.0.29. Each CLI ran in a temporary home, with its
native instruction path linked by this module or an existing provider file
(including user symlinks and custom paths) edited through Context. Twelve additional runtime checks verified shared updates, restoration, separate
edits and independence from subsequent global changes. A unique instruction marker
appeared in the CLI's request to a local HTTP test server. The server rejected
the request after capturing it: no real credentials or paid model calls were
used. This verifies loading into a request, not model adherence or all versions.
Native paths follow the [Claude Code memory documentation](https://code.claude.com/docs/en/memory)
and [OpenCode rules documentation](https://opencode.ai/docs/rules/).
