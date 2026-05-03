# Fura Conversational Frontend-Control Agent Plan

## Requirement

Add support for an AI-controlled frontend assistant in Fura. The user can send natural-language control/help prompts to the backend, the backend runs a dedicated controller agent, and the controller can either answer conversationally or dispatch validated frontend UI actions to the requesting browser client.

This must not reuse the active coding session's `prompt.send` path because UI-control text must not be persisted into a user's work session, trigger slash-command routing, or conflate frontend steering with coding-agent execution.

Primary MVP examples:

- User: "find me a session where I talked about xyz"
  - Controller replies with candidate sessions and reasons/snippets.
  - No session is opened yet.
- User: "okay open the second one"
  - Controller resolves "second one" from the prior candidates.
  - Bridge sends a typed `SelectSession` action to that same frontend client.

## Refined Product Model

The controller is both:

1. **Conversational frontend assistant** — can answer questions, return candidates, and wait for the user's follow-up.
2. **Validated UI actuator** — can dispatch typed, non-destructive desired-state UI actions when the user asks it to act.

Not every control prompt should become a frontend mutation. Discovery/query prompts should usually produce `control.reply`; action-oriented prompts may produce `frontend.control`.

## Key Findings

- Fura backend protocol is centralized in `src/protocol.rs`; frontend messages are parsed by `src/web.rs::handle_websocket_frame` and dispatched through `src/commands.rs::handle_client_message`.
- Backend-to-frontend events are `ServerMessage`s on `AppState.events`, a broadcast channel. Any frontend-control event must be explicitly client-targeted or every connected browser may act on it.
- OMP RPC already supports host tools through `set_host_tools`, `host_tool_call`, and `host_tool_result` (`/home/aleksander/repos/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts` and `rpc-mode.ts`). Fura does not currently handle those frames.
- OMP RPC `prompt` is asynchronous and returns only success/failure, not a structured completed control result. Fura must observe events/tool calls rather than treating the prompt response as the completed control result.
- OMP `AgentSession` can set active tools via `setActiveToolsByName`, but RPC does not currently expose a general `set_active_tools` command. Without such a command, a controller OMP session would still have default coding tools active; prompt-only "do not use filesystem tools" is not an enforceable safety boundary.
- Frontend session UI currently has no session search input. Sessions live in `frontend/src/main.ts` state: `sessions`, `activeSessionId`, `sessionListItems`, `renderSessions()`, `handleSessionButtonClick()`, and `activateSession()`.
- W3C APG guidance for combobox/listbox interactions supports a search/filter input with a list of selectable results; keep focus and selection semantics explicit. MCP tool guidance recommends making exposed tools clear and retaining human control for higher-risk operations. The MVP should expose only non-destructive frontend tools.

## Recommended Approach

Build a dedicated **Fura Controller** backed by a restricted OMP RPC session, and expose Fura/frontend capabilities to it as typed host tools. The controller is an OMP session because OMP remains the source of truth for model execution, tool calls, streaming, and persistence. It is not a normal user coding session: Fura labels it as bridge-control purpose, keeps it out of the ordinary session workflow, restricts its active tools to Fura controller tools, and routes all side effects through validated Fura code.

The frontend sends each control prompt with a point-in-time UI snapshot. The backend/controller reasons from that snapshot plus Fura backend state. The snapshot is **context**, not a live state contract. The bridge does not need live frontend-state streaming for the MVP.

The bridge sends frontend actions as fire-and-forget typed events. The frontend applies them best-effort using canonical local handlers. If the UI changed in the meantime, the frontend may no-op, ignore safely, or show a local notice. The backend must word internal/tool results honestly as "dispatched" rather than "applied" because the MVP has no frontend action acknowledgement.

Do **not** build a deterministic/no-agent Phase 1. A strict parser for "find/open/filter" commands would be both less useful and still complex enough to distract from the real product. The MVP should use the controller agent from the start, with its authority restricted to typed Fura controller host tools.

The controller prompt should explicitly frame the session as **Ask Fura**, not as the active coding agent. It should state that Fura is a browser UI for OMP sessions; the controller helps users find, discuss, summarize, prepare, or navigate sessions; it cannot directly change the browser; it may only call `fura_*` host tools; frontend actions are fire-and-forget; search results are limited to metadata plus loaded/preloaded transcript projection unless a future tool says otherwise; and active-coding-agent requests should be staged as prompt drafts rather than sent directly.

## Safety and Scope Decisions

