# UI Preferences (client display toggles)

Design intent for the persisted, bridge-owned display preferences that shape
how the transcript renders. Current preferences:

| Preference | Config key (`.fura/config.yaml`) | Values | Default |
| --- | --- | --- | --- |
| Tool bubbles | `show-tools` | bool | `true` |
| Inline edit diffs | `show-edit-diffs` | bool | `true` |
| Thinking visibility | `thinking-visibility` | `auto` / `shown` / `hidden` | `auto` |

## Model

- Preferences are **global, not per-session or per-client**. The bridge owns
  them (`AppState`), persists them in `.fura/config.yaml`, and projects them to
  every client through `ClientConfig` (`hello` and `config.updated`).
- Clients change a preference with `config.set` (partial: only the fields being
  changed). The bridge validates, persists, then broadcasts `config.updated`;
  on a persistence failure it rolls the in-memory values back and returns an
  error instead of broadcasting.
- All connected clients (desktop tabs, mobile) follow the same values. Mobile
  may omit the editing UI for a preference (today it has toggles for tools and
  thinking but not edit diffs) yet must still *apply* the value it receives.
- Frontends treat a missing field as its default (`parseToolVisibility` /
  `parseThinkingVisibilityMode`), so an older bridge serving a newer frontend
  degrades to defaults instead of breaking.

## Rendering contract

- `show-tools` — hides/shows tool cards inline in the transcript. The Tools
  panel always shows them regardless. Edit-family cards remain in the transcript
  while `show-edit-diffs` is enabled, including running operations and errors.
- `show-edit-diffs` — hides/shows recorded patch previews on edit-family cards
  (`edit`, `ast_edit`, `write`, plus tools with `details.diff` or per-file diffs).
  File headers remain visible when tool cards themselves are shown. The value
  participates in the tool-card render cache key, so flipping it re-renders tool
  cards without invalidating cached message DOM.
- `thinking-visibility` — `auto` shows live thinking expanded and historical
  collapsed; `shown`/`hidden` force it. Changing it resets the transcript
  render cache (thinking lives inside message DOM).

### Edit-file cards

Desktop transcript, Tools and mobile share the same edit renderer:

- Every reported file has a keyboard-operable disclosure with its path, operation,
  completion state and recorded patch counts. Paths within the session cwd retain
  their directories; outside paths remain absolute. Tooltips retain original paths.
  Rename headers show source and destination, not just the destination basename.
- One short patch (at most 120 lines) opens by default. Multiple files, unknown
  combined patches and long patches start closed. File headers stay visible.
- Patch DOM is created only when opened. Long patches reveal another 120 lines
  per action inside a bounded scroll area; no recorded lines are permanently
  discarded. Copy copies that file's entire reported patch.
