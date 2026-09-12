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
refreshes do not change the chosen mode. Close/reopen and repository/session
switches invalidate older decisions. Ordinary re-entry reevaluates a stored mode
but retains its ref, selected immutable OID, file selections and comments; direct
commit navigation, dedicated review sessions and Advanced Compare retain their
existing explicit navigation behavior.

Moving focus to another visible panel or window is not a new entry. Popout,
redock and internal Dockview transfer retain the repository, viewed ref, pinned
OID, file/stat selection, disclosures and independent scroll positions.

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
With focus inside History, `n` selects the next loaded row (older commit), and `p`
the previous row (newer commit), without wrapping at the window boundaries.
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
Add/Hide selected/Set default and Advanced Compare. The menu survives background
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

## Diff highlighting

Git/commit rows and recorded edit-card patches share a presentation-only tokenizer,
with separate adapters rather than a shared UI component. Existing `highlight.js/common`
provides explicit path-based languages, including `.rs` → Rust; missing grammars and
unknown paths stay plain. No language autodetection or current-file content is fetched.

Line backgrounds remain subtle; syntax owns the foreground. Intraline emphasis applies
only to a single removed/added pair within one contiguous fragment, with an unambiguous
word-level alignment and at least half of the longer line unchanged. Whole blocks are
never paired by index. Words/whitespace runs are atomic; grapheme boundaries preserve
Unicode and the original UTF-16 source offsets.

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

The Range-diff-only **Ignore whitespace** checkbox defaults off and passes
`--ignore-all-space` to the final native `range-diff` command. It does not filter
the DOM, normalize patches or change commit matching/statuses: an indentation-only
pair can retain `!` with no body; only native `=` receives `(no change)`.
Substantive edits, added/removed commits and blank-line changes follow native Git.
Toggling preserves repository/refs, cancels the previous request and immediately
recomputes. The echoed option is part of result identity; old or mismatched-mode
responses cannot replace the current output. There is no durable preference.
File diff is unaffected, and raw-patch preflight limits remain unchanged.

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
