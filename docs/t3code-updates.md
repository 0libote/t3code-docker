# Upgrading T3 Code

Open **Setup → Environment → T3 Code updates**. **Check for updates** reads the
official platform package's published channel, and **Update and restart**
installs its exact release immediately. It does not use mise's waiting period.

**Stable** is the default. Choose **Nightly** to try new features earlier, or
choose **Stable** again to return to its latest published release. The
confirmation shows the exact target and explains the interruption before
anything is installed. Changing channels can intentionally select an older
release; Update within a channel never downgrades a newer installed version.

Checks run on startup and hourly. By default downloads and restarts happen
only when you confirm an update; **Auto-update** next to the card heading
opts in, sharing one dialog with the independent provider and toolchain
settings. It checks on its own
cadence (default every 3 hours) and installs the selected channel's release
only after 30 minutes without activity, never switching Stable ↔ Nightly.
Turning the T3 Code switch on asks for a separate confirmation first, because
T3 Code is alpha and a release can break T3 Code or its compatibility with
this setup console.
Idle tracks console and client activity, not agent turns: a turn that
outlasts the idle time with every client closed can still be interrupted.
T3 Code keeps running while the release downloads, verifies
its SHA-512 integrity and checks compatibility with the container supervisor.
Once ready, only T3 Code restarts. Active agent turns and its terminals stop;
clients reconnect. The Setup service and container keep running. A failed or
timed-out startup restores the previous version and SQLite snapshot, and an
interrupted update recovers before the server starts again.

The channel, selected native binary, adjacent client assets and cached releases
live in `$T3CODE_HOME/container-runtime` on the state volume. They survive a
container restart or image recreate. The image still supplies the initial
release and the supervisor; an explicitly selected release stays selected
after an image upgrade. Existing images need one image upgrade to gain this
feature, and future releases which require a newer supervisor may still need
a new image.

After a successful update, obsolete cached releases are removed. The active
release, its predecessor and the latest known target for each channel are kept.

Current Nightly releases use a newer thread database than Stable 0.0.45.
Nightly seeds it from the older database once; later channel switches keep the
two histories separately. The first switch can take longer while Nightly
imports the existing thread history. Returning to Stable can therefore show
earlier history, and returning to Nightly shows its retained history. Both databases
are preserved on the volume. Device pairings, revocations and consumed pairing
links follow channel switches when the native authentication schemas match;
an incompatible format stops the switch safely. This limitation appears in
the channel confirmation as well.

New permission scopes are limited to what the target release understands.
Switching stops if a restricted credential would gain older broad permissions;
revoke that credential before retrying.
When an unchanged credential returns to a newer release, its previously
granted permissions are restored; revocations still follow the active store.
Existing older credentials may need pairing again to grant newly introduced
permissions, as required by T3 Code itself.
Conversely, credentials first issued on Nightly can contain signed permission
claims Stable 0.0.45 cannot decode. Those devices need pairing again on Stable;
their original credentials work again on Nightly unless revoked or expired.
