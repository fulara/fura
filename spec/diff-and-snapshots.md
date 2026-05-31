# Fura Diffs & Snapshots

## Goal

Show how an OMP session's code changes accumulate over time, against a stable, re-baseable
diff base, and let the user re-baseline cheaply after history rewrites (e.g. a rebase) without
deleting anything.

The feature should answer "what has this session changed?" out of the box (zero configuration),
stay correct after the user rebases or pulls upstream, and never pretend Fura owns the
snapshots — they are OMP session-log data and Fura is a read-only projection of them.

## Current implementation status

Implemented:

- backend `src/diff.rs` for `sessionChanges`/`compareDiff` summaries, scoped lazy `diff.content`
  per-file patches, tokenized diff jobs (stale results suppressed), repo/base candidate
  assembly, detached review-worktree create/checkout, and review-comment anchor mapping,
- repo-diff snapshots are **append-only OMP session-log entries** (`type: "custom"`,
  `customType: "repo-diff-snapshot"`, `data.version == 1`); OMP creates them, Fura only reads
  them via `read_session_diff_snapshots`. OMP auto-creates one `session-start` snapshot at
  session start; the "Snapshot now" UI creates `manual` snapshots, optionally pinned at an
  explicit Git ref,
- each snapshot pins a Git tree/commit under `refs/omp/diff-snapshots/<id>` (durable across
  rebase/GC) and records `tree`, `commit`, `ref`, `createdAt` (ISO-8601 UTC), `repoRoot`,
  `kind`, `label`; `sessionChanges` diffs `git diff <base-snapshot.tree> <working-tree>`,
- **default diff base = the newest snapshot by `createdAt` for the repo**
  (`select_session_repo` / `latest_snapshot_for_repo`). Fura ignores OMP's snapshot `kind`;
  OMP keeps `kind` and its own selector. A re-baseline therefore just needs a newer snapshot —
  no deletion, no sticky session-start,
- base selection is **not persisted**: the repo/base dropdown selection is per-view only;
  reload recomputes the default (newest). The auto request sends `repoId: null`,
- **`/rebase <branch>`** Fura-native slash command (`commands.rs::handle_rebase_slash_command`
  → `diff::rebase_session_repo`): agent-free `git rebase <branch>` on the session `cwd` repo,
  followed by a branch-tip snapshot that becomes the newest base.

Current limitations / accepted residual risks:

- `/rebase` is single-repo (session `cwd`, worktree ignored), no fetch, no `--onto`/flags, and
  takes exactly one ref argument (extra args are rejected),
- `/rebase`'s `Busy`/`Starting` guard is a check, not a lock: a prompt arriving on another
  client mid-rebase can race the working tree, and an abort would discard those edits. Accepted
  for a single-operator local tool (sub-second window, conflict required) rather than adding a
  cross-cutting rebase-in-progress dispatch lock,
- the wire names `SessionRepoCandidate.session_start_snapshot` / `has_session_start_snapshot`
  and `DiffEndpoint::SessionStartSnapshot` now mean "base / newest snapshot"; a full rename
  across `protocol.rs` + `protocol.ts` + frontend + tests is intentionally deferred,
- multi-repo sessions: the default base prefers the newest snapshot in the **active**
  (cwd/worktree) repo, falling back to the newest snapshot overall only when the active repo
  has none — so a newer snapshot in an unrelated repo never silently switches which repository
  the view shows; switch repos via the dropdown,
- there is **no snapshot deletion** in Fura or OMP (append-only). Stale snapshots stay in the
  list but are never the default once a newer one exists.

## Product thesis

Diffs & Snapshots is the session-changes lens, adjacent to session creation and the Conflict
Resolver, scoped as:

- a read-only projection of OMP-owned, append-only snapshots,
- a zero-config "changes since the session's base" diff, with the base re-baseable on demand,
- an ergonomic re-baseline path (`/rebase`, or "Snapshot now → ref") for the common
  post-rebase case,
- not a second source of truth for snapshots, and not a Git history-management UI.

The base-selection design follows from one fact: a re-baseline is "where the work now starts",
which is exactly the newest snapshot. Marking that with OMP `kind` would also work, but Fura
already owns the *selection* (the `repoId` is never persisted in OMP), so picking the newest
snapshot keeps Fura aligned with OMP's own default selector and needs no OMP change.

## Non-goals

- snapshot deletion / tombstones (OMP is append-only; hiding is not worth the divergence),
- persisting a pinned base across reloads (self-defeating with newest-wins: every new snapshot
  would have to clear it),
- interactive rebase, `--onto`, conflict resolution inside `/rebase` (use the shell, or the
  Conflict Resolver), or fetching as part of `/rebase`,
- editing OMP's `kind` semantics or removing the field (no benefit to Fura; touches OMP TUI),
- a hosted terminal/shell (separate feature with its own threat model).

## Snapshot model

- Storage: append-only `custom` entries in the OMP session JSONL. OMP `SessionManager` exposes
  only `appendCustomEntry` — no delete. Fura must treat snapshots as immutable, ordered facts.
