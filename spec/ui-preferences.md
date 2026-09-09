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
  panel always shows them regardless.
- `show-edit-diffs` — hides/shows the inline unified-diff preview on
  edit-family tool cards (`edit`, `ast_edit`, `write`, plus any tool whose
  result carries `details.diff`). The preference is part of the tool-card
  render cache key (`d1`/`d0` prefix), so flipping it re-renders tool cards
  without invalidating cached message DOM.
- `thinking-visibility` — `auto` shows live thinking expanded and historical
  collapsed; `shown`/`hidden` force it. Changing it resets the transcript
  render cache (thinking lives inside message DOM).

### Desktop density

Desktop uses a fixed compact layout, not another persisted display preference:
208px session sidebar, flat two-line session rows, small proportional titles,
compact panel headers and a 48px resizable prompt field. Session metadata and
repository paths ellipsize rather than expanding their rows. Transcript prose
and code font sizes are unchanged. Keyboard focus remains visible; coarse-pointer
controls use at least 44px targets. Shared-component density overrides live in
`desktopDensity.css`, imported only by the desktop entry point; mobile keeps the
shared form typography and card defaults.
The prompt field touches the status-bar separator when no images are attached.
The hidden attachment strip contributes no padding or border; attached images
remain visible above the prompt.

### Context usage

Both status bars display OMP's authoritative `get_state.contextUsage`: current
context tokens, model capacity and percentage, not cumulative session token usage.
Fura refreshes this state after model selection/cycling, builtin `/compact`
completion (`prompt_result` or local-only prompt response), low-level `compact`
responses and automatic compaction completion. No further prompt or page reload
is needed. Unknown usage clears the previous value rather than retaining stale
numbers; provider-specific token accounting stays in OMP.

## Adding a new preference

Mirror the existing plumbing end to end: `config.rs` (FuraConfig + disk struct
+ default + `client_config` + `save_fura_config`), `state.rs`, `protocol.rs`
`ConfigSet`, `commands.rs` `set_client_config` (including the rollback path),
`frontend/src/protocol.ts` (`ServerConfig` + `config.set`), and both shells'
`applyVisibilityPreferences`. Decide explicitly whether the toggle UI appears
on mobile; applying the value is mandatory either way.
