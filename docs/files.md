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
