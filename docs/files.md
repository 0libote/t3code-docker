# Files

Open **Files** under Tools in Setup, or press **G F**. Projects lists every visible
folder at the top of `/workspace`; a workspace that is itself a Git repository
appears as one project. Home opens the persistent home folder, with hidden files
shown by default.

Use **Go to folder** (**Ctrl/Command L**) to open another absolute path. Files has
the same filesystem permissions as t3’s terminals. It does not use sudo and does
not restrict browsing to the workspace or home folder.

Select a row to inspect it; double-click a folder to open it. On a phone, tap to
open and hold for actions. View offers hidden files, sorting, selection and Sizes.
Search matches names inside the current folder and its descendants, with type,
size and modification filters. It never executes a file.

Folder sizes show allocated disk space; files show their length. Files reuses
Storage’s existing scan, with a small cached directory index. Missing sizes are
measured in the background, two folders at a time, for up to 20 seconds each.
Unknown sizes remain unknown; a partial measurement is marked as an estimate.
**Measure again** refreshes the current folder, or starts Storage’s scan at the
Projects and Home roots. Git facts are local reads, bounded and cached; no fetch,
hooks or fsmonitor commands run. Repositories that apply executable content
filters report Git status as unavailable, so browsing never runs those filters.
Submodule working-tree changes are not inspected; their own folder can be opened
for its Git facts.

Rebuildable folders use known build/install directory names. Inside a Git
repository they must be ignored and contain no tracked source. Elsewhere a
matching project marker is required. Size bars hatch this part and name it in
text, without depending on colour alone.

Text previews are limited to 1 MiB and 200 displayed lines. Image previews allow
up to 25 MiB and PDFs up to 50 MiB. Secret values start hidden. Single-file
downloads are served as sandboxed attachments; opening HTML or SVG does not run
it as console code. Managed folders identify the pages that own them. Operating
system permissions still decide what can be read.

When the running T3 version exposes project roots and thread summaries through
its supported RPC, project details include thread activity. Files never reads
T3’s database. Unsupported runtimes omit this information.

See [Storage](storage.md) for cache and tool-version maintenance.


Create folders and rename items in place. Move to opens a destination picker;
copy keeps the originals. Same-mount moves can be undone for five minutes if
nothing has changed since the move. Replaced destinations are kept in Trash.
Cross-filesystem moves copy into private staging, verify the source, then publish
complete copies before removing the originals. Two server jobs run at a time.

Trash is per filesystem, merged into one view. Workspace items use
`/workspace/.t3-trash`; home items use `~/.t3/trash`. A symlink is moved as a link.
Restore keeps any conflicting name by adding `(restored)`. Items expire after
seven days; disk pressure at 90% removes the oldest until usage is below 85%,
while preserving the first ten minutes for Undo. Empty Trash requires a fresh
confirmation. Other mounts have no implicit Trash.

Upload files, a folder, clipboard files or a desktop drop. At most three files
upload together in ordered 8 MiB chunks. Received data stays under a private
staging name until completion. The server reserves 1 GiB of headroom. The tray
shows progress, recovery, conflicts and completed files; phones use a sheet.
Choose the same name, size and modification time in the same destination to
resume after reopening the console. Unfinished sessions expire after 24 hours.
Conflicts offer Replace (the old file goes to Trash), Keep both or Skip.
A lost finish reply is checked against the server's saved result, never replayed
as a fresh upload. Empty folders from desktop drops are preserved.

The editor supports valid UTF-8 text up to 5 MiB. Drafts live only in this tab;
refresh polling never replaces an unsaved draft. Secret values remain masked
except on the line being edited. A stale save offers Discard mine, Save as a
copy, Overwrite theirs and Compare. Saves use a synced temporary file, preserve
the mode and publish by rename. The console never executes the edited file.

Managed folders begin locked. **Edit anyway** unlocks only the named managed
root until you leave it; **Lock again** ends that permission immediately.
Sign-ins and keys have separate consequences. Process checks fail closed when
activity cannot be established. For a supervised T3 process, **Stop T3 Code
first** pauses it for the change and verifies that it restarts. Other processes
must be stopped in their terminals. Setup remains available during this pause.

The authenticated `/files/*` API uses absolute paths and the same permissions as
the UI. Writes require same-origin requests. JSON bodies are limited to 64 KiB,
except `/files/write` (5 MiB + 64 KiB); raw upload chunks allow 8 MiB. Managed
writes carry `unlock` equal to the managed root, and sign-in/key changes require
`confirmed: true`. `requestId` deduplicates editor, rename, mkdir and move replies
within a bounded five-minute window. See the Files tests for request examples.
