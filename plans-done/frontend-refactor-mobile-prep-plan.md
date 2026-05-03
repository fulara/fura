# Fura Frontend Refactor + Test Hardening Plan

## Goal

Prepare the Fura frontend for a dedicated mobile UI and safer WebSocket auth by extracting reusable frontend seams first, while preserving current desktop behavior.

This is a planning document only. No implementation is included.

## Why Refactor First

The current frontend is concentrated in `frontend/src/main.ts`. It owns protocol DTOs, WebSocket lifecycle, app state, desktop shell markup, Dockview setup, transcript rendering, tools, diffs, Ask Fura, composer behavior, voice, sessions, and category UI.

Adding mobile directly into that shape would force one of two bad outcomes:

- duplicate desktop logic for mobile; or
- spread `if mobile else desktop` branches through a large file.

The refactor should create seams that mobile and desktop can both compose, without changing the user-visible desktop UI first.

## Constraints

- Keep plain Vite + TypeScript. Do not introduce a frontend framework.
- Keep the frontend mostly disposable/stateless; Rust bridge remains source of projected session state.
- Keep normal DOM rendering, not terminal emulation.
- Preserve Dockview behavior for desktop.
- Do not add optimistic transcript state.
- Do not expose raw logs in the UI.
- Do not rewrite everything. Extract only code that earns reuse or testability.
- Each phase must keep `npm --prefix frontend run build` passing.

## Current State Observed

- `frontend/package.json` has `dev`, `build`, and `preview` scripts only; no test script.
- No frontend `*.test.*` / `*.spec.*` files were found under `frontend/`.
- Current frontend dependencies are `dockview-core`, `highlight.js`, and `marked`; dev dependencies are `typescript` and `vite`.
- `frontend/src/main.ts` reads token from URL/localStorage and owns WebSocket connection.
- `frontend/src/style.css` is desktop-first with `body { min-width: 960px }` and no media queries.
- Dockview panel rendering relies on owner-document helpers so popout windows create DOM in the correct document.

## Testing Direction

Use Vitest for frontend unit tests, because it fits Vite/TypeScript projects and can test extracted pure functions and DOM helpers without adding a framework.

Official Vitest docs note:

- browser-like environments can use `jsdom` or `happy-dom` for web app tests;
- Browser Mode can run tests in a real browser;
- Browser Mode with Playwright is recommended over preview provider for CI/local reliability when real browser behavior matters.

Plan:

- Start with Vitest + jsdom or happy-dom for fast unit/component-ish tests of extracted modules.
- Add real browser smoke later using existing Browser tool/manual smoke or Playwright/Vitest Browser Mode only when the mobile shell needs real layout/interaction confidence.
- Do not introduce Testing Library unless tests become too low-level; plain DOM assertions are enough for initial seams.

