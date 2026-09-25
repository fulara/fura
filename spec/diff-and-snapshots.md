# Fura Git changes and comparisons

## Product contract

The normal Diffs panel is **Git changes**, not an attribution of changes to one session.
A session selects known repositories; Git reports their shared state. **Current changes**
shows unstaged/staged/untracked changes; **History** reviews stored commits without typing
refs or checking anything out. The header always identifies the repository, branch and HEAD.
After committing, Current changes may be empty; History remains useful. Repository snapshots
are no longer created or used as diff bases.

Ordinary entry into Diffs, a session change while that pane is visible, or choosing
another repository requests fresh status for the **selected actual repository**.
Dirty index/worktree (including conflicts and nonignored untracked files) opens
Current changes; clean opens History. `status.showUntrackedFiles` cannot hide
untracked dirtiness from this decision. Git's existing submodule ignore semantics
remain in force. Viewed history refs and pinned commits are never status inputs.

This is one decision per entry, correlated with that entry's session and diff
request. While status is loading/unknown, neither mode is presented as selected;
loading or the actual diagnostic remains visible with manual navigation available.
Manual mode/commit/Compare navigation cancels a pending decision. Background
refreshes do not change the chosen mode. Intentional panel teardown/recreation and
repository/session switches invalidate older decisions. Ordinary re-entry reevaluates a stored mode
but retains its ref, selected immutable OID, file selections and comments; direct
commit navigation, dedicated review sessions and Advanced Compare retain their
existing explicit navigation behavior.

