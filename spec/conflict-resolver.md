# Fura Conflict Resolver

## Goal

Add a standalone desktop Conflict Resolver to Fura for resolving Git merge/rebase/cherry-pick/revert conflicts with an IntelliJ-like 3-way workflow plus agent-assisted explanation and proposal.

The feature should make Fura useful when a developer is stuck in a conflicted repository, without pretending that an LLM can safely auto-merge arbitrary business logic.

## Current implementation status

Implemented so far:

- dedicated desktop Conflict Resolver Dockview host/mode, separate from normal session and diff-review layouts,
- backend `src/conflict.rs` for repository scan, conflict classification, stage 1/2/3/result extraction, guarded conflict-result writes, explicit stage-resolved flow, and preview-first deterministic magic wand resolution,
- frontend `frontend/src/conflictResolver.ts` with conflicted file list, branch-aware labels, editable result, per-conflict resolution actions, conflict navigation, focused conflict preview, and magic-wand preview/apply-to-draft UI, backed by a normal OMP session created from desktop UI specifically for this workflow,
- protocol messages for `conflict.scan`, `conflict.file.open`, `conflict.file.previewMagicWand`, `conflict.file.writeResult`, `conflict.file.stageResolved`, `conflict.snapshot`, `conflict.file`, `conflict.magicWandPreview`, `conflict.status`, and `conflict.error`,
- hardening for stale-response filtering, draft-loss confirmation, unsupported-conflict read-only behavior, and content-hash version guards.

Current limitations:

- deterministic magic wand preview is implemented only for narrow text cases: identical sides, linewise independent edits, same-line non-overlap, and add/add import-style unions with duplicate removal,
- magic wand is preview-first and apply-to-draft only; the actual write boundary is still explicit save,
- magic wand currently operates only on saved `both modified` / `add/add` text conflicts whose remaining markers still match Git's unresolved chunks,
- agent assistance is implemented for saved text `both modified` / `add/add` conflicts as a preview-first subset: explain selected conflict, propose selected-conflict resolution, and propose whole-file resolution,
- conflict-resolution agent assistance now runs through the normal OMP session created/selected from the Conflict Resolver flow, so it stays preview-first without borrowing an unrelated active session,
- manual resolution currently supports only text `both modified` and `add/add` conflicts.
## Product thesis

Conflict resolution is a standalone Fura tool, adjacent to session creation and diff review, scoped as:

- a local repository/worktree tool,
- a 3-way conflict resolution UI,
- an agent-assisted review/proposal loop,
- not an autonomous merge-and-commit bot.

The comparable IntelliJ UX to preserve is:

- left/right read-only inputs,
- editable result pane,
- apply all non-conflicting changes,
- accept one side or both at a conflict,
- a “magic wand” for simple conflicts,
- explicit review/apply by the human.

JetBrains documents the IntelliJ merge tool as local/read-only left and right panes with an editable central result, explicit accept/ignore actions per side, automatic application of non-conflicting changes, and a simple-conflict resolver button for cases such as edits to different parts of the same line. Git documents the custom mergetool contract as `BASE`, `LOCAL`, `REMOTE`, and `MERGED`, where the tool writes the resolved result into `MERGED`.

References:

- https://www.jetbrains.com/help/idea/resolve-conflicts.html
- https://git-scm.com/docs/git-merge
- https://git-scm.com/docs/git-mergetool

## Non-goals

Do not build these in v1:

- full IDE editing outside conflict/result buffers,
- background autonomous merges,
- automatic staging/commit/push,
- conflict resolution for binary files,
- lockfile generation without invoking the package manager,
- database migration conflict policy beyond warning and manual resolution,
- mobile UI,
- raw Git porcelain exposed directly to the frontend as the product API.

## User workflow

### Entry points

The user opens Conflict Resolver from the desktop sidebar action row next to `New` and `Diff`. That opens the creation flow in Conflict Resolver mode, where the user enters the conflicted repository root and creates a normal OMP session for this workflow. After that session becomes active, desktop opens the Conflict Resolver workspace and scans that session's configured repository root for unresolved Git conflicts.

