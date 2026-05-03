# Dockview Migration Plan

## Goal

Migrate Fura's central workspace from a fixed transcript-only area to a Dockview-backed panel host, starting with two panels:

- `Transcript`
- `Tools`

The migration should preserve the existing Fura GUI behavior. Dockview should own only panel layout: tabs, splits, resizing, docking, floating, popout, and layout persistence.

## Non-goals

- Do not move the whole app into Dockview.
- Do not rewrite transcript, markdown, code block, thinking block, or tool card rendering from scratch.
- Do not change the Rust bridge protocol for the initial migration.
- Do not introduce React/Vue/Svelte.
- Do not rely on Dockview to understand OMP/Fura domain state.

## Target Architecture

Keep stable session chrome outside Dockview:

```text
┌─────────────┬─────────────────────────────────────┐
│ sessions    │ workspace header                    │
│ sidebar     ├─────────────────────────────────────┤
│             │ Dockview panel host                 │
│             │   Transcript | Tools                │
│             ├─────────────────────────────────────┤
│             │ status bar                          │
│             │ prompt input                        │
└─────────────┴─────────────────────────────────────┘
```

Fura owns panel contents. Dockview owns panel placement.

```text
Dockview: where panels live
Fura: what panels mean and render
```

## Recommended Dependency

Use `dockview-core`, not a framework wrapper.

Observed package metadata from npm:

- Package: `dockview-core`
- License: MIT
- Description: zero-dependency layout manager for vanilla TypeScript
- Supports tabs, groups, grids, splitviews, floating groups, and popout windows

Relevant docs:

- https://dockview.dev/
- https://dockview.dev/docs/core/groups/popoutGroups/
- https://dockview.dev/docs/core/groups/floatingGroups/
- https://www.npmjs.com/package/dockview-core

## UX Decision

Default layout should be:

```text
Transcript | Tools
```

Recommended defaults:

- Transcript left, approximately 70% width.
- Tools right, approximately 30% width.
- Keep existing inline tool bubble toggle.
- Once the Tools panel exists, consider defaulting inline tool bubbles to off for cleaner transcript scanning.

Tool visibility concepts should remain distinct:

- `Tools panel visible/docked/popped out`: controls the dedicated tool execution view.
- `Inline tools on/off`: controls whether tool cards appear inside the chronological transcript.

## Phase 1: Prepare Render Boundaries

### Objective

Make transcript and tools rendering target explicit containers instead of relying on one global `#transcript` element.

### Work

1. Extract transcript rendering into:

```ts
function renderTranscriptView(container: HTMLElement, projection?: SessionProjection): void
```

2. Extract tool rendering into:

```ts
function renderToolsView(container: HTMLElement, projection?: SessionProjection): void
```

3. Keep existing tool card renderers:

- `renderToolCard`
- `renderReadToolCard`
- `renderReadToolGroup`
- `renderGrepToolCard`
- `renderTodoWriteCard`
- `renderTaskCard`

4. Update `renderActiveSession()` to orchestrate:

```ts
renderTranscriptView(transcriptContainer, projection);
renderToolsView(toolsContainer, projection);
```

5. Preserve current scroll behavior in the transcript view:

- scroll to bottom on session switch/open
- during live updates, scroll only if already near bottom
- preserve manually opened thinking blocks across re-renders

### Acceptance

- Existing single-transcript UI still behaves the same.
- Inline tool toggle still works.
- No Dockview dependency yet.
- `npm --prefix frontend run build` passes.

## Phase 2: Add Dockview Panel Host

### Objective

Replace the fixed central `#transcript` section with a Dockview host that contains `Transcript` and `Tools` panels.

### Work

1. Install `dockview-core`.
2. Add Dockview CSS/theme imports according to package docs.
3. Replace central transcript markup with a container, for example:

```html
<div id="workspacePanelHost" class="workspace-panel-host"></div>
```

4. Keep outside Dockview:

- sidebar
- workspace header
- status bar
- prompt form
- command palette and attachment previews unless later deliberately moved

5. Register two panels:

- `transcript`
- `tools`

6. Initial layout:

- `Transcript` as primary panel
- `Tools` docked to the right

7. Make panel renderers call Fura-owned render functions:

```ts
renderTranscriptView(panelContainer, projection);
renderToolsView(panelContainer, projection);
```

8. On session state updates, re-render both panels from the same `SessionProjection`.

### Acceptance

- Transcript renders inside Dockview.
- Tools render in right-side panel.
- Prompt/status/header/sidebar remain stable outside Dockview.
- Resizing the split works.
- Switching sessions updates both panels.
- Existing inline tool toggle still controls only transcript inline tools.
- `npm --prefix frontend run build` passes.

## Phase 3: Persist Layout

### Objective

Persist the user's panel layout locally.

### Work

1. Serialize Dockview layout when it changes.
2. Store it in `localStorage`, e.g.:

```ts
const DOCKVIEW_LAYOUT_STORAGE_KEY = "fura.dockview.layout";
```

3. Restore layout on startup when valid.
4. Fall back to default `Transcript | Tools` layout when missing or invalid.
5. Version the persisted layout if needed:

```ts
type PersistedDockviewLayout = {
  version: 1;
  layout: unknown;
};
```

### Acceptance

- User layout survives reload.
- Corrupt/incompatible layout does not break startup.
- Default layout still works for first-time users.
- `npm --prefix frontend run build` passes.

