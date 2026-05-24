# Fura upstream migration plan

## Goal

Move Fura-specific work from the old `fork-stuff` history onto current `upstream/main` without replaying thousands of rebased/cherry-picked upstream commits.

Current known refs:

- Current branch: `fork-stuff-new`
- Old Fura tip: `0131b9ed5 Align Goal Mode RPC controls`
- True upstream tip during analysis: `upstream/main` at `3b072a10b`
- Old local base: `origin/main` at `24fa1fa11 fix: outdated tests`
- Upstream patch-equivalent base: `b0a31a5956d4ef11277cfb3fd9af936583ad12be fix: outdated tests`

Observed range:

- `b0a31a595..upstream/main`: 1128 raw upstream commits
- Patch-equivalent already present on old Fura branch: 540 non-merge commits
- Patch-unique missing upstream commits: 426 non-merge commits
- Merge commits in range: 162

Conclusion: do not rebase the old branch wholesale. Start from `upstream/main` and manually replay the Fura-specific patches.

## Fura commits to preserve

Patch-unique Fura commits not present in upstream:

1. `5b2f2fa02 feat(coding-agent): add durable repository diff snapshots`
2. `ec95beda0 feat(coding-agent/rpc): add RPC plan review handoff`
3. `b19d2ed2a Add RPC active tool restriction`
4. `e1dc0fe67 Clarify Mermaid source and ASCII tool guidance`
5. `b080e4ee1 Add discuss-plan mode to plan review`
6. `4e60c421f Fix tests after upstream rebase`
7. `1ddb49a81 Add RPC plan approval context options`
8. `a4044eec6 Add Goal Mode RPC state projection`
9. `9e39e9599 Add Goal Mode RPC controls`
10. `0131b9ed5 Align Goal Mode RPC controls`

`4e60c421f` should not be replayed as-is. It was an old compatibility/test-fix commit. Recreate only the still-needed fixes after porting the real features.

## Major upstream changes that affect Fura

### RPC protocol expansion

Upstream added or changed RPC surface area:

- `set_host_uri_schemes`
- `host_uri_request`
- `host_uri_result`
- `host_uri_cancel`
- `RpcHostUriBridge`
- `handoff`
- `contextUsage` in session state
- rpc-ui/tool UI context over RPC

Fura also modifies the same protocol files with:

- `repo_diff_get`
- `repo_diff_snapshot`
- `set_plan_mode`
- `approve_plan_mode`
- `discuss_plan_mode`
- `set_active_tools`
- `goal_mode`
- `planMode` state
- `goalMode` state
- `plan_review` event

Risk: high. The protocol must be merged deliberately. Do not take either side wholesale.

### Plan approval flow

Upstream moved plan approval onto the hidden `resolve` standing handler and added:

- `PlanApprovalDetails`
- title normalization/fallback
- auto-naming approved plan sessions
- approve-and-compact
- pending apply recovery on failure
- opaque `extra` handling for model compatibility

Fura plan-review RPC must call into the upstream resolve/plan approval path instead of duplicating old approval logic.

### Goal mode

Upstream already has core goal mode and later fixes for state-machine behavior after interrupts/reloads. Fura should only add RPC projection/control on top of upstream goal runtime.

Final Fura RPC goal operations should be:

- `create`
- `pause`
- `resume`
- `drop`
- `set_budget`

Do not expose `complete` over RPC unless we explicitly change that contract.

### Eval tool breaking change

Upstream changed eval input from string cell source to structured JSON cells:

```ts
cells: Array<{
  language: "py" | "js";
  code: string;
  title?: string;
  timeout?: number;
  reset?: boolean;
}>;
```

Fura/harness clients must choose one contract. Preferred long-term path is upstream JSON cells. If backward compatibility with the old string input is required, implement an explicit compatibility wrapper rather than mixing both internally.

### Hashline/read/edit changes

Upstream changed read selectors and hashline syntax substantially, including a canonical hashline format and safety fixes such as dropping anchors on truncated lines.