### Happy path

1. Fura detects a conflicted Git repository.
2. Desktop opens a dedicated Conflict Resolver mode/panel.
3. The sidebar lists conflicted files, grouped by conflict type.
4. Selecting a file shows:
   - base/common ancestor,
   - current branch,
   - incoming change,
   - editable conflict result.
5. User applies deterministic actions:
   - apply all non-conflicting changes,
   - accept ours,
   - accept theirs,
   - accept both,
   - edit result.
6. For hard conflicts, user asks the agent to explain or propose a resolution.
7. Fura shows the proposed result as a preview diff before writing.
8. User applies the proposal explicitly.
9. Fura verifies there are no conflict markers in the file and the Git index no longer reports that path as unmerged after staging/marking resolved.
10. Fura reports remaining unresolved files truthfully.

## UX model

### Desktop-only v1 with dedicated Dockview

Conflict Resolver belongs in desktop, not mobile. Mobile can later show read-only conflict state, but resolving conflicts on a phone is not a v1 product target.

Use a dedicated Conflict Resolver Dockview host/mode instead of trying to fit conflict-resolution panels into the existing normal or diff-review Dockview. Prior diff/diffs work showed that mixing workflows with different panel invariants creates layout confusion and brittle restoration logic. Conflict resolution has its own invariants — entry via dedicated create/open flow, conflicted file list, 3-way source panes, editable result, and agent proposal panel — so it should have its own persisted layout namespace and mode switch.

The normal workspace, diff-review workspace, and conflict-resolution workspace should be treated as separate topologies. Shared rendering helpers are fine; shared Dockview panel identity/layout state is not.

### Layout

Preferred v1 layout:

```text
+----------------------+-----------------------------------------------+
| Conflicted files     | File: frontend/src/protocol.ts                |
|                      |                                               |
| [!] protocol.ts      | +-------------+-------------+-------------+   |
| [!] session.rs       | | Ours        | Base        | Theirs      |   |
| [ ] README.md        | | read-only   | read-only   | read-only   |   |
|                      | +-------------+-------------+-------------+   |
| Agent panel          | | Result / editable merged file            |   |
| - Explain conflict   | | with hunks, actions, and preview states  |   |
| - Propose resolution | +-------------------------------------------+   |
+----------------------+-----------------------------------------------+
```

The exact editor component can be decided during implementation. Monaco is attractive for 3-way editing, but v1 can also use the existing code/diff rendering if result editing remains constrained and reliable.

### Conflict actions

Per file:

- Apply non-conflicting changes.
- Resolve all simple conflicts in file.
- Ask agent about file.
- Propose file resolution.
- Mark resolved / stage file.
- Revert file to conflicted result from Git if the user wants to restart.

Per conflict hunk:

- Accept ours.
- Accept theirs.
- Accept both: ours then theirs.
- Accept both: theirs then ours.
- Ignore ours.
- Ignore theirs.
- Explain conflict.
- Propose resolution.
- Copy agent prompt context.
### Current manual-resolution ergonomics

Current desktop behavior includes:

- branch-aware buffer labels instead of raw `ours` / `theirs`,
- conflict picker plus previous/next conflict navigation,
- focused conflict preview showing current-branch and incoming chunks side by side,
- editable conflict-result draft with guarded save,
- explicit preview-first magic wand that explains its matched rule and only applies into the local draft after an explicit click,
- explicit “Mark resolved” only after save and after conflict markers are gone,
- confirmation before losing an unsaved resolution draft while refreshing, switching files, opening another root, leaving Conflict Resolver, switching sessions, or switching to Ask Fura.

The UI must always distinguish deterministic local actions from agent proposals.

## Backend architecture

Add a `conflict` backend module rather than expanding `diff.rs` indefinitely.

Suggested ownership:

- `src/conflict.rs`
  - repository conflict discovery,
  - Git stage extraction,
  - conflict marker parsing,
  - deterministic resolution helpers,
  - result write/stage operations.
- `src/protocol.rs`
  - `conflict.*` client/server DTOs.
