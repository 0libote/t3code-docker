# Spike: skills-hub CLI for skills/plugin support

Branch: `exp/skills-hub-sync` (off `main`). Disposable test only, no repo changes.
Test home: `/tmp/sh-hub-test`, CLI 1.0.1 (`skillshub-cli`), glibc 2.41 satisfies CLI's 2.39 floor.

## What skills-hub is

Central library (`~/.skillshub/<skill>`) + `deploy` to 48 tool adapters
(`agents list`: global dir, project dir, detection dir, `sync_mode`).
Commands are JSON-stable: `skills install/list/search/show/status/check`,
`skills deploy/undeploy [--agent …] [--project …] [--dry-run]`,
`skills update/check --all`, `skills adopt --dry-run/--yes`, `tag`, `remove`
(recycle bin). Install script is SHA-256 verified, `~/.local/bin`, no node/npm.

## Experiment: ponytail

- `skills install https://github.com/DietrichGebert/ponytail` returns
  `MULTI_SKILLS` with 6 candidates (`skills/ponytail`, `-audit`, `-debt`,
  `-gain`, `-help`, `-review`). One `--subpath` each — same per-skill
  friction our preview has.
- Library records git source + revision + content hash; `check` reports
  `update_available` without touching targets. Closest existing equivalent
  to our `origins.mjs` fingerprint + `check-update` model.
- `deploy --dry-run` previews; real deploy defaults to **symlink**
  (`mode: symlink`) from each tool dir to the central copy, not a copy.
- Deploy **refuses unknown tools**: `AGENT_NOT_FOUND … not_installed`
  until the detection dir exists (created `.claude`, `.codex`,
  `.config/opencode` to proceed). Our console manages files regardless
  of detection — UX gap to note.
- Conflict: planting an unmanaged `skills/ponytail/SKILL.md` then
  deploying gives `TARGET_CONFLICT … unmanaged_target`; `adopt --dry-run`
  is the recovery path. Mirrors our replacement-consent + fingerprint
  checks, but centralized.

## What it can't do (plugin gap remains)

- No plugin/marketplace/hook handling: no `marketplace add`, no
  `.claude-plugin` / `.codex-plugin` hooks, no `opencode.json` plugins
  array, no Cursor `hooks.json` merge, no Grok enable list. Deploying
  all 6 ponytail skills still yields prompt-only skills, same as our copy.
- No native policy controls: no Claude `skillOverrides`, OpenCode
  `permission.skill`/`permissions`, Codex `skills/config/write`
  enable/disable. Complementary to, not a replacement for,
  `docker/setup/skills/policies.mjs` + `native.mjs`.
- No bundled/system/plugin inventory distinction beyond
  managed-vs-unmanaged; our hide-bundled + read-only plugin roots
  still add value.

## Options for this repo

1. **Adapter table**: borrow the 48-entry global/project/detection paths
   (`tool_adapters/mod.rs`) to grow beyond our 7 providers. MIT licensed.
   → Landed in part: `docker/setup/skills/adapters.mjs` + `adapter` on the
   inventory + `tests/skill-adapters.test.mjs` (the update half came via
   `feat/skill-source-updates`, below).
2. **Library + symlink deploy**: single update point + `check/update --all`
   beats per-provider copies, but changes persistence (central lib must be
   on the state volume), edit/remove semantics (symlink vs copy), and the
   no-shell setup-page story (CLI vs native service).
   → Landed in copy-model form via `feat/skill-source-updates`:
   `.t3-skill-source.json` provenance + on-demand `check-update`, no
   central library, no symlinks.
3. **CLI bridge**: shell to `skillshub-cli --json` like `native.mjs` shells
   to managed CLIs — bounded, allowlisted subcommands, dry-run first.
   Still leaves the ponytail plugin layer (hooks/commands/marketplace) open.

Not committing to any option here; this file is the spike record.