- Fields Fura reads (`SessionDiffSnapshot` / `SessionDiffSnapshotSummary`): `entryId`, `kind`
  (`session-start` | `manual`, read but unused for selection), `label`, `repoRoot`, `tree`,
  `ref` (`refs/omp/diff-snapshots/<id>`), `commit`, `createdAt`.
- Anchoring: every snapshot writes a durable ref, so the pinned tree/commit survives rebase and
  GC; the diff against an old snapshot stays computable — "stale" means "no longer the base you
  want", not "broken".

## Base selection model

- Candidates (`session_repo_candidates`): worktree-path, cwd-path, and one per snapshot;
  path candidates carrying a snapshot that is also a standalone candidate are hidden to dedupe.
- Default (`select_session_repo`, no explicit `repoId`): the newest snapshot (greatest
  `createdAt`) **within the active cwd/worktree repo** (`preferred_repo_roots`, captured before
  shadowed path candidates are hidden); falls back to the newest snapshot in any repo, then to
  the prior path-candidate / first-candidate behavior for repos with no snapshots.
- Fresh session: only the auto `session-start` snapshot exists, so it is the newest and the
  base — behavior preserved.
- Override: selecting any snapshot in the dropdown sets `repoId` for that view only.

## `/rebase <branch>` command

Contract:

1. Parse exactly one ref argument; reject empty or extra args with a usage error (before any
   session lookup).
2. Refuse if the session is `Busy`/`Starting`, has no `cwd`, the `cwd` is not a Git repo, the
   working tree is dirty, or `<branch>` does not resolve — each up front, touching nothing.
3. Run `git rebase <branch>` in the `cwd` repo (no fetch). On any failure (conflicts included),
   `git rebase --abort` to restore the original HEAD; escalate to a manual-recovery error only
   if a rebase is still in progress afterwards (`rebase_in_progress`).
4. On success, create a snapshot pinned at the branch tip via the existing `repo_diff_snapshot`
   RPC (`label: "rebase onto <branch>"`). Newest-wins makes it the diff base automatically.

The happy path needs no agent and no form; the only decision point is a conflict, which is
delegated to the shell / Conflict Resolver, not handled in-command.

## Backend ownership

- `src/diff.rs` owns snapshot reading, candidate assembly, base selection, diff generation, the
  `rebase_session_repo` helper, and review-worktree mechanics.
- `src/commands.rs` owns the `/rebase` slash dispatch and orchestration (guards, then the
  snapshot RPC).
- `src/protocol.rs` + `frontend/src/protocol.ts` carry the DTOs (`SessionRepoCandidate`,
  `SessionDiffSnapshotSummary`, `DiffEndpoint`, the `sessionChanges*`/`compareDiff`/`diff.*`
  messages); manually mirrored, no generated schema.
- OMP is the source of truth for snapshot creation (`repo_diff_snapshot` RPC) and storage.

## Protocol sketch

Client → bridge:

- `sessionChanges.request` — summary for a session (optional `repoId`, detail mode, selected
  file, context lines),
- `sessionChanges.snapshot` — create a snapshot (optional `label`, `repoRoot`, `ref`),
- `compareDiff.request` — arbitrary base/head refs,
- `diff.content.request` — scoped lazy per-file patch,
- `diff.cancel` — cancel an in-flight diff job,
- review-worktree ensure/checkout and review-comment messages,
- `/rebase <branch>` rides the normal slash/prompt path, not a dedicated message.

Bridge → client:

- `SessionChangesSummary` (state: `repos`, `selectedRepoId`, `comparison` with `base`/`head`
  `DiffEndpoint`s, `summary`, `review`), `diff.content`, diff error / `missingSnapshot` /
  `missingRepo` states, and a `session.notice` for `/rebase` outcomes.

## Implementation phases

### Phase 1: snapshot projection + session-changes diff

Status: implemented. Read OMP snapshots, build candidates, diff base→working-tree, lazy
per-file patches, tokenized jobs.

### Phase 2: compare diffs + review worktrees + review comments

Status: implemented. Arbitrary ref compare, detached review worktrees under
`.fura/review-worktrees/<uuid>`, agent review comments mapped to anchors.

### Phase 3: newest-snapshot base + `/rebase`

Status: implemented. Default base = newest snapshot by `createdAt` (ignore `kind`); agent-free
`/rebase <branch>` with guards, abort-on-failure, and branch-tip re-baseline snapshot.

## Open questions

- Is the deferred rename of `sessionStartSnapshot`/`hasSessionStartSnapshot` to base/newest
  worth a one-shot cross-cutting change, or left until the next diff-view refactor?
- If `/rebase` grows (form, `--onto`, fetch, conflict routing), does the accepted concurrency
  race justify a real rebase-in-progress dispatch lock?

## Recommended next step

Leave the subsystem as-is unless `/rebase` grows; if it does, revisit the concurrency lock and
the wire-name rename together rather than piecemeal.
