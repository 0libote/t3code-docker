# Basic skill management in Context

Research and proposal, 2026-10-16. Repository inspected at `6129b0f`.
This document records the researched implementation plan. The first inventory
and local-file slices are implemented on `feat/context-skills-inventory`:
known-root discovery for all six providers, native Codex inventory/state,
Markdown viewing and add/edit/remove in Claude/Codex/OpenCode's own user skill
folders. Native Codex enable/disable is also implemented, with fresh discovery,
settings conflict checks and verified results. Shared storage and the other
providers' native activation controls remain planned.

## Recommendation

Add a **Skills** section below Instructions in **Setup → Context**. Start with
global skills for Claude Code, Codex and OpenCode, the three providers already
supported by Context. List existing installations, open their `SKILL.md`, add a
new Markdown skill, enable/disable it for a provider, and remove a local
installation. Keep plugin and system skills visible but read-only initially.

Use a small backend adapter for each provider. Prefer native inventory and
configuration APIs where they work; supplement these with bounded filesystem
discovery so disabled, invalid and broken installations remain visible. A model
call is unnecessary. The web UI should use authenticated setup HTTP routes.
An MCP tool can wrap the same service later if agent access becomes useful.

Use native files and native settings as the durable state. Do not introduce a
canonical T3 skill store, `.manifest.json`, presets or a synchronization loop.
This keeps the first version useful without deciding a new package format.

## What the PR discussion establishes