- Add an OMP RPC command for active-tool restriction before enabling the controller session. Recommended shape: `{ type: "set_active_tools", toolNames: string[] }` returning `{ toolNames: string[] }`, implemented with `session.setActiveToolsByName(...)`. Fura will call it after `set_host_tools` so the controller can only use `fura_*` host tools.
  - `set_host_tools` already exists in OMP and answers "what Fura-specific tools does this host provide?" Fura still must use it to register `fura_search_sessions`, `fura_reply`, `fura_select_session`, etc.
  - `set_active_tools` is separate and answers "which tools may this controller session use?" It is needed because registering host tools may otherwise leave normal coding tools active alongside the Fura tools.
- Do not drive the browser by sending raw DOM instructions or opaque JSON blobs. Add typed `FrontendControlAction` protocol variants and validate every tool argument in Rust.
- Do not initially support destructive actions such as deleting/stopping sessions or creating worktrees. If added later, they must require explicit frontend confirmation.
- Target control replies and control events to the requesting browser client. The frontend generates/stores a stable `clientId` in `sessionStorage`, includes it in `control.prompt`, and ignores targeted events for other clients.
- Allow only one active controller run at a time in the MVP. This avoids ambiguous routing of host-tool calls because OMP host-tool call frames do not include the originating browser client. If a second control prompt arrives while the controller run is active, return a typed error/notice.
- No frontend action acknowledgement is required in the MVP. If future workflows need reliable multi-step automation, add `frontend.control.result` later with action ids and bounded waits. Do not add that complexity now.

## Frontend Snapshot Contract

`control.prompt` carries a compact structured snapshot of the requesting frontend's current state. It should be enough for the controller to understand the UI context, but it should not be a raw DOM dump or a transcript dump.

Recommended MVP shape:

```ts
type FrontendUiSnapshot = {
  activeSessionId?: string | null;
  focusedArea?:
    | "controller"
    | "sessionSearch"
    | "sessionList"
    | "prompt"
    | "transcript"
    | "tools"
    | "unknown";

  sessionSearchQuery: string;
  visibleSessionIds: string[];

  promptDraft?: {
    sessionId?: string | null;
    hasText: boolean;
    textLength: number;
  };

  panels?: {
    transcriptVisible: boolean;
    toolsVisible: boolean;
  };

  blockingUi?: {
    modalOpen: boolean;
    dialogOpen: boolean;
  };
};
```

Privacy/default rule: do not include full prompt draft text, full transcript content, or raw DOM unless a future feature explicitly requires it and the user-facing behavior justifies it.

## Protocol Shape

### Frontend to bridge

```ts
type ClientMessage =
  | {
      type: "control.prompt";
      clientId: string;
      conversationId?: string;
      text: string;
      uiSnapshot: FrontendUiSnapshot;
    }
  | {
      type: "control.abort";
      clientId: string;
      conversationId?: string;
    };
```

### Bridge to frontend: conversational replies

```ts
type ServerMessage =
  | {
      type: "control.reply";
      targetClientId: string;
      conversationId: string;
      message: string;
      candidates?: ControlCandidate[];
      suggestedActions?: ControlSuggestedAction[];
    };

type ControlCandidate =
  | {
      type: "session";
      candidateId: string;
      sessionId: string;
      title?: string | null;
      cwd?: string | null;
      timestamp?: string | null;
      status: string;
      kind: "managed" | "available" | string;
      reason: string;
      snippets?: string[];
    };

type ControlSuggestedAction = {
  label: string;
  action: FrontendControlAction;
};
```

`candidateId` only needs to be stable within a control conversation. It lets follow-up prompts like "open the second one" or button clicks refer to the same candidate set without exposing raw UI ordering as the only identity.

### Bridge to frontend: fire-and-forget UI actions

```ts
type ServerMessage =
  | {
      type: "frontend.control";
      targetClientId: string;
      action: FrontendControlAction;
    };

type FrontendControlAction =
  | { type: "setSessionSearch"; query: string; focus?: boolean }
  | { type: "selectSession"; sessionId: string }
  | { type: "setPromptDraft"; sessionId?: string | null; text: string; focus?: boolean }
  | { type: "focus"; target: "controller" | "sessionSearch" | "prompt" }
  | { type: "showNotice"; level: "info" | "warning" | "error"; text: string };
```

Frontend action handling rules:

- Apply the action if still valid.
- Treat already-satisfied state as a no-op.
- If impossible, ignore safely or show a local notice.
- Never throw or break the app because a control action arrived in an unexpected UI state.
- Use canonical frontend handlers, e.g. `handleSessionButtonClick()` / `activateSession()`, not parallel session-opening logic.

## Minimal Conversation State

The MVP does not need live UI state sync, but it does need small per-client/per-conversation memory so follow-ups are meaningful.

Recommended state:

```ts
type ControlConversationState = {
  conversationId: string;
  targetClientId: string;
  lastCandidates: ControlCandidate[];
  lastUiSnapshot: FrontendUiSnapshot;
};
```