- Open, settled patches use the shared [diff highlighting](diff-and-snapshots.md#diff-highlighting)
  renderer: muted syntax plus conservative changed-word emphasis. Growing tool results
  stay plain; collapsed files are not tokenized. Unknown paths/languages and excessive
  inputs retain their original text and existing chunk controls.
- Manual disclosure choices are keyed by session, tool call and file identity,
  not render hash or list position. Up to 500 recent choices live in tab-local
  sessionStorage, surviving page reload and history reconstruction. Storage failure
  leaves an in-memory fallback. Relative/absolute paths are reconciled lexically
  against cwd; the browser does not guess symlink, suffix-recovery or URI aliases.
- Completed `details.perFileResults` and single-file `details.path` are authoritative.
  Running cards show requested paths from structured arguments or OMP's freeform
  grammar headers. Native speculative `tool_stream_update` previews are not treated
  as executed changes, and this feature does not add a preview RPC projection.
- A failed tool call is not proof of rollback. Explicit per-file errors are shown;
  missing individual outcomes are unknown because earlier writes may have succeeded.
  AST proposals remain labelled Proposed instead of Completed.
- Legacy/incomplete results retain an explicitly unattributed combined patch.
  Freeform header counts and hunk/line numbers never determine patch attribution.
  Only a known single-target argument can identify an old single-file patch.
- Counts describe reported tool patch lines, not the current Git working tree or
  a commit. Snapshot pruning does not imply create/delete. Later formatting or
  auto-repair may change disk content beyond the tool's recorded patch; original
  tool output remains accessible beneath the file disclosures.

Interaction inspiration: Codex CLI's [path-separated file summaries and counts](https://github.com/openai/codex/blob/9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a/codex-rs/tui/src/snapshots/codex_tui__diff_render__tests__apply_multiple_files_block.snap),
and the [official app documentation's per-file expand/collapse interaction](https://learn.chatgpt.com/docs/code-review?surface=app).
No Codex implementation code is copied; CLI snapshots and app documentation are
separate evidence, not a claim that the app's internal behavior was inspected.

### Desktop density

Desktop uses a fixed compact layout, not another persisted display preference:
208px session sidebar, flat two-line session rows, small proportional titles,
compact panel headers and a 96px default-height resizable prompt field. Session metadata and
repository paths ellipsize rather than expanding their rows. Transcript prose
and code font sizes are unchanged. Keyboard focus remains visible; coarse-pointer
controls use at least 44px targets. Shared-component density overrides live in
`desktopDensity.css`, imported only by the desktop entry point; mobile keeps the
shared form typography and card defaults.
The prompt field touches the status-bar separator when no images are attached.
The hidden attachment strip contributes no padding or border; attached images
remain visible above the prompt.
The textarea remains manually resizable down to 48px, with a maximum of the smaller
of 18rem and 40vh so short windows retain transcript space and reachable controls.
Its height is outside saved Dockview layouts. Manual resizing remains unpersisted;
reload restores the larger default without resetting panel layouts or other preferences.

### Unsent desktop drafts

The desktop composer keeps an in-memory draft per logical session ID: exact text,
images and pasted snippets. New sessions start empty; Ask Fura and the no-session
workspace have separate drafts. Switching panels, same-session projections and
WebSocket reconnects within the same document do not clear them. Reloading the
page or restarting the browser discards drafts; there is no server or browser-storage persistence.

An accepted send consumes only its originating draft. A disconnected/failed
transport send retains it. Steer/follow-up choices are owned by their session;
late rejections retain newer editor text, and failed choices remain recoverable.
Asynchronous image reads and voice updates remain bound to the captured draft,
and cannot revive one already submitted or deleted.

Drafts are retired after an explicit session-delete request and its removal from
the catalog, never just because a session is temporarily absent from a snapshot.
This feature does not add per-session drafts to the mobile composer.

### Context usage

Both status bars display OMP's authoritative `get_state.contextUsage`: current
context tokens, model capacity and percentage, not cumulative session token usage.
Fura refreshes this state after model selection/cycling, builtin `/compact`
acknowledgement, low-level `compact` responses and automatic compaction completion.
The builtin acknowledgement (`prompt_result` or local-only prompt response) can
precede background compaction completion: it must not unlock the composer.
While compacting, `command_output` triggers another authoritative refresh for
success, failure or progress; successful `abort` responses cover cancellation
without terminal output. Only authoritative state ends the compaction lock.
No further prompt or page reload is needed. Unknown usage clears the previous
value rather than retaining stale numbers; provider-specific accounting stays in OMP.

## Adding a new preference

Mirror the existing plumbing end to end: `config.rs` (FuraConfig + disk struct
+ default + `client_config` + `save_fura_config`), `state.rs`, `protocol.rs`
`ConfigSet`, `commands.rs` `set_client_config` (including the rollback path),
`frontend/src/protocol.ts` (`ServerConfig` + `config.set`), and both shells'
`applyVisibilityPreferences`. Decide explicitly whether the toggle UI appears
on mobile; applying the value is mandatory either way.
