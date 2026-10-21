# Skills redesign verification

final result: passed

Date: 2026-10-21. Reference: the user's `t3code-skills-handoff.zip`, SHA256
`9285a3ba6b9afc2c51944e730329e61491ee82175f79c5ba48ba7f5238dfeb7f`.
The handoff README defines behavior; its eight screen families define the visual
reference. The implementation uses the existing vanilla JS Kit and unchanged
vendored design tokens, components and agent marks. No runtime dependency was added.

## Comparison setup

The actual console is rendered by `scripts/console-preview.mjs` on port 23785,
using synthetic API fixtures for all seven providers. No production API or agent
files are connected to that review server. Native T3 preview was used for
interactive verification, including phone sheets, native policy selects and the
import steps. The repository's documented Playwright audits supply repeatable
captures and adversarial interaction checks.

Desktop references are 2880×1800 pixels at 2× density, or 2880×4040 for the full
library. Desktop renders use 1440×900 CSS pixels at 1× density. Reference images
were reduced to 50% and aligned to the same viewport; the library uses its first
900 CSS pixels for the overview and a separate policy-menu state. Phone
references and renders are both 780×1688 pixels, at 390×844 CSS pixels and 2×
density; both were normalized to 390×844 for comparison. Phone rendering uses
`data-density="touch"`.

All eight screen families were captured in light and dark, with source and
implementation joined horizontally in the **same image**. Temporary comparisons
are `/tmp/t3-skills-redesign-comparisons/<screen>-<theme>-compare.png`; captures
are `/tmp/t3-skills-redesign-reviewed-visuals/skills`. Focused inspection covered
cell menus, native selects, notices, availability rows, replacement consent,
results, fixed phone actions and sheet footers. Saved implementation images for
review are linked below.

Source examples use different skill names/content in several screens. The
fixtures preserve the relevant physical identities, folder reach, five installed
agents, two hidden agents, native states, one metadata problem and three import
selections. Those data differences were not treated as layout defects. The
results capture deliberately includes one failed copy, matching the reference's
partial-result state. The Agents capture includes confirmed replacement consent.

## Iteration findings and fixes

| Priority | Finding | Fix and post-fix evidence |
| --- | --- | --- |
| P1 | A previous page error toast could intercept the wizard's primary action. | The installer reports errors inline and keeps earlier page toasts out of its action area. The state-failure → install regression passes without forced clicks. |
| P2 | The general phone header and desktop warning card consumed too much of the library viewport. | Added the compact Setup back header, one tappable problem row, grouped list and fixed install bar. Phone light/dark captures show the list immediately below the filters. |
| P2 | Inspector availability rows put missing agents before actionable controls, and the phone editor action was narrow. | Available agents precede missing ones. Found/copy controls align beside names; policies use full-width native selects. The phone footer's Open SKILL.md action fills the available space. |
| P2 | The phone plan summary lost its expansion state during a choice repaint. | The wizard owns that state; its button exposes `aria-expanded` and `aria-controls`. Phone audits expand and read the plan, then continue through installation. |
| P2 | The result view retained a continue shortcut and placed its library action on the wrong side. | Results have Show in library on the left and Done on the right; no continue shortcut. Failed rows retain their error and adjacent Review again action. |
| P2 | The shell's paragraph margin reset defeated the rail's bottom note. | A scoped selector restores the bottom alignment; the desktop browser audit checks the note's 20px bottom inset. Fresh placement/result captures were compared after this fix. The check waits for the layout to settle before measuring; a transient 2px initial-frame difference does not cause a flaky failure. |
| P1 | Show in library could retain the old search field value and target a hidden desktop row on phones. | It clears the actual field and scrolls the visible highlighted row, respecting reduced motion. Desktop/phone regressions start with an active search and verify it clears. |

## Intentional adaptations

- Existing product agent logos replace the illustrative colored monograms.
- The handoff README requires 44px touch targets and full-width phone policy
  selects. These take more space than the smaller inline selects in the phone
  PNG; the sheet scrolls and keeps its actions fixed.
- Kit positions menus inside the actual viewport, including flipping above a
  cell when needed. The static reference menu can extend below that viewport.
- The standalone phone header links to the guide; inside T3 Code it offers the
  host's Close action. Setup back navigation works in either context.
- Skills counts appear after discovery; opening Instructions alone does not run
  native skill discovery just to populate a tab badge.
- Cursor's documented compatibility paths confirm that both copies can be
  found. No unsupported claim is made about duplicate-name precedence or Codex
  automatically enabling new skills. See the primary references in
  [Context management](docs/context-management.md).

## Verification

- Full suite: **639 tests passed**, no failures or skips.
- Skills browser audit: light/dark at 1440×900, 390×844, 360×720, 820×900 and
  1198×878 embedded. Includes physical joins/filters, independent settings
  columns, failed/stale writes, late reads/source/plan replies, untrusted text,
  revision-preserving drafts, upload/download/create/remove, replacement consent,
  blocked destinations, expiry, non-dismissible publication and partial retry.
- Instructions browser audit: all ten light/dark viewport combinations passed;
  includes source confirmations, draft preservation, conflicts and oversized files.
- Repository geometry audit: **no findings**, 23 states at each of seven
  standalone/embedded viewport configurations.
- Screens: **26 captures** across the affected pages and overlay states in both
  themes, including both phone layouts. No horizontal page overflow.
- Native selects retain readable option colors, keyboard focus and native
  indicators under forced colors. Escape returns focus from the cell menu.
- Native preview contrast samples: light text ratios **4.75–15.09:1**, dark
  **4.85–17.32:1**, covering descriptions, metadata, availability notes, Found and
  section labels. Existing design tokens were preserved.
- Claude Code **2.1.305** metadata-only smoke passed all four visibility states,
  persistence, conflicts and permissions without a model turn. The current
  [official reference](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings)
  independently confirms the menu semantics.
- Classic script syntax, inline-asset tests, shell syntax and `git diff --check`
  pass. The image smoke workflow now copies the shared audit fixtures into its
  disposable container. Docker builds were not run locally: this workspace has
  no Docker CLI; the PR matrix performs the image/architecture checks.

## Review images

| Surface | Light | Dark |
| --- | --- | --- |
| Library | [Desktop](docs/media/skills/library-light.png) | [Desktop](docs/media/skills/library-dark.png) |
| Instructions | [Desktop](docs/media/skills/instructions-light.png) | [Desktop](docs/media/skills/instructions-dark.png) |
| Placement and consent | [Desktop](docs/media/skills/placement-light.png) | [Desktop](docs/media/skills/placement-dark.png) |
| Phone library | [Phone](docs/media/skills/phone-library-light.png) | [Phone](docs/media/skills/phone-library-dark.png) |
| Phone inspector | [Phone](docs/media/skills/phone-inspector-light.png) | [Phone](docs/media/skills/phone-inspector-dark.png) |

Reproduce with the pinned Node 24 executable on PATH, the existing Playwright
installation on NODE_PATH and Chromium via CHROME_PATH:

```sh
node scripts/console-preview.mjs --port 23785
node scripts/skills-ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/context-ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/ui-audit.js http://127.0.0.1:23785/__setup/ dev
node scripts/console-screens.js http://127.0.0.1:23785/__setup/ dev --routes instructions,instructions/skills --scenarios skills --sizes desktop,phone --themes light,dark --skill-overlays
```
