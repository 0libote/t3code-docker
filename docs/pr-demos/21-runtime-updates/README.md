# PR #21: in-container T3 Code release channels

Review source: `12f77da20355abb431169cc138cd9693632c6ef2`. Native round-trip recording and desktop screenshots
were captured from `897c927ccc0c3bf6337330d982cc6784670ade70`; the subsequent
change serializes committed-update cleanup and is covered by the final unit
suite. Responsive captures use the final working tree.

The native Linux arm64 run installs official Stable `0.0.45`, switches to
Nightly `0.0.46-nightly.20261011.2980`, and returns to Stable without replacing
the supervisor. The initial Stable credential works across the round trip;
revocations carry across. A newly issued Nightly credential is retained in
both stores but requires pairing again on this older Stable release because
its signed permission claims cannot be decoded there. The native client keeps
the injected Setup entry after installing both packages.

The GIF is the complete successful desktop browser recording at 4× speed.
The WebM is the original recording. The visible degraded-status banner in
the scratch instance reports device-list timeouts; authentication preservation
was checked independently against the native CLI and HTTP auth endpoint.

Desktop: 1440 × 1000. Phone: 390 × 844. Phone/card/dark-theme screenshots
replay actual native release metadata for deterministic layout verification.
The rollback screenshot is explicitly simulated. Native rollback, hung-trial,
interrupted recovery, SQLite WAL snapshot and auth safety tests run separately.
Eight responsive contexts cover desktop, phone, narrow phone, landscape,
tablet, embedded desktop/phone and dark desktop; keyboard focus and escape
restoration pass in each. Neither iOS nor Android device automation is
available on this Linux host, so these are responsive browser checks.

All captures use a disposable scratch home and test credentials.
No production devices, accounts, cookies or credentials are included.