Recommended initial scripts:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:ui": "vitest --ui"
}
```

`test:ui` is optional and should not be required in CI.

## Phase 0: Establish Frontend Test Harness

### Change

Add a minimal frontend test setup before large refactors.

Candidate dev dependencies:

```text
vitest
jsdom or happy-dom
```

Prefer `jsdom` for compatibility unless install size/performance becomes painful. `happy-dom` is faster but can diverge from browser behavior; any behavior relying on selection, clipboard, layout, or WebSocket should be browser-smoked separately.

Add:

```text
frontend/vitest.config.ts
frontend/src/**/*.test.ts
```

Initial tests should target pure helpers extracted or already extractable from `main.ts`, not full app startup.

### First tests to add

Low-risk, high-value helpers:

- `shortPath`
- `formatTokens`
- `formatCost`
- slash command matching already in `slashCommands.ts`
- snippet/token expansion if currently separable
- code fence parsing/render segmentation if extracted
- storage key parsing for visibility modes

### Acceptance

- `npm --prefix frontend run build` passes.
- `npm --prefix frontend test` passes.
- No production behavior changes.

## Phase 1: Extract Protocol Types

### Change

Create:

```text
frontend/src/protocol.ts
```

Move TypeScript-only protocol/domain types out of `main.ts`, including:

- `ClientMessage`
- `ServerMessage`
- `SessionSummary`
- `SessionProjection`
- `TranscriptEntry`
- `TranscriptMessage`
- `ToolCard`
- diff/control/voice DTOs that are currently frontend protocol mirrors

Rules:

- Type-only move first.
- No behavior changes.
- Keep names domain-preserving and aligned with Rust protocol names.
- Avoid weakening structured fields into `unknown`/`any` except where current protocol is intentionally opaque.

### Tests

Mostly build coverage. Add compile-time-oriented usage where practical, but do not invent runtime tests for pure type moves.

### Acceptance

- `main.ts` imports protocol types.
- No runtime behavior changes.
- `npm --prefix frontend run build` passes.
- `npm --prefix frontend test` passes.

## Phase 2: Extract Pure Formatting and State Helpers

### Change

Create focused modules for pure logic:

```text
frontend/src/format.ts
frontend/src/storage.ts
frontend/src/sessionState.ts
```

Candidate helpers:

- `shortPath`
- `formatTokens`
- `formatCost`
- thinking visibility parser
- tool visibility storage parser
- session sorting/group label helpers, if present in frontend
- active workspace key helpers, if pure enough

Rules:

- Pure functions only.
- No DOM imports.
- No WebSocket imports.
- No global reads/writes except in narrowly named storage helpers.

### Tests

Add unit tests for:

- token/cost formatting edge cases
- path shortening edge cases
- invalid storage values falling back safely
- visibility mode parsing

### Acceptance

- Helpers are imported back into `main.ts`.
- Tests cover extracted behavior.
- Build and tests pass.

## Phase 3: Extract DOM Creation Context

### Change

Create:

```text
frontend/src/dom.ts
```

Move owner-document-aware helpers:

```ts
mkEl
mkText
mkFrag
withRenderDocument / setRenderDocument equivalent
requireElement
```

Important: preserve Dockview popout behavior. Render functions must still create nodes in the panel container's `ownerDocument`, not always the main `document`.

Preferred design:

```ts
type DomContext = {
  document: Document;
  mkEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K];
  mkText(text: string): Text;
  mkFrag(): DocumentFragment;
};
```

Then renderers accept `DomContext` explicitly rather than relying on mutable global `_renderOwner` when feasible.

If converting all renderers at once is too large, keep a compatibility wrapper temporarily inside the same phase, but the end of the phase should have a clear canonical representation.

### Tests

Use jsdom/happy-dom to verify:

- elements are created from the provided document
- `requireElement` throws clear errors
- no renderer silently uses the wrong document in simple extracted tests

### Acceptance

- Popout-aware rendering invariant is preserved.
- Build and tests pass.

## Phase 4: Extract Transcript Rendering

### Change

Create:

```text
frontend/src/transcriptView.ts
```

Move reusable transcript rendering pieces:

- `renderTranscriptView`
- `renderMessage`
- `renderBlock`
- `renderCodeBlock`
- code fence parsing
- thinking block rendering
- notice rendering if transcript-specific

Define an explicit render options object:

```ts
type TranscriptRenderOptions = {
  dom: DomContext;
  projection: SessionProjection | undefined;
  sessionChanged: boolean;
  showToolBubbles: boolean;
  thinkingVisibilityMode: ThinkingVisibilityMode;
  openThinking: Set<string>;
  onThinkingToggle(...): void;
  onCopyCode(...): void;
};
```

The exact shape can differ, but it must make dependencies visible.

Rules:

- Renderer receives state and callbacks; it does not own global app state.
- Preserve current transcript scroll behavior:
  - session switch/open scrolls to bottom
  - live update scrolls only if already near bottom
- Preserve live/historical thinking behavior.
- Preserve code copy behavior.
- Preserve `data-message-id`, `data-block-index`, `data-block-kind` attributes.

### Tests

Add DOM tests for:

- text message rendering
- fenced code block rendering
- copy button targets only the relevant block, with clipboard mocked or callback asserted
- thinking block opens for live/new messages and collapses for historical messages
- redacted/empty blocks render truthfully
- tool bubbles hidden/shown according to option

### Acceptance

- Desktop transcript panel renders identically from user perspective.
- `main.ts` no longer owns block/code rendering internals.
- Build and tests pass.

## Phase 5: Extract Tools View Rendering

### Change

Create:

```text
frontend/src/toolsView.ts
```

Move:

- `renderToolsView`
- tool card rendering helpers
- status/duration/error formatting for tools

Rules:

- Tools renderer accepts projection/options/callbacks.
- It must be reusable by mobile as a full-screen list or sheet.
- It should not know Dockview exists.

### Tests

Add DOM tests for:

- tool call/result summary rendering
- success/error/aborted state labels
- empty tools state
- long output truncation/detail affordance if currently present or added later

### Acceptance

- Desktop Tools panel still renders.
- Mobile can later reuse the same renderer in a different container.
- Build and tests pass.

## Phase 6: Extract Composer Behavior

### Change

Create:

```text
frontend/src/composer.ts
frontend/src/images.ts
```

Move reusable prompt/composer logic:

- pending image model
- image preview rendering
- `blobToBase64`
- prompt submit decision logic
- busy-agent handoff decision surface hooks
- prompt history navigation where separable
- slash palette integration boundaries

Rules:

- Composer logic should expose callbacks like `onSendPrompt` rather than directly owning `send`.
- Keep image paste behavior working on desktop.
- Design so mobile can later add file input/camera picker using the same `PendingImage` model.

### Tests

Add tests for:

- `blobToBase64` / data URL stripping behavior, if test environment supports Blob/FileReader reliably
- image removal updates pending image list
- prompt text expansion/submission decisions
- busy-agent branch selection does not silently drop images/text

### Acceptance

- Desktop prompt behavior is unchanged.
- The image model is reusable for mobile upload.
- Build and tests pass.

## Phase 7: Extract WebSocket Connection Client

### Change

Create:

```text
frontend/src/connection.ts
```

Move current WebSocket lifecycle into a small client wrapper:

```ts
type FuraConnection = {
  connect(): void;
  disconnect(): void;
  send(message: ClientMessage): boolean;
};
```

It should accept callbacks:

```ts
type ConnectionHandlers = {
  onStatus(status): void;
  onMessage(message: ServerMessage): void;
  onLog(message): void;
  onClose(): void;
};
```

This phase should not yet change token-in-URL auth unless intentionally combined with the safer auth phase. Prefer extraction first, behavior second.

Rules:

- `main.ts` handles app state transitions.
- `connection.ts` handles WebSocket mechanics.
- No UI rendering in `connection.ts`.
- Do not log prompt/model/tool payloads.

### Tests

Unit-test with a fake WebSocket implementation:

- connects to expected URL under current behavior before auth refactor
- sends JSON only when open
- reports not-connected false otherwise
- routes parsed messages to handler
- handles malformed/non-text frames truthfully

After safer auth is implemented, update tests to cover auth handshake.

### Acceptance

- Existing desktop connection flow still works.
- Connection code is isolated for the upcoming auth change.
- Build and tests pass.

## Phase 8: Extract Desktop Shell Boundary

### Change

Create:

```text
frontend/src/desktopShell.ts
frontend/src/dockviewWorkspace.ts
```

Move:

- current app shell markup construction
- Dockview initialization
- `loadDefaultLayout`
- panel toolbar/popout handling
- desktop workspace header/action wiring where feasible

Keep `main.ts` as app bootstrap/orchestrator:

```text
main.ts
  creates app state
  creates connection
  chooses shell
  routes server messages
  asks shell/renderers to update