Preserve upstream behavior. Fura diff snapshot output must not reintroduce unsafe anchors or old parser assumptions.

### Auth broker/gateway and streaming

Upstream added remote credential architecture:

- auth broker snapshots and remote writes
- auth gateway provider routes
- `/v1/pi/stream` canonical AssistantMessageEvent stream
- bearer-token gateway handling
- usage endpoints

Upstream stream semantics also changed:

- replayed `start` events after auth retry are possible
- terminal errors can occur after HTTP 200
- abort must be explicit, not inferred from transport close alone

Fura browser/RPC stream handling should be updated around canonical event semantics, not byte-level provider passthrough assumptions.

### Native/build/runtime

Upstream added a native addon version sentinel and loader checks. This directly fixes the class of stale `.node` failure that caused directory reads to report empty directories.

Preserve upstream native loader/build/release contract as a unit.

## Migration strategy

### Phase 0: freeze protocol expectations before editing

Before porting code, write down the final Fura RPC protocol surface in one place:

- all commands
- all responses
- all events
- state shape
- error behavior
- cancellation behavior
- version/compatibility expectations

This should become the source of truth for `rpc-types.ts` and generated fixtures.

Protocol concern is valid: the riskiest part of this migration is not TypeScript conflicts; it is accidentally changing what Fura clients observe. Treat the protocol as an API, not an implementation detail.

### Phase 1: create a clean branch from upstream

Create a new migration branch from current upstream:

```bash
git checkout -b fura-upstream-replay upstream/main
```

Do not rebase `fork-stuff-new` directly. Use old commits only as patch sources.

### Phase 2: merge RPC type contract first

Manually build the final `packages/coding-agent/src/modes/rpc/rpc-types.ts` from upstream plus Fura additions.

Must preserve upstream:

- host URI frames
- handoff command/response
- `contextUsage`
- rpc-ui/tool UI context

Must add Fura:

- repo diff snapshot commands/results
- plan-review events and commands
- active tool restriction command
- goal mode state/control commands

Acceptance criteria:

- one coherent command union
- one coherent response union
- no duplicate/disconnected command names
- generated fixture generator can represent both upstream and Fura frames

### Phase 3: port durable repo diff snapshots

Source commit:

- `5b2f2fa02`

Port in smaller pieces:

1. core snapshot storage/session persistence
2. git/worktree integration on top of upstream `utils/git.ts` and synthetic tree diff semantics
3. slash command registration using upstream unified slash registry
4. RPC commands and client helpers
5. tests and generated fixtures

Do not preserve old worktree/diff assumptions if upstream has newer baseline/delta behavior.

### Phase 4: port RPC plan review and approval

Source commits:

- `ec95beda0`
- `b080e4ee1`
- `1ddb49a81`

Port as one feature group, but split internally:

1. plan review event shape
2. `set_plan_mode`
3. `approve_plan_mode`
4. `discuss_plan_mode`
5. context preservation / compact-before-execute options
6. tests and fixtures

Use upstream resolve/plan approval APIs as the implementation authority.

Do not reimplement old plan approval or compaction logic.

### Phase 5: port active tool restriction

Source commit:

- `b19d2ed2a`

Integrate near upstream host/tool capability controls:

- `set_host_tools`
- `set_host_uri_schemes`
- active tool rebuilds
- ACP permission wrapping
- `report_tool_issue` active-tool enum scoping

Acceptance criteria:

- active-tool changes rebuild the model-visible tool list correctly
- hidden/system tools needed by plan/goal flows still behave intentionally
- Fura cannot accidentally hide host URI bridge behavior unless explicitly designed

### Phase 6: port Goal Mode RPC

Source commits:

- `a4044eec6`
- `9e39e9599`
- `0131b9ed5`

Treat these as one final patch rather than replaying intermediate API churn.

Final RPC controls:

- `create`
- `pause`
- `resume`
- `drop`
- `set_budget`

