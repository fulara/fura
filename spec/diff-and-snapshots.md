# Fura Git changes and comparisons

## Product contract

The normal Diffs panel is **Git changes**, not an attribution of changes to one session.
A session selects known repositories; Git reports their shared state. **Current changes**
shows unstaged/staged/untracked changes; **History** reviews stored commits without typing
refs or checking anything out. The header always identifies the repository, branch and HEAD.
After committing, Current changes may be empty; History remains useful. Repository snapshots
are no longer created or used as diff bases.

The independent inline tool-card diffs still render OMP `result.details.diff`.
OMP context checkpoint/rewind and native hashline editor snapshots are unrelated and
remain intact.

## Commit history

History lists SHA, subject, author and timestamp, then opens the selected commit against
its first parent. An initial commit uses the empty tree; a merge explicitly says that its
diff is against the first parent. Detached HEAD and unborn repositories have explicit states.
The detail pane shows the full commit message and OID, changed files, statistics, hunks,
comments/questions and the existing wider-context controls.

Pages contain at most 30 commits in topological order. The opaque cursor pins the traversal
to its original HEAD; a branch movement cannot silently reorder a subsequent page.
The browser retains a sliding window of at most 300 commits. Latest/Refresh restarts paging;
Older/Newer commit navigation uses the loaded window, with Load older at its boundary.
The selected commit remains independent of that window. View/repository/commit selection
is restored per session and repository, including after a browser reload.

Changing selection replaces in-flight requests. Responses are correlated by client,
request, session and repository; commit summaries additionally match the selected OID.
Disconnects settle pending history/file reads. Returning to an interrupted selection
reloads it instead of leaving an indefinite loading view. The pane can be expanded or
popped out without losing selection or commit navigation.

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
window focus/visibility return and manually. Inactive views are marked stale. This is not
a filesystem watcher; manual refresh remains available for external changes.

Opening a working-tree diff file in Code uses the selected canonical repository root, not
the session's original cwd. Code Refresh retains that root and selected file. Code notes,
questions, deletion and preview/flush are scoped by canonical root, path and file version.

Historical files use **View committed file**, a separate read-only blob view identified by
repository, full commit OID, blob OID and path. It never creates/checks out a review worktree,
starts LSP or substitutes today's file. Deleted files read the parent version. Binary,
non-UTF-8, non-file and blobs over 1,000,000 bytes fail explicitly. Today's deleted directories or
external symlink parents do not prevent reading an immutable historical tree.
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

`/rebase <branch>` retains its existing guarded Git behavior but no longer requests a
snapshot afterward. It still acts on the session cwd repository, without fetching.

## Protocol and ownership

- `src/diff.rs`: direct Git groups/comparisons, version validation, lazy patches, jobs,
  review worktrees and rebase mechanics.
- `src/session_repos.rs`: repository discovery and durable manual corrections.
- `src/protocol.rs` / `frontend/src/protocol.ts`: manually mirrored DTOs.
- `frontend/src/main.ts`, `gitHistory.ts`, `gitFileView.ts`, `diffState.ts`, `diffReview.ts`: panel/review behavior.
- `src/commands.rs`: dispatch, repository updates, rebase and agent review orchestration.

The `sessionChanges.request` / `sessionChanges.summary` wire names retain session context,
not authorship semantics. Requests carry `changeKind`; ready summaries include repository
candidates with `source` and `isDefault`. `sessionRepos.update` takes `sessionId`, `action`
(`add`, `hide`, `default`) and `path`. Successful updates emit `Git repositories updated:`
notices, which trigger a fresh repository summary. `compareDiff.*`, `diff.content.*` and
`diff.cancel` remain separate. Snapshot commands, DTOs and `missingSnapshot` are removed.

`git.history.request` / `git.history` carry bounded history pages and opaque cursors.
`git.file.request` / `git.file` carry immutable committed-file previews. Both have
client/request correlation and connection-owned jobs; replacement requests and socket
closure abort their owners. `sessionChanges.request.currentCommitOid` selects an immutable
commit review independently of the current-change group. No new OMP protocol is required.

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