This state can be ephemeral. It exists to resolve references like "the second one", "that first result", or "open it". It is not a second source of truth for Fura sessions or the browser UI.

## Session Search Semantics

For prompts like "find me a session where I talked about xyz", the default behavior should be conversational candidate discovery, not immediate UI mutation.

Search should be layered and truthful:

1. **Metadata search**: title, cwd, session id, timestamp, kind, status.
2. **Loaded/preloaded transcript search**: projected transcript text and short snippets where already available.
3. **Future enhancement**: on-demand persisted JSONL scan and/or semantic search.

The MVP should label results according to what was actually searched. Do not claim exhaustive semantic search if only metadata or preloaded transcripts were searched.

## Critical Files to Modify Later

No implementation is part of this planning step. When implementation begins, expected files are:

### Fura backend

- `src/protocol.rs`
  - Add `control.prompt`, optional `control.abort`, `control.reply`, `frontend.control`, `FrontendUiSnapshot`, `ControlCandidate`, `ControlSuggestedAction`, and `FrontendControlAction` DTOs.
  - Add `SessionPurpose` (`User`, `BridgeControl`) to `SessionSummary`/`SessionRecord` projection if the controller appears in session state; otherwise keep controller state separate and do not expose it as a normal session.
- `src/state.rs`
  - Add controller state to `AppState`, e.g. `bridge_controller: Arc<RwLock<BridgeControllerState>>`.
  - Track controller transport/session id, registered tools, active run `{ target_client_id, conversation_id, prompt_started_at }`, conversation memory, and whether tools have been restricted.
- New file justified by domain ownership: `src/control.rs`
  - Own controller invariants instead of growing `commands.rs`/`rpc.rs` into dumping grounds.
  - Responsibilities:
    - ensure/start the dedicated controller RPC child with a clear title/name such as "Fura Controller";
    - register `fura_*` host tools via OMP RPC `set_host_tools`;
    - call OMP RPC `set_active_tools` with only those host-tool names;
    - wrap user prompt with controller instructions, current UI snapshot summary, and prior candidate context;
    - reject concurrent runs;
    - handle `host_tool_call` frames for controller tools;
    - send targeted `control.reply` and validated `frontend.control` events;
    - send honest `host_tool_result` frames back to OMP, e.g. "dispatched action" rather than "action applied".
  - MVP host tools:
    - `fura_search_sessions({ query, limit? })`: searches current Fura session summaries and loaded/preloaded transcript projection; returns structured matches without changing UI.
    - `fura_reply({ message, candidates?, suggestedActions? })`: sends a targeted conversational response to the requesting frontend and stores candidates in conversation state.
    - `fura_filter_sessions({ query })`: emits `SetSessionSearch` only when the user explicitly asks to filter the visible sidebar; returns that the action was dispatched.
    - `fura_select_session({ sessionId })`: validates the session exists and emits `SelectSession`; used only after action-oriented user intent.
    - `fura_set_prompt_draft({ sessionId?, text })`: stages text in the prompt box; does not send it.
    - `fura_show_notice({ level, text })`: shows visible controller feedback in the requesting frontend.
- `src/commands.rs`
  - Dispatch `control.prompt`/`control.abort` to `control.rs`.
  - Keep existing `prompt.send` unchanged for user coding sessions.
- `src/rpc.rs`
  - Detect `host_tool_call` and `host_tool_cancel` frames in `apply_rpc_frame` and delegate controller-owned calls to `control.rs`.
  - On controller `agent_end`, clear the active run and broadcast final `ControlStatus` if such status UI is implemented.
  - Ensure normal coding-session tool cards still project exactly as they do today.
- `src/main.rs`
  - Wire the new `control` module and initialize controller state in `AppState` construction and test helpers.
- `fixtures/mock-omp-rpc.mjs`
  - Add support for `set_host_tools`, `set_active_tools`, `host_tool_result`, and mock control prompt paths for candidate replies and select-session actions.

### OMP upstream

- `/home/aleksander/repos/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts`
  - Add `RpcCommand` variant for `set_active_tools` and a matching `RpcResponse`.
- `/home/aleksander/repos/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts`
  - Add command handling that calls `session.setActiveToolsByName(command.toolNames)` and returns the active tool names.
- Existing OMP method already observed: `/home/aleksander/repos/oh-my-pi/packages/coding-agent/src/session/agent-session.ts::setActiveToolsByName`.

### Fura frontend