State projection should call upstream `session.getGoalModeState()` or equivalent current session API. Do not duplicate state transitions.

### Phase 7: port prompt guidance

Source commit:

- `e1dc0fe67`

Apply manually onto current upstream prompts. Keep the intent:

- when user asks for Mermaid source / Markdown-compatible diagrams / browser-rendered diagrams, emit Mermaid fenced source
- use render tool only when ASCII output or artifact is explicitly requested

### Phase 8: decide eval compatibility

Before claiming migration complete, decide:

- adopt upstream JSON cells everywhere, or
- add a deliberate compatibility adapter for old string-cell input

This affects Fura clients and harness/tool prompt docs.

### Phase 9: regenerate generated artifacts

After protocol files are final:

- regenerate RPC contract fixtures
- update generated JSON fixtures
- update tests that assert `get_state`, plan review, repo diff, and goal mode frames

Never carry generated fixtures from old branch without regeneration.

### Phase 10: verification

Minimum targeted verification after implementation:

- RPC contract fixture test
- RPC get-state includes upstream `contextUsage` and Fura `planMode`/`goalMode`
- upstream RPC host URI protocol fixtures remain intact; Fura does not register URI schemes in this migration
- repo diff snapshot tests
- plan review approve/discuss tests
- goal mode RPC tests
- active-tool restriction tests
- one eval contract test for chosen schema
- one read/edit/hashline safety test around truncated anchors if touched

## Recommended handling of protocol anxiety

The concern is justified. The safe path is to make protocol compatibility explicit instead of discovering breakage through runtime behavior.

Recommended safeguards:

1. Add or keep generated RPC contract fixtures.
2. Version or snapshot every externally-visible frame shape.
3. Make a small compatibility table:
   - upstream-only frames
   - Fura-only frames
   - shared frames extended by Fura
   - deprecated/removed frames
4. Do not change frame names during migration unless required.
5. For each changed response, state whether the change is additive or breaking.
6. Prefer additive fields over replacing existing fields.
7. Keep browser/Fura client parsing tolerant of unknown fields, but server tests strict about required fields.

The first concrete task should be protocol inventory, not code movement.

## Initial RPC protocol inventory

Source files compared:

- Fura old branch: `fork-stuff-new:packages/coding-agent/src/modes/rpc/rpc-types.ts`
- Upstream: `upstream/main:packages/coding-agent/src/modes/rpc/rpc-types.ts`

### RPC commands

Shared commands to preserve:

```text
abort
abort_and_prompt
abort_bash
abort_retry
bash
branch
compact
cycle_model
cycle_thinking_level
export_html
follow_up
get_available_models
get_branch_messages
get_last_assistant_text
get_login_providers
get_messages
get_session_stats
get_state
handoff
login
new_session
prompt
set_auto_compaction
set_auto_retry
set_follow_up_mode
set_host_tools
set_interrupt_mode
set_model
set_session_name
set_steering_mode
set_thinking_level
set_todos
steer
switch_session
```

Fura-only commands to preserve:

```text
approve_plan_mode
discuss_plan_mode
fork
goal_mode
repo_diff_get
repo_diff_snapshot
set_active_tools
set_plan_mode
```

Upstream-only commands to preserve:

```text
set_host_uri_schemes
```

Final command contract should be the union of all three groups. Do not remove `set_host_uri_schemes` while adding Fura command variants.

### RPC success response commands

Shared success response commands to preserve:

```text
abort
abort_and_prompt
abort_bash
abort_retry
bash
branch
compact
cycle_model
cycle_thinking_level
export_html
follow_up
get_available_models
get_branch_messages
get_last_assistant_text
get_login_providers
get_messages
get_session_stats
get_state
handoff
login
new_session
prompt
set_auto_compaction
set_auto_retry
set_follow_up_mode
set_host_tools
set_interrupt_mode
set_model
set_session_name
set_steering_mode
set_thinking_level
set_todos
steer
switch_session
```

