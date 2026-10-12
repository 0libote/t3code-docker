# T3 Code update card visual review — PR #22

The screenshots are browser captures of the repository's actual `loadAssets` / `renderConsole` frontend. A loopback-only HTTP fixture server supplies isolated Setup status data; it cannot install releases. Available-update, progress, recovery, offline, and unsupported states are simulated. No running T3 Code instance or container was changed for these captures.

- Before: released v0.13.0 frontend, commit `cfe2ac670ff7b73c193b8f6fe921cddcb37ffca4`.
- After: PR implementation, commit `10a0338b51608eb2acf02a3a548db1533fac407b`.
- Browser: headless Chromium through Playwright, 2× device scale, reduced motion.
- Desktop capture: 1440 × 1000 CSS viewport. Phone: 390 × 844. Narrow Nightly example: 320 × 900. Context: full-page desktop screenshot at 1440 × 1100.
- Before/after card screenshots use Playwright's element screenshot, without compositing or image edits. The context image is a full-page capture.
- T3 preview automation and native iOS/Android devices were explicitly unavailable on this host; phone checks use responsive Chromium viewports.

## Verified rendering

`proof.json` and `verify-final.log` record the final 64-case pass: eight viewport/theme combinations × eight status fixtures. Viewports include desktop, compact desktop, phone, 320 px phone, tablet, landscape phone, embedded layout mode, and dark desktop. Embedded mode renders the actual Setup embed option, without an outer T3 iframe.

States: current Stable, available Stable, current Nightly, available Nightly, starting, recovery, offline, unsupported. Every case passed the existing geometric UI audit, status surface/border checks, footer spacing, desktop control height, phone touch target checks, and JavaScript error checks. Each viewport also passed confirmation cancellation, Escape focus restoration, and Check for updates focus restoration.

The original card measured a 42 px channel switch, a 28 px button, an inherited top-only status border, and a footer action beginning 1 px below the divider. The revised card measures a 30 px switch, a 28 px button, no status background/border, and a footer action beginning 17 px below the divider (1 px divider + 16 px padding). Mobile controls retain at least 44 px touch targets. Long target versions keep their arrow attached, and the status icon stays aligned with the first line of the status label.

The seven Setup page rendering tests, JavaScript syntax check, and `git diff --check` also passed. CI results are linked separately in the PR.
