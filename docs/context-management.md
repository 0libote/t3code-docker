# Global agent instructions

**Setup → Context** edits shared global instructions and existing provider
instruction files. The editor is centered
on desktop and opens as a bottom sheet on phones. Uploading a Markdown file
replaces the draft; only **Save** applies it. Downloads include unsaved edits.

The canonical file lives at `$T3CODE_HOME/setup/context/AGENTS.md`, on the state
volume. Saving writes it atomically with mode `0600` and creates missing links:

| Provider | Native global instruction target | Environment override |
| --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/AGENTS.md` | `CODEX_HOME` |
| OpenCode | `~/.config/opencode/AGENTS.md` | `XDG_CONFIG_HOME` (config root) |

Existing provider files appear as separate rows labelled **Claude Code
instructions**, **Codex instructions** or **OpenCode instructions**. Opening
one loads its current contents; **Save** updates that existing file. Distinct
provider instructions stay separate. They are never merged or replaced by
saving the shared file.

Provider edits follow symlinks to the real file and preserve the link chain and
file permissions. Any other agent using that same file sees the edit too.
Both shared and provider editors reject changed contents instead of overwriting
work made since the editor opened; provider editors also detect a retargeted link. The draft stays available to download;
close and reopen the editor to load the current version before saving again.
Missing targets, dangling links, directories and read failures cannot be saved
over. Provider IDs select fixed native paths, so callers cannot supply an
arbitrary file path.

Saving the shared file creates only missing provider links. Existing files and
user-owned links stay in place and are reported in the notification. Links to
the shared file use its single editor rather than duplicate provider rows.
A symlink at the canonical shared file is refused, so saving cannot silently
replace it.

Start a new agent session after saving: an existing session may retain the
instructions it loaded at startup. Project instructions and provider-specific
precedence still apply.

Only these three native integrations are included. Other providers, project
editing, skill management, catalogs, URL imports, saved setups and Cursor rule
translation are deferred to separate proposals.

## Validation

`node --test tests/*.test.mjs` checks file writes, existing-file discovery and
editing, symlink and permission preservation, conflicting saves, view-model
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
(including user symlinks and custom paths) edited through Context. A unique instruction marker
appeared in the CLI's request to a local HTTP test server. The server rejected
the request after capturing it: no real credentials or paid model calls were
used. This verifies loading into a request, not model adherence or all versions.
Native paths follow the [Claude Code memory documentation](https://code.claude.com/docs/en/memory)
and [OpenCode rules documentation](https://opencode.ai/docs/rules/).