Fura-only success response commands to preserve:

```text
approve_plan_mode
discuss_plan_mode
fork
goal_mode
repo_diff_get
repo_diff_snapshot
set_active_tools
set_plan_mode
```

Upstream-only success response commands to preserve:

```text
set_host_uri_schemes
```

Final response contract should also remain additive: unknown future `command` values should not break Fura clients, but required payloads for known commands should be fixture-tested.

### RPC state fields

Shared state fields:

```text
autoCompactionEnabled
contextUsage
dumpTools
followUpMode
interruptMode
isCompacting
isStreaming
messageCount
model
queuedMessageCount
sessionFile
sessionId
sessionName
steeringMode
systemPrompt
thinkingLevel
todoPhases
```

Fura-only state fields to preserve:

```text
goalMode
planMode
```

Upstream-only state fields:

```text
none observed
```

Final `get_state` must include upstream `contextUsage` and Fura `planMode`/`goalMode` in the same response. This is an important fixture target.

### RPC events and bidirectional frames

Shared host tool frames:

```text
host_tool_call
host_tool_cancel
host_tool_result
host_tool_update
```

Upstream-only host URI frames to preserve:

```text
host_uri_request
host_uri_cancel
host_uri_result
```

Fura-only event/frame to preserve:

```text
plan_review
```

Extension UI frames are shared and should be preserved unchanged:

```text
extension_ui_request
extension_ui_response
```

Final frame contract should include all host tool frames, all host URI frames, extension UI frames, and Fura `plan_review`. Host URI frames are not ordinary tools; active-tool restriction must not accidentally disable them unless that is explicitly designed.

### RPC import/type differences to resolve

- Upstream imports `CompactionResult` from `@oh-my-pi/pi-agent-core/compaction`.
- Fura old branch imports `CompactionResult` from `../../session/compaction`.
- Fura old branch imports `PlanModeState`, `GoalModeState`, and `RepoDiffSnapshotRecord`.
- Upstream has `RpcHostUriSchemeDefinition`, `RpcHostUriOperation`, `RpcHostUriRequest`, `RpcHostUriCancelRequest`, and `RpcHostUriResult`.

Final code should use upstream compaction import paths and add only the Fura state/snapshot imports that are still required.

## Broader migration inventory

### Coding-agent protocol/session/tools

| Area | Upstream inventory | Fura impact | Required migration decision |
|---|---|---|---|
| RPC protocol | Added host URI frames, handoff, context usage, rpc-ui/tool UI context. | High: same files as Fura RPC additions. | Merge protocol unions manually before implementation. |
| Plan mode | Resolve-based approval, approve-and-compact, title fallback, failed apply recovery, opaque `extra`. | High: Fura plan review/approval/discuss commands must use this path. | Upstream resolve flow is authoritative; Fura adds RPC wrapping. |
| Goal mode | Core goal runtime, hidden goal tool, slash/status integration, interrupt/reload repair. | High: Fura should only add RPC projection/control. | Implement on top of upstream goal runtime; no duplicate state machine. |
| Eval | Breaking schema change to JSON `cells`, JS worker runtime, Python runner, display outputs. | High if Fura clients still emit string-cell input. | Choose upstream JSON cells or add explicit compatibility adapter. |
| Read/edit/hashline | Compound/scatter/open-ended selectors, internal URL selector fixes, canonical hashline format, no anchors on truncated lines. | Medium/high for diff snapshots and edit safety. | Preserve upstream parser/safety behavior; adapt Fura outputs around it. |
| Task/follow-up | `YieldQueue`, `onBeforeYield`, subagent progress/telemetry. | Medium: background follow-ups can be injected without direct RPC prompt. | Preserve lifecycle; make RPC state tolerant of queued follow-up behavior. |
| Slash commands | Unified TUI/ACP registry and centralized discovery. | Medium: Fura diff commands register here. | Register once in upstream registry; do not resurrect old parallel handlers. |