[PR #25](https://github.com/dizys/t3code-docker/pull/25) was merged with global
instructions only. The [maintainer's scope discussion](https://github.com/dizys/t3code-docker/pull/25#issuecomment-6185112239)
specifically separates a basic skill manager from catalog/import/preset work,
and asks for a decision about adopting `vercel-labs/skills` before committing to
a manifest format. It also identifies three relevant defects in the earlier
proposal: restore only enabled things, installs lacked update/delete, and regex
frontmatter handling misread folded descriptions and quoted names.

The first release proposed here avoids presets entirely, includes local removal
and editing, and treats upstream package updates as a separate operation from
editing installed Markdown.

## Provider research

### Codex: native inventory and toggle are a good fit

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server#skills)
provides `skills/list` with `cwds` and `forceReload`, plus
`skills/config/write` with `path` and `enabled`. Inventory includes disabled
skills and discovery errors. Use the absolute skill path returned by the API.
The [skills guide](https://learn.chatgpt.com/docs/build-skills)
documents user skills in `~/.agents/skills`, system/admin sources and native
disable entries in the Codex configuration. Runtime discovery also still
recognizes `$CODEX_HOME/skills` in the tested version.

**Locally verified:** Codex CLI **0.163.0**, isolated temporary home and project,
no inference request. An `initialize` handshake followed by `skills/list`
returned fixtures in both `.codex/skills` and `.agents/skills`. Calling
`skills/config/write` for the shared fixture returned
`effectiveEnabled: false`; a forced list retained that skill with
`enabled: false`. The generated `config.toml` used its full `SKILL.md` path.
System skills appeared too. This verifies inventory/configuration behavior,
not model adherence or all Codex versions.

**Implementation:** a bounded stdio App Server helper, resolved to the installed
binary, without starting a conversation. Cache results; do not spawn it on each
status poll. Validate both the write response and a fresh inventory. Keep system
and plugin content read-only for v1. The implemented controls cover native user
skills only, including shared/package-tracked skills whose content stays read-only.
`scripts/skills-native-smoke.mjs` verifies disable/re-enable, stale requests,
fresh-process persistence and configuration preservation against Codex 0.163.0.

### Claude Code: files plus native visibility settings

[Claude's skills documentation](https://code.claude.com/docs/en/skills)
documents personal skills under `~/.claude/skills`, additional managed/project/
plugin sources, and `skillOverrides` states including `on`, `name-only`,
`user-invocable-only` and `off`. Plugin skills are excluded from that setting.
Disabling automatic model invocation alone still permits manual invocation.
Recent versions watch local skill changes; already loaded instructions can
remain in conversation context.

**Implementation:** discover personal skill files and read the native settings;
use the user settings file under the resolved Claude config directory for
global overrides. Offer a toggle only after a disposable runtime check confirms
the installed version honors it. Preserve nonbinary visibility states in the
display. Do not call Claude's model to ask what skills are installed. A complete
runtime/plugin catalog is a later adapter improvement; a filesystem-only list
must advertise its coverage.

**Evidence limit:** Claude is not installed in this workspace, so these skill
controls were researched in current primary documentation, not tested locally.
PR #25's instruction-file checks do not verify skill behavior.

### OpenCode: support V1 and V2 separately

[V1 skills documentation](https://opencode.ai/docs/skills/)
describes global OpenCode skills and compatibility discovery in Claude and
`.agents` roots. Its native configuration is `permission.skill`, with
allow/ask/deny values.

[V2 skills documentation](https://dev.opencode.ai/v2/docs/skills/)
also supports flat Markdown skills, path-derived IDs, additional local sources
and different duplicate precedence. [V2 permissions](https://dev.opencode.ai/v2/docs/permissions/)
use an ordered `permissions` array of action/resource/effect rules. They are
not the V1 object shape. Respect agent rules and higher-priority policies.

The [V2 HTTP API](https://dev.opencode.ai/v2/docs/api)
documents `GET /api/skill`, returning currently registered skills including
paths and content. That result does not itself provide an effective enabled
boolean. Configuration inspection and permission evaluation remain necessary.

**Local discrepancy:** OpenCode **2.0.31** successfully answered
`opencode api --standalone GET /api/skill`, but returned an empty `data` array
for valid sample skills in a disposable home. Adding a Git project, a project
skill and explicit global `skills` sources did not change that result. Path
diagnostics confirmed the scratch home, and `/api/config` found its config.
The cause is unresolved; this does not establish that OpenCode cannot load
skills. Do not treat this probe as a successful discovery integration.

**Implementation:** detect the installed major version, build separate adapters
and resolve this discrepancy before using V2 inventory as authoritative. Use
filesystem discovery as an explicitly labeled fallback. Native API config
patching is preferable only if its installed schema supports the required field
and preserves existing configuration; otherwise use a comment-preserving JSONC
edit. A fresh native check must verify the change before reporting success.

### The other installed providers

The harness catalog supports six providers. The initial UI should show a clear
support/coverage state for each installed one rather than implying unsupported
providers have zero skills. These three can be added independently:

| Provider | Primary research | Proposed initial treatment |
| --- | --- | --- |
| Cursor | [Skills docs](https://cursor.com/docs/skills) document `.cursor`, `.agents`, Claude and Codex compatibility roots. Automatic-invocation control still permits manual use. | Inventory known global files with limited-coverage text. Validate the installed CLI separately before offering full disable. |
| Grok Build | [Skills docs](https://docs.x.ai/build/features/skills-plugins-marketplaces) document native, plugin, compatibility and extra roots. [Settings reference](https://docs.x.ai/build/settings/reference) documents `[skills].disabled` name lists. | A promising next full adapter: verify the installed version's inventory/config interface before adding writes. |
| Muse Code | [Extending docs](https://dev.meta.ai/docs/muse-code/extending) document native/shared/foreign roots and `muse skills list`, `inspect`, `enable`, `install` and `validate`. | Prefer native commands; verify structured output, disable behavior and supported scopes locally before exposing controls. |

None of these three was runtime-tested here. Do not assume desktop/cloud
capabilities or current web documentation match every installed CLI release.

## Why not make the skills CLI the whole backend?

I inspected `vercel-labs/skills` at
[`13e4063`](https://github.com/vercel-labs/skills/tree/13e4063a1cf913f5606d57d42ab83a86f5001e04)
(package version `1.7.2`). Its [command implementation](https://github.com/vercel-labs/skills/blob/13e4063a1cf913f5606d57d42ab83a86f5001e04/src/cli.ts)
offers list/add/remove/update, and its [list implementation](https://github.com/vercel-labs/skills/blob/13e4063a1cf913f5606d57d42ab83a86f5001e04/src/list.ts)
supports `skills list -g --json`. The JSON includes names, canonical paths,
scope, agents and source metadata, but no native enabled state. The
[installer](https://github.com/vercel-labs/skills/blob/13e4063a1cf913f5606d57d42ab83a86f5001e04/src/installer.ts)
discovers canonical and detected-agent directories and deduplicates by
scope/name. That can hide distinctions our editor needs. There is no
enable/disable command in that inspected command dispatch.

**Recommendation:** keep it as a future installation/update adapter. It does not
replace native availability controls. Avoid downloading/running unpinned `npx`
code during page loads, and do not hand-edit its lock files. Local skills can
coexist with its installations; package-managed skills should initially identify
their source and stay read-only to avoid silently creating local package forks.

## First-release behavior

1. A **Skills** section below Instructions has a provider selector, Refresh and
   Add skill. Display global skills only. Explain that project/session overrides
   can change availability. Provider-specific T3 instances sharing the same home
   share these settings; v1 is not per-model or per-thread configuration.
2. Each row shows name, short description, source and state. Use Enabled,
   Disabled, Ask, Manual only, Invalid or Unknown as appropriate. Distinguish
   unavailable scans from empty results. Details show path, native identity,
   coverage and other discovered consumers of the same resolved file.
3. **Edit** opens the existing desktop dialog/mobile sheet pattern, loads raw
   Markdown on demand, and saves only `SKILL.md`. Preserve scripts, reference
   files, unknown frontmatter and permissions. Warn before saving a shared target
   that other providers use. Malformed editable skills remain available to repair.
4. **Add skill** accepts a name, description and instructions, or a Markdown
   upload/paste. Write a single directory plus `SKILL.md` into the selected
   provider's native user root. For Codex, use `$CODEX_HOME/skills`, which the
   local probe verified, instead of automatically broadcasting through
   `~/.agents/skills`. Other providers may still discover compatibility roots;
   report that explicitly. Reject collisions; never replace an existing skill.
5. **Disable** changes provider configuration, leaving content in place.
   **Enable** updates the specific native setting; keep ask/manual-only states
   visible and require an explicit choice before replacing them. Include
   **Use provider default** in details. Do not promise restoration of a previous
   custom policy unless it was actually preserved. Re-read effective state and
   report when another policy still prevents use.
6. **Remove installation** is separate from disabling. Allow removal of local
   user installations after a UI confirmation describing the directory and known
   consumers. For a symlink, remove the selected link and retain the external
   target. Rescan: another installation may still provide that skill. Leave
   plugin/system/package removal to its owner initially.

Do not offer a cross-provider checkbox grid in v1. Native name-based controls
can also affect another definition with the same name; explain that scope in
details rather than suggesting every switch is path-specific. Changes apply to
future loading; they cannot erase instructions already in a conversation.

## Backend and state design

Introduce `docker/setup/skills.mjs` with discovery, normalization and local file
operations, plus small provider adapter modules. Keep `context.mjs` focused on
instructions. Build on these existing seams:

- `docker/setup/app.js`: `contextPage`, file import/export and dialog/sheet UI.
- `docker/setup/client/model.js`: pure row/view models.
- `docker/setup/server.mjs`: authenticated routes, bounded bodies, events and
  installed-harness facts. Add routes to its explicit route allowlist.
- `docker/harness/catalogue.mjs`: versions and executable resolution. Do not
  assume PATH points to the configured provider binary.
- `docker/entrypoint.sh`: persistence of agent directories.
- `tests/context.test.mjs`, `tests/context-api.test.mjs` and the Context audit
  scripts: examples of filesystem, HTTP and UI verification.

Suggested HTTP surface, using the existing GET/POST conventions:

```text
GET  /context/skills?provider=codex
GET  /context/skills/read?id=<opaque installation id>
POST /context/skills/create       { provider, slug, content }
POST /context/skills/save         { id, revision, content }
POST /context/skills/state        { provider, id, stateRevision, enabled }
POST /context/skills/remove       { id, revision }
```

IDs identify provider/source/path combinations; do not deduplicate by name.
Use resolved-path identity to identify shared content. Return capabilities
(`canEdit`, `canToggle`, `canRemove`) and discovery coverage/reasons alongside
metadata. Server-side path validation and fresh discovery must authorize every
action; an opaque ID alone does not make a supplied path safe.

Keep inventory separate from `/status`: fetch on entering Context, switching
provider and Refresh. Cache/single-flight the same request; invalidate after
mutations. No provider processes or full skill-body scans on every console poll.
Bound native subprocess time/output and filesystem entry count/depth/bytes;
surface truncation and partial results. Strip bodies from inventory responses.

For local edits, reuse the current patterns, not every assumption: bounded
64 KiB editor reads, resolved-target writes, permission preservation, content
revision checks, target-link rechecks and per-target serialization. Configuration
edits need the same conflict protection. Atomic rename does not coordinate with
external CLI writers, so detect changes again before writing and report conflicts.
Native methods without compare-and-swap have a residual external-writer race;
do not describe them as fully transaction-safe.

Use a real YAML parser for frontmatter and a structural JSONC editor when needed.
Recommend small pinned, license-recorded vendored modules so the image keeps its
no-runtime-install model. This is a deliberate dependency decision, not permission
to use regex parsing or depend on packages incidentally installed by an agent.
Parse metadata without executing hooks, scripts or dynamic skill content. Show
existing nonstandard skills with diagnostics; new skills should use a portable
slug and name/description format from the [Agent Skills specification](https://agentskills.io/specification).

Respect `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, XDG paths and provider-specific config
overrides. Verify the environment of managed T3 instances matches the setup
service before claiming the inventory is exact. Custom binaries/environments
need explicit coverage limitations.

**Persistence gap:** `entrypoint.sh` currently persists `.claude`, `.codex` and
`.config/opencode`, among other provider homes, but not `~/.agents`. Add narrowly
scoped persistence for `.agents/skills` if shared-root files are editable, using
the existing mounted-path preservation behavior. Include it before shipping
writes to that root. A custom root outside persistent mounts needs an explicit
storage-status message. Existing native roots should not be relocated wholesale.

## Delivery sequence

**PR 1 — Inventory and details.** Add adapter contracts, bounded discovery,
coverage/capability states, read endpoints and the Skills section. Prove Codex
inventory and resolve the OpenCode discrepancy; verify Claude's native behavior
in a scratch installation. Other installed providers show known-root inventory
or an explicit support message. No configuration mutations in this PR.

**PR 2 — Add, edit and remove local skills.** Add parser support, file operations,
conflict-safe editor, Markdown import/export and shared-target handling. Address
the `.agents/skills` persistence gap in this change if that root is writable.
Read-only plugin/system/package rows remain visible.

**PR 3 — Native enable/disable.** Add Codex state writes, verified Claude
overrides and OpenCode V1/V2 permission adapters. Expose controls by installed
capability, validate effective state, and keep existing richer policies visible.
This completes the basic manager. Grok/Muse/Cursor full adapters can follow
without changing storage design or blocking the initial three.

An approximate planning allowance is **4–7 focused development days**, plus
review/CI, assuming native provider checks succeed. This is an estimate, not a
validated implementation schedule; the OpenCode mismatch and parser/config
compatibility are the main uncertainty. PR 1 is useful on its own.

## Validation and acceptance

- Fixtures for existing native, shared, copied and symlinked installations;
  disabled/invalid/broken entries; duplicate names; unavailable roots; custom
  homes and partial scans. Unknown results must never become an empty success.
- File/config tests for stale saves, retargeted links, permissions, supporting
  files, concurrent operations, quoted/folded YAML, unknown fields, JSONC
  comments and decoded-size limits. Test API authentication and ID/path escapes.
- Provider checks in temporary homes using installed versions: discover a unique
  marker, edit and refresh, disable and confirm unavailable, re-enable and
  confirm available, remove and rescan. Verify model-facing advertisement and
  explicit invocation denial where possible, using a local capture server
  rather than paid inference. Test shared-root effects across providers.
- Exercise both supported OpenCode majors. Test unsupported feature/version
  responses. Provider checks must not inherit a real home or credentials.
- UI audit at phone and desktop widths, both themes: selection, loading/errors,
  toggles, stale responses, upload and retained drafts. Block close/duplicate
  submission during writes or explicitly preserve the in-flight operation.
- Run the repository Node suite and UI audit, then relevant image/persistence
  smoke checks. Verify skills and native disabled settings survive container
  recreation, not just process restart.

The release is ready when pre-existing global skills can be inspected, eligible
local files can be created/edited/removed, supported native controls actually
change availability, and the UI accurately describes incomplete coverage.

## Keep for later

Project selection/editing, catalogs, Git/URL/ZIP imports, remote package updates,
preset restore, cross-provider synchronization, plugin lifecycle management,
supporting-file editors, skill execution and an agent-facing MCP tool. None is
needed to deliver the first useful Context feature.