- `frontend/src/main.ts`
  - Add an "Ask Fura"/controller conversation UI near the session controls.
  - Generate `controlClientId` in `sessionStorage` and include it in `control.prompt`.
  - Build and send `FrontendUiSnapshot` on each control prompt.
  - Render targeted `control.reply` messages, candidates, and suggested action buttons.
  - Keep conversation state local enough to display prior replies, while backend keeps the authoritative candidate mapping for follow-up resolution.
  - Add session search state and input above `#sessionsList`; update `renderSessions()` to filter by query and show match/empty state.
  - Extend TypeScript `ClientMessage`/`ServerMessage` with the new control messages.
  - Handle `frontend.control` only when `targetClientId === controlClientId`:
    - `SetSessionSearch`: update the search input/query and re-render sessions.
    - `SelectSession`: reuse `handleSessionButtonClick(sessionId)` so open/attach behavior stays canonical.
    - `SetPromptDraft`: activate the target session if provided, set `promptInput.value`, update palette/previews, and focus the prompt.
    - `Focus`: focus the requested control if available/enabled.
    - `ShowNotice`: render visible controller feedback; do not rely on `appendLog()` because it is console-only.
  - Add controller status rendering (`idle`, `working`, `error`) so users know when the control agent is acting.
- `frontend/src/style.css`
  - Add styles for controller conversation, candidate cards, suggested action buttons, session search, filtered-empty state, and controller notices/status.
  - Keep search/list behavior accessible: explicit label, no JavaScript interception of normal text editing keys, and clear distinction between focus and selected session.
- `frontend/src/slashCommands.ts`
  - Optional: add a supported `/control` or `/fura` command only if the implementation routes it to `control.prompt`; otherwise leave slash commands unchanged to avoid a second incomplete entry point.

## Implementation Order

1. Add the OMP RPC `set_active_tools` command and verify it compiles in OMP before depending on it from Fura.
2. Add Fura protocol DTOs and controller state structs.
3. Implement `src/control.rs` with tool definitions, session search, candidate memory, action validation, active-run tracking, host-tool result formatting, and controller prompt sending.
4. Wire `commands.rs` and `rpc.rs` to route control prompts and host-tool frames.
5. Add frontend controller conversation UI, candidate rendering, and session search UI.
6. Add frontend handling for typed fire-and-forget `frontend.control` actions.
7. Update `fixtures/mock-omp-rpc.mjs` for deterministic smoke coverage.
8. Add/update tests, then run verification.

## Verification

Run only relevant checks after implementation:

- Fura Rust formatting/check/tests from repo root:
  - `cargo fmt`
  - `cargo check`
  - `cargo test`
- Fura frontend build:
  - `npm --prefix frontend run build`
- OMP targeted checks after adding `set_active_tools`:
  - use the OMP repo's targeted TypeScript/test command for `packages/coding-agent/src/modes/rpc/rpc-types.ts` and `rpc-mode.ts` if available; otherwise run the package typecheck/build command documented in that repo.
- Manual/mock smoke:
  - build frontend;
  - run Fura against `fixtures/mock-omp-rpc.mjs` with `FURA_TOKEN=dev`;
  - connect browser to `http://127.0.0.1:3737/` and enter bridge token `dev` in the auth screen;
  - send a controller prompt like "find me a session where I talked about mock";
  - verify the controller replies with candidates and does not open a session;
  - send "open the second one" or click an "Open" suggestion;
  - verify the targeted frontend opens/selects the session;
  - verify no normal coding session receives the control prompt.

## Acceptance Criteria

- A user can ask a control question and receive a conversational answer without changing frontend state.
- Session-search results are returned as structured candidates with truthful reasons/snippets based on searched data.
- Follow-up references like "open the second one" resolve against the prior candidate list for that control conversation.
- Opening/selecting a session only happens after explicit action-oriented user intent or an explicit candidate button click.
- Control prompts and control replies do not go through the active coding session's `prompt.send` path.
- The controller OMP session is restricted to Fura controller host tools before prompts are sent.
- Frontend-control events are scoped to the requesting browser client.
- All control side effects are represented as typed protocol actions and validated in Rust.
- Frontend-control actions are fire-and-forget in the MVP; the system does not claim they were applied unless a future acknowledgement protocol is added.
- Non-destructive MVP only; destructive actions are absent or rejected with a clear message.

## Deferred Enhancements

- Frontend action acknowledgements with action ids, result status, updated snapshot, and bounded backend waits.
- Multi-step reliable UI automation based on acknowledged action results.
- On-demand persisted JSONL transcript scanning across all sessions.
- Semantic/vector search over sessions.
- Destructive actions behind explicit frontend confirmation.

## Continuation Note

- 2026-05-01: Refined from pure frontend-control action plan into a conversational frontend assistant plan. The MVP uses point-in-time UI snapshots and fire-and-forget typed frontend actions; it intentionally does not require live frontend-state sync or frontend action acknowledgements.