### AI/auth/provider layer

| Area | Upstream inventory | Fura impact | Required migration decision |
|---|---|---|---|
| Auth broker | Remote credential vault, snapshot generation/304, remote writes, redacted refresh sentinel. | High for browser/remote Fura assumptions. | Treat local auth and remote broker as separate modes. |
| Auth gateway | Provider routes plus `/v1/pi/stream`; bearer handling; CORS; usage endpoints. | High: Fura can use canonical events instead of provider passthrough. | Prefer `/v1/pi/stream` where both sides are OMP-aware. |
| Streaming | Idle watchdogs, abort propagation, auth retry with possible replayed `start`, terminal errors after HTTP 200. | High for browser stream decoder. | Model explicit start/error/done/abort events; do not infer success from HTTP status alone. |
| Service tier | `serviceTier` replaces fast-mode boolean; scoped values; Anthropic priority fallback emits `disabledFeatures`. | Medium/high for UI state. | Surface service tier and disabled feature state in Fura clients. |
| Tool schemas | Zod/raw JSON Schema, draft-2020-12 normalization, TypeBox root exports removed, StringEnum removed, `{}` normalized to `true`. | High if Fura serializes/validates schemas. | Keep schemas opaque over RPC; normalize server-side with upstream utilities. |
| Provider registry | Bedrock, Fire Pass, generic OpenAI-compatible discovery, path-scoped model config, model cache migration. | Medium for model selector/catalog. | Use registry output; avoid hardcoded provider assumptions. |
| Web search | Hard fetch timeout, abort propagation, auth/quota classification, Perplexity OAuth fixes. | Medium for RPC web search. | Thread cancellation and structured auth/quota errors to UI. |

### Native/runtime/TUI/build

| Area | Upstream inventory | Fura impact | Required migration decision |
|---|---|---|---|
| Native loader | Version sentinel, explicit exports, stale `.node` load-time error, Windows staging. | High: fixes observed stale native-addon bug. | Preserve loader/sentinel/release pipeline as a unit. |
| Release/build | Bun `>=1.3.14`, worker entrypoints for compiled binaries, native embedding/reset. | High for Fura binaries. | Include browser/eval/stats worker entrypoints in packaging. |
| pi-shell | Shell/process moved into `crates/pi-shell`; cancellation and macOS descendant fixes. | Medium/high for process reliability. | Port shell changes into `pi-shell`, not old `pi-natives` internals. |
| Bash fixups | Native AST-backed `applyBashFixups`, warning notices, top-level `head`/`tail`/`2>&1` stripping. | Medium for tool behavior and prompts. | Keep upstream fixup path; layer Fura restrictions outside it. |
| TUI hyperlinks | OSC 8 file links, fs-backed internal URL handling, style/link bleed fixes. | Medium for web/mobile rendering. | Convert to structured links or strip safely at Fura frontend boundary. |
| TUI shimmer/settings | Loader shimmer, progress animations, `SettingsList#setItems`. | Low/medium UI conflict risk. | Prefer upstream helpers; gate ANSI animation for non-terminal clients. |
| Worktree/diff | Synthetic tree diff baseline/delta, `omp worktree list/clear`, pi-iso backend. | High for durable repo diff snapshots. | Build Fura snapshots on upstream synthetic diff semantics. |
| Agent telemetry/hooks | OTEL spans, `onChatUsage`, `onRunEnd`, `beforeToolCall`/`afterToolCall`, `onBeforeYield`. | Medium/high for active tool and state projection. | Consider using hooks for Fura active-tool enforcement and tolerate telemetry in event payloads. |
| Robomp/swarm | Container slots, gh-proxy, dashboard, host tools, auth-gateway integration. | Low direct conflict, medium operational relevance. | Mostly leave untouched; note host URI/auth-gateway overlap. |


## Fura bridge consumer inventory

This section records what the Fura bridge currently sends to, parses from, and projects out of the OMP RPC protocol. It is the compatibility checklist for the migration.