Moving focus to another visible panel or window is not a new entry. Popout,
redock and internal Dockview transfer retain the repository, viewed ref, pinned
OID, file/stat selection, disclosures and independent scroll positions.
Permanent top-level docked panels cannot be user-closed; additional pinned diff
tabs can. Native popup close and **Return to main** redock existing content rather
than invoking panel teardown (see
[workspace panel lifetime](ui-preferences.md#desktop-workspace-panel-lifetime)).

The independent inline tool-card diffs still render OMP `result.details.diff`.
OMP context checkpoint/rewind and native hashline editor snapshots are unrelated and
remain intact.

## Commit history

History lists SHA, subject, author and timestamp, then opens the selected commit against
its first parent. An initial commit uses the empty tree; a merge explicitly says that its
diff is against the first parent. Detached HEAD and unborn repositories have explicit states.
The detail pane shows the full commit message and OID, changed files, statistics, hunks,
comments/questions and the existing wider-context controls.

The existing History commit-message disclosure remembers its open/closed
preference in memory per session/repository, shared across commit selections.
First use remains collapsed. Only explicit summary activation (pointer,
Enter or Space) changes that preference; DOM recreation and delayed toggle
events do not. Loading, refresh, subject-only commits and later commits retain
the preference while always rendering the selected commit's actual content.
Same-view rerenders restore summary focus when it remains available. This is
not CSS positioning, per-commit state or persisted configuration. Dedicated
reviews and Advanced Compare retain their existing disclosure behavior.

**History branch** selects what is viewed, never what is checked out. HEAD is the
default; options use fully qualified local `refs/heads/*` and locally stored
`refs/remotes/*` names, excluding tags and symbolic aliases such as `origin/HEAD`.
Local and remote labels remain distinct even when their short names collide.
Stored branches are ordered by tip **committer** date descending, with full ref
name ascending as the deterministic tie-breaker; HEAD remains the separate first
choice. Author date and checkout recency do not affect ordering. Git treats missing
or invalid commit dates as timestamp zero, tied with epoch dates by full ref name;
unreadable objects produce an error. Symbolic aliases are excluded before the
1,000-branch result cap. The existing Git-output safety bound still applies.
Later pages retain those choices. Selected refs absent from that bounded list
remain selectable through the retained selection.

The History branch picker filters loaded choices by case-insensitive substring,
preserving that order and local/remote labels. Search text is transient: opening,
typing, clearing and dismissing never change the viewed ref or pinned review.
Only choosing a result by click or Enter commits a selection. Arrow keys move the
active result; Escape restores trigger focus, and Tab/outside dismissal cancels.
IME composition cannot accidentally select a result. Reopening starts with an
empty query. A capped list explicitly says search covers only loaded refs.
Same-review asynchronous rerenders retain the open picker's query, caret and
active ref, including initial commit loading. Changing session, repository or
viewed ref discards that transient draft; it is never written to sessionStorage.
An in-progress IME composition is not replayed into a replacement input.

The checkout label always identifies actual HEAD. A separate viewed-ref/pinned-tip
label identifies the history snapshot. Changing the viewed branch clears its pages,
cursor and selected commit, then selects the first returned commit using the usual
review flow. Choices and immutable selections are stored per session/repository in
the existing sessionStorage key; legacy single-repository selections remain readable.
Current changes continues to use actual HEAD/index/worktree, not the viewed branch.
Dedicated review sessions and Range-diff are not branch-selector consumers.

Pages contain at most 30 commits in topological order. The opaque v2 cursor binds
canonical repository, selected ref, pinned tip OID and offset. A branch movement
cannot silently reorder a subsequent page. Legacy, malformed or mismatched cursors
require an explicit refresh. The browser retains at most 300 commits.
Latest/Refresh resolves the viewed ref again and restarts paging without changing
the selected immutable review. Older/Newer uses the loaded window, with Load older
at its boundary. Deleted refs still permit existing pinned pages while their objects
exist; refreshing a missing ref errors instead of falling back to HEAD. Detached or
unborn checkout does not prevent browsing another valid branch.
With focus inside History, `n` selects the next/newer commit toward the pinned tip
(previous loaded row), and `p` the previous/older commit toward ancestors (next
loaded row), without wrapping at the window boundaries.
These shortcuts ignore editable fields, selects, modifiers and composition events;
they work in docked and popped-out panels and retain focus through patch reloads.

Changing selection replaces in-flight requests. Responses are correlated by client,
request, session and repository; commit summaries additionally match the selected OID.
Disconnects settle pending history/file reads. Returning to an interrupted selection
reloads it instead of leaving an indefinite loading view. The pane can be expanded or
popped out without losing selection or commit navigation.

Advanced Compare obtains its Base/Head from the selected immutable review even
after that commit leaves the loaded page. If no parent exists or is available,
Base stays empty and must be chosen explicitly; checkout HEAD is never invented
as that commit's parent. The ordinary history review still uses the empty tree
for an initial commit.
Opening Compare during a pending ordinary-entry status check supersedes that
probe with the retained explicit review request, so cancelling Compare cannot
leave a pinned History review waiting for a working-tree response.

Desktop chrome is compact: repository selector, branch/HEAD and view navigation share
one header (two rows in narrow panels). **Review options** is a native disclosure for
Add/Hide selected/Set default, Open diff… and Advanced Compare. The menu survives background
summary/history rerenders while open and closes after an action or Escape.
History and changed files use dense rows with independent scrolling. Long subjects
and paths truncate visually; tooltips retain their full values.

The selected commit subject, navigation, totals and patch actions share one detail
toolbar. Expanding the subject reveals the full OID, message, author, timestamp and
comparison endpoints; merge/initial-commit basis remains visible when collapsed.
An open description survives patch rerenders for the same comparison only.
Pop out lives in the Dockview tab header, not in a separate content toolbar.

**Show more context** adds ten context lines to the visible patch, up to 200.
In All files view it reloads the aggregate patch; with one file selected it reloads
that file. Expanding context never silently changes the file selection.

## Opening a server diff file

**Review options → Open diff…** opens a native HTML dialog browsing the **Fura
server's filesystem**, not a browser-local upload or an OS dialog on the server.
It is also available without a selected session and in dedicated review sessions.
Directory path/Go, Up, directory entries and a file-path/Open form allow navigation.
The listing shows directories and `.diff`/`.patch` files (case-insensitive); a typed
file path may have any extension. Paths returned by the server are canonical.

Successful directory visits and file opens remember their containing directory in
origin-scoped browser `localStorage` (`fura.diff.lastDirectory`), across dialog close
and page reload. The initial fallback is session cwd, then server default cwd.
Failed paths never overwrite this preference. Request IDs reject late/superseded
replies; changing input invalidates a pending read. Cancel, disconnect and session
switch close the picker. Errors leave the previous listing available.

The selected UTF-8 patch replaces only the displayed diff surface. It reuses the
shared parser, syntax highlighting and Unified/Side by side preference, with no
comments, agent questions, checkout, wider-context reads or apply action. Background
Git replies cannot replace it. Close file returns to the existing Git review;
session switches and reloads discard the opened file, not the remembered folder.
Git patches and plain unified headers (including timestamps) are supported.
Header-like source lines within hunks remain source lines; unsupported binary or
combined patch content stays read-only metadata. All content is rendered as text.

Authenticated `diffFile.list` / `diffFile.open` requests carry `requestId` and `path`.
Only the requesting connection receives `diffFile.listed`, `diffFile.opened` or
`diffFile.error`. These reads do not call Git or OMP and never write filesystem data.
Explicit server browsing is not repository-contained; access uses the server user's
filesystem permissions. File opens require regular files, reject NUL/non-UTF-8 and
empty/non-diff content, and are bounded to 2 MiB, 20,000 lines and a conservative
32 MiB estimated expanded-row size before parsing. No partial patch is returned.
Listings stop after 1,000 matching entries or 10,000 inspected entries and visibly
report truncation; a typed path remains usable. Filesystem work runs off the async
runtime, and supported Unix targets use nonblocking opens plus descriptor type checks.
Event summaries never include imported patch content.

## Independent pinned panels

**Pin as new tab** in Current changes, History and ordinary ref Compare adds
an active independent review tab in the existing Diffs group without replacing
ordinary Diffs, adding a split or changing group proportions. Several pins may
coexist. They use the same file/patch renderer, parser, highlighting, split layout
and comment anchors, with separate controllers and mutable UI state. Native
Range-diff explicitly disables Pin because it compares patches, not file versions.

A session-backed pin captures the canonical worktree, Current changes group,
viewed branch name, selected History OID, file, layout/whitespace settings,
available patch cache, scroll and local review draft. It is an independent
repository browser, not a frozen commit-only view: **History** retains its own
branch picker, clickable commits, older pages and `n`/`p` navigation; **Current
changes** returns to the captured worktree/group. Pinning checkout History resolves
its branch name so later checkout changes do not retarget the pin. Detached HEAD
keeps HEAD semantics. Choosing another branch inside the pin is explicit and local.
Ordinary ref Compare pins still capture resolved comparison endpoints.
Two sessions sharing one worktree share its Git changes; pinning is not attribution
or isolation of one agent's edits.

**Latest** refreshes the pin's viewed branch without replacing its selected
commit; choosing a commit changes only that pin's comparison. **Refresh** also
reloads the displayed comparison. History responses have independent request IDs,
repository/ref validation and bounded pages; stale replies cannot replace a newer
selection. Older pages retain their original cursor/ref binding even when the
initial page was loaded through HEAD and the pin now names that branch explicitly.

Switching conversations, ordinary repositories, normal/diffReview workspace,
focus or visibility does not retarget or refresh pins. **Refresh**, an uncached
file read, or a whitespace/detail/context change reads only the captured source.
Current changes can consequently show newer contents of the same worktree; it is
not an archival snapshot. Layout and cached file selection remain local and do
not request another comparison. The header identifies the source and explains
manual refresh. During refresh/failure, retained content is explicitly old and
cannot submit stale review actions. Disconnect leaves a readable error; reconnect
requires explicit Refresh rather than silently resuming reads.

Each pin has a unique client ID and fresh diff generation on the existing socket,
isolating the backend's client/scope slots from ordinary Diffs and other pins.
Summary/content acceptance includes generation, repository, whitespace, comparison,
selected file and context. Closing a tab cancels its generation and releases its
cache; late replies cannot revive it. Cache limits apply independently per pin.

Session-backed comments and review prompts keep the original recipient, visibly
labelled **Send to …** in the pin and preview. They never use the newly active
conversation. Sending notes/questions to a busy recipient queues them as follow-up;
it does not switch sessions. Compare opened without an agent remains read-only.
Stopped/unavailable recipients cannot be resumed by pin actions. Deleting a source
session blocks fresh sessionChanges/History reads and leaves the last result with
an unavailable-source diagnostic. Repo-scoped Compare reads do not require that
session, but its agent actions still do. Missing repositories never fall back to
another source.

Code/file actions use the displayed comparison's canonical root, committed OID
and old/new path. Immutable previews and their Copy action never read today's
file; live Code explicitly reads that worktree and keeps the pin's note recipient. A pinned Code
revision survives conversation changes rather than restoring another worktree
under its recipient. Returning to active-workspace Code is explicit.

Pins share the ordinary Dockview tab strip; there is no separate pin host or
reserved screen area. Normal and diffReview retain separate user arrangements.
Each pin has one controller, one persistent content DOM and one current host.
Changing workspace transfers docked content, not its source or lifetime; the
native Dockview wrapper may change but transfer never closes or refreshes the pin.
Inactive tabs retain drafts, selection, settings and scroll.

**Open in new window** uses native popout for the selected pin. An opening or
open popup remains owned by its original workspace and stays visible through
workspace changes. A blocked popup leaves a functioning tab. Popup close and
**Return to main** return the same content to the active workspace, preferring
its remembered group and tab neighbors, then its docked Diffs group, then a
main grid group. They do not switch conversations. Only **Close pinned panel**
deletes the review instance. Unrelated session events and focus changes do not
recreate its draft or text selection.

Splits are explicit user actions. A pin-only group evacuated by popout or
workspace transfer occupies no space while retaining its return geometry.
Closing its last docked pin while another is popped out also releases its area;
closing all associated pins removes the empty return group. Other user splits
and sizes are preserved rather than resetting either workspace to defaults.

Lifetime is **the current application document only**. Reload discards pins,
patches and drafts; layout serialization excludes their descriptors and empty
groups, so reload never restores broken tabs or retargets them to an active agent.
There is no persisted patch archive, new OMP session, checkout, worktree creation,
filesystem watcher, diff-source polling loop or backend protocol change.

## Diff layout

The desktop patch toolbar offers **Unified** (default) and **Side by side** for
Current changes, History and ordinary ref Compare. One presentation preference is
shared by these panes and retained in the main window's `sessionStorage`
(`fura.diff.layout`), including refresh, reload, focus and popout/redock. It does
not change repository, session, refs, selected commit/file or checkout, and does
not initiate a new comparison.

Split puts old/removals on the left and new/additions on the right, with separate
line numbers and syntax state. Context shares a visual row; consecutive removal
and addition runs align by position only within the same paths and hunk. This is
layout, not a claim that unequal changes are semantic pairs. Wrapped lines and
comment threads keep the next pair aligned. Striped, labelled **No line** cells
have no source text, gutter or actions; an actual blank source line keeps its
number. Metadata stays full-width. No-newline markers stay with the preceding
source side. Binary/unsupported or unanchored patch content remains unified with
a fallback explanation; no content outside the supplied hunks is invented.

Entirely added files use full-width source rows even with **Side by side**
selected, including mixed aggregates and pinned views. The canonical parser's
explicit absent old path (`null` / `/dev/null`) identifies a new file; an
insertion-only hunk in an existing file does not. All-new patches omit the
old/new column heading and split minimum width. Line numbers, highlighting,
blank lines, no-newline markers and right-side review anchors stay intact.

Narrow docked panes scroll the patch horizontally rather than crushing source
columns; expanding or popping out the pane shows both columns together.


Review actions keep the original canonical row and immutable comparison/path
identity. Shared context has one canonical right-side anchor: its left copy is
display-only, while the right copy retains comments/questions. Removed and added
lines retain their respective old/new anchors. File Copy uses the original
committed content, never the displayed DOM.

Native range-diff remains unified and explicitly explains the limitation: it
compares patches, not two file versions. Transcript edit cards keep their existing
layout; there is no separate mobile redesign.

## Ignore whitespace in ordinary patches

The patch toolbar's **Ignore whitespace** checkbox defaults off and applies in
both Unified and Side by side. Current changes (staged/unstaged), pinned History
commits and ordinary ref/WORKTREE Compare share the main window's
`sessionStorage` preference `fura.diff.ignoreWhitespace`; refresh, focus, layout
changes, reload and popout/redock retain it.

The backend generates patches with native Git `--ignore-all-space` (`-w`).
It ignores whitespace when comparing lines, not arbitrary added/deleted blank
lines. An EOF-newline-only difference can disappear, as it does in native Git.
The existing restored-WORKTREE libgit2 path uses its equivalent whitespace
option; new/untracked additions retain their contents. Nothing trims source text
or hides diff rows heuristically.

File lists, statistics, version fingerprints and `workingTreeDirty` remain
unfiltered. The UI says so while filtering, and an empty file or aggregate patch
shows an explicit no-patch-changes message without removing the changed file or
claiming a clean worktree. Ordinary smart-entry still uses actual Git status.
Copy file retains the original committed bytes, including whitespace.

Each toggle replaces the ordinary request with a new `diffId` while preserving
repository, refs, selected commit/file and History branch. `ignoreWhitespace`
defaults false in requests, is echoed in request/comparison/content identities,
and must match the prepared comparison on lazy content reads. Patch caches are
mode-separated; old summary/content/error replies cannot replace the active
request. Completion alone cannot settle a generation before its summary.
While refreshing, a retained patch explicitly identifies its previous whitespace
mode and disables old review actions; the checkbox remains usable for reversal.

The source `comparisonKey` does not change just because the filter changes.
Comments keep their original side, line numbers and text; notes absent from the
filtered patch remain accessible in the review summary rather than being
re-anchored. Agent-review patch regeneration uses that review's whitespace mode.
The separate native Range-diff checkbox remains independent and nonpersistent.

## Diff highlighting

Git/commit rows and recorded edit-card patches share a presentation-only tokenizer,
with separate adapters rather than a shared UI component. Existing `highlight.js/common`
provides explicit path-based languages, including `.rs` → Rust; missing grammars and
unknown paths stay plain. No language autodetection or current-file content is fetched.

Line backgrounds remain subtle; syntax owns the foreground. Intraline emphasis applies
only to a single removed/added pair within one contiguous fragment, with an unambiguous
word-level alignment and at least half of the longer line unchanged. Whole blocks are
never paired by index for intraline emphasis. Words/whitespace runs are atomic;
grapheme boundaries preserve Unicode and the original UTF-16 source offsets.

Old/new sides have independent multiline context. Hunks, path/language changes, elisions
and unproven numbered gaps reset it. Expanding context changes the complete-text cache
key. A fragment beginning inside a comment/string without its opener cannot be recognized
reliably; historical diffs never borrow today's file to conceal missing context.

Limits: 2,000 rows and 100,000 UTF-16 units per renderer; 500 rows / 16,000 units per
fragment; 4,096 units per source line/path; 4,096 syntax ranges and 64 nesting levels.
The text/range-only LRU charges a 2 MiB budget. Intraline allows 2,048 units / 256 graphemes
per side and 65,536 DP cells. A measured 12 ms work budget prevents further expensive
work, but cannot preempt a synchronous highlight.js call or DOM work. Exceeding limits
falls back to the original line diff, not truncated or hidden content.

Only controlled highlighter HTML enters an inert template, with exact-text validation
and span/class allowlisting. Visible DOM is built from original text slices. Raw patches,
copy, selections, line numbers, Git identities and review anchors remain authoritative;
highlighted DOM is never used as their data source.

## Git groups

Each request selects one `changeKind`:

- `unstaged`: index to working tree (`git diff`), the default;
- `staged`: HEAD to index (`git diff --cached`), including repositories without a first commit;
- `untracked`: nonignored untracked files as additions, without staging them.

The same path can have different staged and unstaged patches. Group selection is kept
through refreshes. Binary files and conflicts remain visible; combined conflict patches
are read-only metadata, without invented two-sided comment anchors. Empty files, file
modes, renames, deletions and paths containing tabs/newlines are handled explicitly.
Untracked symlinks show their target text, never the contents of an external target.

Read paths never run `git add`, `read-tree`, `write-tree`, `commit-tree` or `update-ref`.
They do not modify the index, branch, working files, Git objects or existing snapshot refs.
Git reads use literal pathspecs and disable optional index locks, fsmonitor, external diff
drivers, textconv and signature display. They inspect stored objects, ignoring `refs/replace`,
consistently with the immutable blob reader. Agent-review prompts state this inspection policy.
Read-only Git subprocesses also clear inherited Git repository/index/object/config
redirections and disable lazy fetching and all transports. Missing promised objects
produce explicit errors, including in selected-commit patches and immutable file
previews; browsing never downloads them. This requires installed Git support for
`--no-lazy-fetch`. Existing mutation command invocation semantics are unchanged.
Output and previews are bounded; unsupported non-UTF-8 paths fail explicitly.

Working-tree reads conservatively refuse repositories with active clean/process filters
on tracked or nonignored untracked paths. This includes affected Git LFS worktrees even if
the filtered path appears unchanged; History and immutable comparisons remain available.
Fura does not execute those filters to obtain a normalized patch. This is a preflight guard,
not a sandbox against concurrent configuration changes or arbitrary filesystem behavior.

## Repository discovery and manual corrections

`src/session_repos.rs` discovers the nearest working-tree root from concrete paths:

1. the session's managed worktree and cwd;
2. `additionalDirectories` in the known OMP session header, including title-prefixed and legacy logs;
3. trusted tool metadata: edit paths/move sources, write resolved paths, explicit bash cwd,
   and recognized eval path/cwd events;
4. initialized submodules declared by Git, without walking arbitrary directories;
5. previously discovered and manually added roots.

Files, deleted paths and nonexistent child paths resolve through existing ancestors.
A nested repository is discovered only when a concrete path identifies it. Linked
worktrees remain distinct by canonical working-directory root, even when Git storage is
shared. Deleted stored roots do not silently become their parent repository.

SQLite tables `session_repositories` and `session_repository_defaults` in the existing
Fura database retain associations and per-session **Add**, **Hide selected**, and
**Set default** decisions. Hiding suppresses automatic re-addition; Add restores a hidden
root. Newly discovered repositories do not replace the established default or an explicit
view selection. Manual corrections do not write OMP session logs.

Discovery is best-effort. It does not infer paths from conversation, shell programs or
arbitrary eval code. Relative eval paths without explicit cwd evidence are skipped.
Remote/internal tool URIs are not treated as local paths. Fura does not yet subscribe to
OMP child-agent operation streams; opaque shell/eval/subagent work can require manual Add.
Repository association is not proof that an operation modified that repository.

## Patch versions, comments and refresh

Mutable comparisons use opaque BLAKE3 version identities, not synthetic Git trees.
Their identity includes the Git group, base/index data, relevant Git configuration,
changed-file contents and visible submodule checkout/staged/unstaged/untracked state.
Fingerprint reads have a 64 MiB total byte budget and 12-second deadline; exceeding either
fails explicitly, never producing a partial reusable version. Summary and lazy patch generation
validate the version before and
after reading. If state changes, loading/anchoring fails with a request to refresh rather
than attaching new content to an old comparison key.

Comments/questions remain tied to `comparisonKey` and exact line context. Group switches
and changed versions cannot reuse another patch's comments. Immutable commit comparisons
keep their resolved object IDs. Agent-review prompts distinguish Git endpoints from opaque
Fura version IDs and prohibit treating those IDs as Git refs.

The UI retains filtering, file/stat views, lazy per-file patches, hunks, wider context,
comments and agent questions. It refreshes after a turn settles, on panel re-entry, on
window focus/visibility return and manually. Visible inactive panels accept summaries
and lazy patches without reclaiming keyboard focus; hidden tabs and workspaces defer
rendering and reads until visible. This is not a filesystem watcher, polling loop or
automatic History Latest action; manual refresh remains available for external changes.
After reconnect, the restored session list resumes stale visible ordinary reviews
without changing the chosen mode or selected immutable commit.

A same-target refresh keeps the last readable result until the replacement is ready,
with an explicit refreshing or failure status. Actions bound to the retained comparison
cannot submit stale anchors while it is retained. Changing repository, session, refs,
commit or file cannot relabel old content as the new target. Normal Compare keeps its
explicit repository/refs separate from a dedicated review workspace; background replies
also preserve unsubmitted Compare controls and open branch-picker drafts.

Opening a working-tree diff file in Code uses the selected canonical repository root, not
the session's original cwd. Code Refresh retains that root and selected file. Code notes,
questions, deletion and preview/flush are scoped by canonical root, path and file version.

Historical file menus offer two separate actions: **View committed file** retains the
read-only modal; **View this revision in Code** opens a distinct immutable source in
the Code panel. Both use the existing blob reader without checkout, LSP or today's-file
fallback. Deleted files read the actual comparison base and old path, not a guessed parent;
renames read the head-side path. Binary, non-UTF-8, non-file and blobs over 1,000,000 bytes
fail explicitly. Today's deleted directories or external symlink parents do not prevent
reading an immutable historical tree. See the [Code contract](read-only-code-browser.md#git-diff--code-and-committed-files)
for identity, pending-read isolation, chunking and return behavior.
Diff panes retain enough width for controls, including restored layouts.
Short docked panes scroll the review surface instead of collapsing the file list
and patch area behind the session status bar.

## Separate comparisons

**Advanced Compare** is separate from History and inherits the selected repository/commit.
It supports Git refs, commits, merge-base comparisons, WORKTREE and commit stepping.
WORKTREE also includes nonignored untracked additions without materializing a Git tree.
Paths removed from the index but present on disk use their net base-to-filesystem change;
unchanged files disappear, and file lists, counts and patches agree, including type changes.
Lazy file reads select exact deltas rather than descendant paths matched by Git pathspecs.
Review worktrees remain an explicit operation, never a prerequisite for reading a diff.

**Range-diff** is a second mode in the same Compare access, not a review session.
Editable Base / Old / New invoke installed Git's three-ref form: compare
`Base..Old` against `Base..New`. For example, `origin/v35`, `@{u}`, `HEAD`.
Old defaults to `@{u}`, New to `HEAD`; Base remains explicit. Missing upstreams,
invalid refs and non-repositories are errors, never guessed replacements.
Opening from a dedicated agent-review layout switches to the existing normal
workspace without starting an agent or discarding the session's composer draft.

Git owns pairing, ordering and patch generation. The browser displays one scrollable
monospace output, preserving whitespace and safe dual-color SGR styles. Native `=`
summary rows gain `(no change)` without a patch body. Added, removed and changed
commits retain native output; there are no links, comments, file actions or commit tree.
Text nodes prevent HTML execution; unsupported terminal controls are stripped.
Unfamiliar textual output remains plain text rather than being heuristically parsed.

The separate Range-diff **Ignore whitespace** checkbox defaults off and passes
`--ignore-all-space` to the final native `range-diff` command. It does not filter
the DOM, normalize patches or change commit matching/statuses: an indentation-only
pair can retain `!` with no body; only native `=` receives `(no change)`.
Substantive edits, added/removed commits and blank-line changes follow native Git.
Toggling preserves repository/refs, cancels the previous request and immediately
recomputes. The echoed option is part of result identity; old or mismatched-mode
responses cannot replace the current output. There is no durable preference.
Its state does not change ordinary File diff filtering, and raw-patch preflight
limits remain unchanged.

All three refs resolve to full commit OIDs before comparison. Results show repository,
input refs and pinned OIDs. The read-only Git runner disables external diff, pagers,
signatures, hooks, optional locks, replacement objects, lazy fetch and transports.
Any effective configured textconv driver is refused, even if inactive: native
range-diff's nested `log -p` does not reliably inherit outer `--no-textconv`.
This requires Git supporting `--no-lazy-fetch` and does not sandbox concurrent
same-user repository/configuration mutation.

Limits are 256 non-merge commits and 8,000,000 patch-input bytes per range,
256,000 output bytes, 12 seconds per subprocess and 15 seconds overall.
The browser also caps lines, line length and DOM runs, visibly marking clipping
or bounded plain-text fallback. These bounds are not OS-enforced Git memory quotas.
On Unix, cancellation kills the owned process group; other platforms kill the child.
Input edits, replacement, mode changes, panel closure and disconnect invalidate the
browser result; reconnect does not silently replay a comparison as current.

`/rebase <branch>` retains its existing guarded Git behavior but no longer requests a
snapshot afterward. It still acts on the session cwd repository, without fetching.

## Protocol and ownership

- `src/diff.rs`: direct Git groups/comparisons, version validation, lazy patches, jobs,
  review worktrees and rebase mechanics.
- `src/diff_files.rs` / `frontend/src/diffFilePicker.ts`: bounded server filesystem picker and read-only patch imports.
- `src/session_repos.rs`: repository discovery and durable manual corrections.
- `src/range_diff.rs` / `frontend/src/rangeDiff.ts`: bounded native range-diff execution and safe ANSI rendering.
- `src/protocol.rs` / `frontend/src/protocol.ts`: manually mirrored DTOs.
- `frontend/src/main.ts`, `gitHistory.ts`, `gitFileView.ts`, `diffState.ts`, `diffReview.ts`: panel/review behavior.
- `src/commands.rs`: dispatch, repository updates, rebase and agent review orchestration.

The `sessionChanges.request` / `sessionChanges.summary` wire names retain session context,
not authorship semantics. Requests carry `changeKind`; ready summaries include repository
candidates with `source` and `isDefault`. `sessionRepos.update` takes `sessionId`, `action`
(`add`, `hide`, `default`) and `path`. Successful updates emit `Git repositories updated:`
notices, which trigger a fresh repository summary. `compareDiff.*`, `diff.content.*` and
`diff.cancel` remain separate. Snapshot commands, DTOs and `missingSnapshot` are removed.

Ready Current changes summaries additionally report `workingTreeDirty`, independent
of the displayed Git group. Missing/null means unknown, not clean.
`workingTreeStatusError` preserves a refused/failed status read without disabling
an otherwise safe staged comparison. Its diagnostic survives lazy patch rendering.
Immutable commit summaries do not inspect worktree status. These optional response
fields need no OMP protocol change; an older bridge leaves entry selection explicit.

`git.history.request` / `git.history` carry bounded history pages and opaque cursors.
Optional `historyRef` defaults to HEAD when absent/null and is validated within the
session-authorized repository. Results retain actual `branch`/`headOid`, echo
`historyRef`, expose current `historyTipOid` separately from pinned `historyHeadOid`,
and include first-page `branches` plus `branchesTruncated` (null list on later pages).
`git.file.request` / `git.file` carry immutable committed-file previews. Both have
client/request correlation and connection-owned jobs; replacement requests and socket
closure abort their owners. `sessionChanges.request.currentCommitOid` selects an immutable
commit review independently of the current-change group. No new OMP protocol is required.

`git.rangeDiff.request` carries `requestId`, `clientId`, `repoRoot`, `base`, `old`,
`new` and `ignoreWhitespace`; `git.rangeDiff` returns correlated pinned identity,
the option, native output, truncation and errors. Missing option fields default to
false for compatibility. `git.rangeDiff.cancel` names the request. Jobs belong to
the authenticated socket, with one active request per connection; replacement
and disconnect abort it. No OMP operation, fetch, checkout or repository write
is part of this mode.

## OMP cutover and historical data

Own repo-snapshot patches were removed from the vendored fork stack on the unchanged
upstream base. Mixed commits retain their unrelated RPC/plan/goal/BTW/process-safety
changes. There is no new disable switch or replacement snapshot service.

Existing `repo-diff-snapshot` custom entries and `refs/omp/diff-snapshots/*` are historical
user data: this migration does not delete them. They are ignored by repository discovery
and normal diff generation. Legacy conversations remain loadable. Ordinary session
deletions no longer run the removed snapshot-ref cleanup integration.

Publishing rewritten OMP history and the Fura submodule pointer requires separate approval.
Publication is not deployment: existing bridge/OMP processes are not restarted automatically.