- `src/commands.rs`
  - dispatch client messages to conflict module.
- `frontend/src/conflictResolver.ts`
  - pure view state/render helpers.
- `frontend/src/main.ts` / `frontend/src/desktopDockview.ts`
  - dedicated Conflict Resolver Dockview host/mode wiring, separate from normal and diff-review layouts.
- `frontend/src/style.css`
  - desktop styling.

Keep this separate from `diff.rs` because conflict resolution has different invariants:

- three source stages plus one result,
- writable result buffer,
- unmerged index entries,
- path-level resolved/staged state,
- conflict markers in the working tree,
- operation contexts such as merge, rebase, cherry-pick, revert, and stash apply.

## Git model

### Source of truth

Git is the source of truth for conflict state.

Fura should derive conflict state from:

- repository root,
- `git status --porcelain=v2` or equivalent library-backed status,
- unmerged index stages,
- working tree file content,
- merge/rebase/cherry-pick state files when available.

For a conflicted file, Fura needs four logical buffers:

- `base`: common ancestor / Git stage 1 when available,
- `ours`: local/current branch / Git stage 2,
- `theirs`: incoming branch / Git stage 3,
- `result`: working tree file, initially containing Git conflict markers or an edited conflict result.

If any source buffer is unavailable, the UI must show that truthfully and degrade to two-way/manual resolution.

### Conflict types

At minimum, classify:

- both modified,
- add/add,
- delete/modify,
- rename/modify,
- rename/delete,
- both deleted,
- binary conflict,
- submodule conflict,
- unknown/unhandled.

V1 may only support text conflicts for `both modified` and `add/add`, but it must list unsupported conflicts with clear next steps rather than hiding them.

### Safety rules

Fura must not:

- mutate a repository unless the user explicitly applies an action,
- stage a file without showing the resulting content or making the action explicit,
- commit automatically,
- resolve files outside the selected repository root,
- follow symlink escapes outside the repository root,
- overwrite files that changed since Fura loaded them without detecting stale content,
- claim success while Git still reports unmerged entries,
- treat absence of conflict markers as proof that the Git index is resolved.

Every write should be guarded by the file version/hash that the frontend reviewed.

## Deterministic magic wand

The first magic wand should be a deterministic resolver for simple cases. It should run before or without involving an agent.

Current implementation status:

- implemented as a preview-first flow: `conflict.file.previewMagicWand` returns `conflict.magicWandPreview`, and the user must still apply the preview into the draft and save explicitly,
- implemented rules:
  - identical-side deduplication,
  - combine linewise edits when each changed line is still anchored by base on the opposite side,
  - combine non-overlapping same-line edits,
  - add/add import-style union with exact-duplicate removal,
- unsupported or ambiguous blocks stay manual-only.

Supported candidates:

- apply all non-conflicting changes,
- combine edits to disjoint portions of the same line when the merge algorithm can prove no overlap,
- merge import lists and remove exact duplicates,
- merge sorted/export lists when both sides add distinct entries,
- preserve both enum/object/type members when keys are distinct,
- resolve pure whitespace/line-ending conflicts when repository attributes/config make the policy clear.

Output states:

- `applied`: written to result after explicit user click,
- `preview`: safe proposal but not written,
- `needsReview`: plausible but requires user review,
- `unsupported`: no deterministic resolution.

The deterministic wand must explain what rule it used. If it cannot name a rule, it should not apply.
## Agent-assisted conflict resolution

Agent help should be proposal-oriented:

- explain selected conflict,
- propose selected hunk resolution,
- propose whole-file resolution.

Current implementation status:

- implemented as `conflict.agent.run` → `conflict.agentResult`,
- supports `mode: "explain"` for the selected conflict,
- supports `mode: "propose"` for the selected conflict and the whole file,
- returns summary, explanation, risk label, and optional proposed file content,
- remains preview-first: applying the agent result only updates the local draft, and explicit save is still the disk-write boundary,
- validates `sourceVersion` and rejects stale proposals,
- for selected-conflict proposals, validates that bytes outside the selected conflict block remain identical to the saved file.