### Commands Fura sends to OMP

Typed in `src/omp_rpc.rs`:

```text
get_state
get_messages
get_session_stats
get_available_models
set_model
set_thinking_level
prompt
abort
goal_mode
```

Constructed as raw JSON in other Rust modules:

```text
approve_plan_mode
repo_diff_snapshot
set_active_tools
set_host_tools
set_session_name
```

Also handled in response paths, even if not all are typed in `OmpRpcCommand`:

```text
discuss_plan_mode
fork
handoff
repo_diff_get
set_plan_mode
```

Migration implication: do not judge compatibility only by `OmpRpcCommand`. Fura already emits several commands as raw `serde_json::json!` values.

### Frames Fura currently parses from OMP

`src/omp_rpc.rs` recognizes:

```text
ready
response
agent_start
agent_end
plan_review
message_update
message_end
tool_execution_start
tool_execution_update
tool_execution_end
goal_updated
extension_ui_request
host_tool_call
host_tool_cancel
```

Unknown frames are ignored.

Upstream host URI frames are currently **not** parsed by Fura:

```text
host_uri_request
host_uri_cancel
host_uri_result
```

This is acceptable because Fura will not register host URI schemes during the initial migration. If a future Fura feature sends `set_host_uri_schemes`, it must also parse and respond to host URI frames. The migration should preserve upstream support in Oh My Pi even though Fura leaves URI schemes unregistered.

### Fura-visible `get_state` fields

Fura reads these fields from `get_state` responses:

```text
sessionId
sessionName
sessionFile
model
thinkingLevel
contextUsage.tokens
contextUsage.contextWindow
contextUsage.percent
planMode
goalMode
todoPhases
```

Fura currently ignores but should tolerate upstream fields:

```text
isStreaming
isCompacting
steeringMode
followUpMode
interruptMode
autoCompactionEnabled
messageCount
queuedMessageCount
systemPrompt
dumpTools
```

Target rule: Fura client parsing must remain tolerant of extra fields. Oh My Pi server tests should remain strict about required fields for known response shapes.

### Fura plan projection contract

Fura frontend type:

```ts
type PlanModeProjection = {
  enabled: boolean;
  planFilePath: string;
  workflow?: string | null;
  discussion?: boolean;
};
```

Fura pending plan-review type:

```ts
type PendingPlanReviewProjection = {
  planFilePath: string;
  finalPlanFilePath: string;
  title?: string | null;
  content: string;
};
```

Fura bridge behavior:

- `plan_review` event creates `pendingPlanReview`.
- `approve_plan_mode` clears `pendingPlanReview`, may queue `set_session_name`, and then refreshes state.
- `discuss_plan_mode` updates `planMode.discussion`.
- `set_plan_mode` updates `planMode`.

Target rule: upstream resolve-based approval must remain authoritative, but it must still emit enough RPC state/events for these Fura projections.

### Fura goal projection contract

Fura frontend type:

```ts
type GoalModeProjection = {
  enabled: boolean;
  mode: "active" | "exiting";
  reason?: "completed" | null;
  goal: {
    id: string;
    objective: string;
    status: "active" | "paused" | "budget-limited" | "complete" | "dropped";
    tokenBudget?: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: number;
    updatedAt: number;
  };
};
```

Fura bridge behavior:

- `goal_updated.state` updates `goalMode`.
- `get_state.data.goalMode` updates or clears `goalMode`.
- `goal_mode` response reads `data.goalMode`.
- Goal commands sent by Fura are `create`, `pause`, `resume`, `drop`, and `set_budget`.

Target rule: implement Goal RPC on top of upstream goal runtime and keep Fura's no-`complete` external control surface unless intentionally changed.

### Fura active-tool/controller contract

Fura controller session sends:

```text
set_host_tools
set_active_tools
```

Controller host tools:

```text
fura_search_sessions
fura_reply
fura_select_session
fura_set_prompt_draft
fura_show_notice
```

