# Contributing

Issues and pull requests are welcome. Before opening one:

- **`scripts/smoke-test.sh` defines what must keep working.** It starts the
  image and checks, against the running container, the things a user would
  notice if they broke. Run it against your build
  (`./scripts/smoke-test.sh t3code:browser`) and add a check for whatever you
  fixed. Most of its checks were added after something broke.
- **CI builds and tests both images on both architectures** before anything is
  published, so a change that only works on amd64 is caught. The slower agent
  lifecycle test runs on amd64 for every build.
- **To work on the setup page or what it adds to T3 Code's pages**, run
  `node scripts/dev-console.mjs` inside a container from this image. It starts
  a scratch T3 Code and the setup page from your working tree behind the
  image's one-port router, as `T3_SINGLE_PORT` would. It restarts the setup
  page as you edit, serves T3 Code's pages with your copy of
  `docker/t3-client/setup-bridge.js`, and prints a pairing link.
  `scripts/setup-bridge-audit.js` checks those pages in a browser, through the
  same router.
  `node scripts/storage-ui-audit.js http://127.0.0.1:23780/__setup/ dev`
  checks storage layouts and keyboard flows in light/dark and embedded modes.
  Its storage data and mutations are intercepted, so it cannot clean a real
  cache or change preferences. Screenshots go to `/tmp/t3-storage-ui-audit`;
  set `T3_STORAGE_UI_OUTPUT` to change that location. The development console
  isolates its home, mise state, and caches under `/tmp/t3-dev/home`.

Releases are made from tags. Pushing `vX.Y.Z` builds each image for each
architecture, tests each one against the exact digest that was pushed, runs the
agent lifecycle test and measures the image size on amd64, and then combines
the tested digests into one manifest without rebuilding. `latest` points at
`browser`. Published releases are then mirrored to Docker Hub; see
[Docker Hub publishing](docs/dockerhub-publishing.md).
