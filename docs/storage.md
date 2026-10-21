# Storage management

**Setup → Storage** shows available filesystem space, cache sizes, and a folder
inventory. A warning appears in
Overview and navigation at 80% usage; it becomes critical at 90%. Filesystem
usage includes other containers and host files, while the inventory covers
folders visible inside this container. Sizes use decimal GB and allocated disk
space. Scans run in the background, at startup and every ten minutes; polling
reads the cached inventory and current filesystem space. The refresh button
beside **Disk** requests a new scan. The latest inventory survives setup service
restarts.

**Clear caches** at the top of the page, or **Clear** on one cache, previews the
estimated space and asks for confirmation. Each cache is cleared only by its
own tool's native command:

| Cache | Command | Notes |
| --- | --- | --- |
| Go build cache | `go clean -cache` | Compiled packages; builds recreate them. |
| Go module cache | `go clean -modcache` | Downloaded modules; builds fetch them again. |
| npm downloads | `npm cache clean --force` | The `_cacache` downloads only; `_npx` tools are left alone. |
| uv cache | `uv cache clean` | Downloaded Python packages; uv fetches them again. |
| Bun install cache | `bun pm cache rm` | Includes cached `bunx` packages; installs fetch them again. |
| mise caches | `mise cache clear` | Version metadata and backend downloads; installed tools stay installed. |
| Deno cache | `deno clean` | Cached remote modules; Deno fetches them again. |

Cleanup leaves project files, installed tools, credentials, conversations,
and backups alone. The next build or install may take longer. Cleanup shares
the installation lock, refuses to run during detected build/install activity
(Go, npm/pnpm/yarn/Bun, uv/pip, Cargo, Deno, and mise operations), and rejects
linked or external cache locations. A custom cache outside managed home cache
folders must be cleaned from a terminal. Operation results survive service
restarts.

Bun discovery uses a disposable project and cleanup is pinned to the checked
cache directory. Only `~/.bun/install/cache` and `~/go/pkg/mod` are eligible
under those tool homes; their parent, `bin`, and `src` directories are protected.

**Settings**, under the caches, controls two independent policies:

- **Automatic cache cleanup** starts off. When enabled, each cache over its own
  limit is cleared after ten minutes without detected build/install activity.
  This clears the whole cache; a limit is a trigger, not a target size.
  Defaults are 10 GB for the Go build cache, 5 GB for mise, 2 GB for Go
  modules, npm, uv, and Bun, and 1 GB for Deno. Limits range from 0.25 to 500 GB.
- **Keep managed versions bounded** starts on. After a verified install or
  update, older versions owned by the setup manager are trimmed. The current
  and previous selections, versions required by mise's tracked project configs
  or tool selections, configured provider paths, and running processes are
  protected. Unmanaged installs are kept. If references cannot be verified,
  trimming stops. **Older tool versions → Review** provides a manual preview;
  the server checks it again before removing anything.

Preferences live in `~/.t3/setup/storage-policy.json` (under `T3CODE_HOME` when
set) and persist with T3 state. Invalid preferences pause automatic cleanup.
Older preference files without the newer cache limits keep working; missing
limits fall back to the defaults above.
The CLI uses the same service and policies:

```bash
t3-storage status                 # cheap filesystem/cached inventory read
t3-storage scan --json            # measure folders now
t3-storage clean all              # preview every cleanable cache
t3-storage clean uv --yes         # explicitly clear the uv cache
t3-storage trim                   # review older managed versions
t3-storage trim --yes             # recheck and remove eligible versions
t3-storage policy --automatic on --go-budget 10 --npm-budget 2 --uv-budget 2 --bun-budget 2 --mise-budget 5 --deno-budget 1 --gomod-budget 2
```

`t3-doctor` includes filesystem pressure and the cached inventory. Project
storage such as Wrangler/R2 state, test artifacts, and local databases belongs
to the project that creates it. Backup retention belongs to the upgrade or
backup process that produces the copies. Neither is automatically deleted here.
Unused host Docker volumes and host build caches need host administration;
the storage service does not require the Docker socket.

The supplied Compose file rotates each service's Docker logs at 10 MB, keeping
three files. For an existing deployment, apply the changed Compose configuration
by recreating the container while reusing its home and workspace volumes.
In **1Panel**, add the same `logging` block from `compose.yaml` to the stack's
Compose definition before redeploying. Rotation is a container/daemon setting,
so updating the image alone cannot apply it. Keep the existing volume mappings
when redeploying, especially if home uses an anonymous volume.