`set_active_tools` restricts the controller to exactly those `fura_*` tools.

Migration implication: upstream's host URI bridge is not a normal tool. Fura's initial migration decision is to leave host URI schemes unregistered and not implement host URI handling in Fura. Active-tool restriction must still avoid deleting or breaking upstream host URI routing inside Oh My Pi, because it may be used by non-Fura RPC clients.

### Fura repo diff snapshot contract

Fura sends:

```text
repo_diff_snapshot
repo_diff_get
```

Fura consumes response data shaped like:

```text
snapshots[]
selectedSnapshot
headSnapshot
diff
stat
```

`selectedSnapshot.entryId` is used to bind created snapshots back to Fura diff candidates.

Migration implication: old Fura snapshot persistence should be rebuilt on upstream worktree/synthetic-tree-diff semantics, but this response shape is externally useful to the Fura bridge and should stay stable unless the frontend is changed in the same migration.

## Target RPC contract for first implementation pass

The first implementation pass should produce only a coherent protocol surface and fixture set. It does not need all feature internals fully ported yet, but types and generated fixtures must describe the final contract.

### Target command union

Start from upstream `RpcCommand` and add these Fura commands:

```text
fork
set_plan_mode
approve_plan_mode
discuss_plan_mode
set_active_tools
goal_mode
repo_diff_get
repo_diff_snapshot
```

Keep upstream command:

```text
set_host_uri_schemes
```

### Target response union

Start from upstream `RpcResponse` and add success responses for:

```text
fork
set_plan_mode
approve_plan_mode
discuss_plan_mode
set_active_tools
goal_mode
repo_diff_get
repo_diff_snapshot
```

Keep upstream success response for:

```text
set_host_uri_schemes
```

Error response remains generic:

```ts
{ id?: string; type: "response"; command: string; success: false; error: string }
```

### Target state union

Start from upstream `RpcSessionState` and add:

```text
planMode: PlanModeState | null
goalMode: GoalModeState | null
```

Keep upstream:

```text
contextUsage?: ContextUsage
systemPrompt?: string[]
dumpTools?: Array<{ name: string; description: string; parameters: unknown }>
```

### Target event/frame union

Keep upstream frames:

```text
extension_ui_request
extension_ui_response
host_tool_call
host_tool_cancel
host_tool_update
host_tool_result
host_uri_request
host_uri_cancel
host_uri_result
```

Add Fura event:

```text
plan_review
```

### Target generated fixtures

Minimum fixture set before feature porting:

```text
command-get-state
response-get-state-with-context-plan-goal
command-set-host-uri-schemes
frame-host-uri-request
frame-host-uri-result
frame-host-tool-call
frame-host-tool-result
event-plan-review
command-set-plan-mode
response-set-plan-mode
command-approve-plan-mode
response-approve-plan-mode
command-discuss-plan-mode
response-discuss-plan-mode
command-set-active-tools
response-set-active-tools
command-goal-mode-create
command-goal-mode-set-budget
response-goal-mode
command-repo-diff-get
response-repo-diff-get
command-repo-diff-snapshot
response-repo-diff-snapshot
```

Fixtures should assert shape, not current default values.

## Expanded implementation workplan

### Work package A: protocol-only branch

Start from:

```bash
git checkout -b fura-upstream-replay upstream/main
```

Apply no feature logic yet. Only add final RPC types and fixture generator support.

Files expected:

```text
packages/coding-agent/src/modes/rpc/rpc-types.ts
packages/coding-agent/scripts/generate-rpc-contract-fixtures.ts
packages/coding-agent/test/fixtures/rpc-contract/...
packages/coding-agent/test/rpc-contract-fixtures.test.ts
```

Acceptance:

- Typecheck for the touched package if feasible.
- RPC fixture test passes.
- Fixture set contains both upstream host URI frames and Fura plan/goal/repo-diff frames.

### Work package B: repo diff snapshots