```

Rules:

- Desktop shell remains canonical for current UI.
- Dockview stays desktop-only from the module boundary onward.
- Shared renderers do not import Dockview.
- Mobile shell will be added later as a sibling, not by editing Dockview internals.

### Tests

Limited unit testing; this is integration-heavy. Add small tests for shell factory DOM if valuable, but rely mainly on build + browser smoke for Dockview.

### Acceptance

- Desktop browser smoke shows existing sidebar/header/Dockview/prompt behavior.
- `main.ts` no longer contains Dockview internals.
- Build and tests pass.

## Phase 9: Implement Safer Auth on the New Seams

This corresponds to Phase 1 in `plans/fura-mobile-auth-plan.md`, but it should happen after `connection.ts` exists.

### Change

- Remove token-in-URL auth.
- Add WebSocket auth handshake.
- Add frontend auth gate.
- Store token in `sessionStorage` by default, optional `localStorage` remember.

### Tests

Connection/auth tests with fake WebSocket:

- `/ws` is used without query token
- old `?token=` is removed from address bar and not auto-used
- `auth.required` triggers stored-token send or auth UI state
- `auth.ok` transitions to authenticated state
- `auth.failed` clears attempted token and surfaces precise error
- no normal `ClientMessage` is sent before auth ok

Backend tests remain in the mobile auth plan.

### Acceptance

- Frontend tests cover auth state machine.
- Backend tests cover server invariants.
- Build/tests pass.

## Phase 10: Add Mobile Shell

Only after shared renderers and connection/auth seams exist.

### Change

Create:

```text
frontend/src/mobileShell.ts
```

Mobile composes:

- session list renderer
- transcript renderer
- tools renderer
- diffs renderer or summary renderer
- composer module
- Ask Fura surface

Mobile must not import Dockview.

### Tests

- shell mode selection helper tests
- mobile shell DOM smoke tests in jsdom/happy-dom
- browser smoke at phone viewport for actual layout

### Acceptance

- desktop mode unchanged
- mobile mode no horizontal scrolling at normal phone width
- prompt/session/transcript core workflow works
- build/tests pass

## Refactor Guardrails

- Each phase must be reviewable independently.
- Do not move code and change behavior in the same phase unless the phase explicitly says so.
- When moving functions, preserve names first; rename only after tests prove behavior.
- Do not create generic `utils.ts`; create domain modules.
- Do not introduce abstractions that only have one speculative caller unless they are required to remove a real dependency from `main.ts`.
- If a renderer needs many unrelated callbacks, split the renderer rather than passing a giant app object.
- The second time a pattern repeats across desktop/mobile is when it earns a shared abstraction.

## Verification Matrix

After every frontend refactor phase:

```bash
npm --prefix frontend run build
npm --prefix frontend test
```

After phases touching protocol/auth/backend integration:

```bash
cargo fmt
cargo test
npm --prefix frontend run build
npm --prefix frontend test
```

Manual/browser smoke after shell/Dockview phases:

- load desktop app
- connect with token/auth flow appropriate to current phase
- create/open session with mock RPC
- transcript renders
- tools panel renders
- diffs panel opens
- prompt send works
- Dockview layout persists
- popout still creates styled content or shows blocked-popup notice

Mobile smoke after mobile shell exists:

- phone-width viewport selects mobile shell
- session drawer/list opens
- active transcript reads correctly
- composer sends prompt
- tools/diffs/Ask Fura surfaces open and close

## Relationship to Mobile/Auth Plan

`plans/fura-mobile-auth-plan.md` remains the product/security plan. This refactor plan should be executed first and then used to make that plan safer:

1. establish test harness;
2. extract protocol/format/DOM/rendering/connection seams;
3. implement safer auth in the extracted connection boundary;
4. add mobile shell using shared renderers.

## Non-Goals

- No mobile UI implementation in the refactor phases before Phase 10.
- No native app.
- No public internet deployment.
- No framework migration.
- No broad style redesign.
- No Dockview replacement for desktop.
- No full end-to-end test suite before the seams exist.

## Final Acceptance Criteria

The refactor is complete when:

- desktop behavior remains intact;
- `main.ts` is mostly bootstrap/orchestration, not every subsystem;
- shared renderers can be called by both desktop and mobile shells;
- WebSocket mechanics are isolated from UI rendering;
- a frontend test harness exists and covers extracted helpers/renderers/connection state;
- mobile work can proceed without duplicating transcript/composer/session logic;
- all required verification commands pass.