The current subset uses the OMP session opened from the Conflict Resolver flow itself for agent assistance. That keeps the workflow isolated from unrelated coding sessions without introducing a second hidden session.

The agent should receive structured context, not the whole repo by default:

- repository root,
- operation type if known: merge/rebase/cherry-pick/etc.,
- path and conflict type,
- base/ours/theirs/result snippets,
- neighboring symbols/imports,
- related tests or protocol mirror files when discoverable,
- current user instruction.

Agent output must be a patch/proposed result plus explanation/risk, not silent file mutation.

### Agent risk levels

Every proposal should be labeled:

- low: mechanical/import/list resolution with clear tests,
- medium: semantic code merge with local context,
- high: business logic, generated files, lockfiles, migrations, config, or ambiguous intent.

High-risk proposals should default to preview only and require manual edit/apply.

## Protocol sketch
## Protocol sketch

Client messages:

```text
conflict.scan { root }
conflict.file.open { repoId, path }
conflict.file.applyAction { repoId, path, action, conflictId?, expectedVersion }
conflict.file.writeResult { repoId, path, content, expectedVersion }
conflict.file.stageResolved { repoId, path, expectedVersion }
conflict.agent.run { sessionId, repoId, path, expectedVersion, mode, scope, conflictId?, instructions }

Server messages:

conflict.snapshot { repos }
conflict.file { repoId, path, base?, ours?, theirs?, result, conflicts, version }
conflict.magicWandPreview { preview }
conflict.agentResult { result }
conflict.status { repoId, path?, state }
conflict.error { repoId?, path?, message }
```

These protocol names are part of the standalone Conflict Resolver surface; Rust and TypeScript mirrors must stay in sync.

## Implementation phases

### Phase 1: conflict discovery and read-only workbench

Status: implemented.

Delivered:

- backend scan for conflicted repos/worktrees,
- conflicted file list,
- stage 1/2/3/result extraction for text files,
- desktop Conflict Resolver panel,
- read-only 3-way/result display,
- unsupported conflict warnings.

### Phase 2: manual resolution

Status: implemented, with post-Phase-2 hardening.

Delivered:

- editable result buffer,
- accept current/incoming/both per conflict block,
- guarded write result flow,
- explicit mark-resolved/stage flow,
- content-hash stale-content guard,
- backend conflict-marker validation before stage,
- draft-loss confirmation and stale-response filtering in the frontend.

### Phase 3: deterministic magic wand

Status: implemented for the initial preview-first subset.

Delivered:

- rule-based deterministic preview for narrow safe text conflicts,
- explicit preview/apply-to-draft flow with no automatic write,
- rule explanation per resolved conflict block,
- focused Rust/frontend tests for safe rules and refusal paths.

### Phase 4: agent explain/propose

Status: implemented for the initial preview-first subset.

Delivered:

- conflict-context builder for saved-file agent assistance,
- conflict-resolution agent integration through the OMP session opened from the Conflict Resolver flow,
- explain selected conflict,
- propose selected-conflict or whole-file resolution,
- preview-first apply-to-draft flow with explicit save still required for disk writes,
- risk labels and stale-version validation.

## Open questions
## Open questions

- Should Fura invoke Git through CLI commands first, or use `git2` for index stage access and reserve CLI for operations `git2` handles poorly?
- Which editor component gives the best 3-way/result editing tradeoff for plain Vite TypeScript without turning Fura into an IDE?
- Should Conflict Resolver assistance keep using the normal session opened from its entry flow, or should future iterations add a separate restricted sub-session only if product requirements change?
## Recommended next step

Harden the current Phase 4 agent path without expanding scope beyond conflict resolution.

Concrete next implementation plan:

1. Keep repository-root selection inside the Conflict Resolver entry/create flow; do not reintroduce implicit scan targets from unrelated active sessions.
2. Keep agent output preview-first, with risk labels and explicit apply.
3. Leave deterministic rules narrow; do not silently turn the agent path into automatic conflict resolution.
4. Preserve the current save/version/stage guards when applying any agent proposal.