Port `5b2f2fa02` as a feature, not as a raw cherry-pick.

Order:

1. Snapshot storage and types.
2. Git/worktree integration using upstream synthetic tree diff helpers.
3. Slash command registration.
4. RPC command implementation.
5. Fura-facing response shape tests.

Acceptance:

- Existing upstream worktree/diff tests still pass.
- New repo snapshot tests pass.
- Response shape still has `snapshots`, `selectedSnapshot`, `headSnapshot`, `diff`, and `stat`.

### Work package C: plan review RPC

Port `ec95beda0`, `b080e4ee1`, and `1ddb49a81`.

Order:

1. `plan_review` event emission.
2. `set_plan_mode` command.
3. `discuss_plan_mode` command and `PlanModeState.discussion`.
4. `approve_plan_mode` using upstream resolve approval.
5. `preserveContext` / `compactBeforeExecute` options.
6. Plan review tests and fixtures.

Acceptance:

- RPC approval path uses upstream resolve/plan approval logic.
- Failed apply keeps pending resolution semantics.
- Fura can still distinguish execute, compact, and keep-context approval modes.

### Work package D: active tool restriction

Port `b19d2ed2a`.

Order:

1. Add `set_active_tools` type/response if not already in protocol package.
2. Route command to upstream active-tool session API.
3. Confirm active-tool changes rebuild prompt/tool discovery.
4. Confirm upstream host URI protocol remains present in Oh My Pi, while Fura does not register any URI schemes.

Acceptance:

- Controller can restrict to `fura_*` tools.
- Non-tool protocol frames still work.
- `report_tool_issue` / active-tool enum behavior remains upstream-compatible.

### Work package E: goal RPC

Port `a4044eec6`, `9e39e9599`, and `0131b9ed5` as one squashed feature.

Order:

1. Add `goalMode` to state projection.
2. Add `goal_mode` command using upstream goal runtime.
3. Support only `create`, `pause`, `resume`, `drop`, `set_budget`.
4. Wire `goal_updated` event/state refresh behavior if upstream RPC does not already expose it.
5. Goal RPC tests and fixtures.

Acceptance:

- Fura can start, pause, resume, drop, and set budget.
- No external RPC `complete` command unless deliberately reintroduced.
- Interrupt/reload behavior uses upstream fixed goal state machine.

### Work package F: prompt guidance

Port `e1dc0fe67` manually onto current upstream prompts.

Acceptance:

- Mermaid-source instruction remains present.
- Render-tool instruction remains scoped to ASCII/artifact requests.
- Prompt tests/snapshots updated only if they exist and fail.

### Work package G: compatibility decisions before final cutover

Make explicit decisions and update this file before implementation ends:

1. Eval contract:
   - Fura currently does not generate `eval` tool calls directly,
   - decision can be deferred unless Fura starts generating tool calls or validating tool schemas,
   - if Fura does add eval generation later, prefer upstream JSON `cells`; otherwise add an explicit old-string-input compatibility adapter.
2. Host URI:
   - decision for initial migration: Fura leaves schemes unregistered,
   - Fura does not implement `host_uri_request` / `host_uri_result` / `host_uri_cancel`,
   - upstream Oh My Pi host URI protocol must still be preserved for compatibility with other RPC hosts.
3. Auth gateway:
   - Fura continues spawning local `omp --mode rpc`, or
   - Fura can target `/v1/pi/stream`/gateway in a later phase.
4. ANSI/OSC8:
   - strip at Fura web boundary, or
   - convert to structured frontend links.

These are contract decisions, not incidental implementation details.

## Updated current recommended next step

The next concrete step is now narrower than “start migration”:

1. Create the clean `fura-upstream-replay` branch from `upstream/main`.
2. Implement Work package A only: final RPC protocol types plus generated fixtures.
3. Compare generated fixtures against this inventory.
4. Only then port feature logic.

This keeps the scary part — protocol drift — isolated and reviewable before larger code motion begins.