## Phase 4: Make Renderers Popout-Safe

### Objective

Prepare Fura panel rendering for Dockview popout windows.

### Problem

Popout panels render in another `window.document`. Code that always uses global `document.createElement(...)` can create nodes in the wrong document.

### Work

1. Introduce a small helper pattern:

```ts
function element<K extends keyof HTMLElementTagNameMap>(
  owner: Document,
  tag: K,
): HTMLElementTagNameMap[K] {
  return owner.createElement(tag);
}
```

2. In panel render paths, prefer:

```ts
const owner = container.ownerDocument;
owner.createElement("div");
```

3. Apply this at least to renderers that can appear inside `Transcript` or `Tools` panels:

- message renderers
- block renderers
- code block renderer
- tool card renderers
- copy buttons
- thinking details

4. Keep global `document` usage only for fixed app shell and truly main-window-only elements.

### Acceptance

- Main window rendering still works.
- Panel renderers no longer assume global `document`.
- `npm --prefix frontend run build` passes.

## Phase 5: Enable Popout Windows

### Objective

Allow Dockview groups, especially Tools, to pop out into a separate browser window and dock back.

### Work

1. Add `frontend/public/popout.html` or equivalent static asset expected by Dockview.
2. Ensure popout page loads required Fura and Dockview styles.
3. Wire Dockview popout API:

```ts
api.addPopoutGroup(group, {
  popoutUrl: "/popout.html",
});
```

4. Expose UI affordance:

- panel menu item or button: `Pop out`
- dock-back action if Dockview default behavior is not enough

5. Handle popup blocker failure:

```ts
api.onDidOpenPopoutWindowFail(() => {
  // show a session notice or non-invasive UI message
});
```

6. Verify close behavior:

- if user closes popup, Dockview should attempt to restore the group
- if restore fails, explicitly move Tools back into the main grid

### Acceptance

- Tools can pop out into a separate browser window.
- Closing popup restores Tools to the main layout or safe fallback.
- Dock-back path works.
- Popout panel is styled correctly.
- Transcript and Tools continue updating from live session state.
- `npm --prefix frontend run build` passes.

## Phase 6: Polish and Guardrails

### Objective

Make the panel system pleasant and hard to break.

### Work

1. Add empty states:

- no active session
- no tool executions yet
- tools popped out placeholder if needed

2. Add panel-specific controls only where useful:

- Tools: clear filter/search later, not clear history
- Transcript: inline tool visibility toggle can stay in header or move into transcript panel toolbar

3. Consider future filters:

- running tools only
- failed tools only
- tool name filter

4. Add keyboard/focus guardrails:

- prompt keyboard behavior should not break when panels are focused
- copy buttons should still work inside popouts

5. Avoid making Dockview the source of domain truth:

- layout state may persist
- session/tool/transcript state remains in Fura projections

### Acceptance

- The UI remains understandable when panels are moved, resized, or popped out.
- Prompt/status/session controls remain stable.
- No panel placement loses transcript/tool state.

## Verification Strategy

After each phase:

```bash
npm --prefix frontend run build
```

For popout/floating work, also manually verify in browser with mock RPC:

```bash
npm --prefix frontend run build
FURA_TOKEN=dev cargo run -- \
  --static-dir frontend/dist \
  --rpc-program node \
  --no-default-rpc-args \
  --rpc-arg fixtures/mock-omp-rpc.mjs
```

Manual scenarios:

1. Open a session.
2. Confirm transcript renders.
3. Confirm Tools panel shows historical and live tool executions.
4. Toggle inline tools off/on and verify tools return to their chronological transcript positions.
5. Resize Tools panel.
6. Reload and verify layout restore.
7. Pop out Tools.
8. Close popup and verify safe restore.
9. Switch sessions and verify both panels update.
10. Copy from transcript/code/tool output where applicable.

## Risks

### Popout document mismatch

Mitigation: convert panel renderers to use `container.ownerDocument`.

### CSS not loaded in popout

Mitigation: add/verify `popout.html` loading the same CSS/theme assets.

### Layout dependency takes over app architecture

Mitigation: keep Dockview limited to the central workspace panel host.

### Prompt/status instability

Mitigation: keep prompt, status bar, session header, and sidebar outside Dockview.

### Layout persistence breakage after future panel changes

Mitigation: version persisted layout and fall back cleanly.

## Open Decisions

1. Should inline tool bubbles default to off once the Tools panel exists?
   - Recommendation: yes, if Tools panel is visible by default.

2. Should Tools be right-side by default or a tab?
   - Recommendation: right-side by default, roughly 30% width.

3. Should `Status` become a Dockview panel later?
   - Recommendation: not initially. Keep it fixed until there is a concrete status-detail view.

4. Should popout be enabled immediately?
   - Recommendation: no. First land docked panels, then make renderers popout-safe, then enable popout.

## Summary

Dockview is a good fit if Fura is becoming a workspace with movable panels. The safest migration is incremental:

1. Extract panel renderers.
2. Add Dockview only to the central workspace.
3. Start with Transcript left and Tools right.
4. Persist layout.
5. Make renderers popout-safe.
6. Enable Dockview popout windows.

This preserves the existing Fura GUI while giving us docking, resizing, and eventual popout support without hand-rolling a full layout manager.
