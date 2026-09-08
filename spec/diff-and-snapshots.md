# Fura Git changes and comparisons

## Product contract

The normal Diffs panel is **Git changes**, not an attribution of changes to one session.
A session selects a set of known repositories; Git reports their current shared state.
Edits from another agent, editor or person are included. After committing, the basic
view may be empty. Repository snapshots are no longer created or used as diff bases.

The independent inline tool-card diffs still render OMP `result.details.diff`.
OMP context checkpoint/rewind and native hashline editor snapshots are unrelated and
remain intact.

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
Git commands use literal pathspecs and disable optional index locks, external diff drivers
and textconv. Output and previews are bounded; unsupported non-UTF-8 paths fail explicitly.

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
Their identity includes the Git group, base/index data, relevant Git configuration and
changed-file contents. Summary and lazy patch generation validate the version before and
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

Opening a working-tree diff file in Code uses the selected repository root, not the
session's original cwd. Indexed and deleted versions do not misleadingly open unrelated
working-tree content. Diff panes retain enough width for controls, including restored layouts.

## Separate comparisons

The existing Compare/ref-review mode supports Git refs, commits, merge-base comparisons,
WORKTREE and commit stepping. WORKTREE comparisons also include nonignored untracked
additions without materializing a Git tree. Review worktrees remain an explicit operation,
not a prerequisite for reading the normal Git changes panel.

`/rebase <branch>` retains its existing guarded Git behavior but no longer requests a
snapshot afterward. It still acts on the session cwd repository, without fetching.

## Protocol and ownership

- `src/diff.rs`: direct Git groups/comparisons, version validation, lazy patches, jobs,
  review worktrees and rebase mechanics.
- `src/session_repos.rs`: repository discovery and durable manual corrections.
- `src/protocol.rs` / `frontend/src/protocol.ts`: manually mirrored DTOs.
- `frontend/src/main.ts`, `diffState.ts`, `diffReview.ts`: panel/review behavior.
- `src/commands.rs`: dispatch, repository updates, rebase and agent review orchestration.

The `sessionChanges.request` / `sessionChanges.summary` wire names retain session context,
not authorship semantics. Requests carry `changeKind`; ready summaries include repository
candidates with `source` and `isDefault`. `sessionRepos.update` takes `sessionId`, `action`
(`add`, `hide`, `default`) and `path`. Successful updates emit `Git repositories updated:`
notices, which trigger a fresh repository summary. `compareDiff.*`, `diff.content.*` and
`diff.cancel` remain separate. Snapshot commands, DTOs and `missingSnapshot` are removed.

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
