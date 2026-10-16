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

Status polls and editor loads check the resolved file size before reading.
Files larger than 64 KiB stay in place and show as too large to edit; reduce
them directly on disk before editing in the console. Reads are capped at
64 KiB plus one byte to detect growth after the size check. Shared and separate
source choices remain visible, but unavailable files cannot be edited or
switched through the console.

Creating shared instructions links missing native files; later saves update only
providers already using Shared. Existing separate
files stay in place until the user explicitly chooses Shared for that provider.
A symlink at the canonical shared file is refused rather than replaced.

Start a new agent session after saving: an existing session may retain the
instructions it loaded at startup. Project instructions and provider-specific
precedence still apply.

Only these three native instruction integrations are included. Project
instruction editing, catalogs, URL imports, saved setups and Cursor rule
translation are deferred to separate proposals.

## Global skill inventory

The **Skills** section provides inventory and local file management from the
[skill management plan](skill-management-plan.md). Select Claude Code, Codex,
OpenCode, Cursor, Grok Build or Muse Code to inspect known global skill folders.
Nested `SKILL.md` files, compatibility directories, shared files and broken
links remain distinct installations. OpenCode's flat global Markdown files
are included too. Environment overrides for Claude, Codex, XDG and Grok roots
are honored.

**View** opens raw Markdown in a desktop dialog or phone sheet. Copy and
download preserve its text; skill Markdown is not rendered as HTML or executed.
Metadata uses a pinned vendored YAML parser, including quoted names and folded
descriptions. Parse problems, missing targets and oversized files stay visible.
Content reads are limited to 64 KiB, frontmatter to 16 KiB. Local scans are
bounded by entry count, depth, skill count, total bytes and elapsed time.
Truncated or unavailable locations produce visible scan messages.

The managed Codex executable is queried through its App Server using only
`initialize` and `skills/list` for inventory; no conversation or model turn is started.
Native global/system/admin entries include Enabled/Disabled state. Known local
files absent from that native result remain Unverified. Native discovery has a
six-second deadline and a 2 MiB output limit; unsupported or unavailable versions
fall back to the local list with a reason. Custom T3 provider binaries,
environments and project/session overrides may produce different inventories.

Other providers currently use local folder discovery and show **Unverified**
availability. Plugin inventories, configured extra locations and effective
permission evaluation are not included in those adapters. In particular,
OpenCode 2's experimental native list returned empty for the research fixtures,
so it is not treated as an authoritative empty inventory.

Inventory loads when Context opens or its provider changes. **Refresh skills**
rescans after external changes. Concurrent requests share a lookup and results
are cached for 15 seconds; regular `/status` polling does not scan skills.
Bodies load separately through authenticated, discovered-installation IDs.
Details refuse a link retargeted after discovery. No skill files, provider
settings or persistence mappings change during inventory reads. Native Codex
startup may maintain its own system-skill cache as usual.

### Add, edit and remove local skills

Claude Code, Codex and OpenCode's own user skill folders support **Add skill**,
**Edit** and **Remove**. Add accepts a portable folder name and raw Markdown,
including upload/paste. The frontmatter name must match the new folder name.
Existing installation names are never overwritten; new files use mode `0600`.
These native directories already participate in the image's agent-home
persistence when `T3_PERSIST_AGENT_CREDENTIALS` is enabled. Custom locations need
their own persistent mounts.

Editing changes only `SKILL.md`, preserves its existing permissions and follows
user file/directory symlinks. Supporting scripts and references stay in place.
Providers using that same target see the change too. Read responses include a
revision covering content, target identity and permissions; saves reject stale
revisions, missing targets and retargeted links. A failed save retains the draft
for download. Save uses a temporary file and atomic rename, with serialization
per resolved target. An external writer can still race between the final check
and rename; this is not a filesystem transaction with other applications.

Removal requires confirmation and both a file revision and a bounded supporting
tree fingerprint. A changed supporting file invalidates the confirmation.
Ordinary skill folders are moved aside, verified again and removed, including
their supporting files. Directory/file link removal preserves the linked target.
Root-level Markdown removal removes only that file. A skill containing a nested
installation cannot be recursively removed from the console. Changes during the
move trigger rollback; if the original path is occupied, or removal fails, the
error identifies the preserved entry for manual recovery.

System, plugin, package-tracked, compatibility and shared `.agents` installations
remain read-only here. A provider root linked to shared or plugin storage also
cannot create skills. The global skills CLI lock is read only to recognize
package ownership; the console does not edit its lock or create a T3 manifest.
Oversized/unreadable locks conservatively disable local changes. Shared-root
persistence remains planned work. These restrictions cover Markdown changes;
Codex availability controls can still apply to a native user skill stored there.

### Native Codex availability

**Enable** and **Disable** appear for user skills verified by the managed Codex
inventory, including shared and package-tracked user skills. The console sends
the selected installation's path to Codex's native `skills/config/write` method.
It changes Codex availability only, leaves Markdown and other providers alone,
and uses Codex's existing user configuration persistence. System, admin, plugin,
unavailable and filesystem-only entries do not offer these controls.

Requests carry an opaque revision covering native settings and the selected
installation/state. The service reloads inventory and checks settings immediately
before writing, rejects stale requests, and serializes console changes against
the same config file. Settings reads are bounded to 1 MiB; unsafe or unavailable
settings leave inventory usable with controls disabled. Configuration contents
are never included in responses. Codex preserves the configuration through its
own writer; the console does not parse or rewrite TOML.

Both the write acknowledgement and a freshly started native inventory must
confirm the requested state before success is reported. Failed or ambiguous
writes trigger a refresh; they are not automatically rolled back. Native writes
do not support compare-and-swap, so an external writer can still race the last
check. Start a new conversation after changing availability: loaded instructions
can remain in existing conversations, and project/session settings may differ.
Claude's richer visibility states and OpenCode's version-specific permission
rules still require runtime verification before exposing native controls.

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
node scripts/skills-ui-audit.js http://127.0.0.1:23780/__setup/ dev
```

The browser audits need `playwright` or `playwright-core` and Chromium. In an
image with Playwright under `/opt/t3/node_modules`, set
`NODE_PATH=/opt/t3/node_modules` for these commands. Skill UI checks use response
fixtures and never change installed skills. Unit/HTTP tests cover bounded
discovery, native protocol failure, duplicate names, YAML metadata, cache and
refresh behavior, authentication, unknown IDs, deleted files and retargeted links.
Local file checks cover add/edit/remove, stale/concurrent saves, permission and
symlink preservation, supporting-file conflicts, package ownership, failed
publication and interrupted-removal rollback. Native control checks cover stale
settings, native write/verification failures and serialized requests. Browser
checks cover Markdown upload, draft recovery, save progress, explicit removal
confirmation, native state failures, busy controls and late provider responses.

The adapters were also checked with Codex 0.163.0 in a disposable home. Native
enable/disable, stale-request rejection, settings persistence across fresh
processes, shared-file isolation and unrelated configuration/comment preservation
passed without inference. Reproduce using the installed executable's absolute
path (the script creates and removes its own temporary home):

```sh
node scripts/skills-native-smoke.mjs /absolute/path/to/codex
```

Other providers' native skill activation has not been verified by this implementation.

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
