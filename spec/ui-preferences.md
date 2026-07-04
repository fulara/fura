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

## Adding a new preference

Mirror the existing plumbing end to end: `config.rs` (FuraConfig + disk struct
+ default + `client_config` + `save_fura_config`), `state.rs`, `protocol.rs`
`ConfigSet`, `commands.rs` `set_client_config` (including the rollback path),
`frontend/src/protocol.ts` (`ServerConfig` + `config.set`), and both shells'
`applyVisibilityPreferences`. Decide explicitly whether the toggle UI appears
on mobile; applying the value is mandatory either way.
