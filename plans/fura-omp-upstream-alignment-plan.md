# Fura / OMP Upstream Alignment Plan

## Source notes found

The likely older feature note is `/home/aleksander/repos/oh-my-pi/docs/gui-rpc-bridge-design.md`. It is currently untracked in the OMP repo. It reads like the original bridge design and is still useful because it records the core product boundary:

- Fura is an external browser/Rust bridge around OMP RPC, not a TUI rewrite.
- OMP remains source of truth for agent execution, session persistence, model/tool state, compaction, MCP/LSP/bash/python/browser tooling, and durable session files.
- Fura owns projection, UI state, reconnect behavior, local/remote browser serving, review workflows, and user-facing orchestration.
- Missing OMP RPC features should become small upstreamable protocol additions, not permanent broad fork drift.

Existing Fura planning notes also relevant:

- `plans-done/FURA_FRONTEND_CONTROL_AGENT_PLAN.md`
- `plans/read-only-code-browser-rust-analyzer-plan.md`
- `plans/image-output-and-diagram-tools-plan.md`
- `plans/fura-mobile-auth-plan.md`

## Current alignment state after rebase

`fork-stuff` is now rebased on `origin/main` and keeps the Fura-required fork surface:

- durable repo diff snapshots;
- RPC `repo_diff_get` and `repo_diff_snapshot`;
- RPC `set_plan_mode`, `approve_plan_mode`, and `discuss_plan_mode`;
- RPC `plan_review` events;
- RPC `set_active_tools` for Ask Fura controller isolation;
- RPC `fork`;
- Mermaid source vs ASCII rendering guidance.

The important semantic change is plan mode: upstream now uses the hidden `resolve` tool for approval, not the fork's old `exit_plan_mode` tool. The rebase keeps Fura's browser-facing `plan_review` event while wiring plan approval through upstream's resolve-based flow.

That means Fura's UI contract stays stable for now, while the OMP-side implementation moves closer to upstream instead of preserving an obsolete fork-only tool.

## Alignment principles

### Keep OMP authoritative

If a feature controls agent behavior, durable session semantics, tool availability, model choice, or context management, the canonical implementation belongs in OMP. Fura should ask for state and send typed intents.

Examples:

- goal mode lifecycle and budgets;
- plan mode approval/execution semantics;
- branch/fork/session tree semantics;
- tool restriction and permission semantics;
- compaction behavior;
- model/thinking selection.

### Keep Fura as projection plus workflow UI

If a feature is about browser layout, mobile/desktop parity, reconnect UX, diff/code review affordances, annotations, comments, controller conversation UI, or rendering, it belongs in Fura.

Examples:

- Dockview/mobile layouts;
- transcript/tool/card rendering;
- diff review comments and agent-review orchestration;
- Ask Fura candidate memory and frontend control actions;
- plan/goal review cards;
- local browser auth/Tailscale/HTTPS serving.

### Shrink fork-only behavior over time

The fork is acceptable as a proving ground, but every OMP-side addition should have a narrow upstream story:

- one command/event per capability;
- typed request/response shapes;
- no Fura-specific names unless the capability is truly Fura-only;
- tests in OMP before Fura depends on it;
- Fura bridge preserves backward compatibility only where it materially helps local development.

## Feature alignment priorities

### 1. Goal Mode in Fura

Goal mode is now important enough to treat as a first-class Fura workflow, not an opaque slash command.

Why it matters:

- Goal mode is upstream's long-running objective-management layer.
- It is closer to how a browser GUI should help: show the objective, budget, status, continuation pressure, and completion state outside the transcript noise.
- Fura already manages long-lived sessions and multiple clients; it can make goal state visible without changing goal semantics.

OMP should own:

- goal creation/resume/pause/drop/complete semantics;
- token/time budget accounting;
- continuation prompts;
- durable session entries for goal state;
- any rules for when goal mode can coexist with plan mode.

Fura should own:

- desktop and mobile goal status cards;
- controls that send typed goal commands;
- warnings when goal mode blocks another action;
- transcript rendering of goal events;
- session-list badges/filtering for active goal sessions.

Recommended first slice:

1. Extend OMP RPC `get_state` with `goalMode` if not already present.
2. Add Fura Rust protocol DTOs and `SessionProjection.goalMode`.
3. Add frontend protocol type and read-only goal status rendering.
4. Add tests proving unknown/missing goal state does not break older OMP fixtures.
5. Add explicit goal actions only after read-only projection is correct.

Likely Fura files when implemented:

- Backend: `src/omp_rpc.rs`, `src/session.rs`, `src/protocol.rs`, `src/projection.rs` or RPC state refresh handling in `src/rpc.rs`.
- Frontend: `frontend/src/protocol.ts`, `frontend/src/main.ts`, `frontend/src/mobileApp.ts`, likely a new domain module such as `frontend/src/goalMode.ts`.
- Fixture/tests: `fixtures/mock-omp-rpc.mjs`, Rust projection tests, frontend render tests.

### 2. Plan Mode alignment

Short term: keep Fura's current browser approval UX using `plan_review`, `plan.approve`, and `plan.discuss`.

Why:

- Fura needs to show the full proposed plan in the browser before approval.
- Upstream `resolve` is a good internal mechanism, but a browser still needs a structured event carrying plan paths/title/content.
- Keeping the frontend protocol stable reduces risk while the OMP fork settles after rebase.

Medium-term alignment:

- keep `set_plan_mode` as the browser entrypoint unless upstream grows an equivalent command;
- consider replacing `approve_plan_mode` with a generic `resolve` RPC command only if Fura can safely correlate pending actions and present the right UI;
- preserve browser-specific `plan_review` events because the UI needs preview content;
- add Fura UI for upstream's new “approve and compact context” choice;
- make `discuss_plan_mode` a thin state update over upstream plan discussion state, not a separate planning engine.

Do not resurrect `exit_plan_mode`. It is now the wrong abstraction because upstream's canonical preview/apply mechanism is `resolve`.

#### Why the three approval choices matter

- **Approve and execute** is the safest default when planning has produced a lot of exploratory or contradictory context. OMP starts a fresh execution session, writes the approved plan into that new session's `local://` artifact root, and the executor sees the plan as the source of truth rather than the full planning debate.
- **Approve and compact context** is the upstream-favored middle path for long plans. It keeps the current session identity/history, but first asks OMP to distill the planning conversation. The executor keeps useful context while dropping most negotiation/noise. This is better than the old single approve path when the plan took many turns to settle.
- **Approve and keep context** is useful when the planning conversation contains details that should not be compressed away: user constraints, examples, domain terminology, or unresolved nuance. It is more token-heavy and can carry stale discussion into execution, so it should be deliberate rather than the only approve behavior.

The old Fura behavior effectively had one browser button and one execution shape. Upstream's split is more useful because the right context policy depends on how the plan was created: clean short plan -> fresh execute; long noisy planning -> compact; context-rich domain plan -> keep.

### 3. Upstreamable RPC capability set

The fork-only RPC commands should be converted into small upstream PRs where possible:

- `set_active_tools` — necessary for any embedded/controller client that must restrict tool surface safely.
- `repo_diff_get` / `repo_diff_snapshot` — useful for headless review clients, not inherently Fura-specific.
- `fork` — small RPC parity command for existing session behavior.
- plan-review event/approval support — upstream shape should follow `resolve`, not old `exit_plan_mode`.
- future `goalMode` projection and goal commands.

Suggested upstream order:

1. `set_active_tools` because it is tiny, low-risk, and security-relevant for controller sessions.
2. `fork` because it is small parity.
3. `goalMode` read-only RPC projection because it benefits all headless clients.
4. repo diff snapshot RPC because it is larger and touches durable git/session behavior.
5. plan-review browser protocol once the resolve alignment is proven locally.

### 4. Session tree and branch navigation

From `docs/gui-rpc-bridge-design.md`, still valuable:

- `get_session_tree` for visual branch navigation;
- `get_entries` for precise branch/message reconstruction;
- `checkout_entry` or equivalent for navigating to a prior entry without inventing a branch.

Why this should wait:

- It touches durable session semantics and branch history.
- It is easy to build a pretty browser tree that lies about OMP's actual active branch.
- Goal/plan/diff parity gives more immediate product value and smaller protocol changes.

When implemented, OMP should return durable entry/tree data; Fura should only render and request navigation.

### 5. RPC UI/dialog parity

Upstream RPC UI support is now broader. Fura should stay aligned with OMP's `ExtensionUIContext` methods:

- continue supporting `select`, `confirm`, `input`, `editor`, `notify`, `set_editor_text`, `setStatus`, `setWidget`, `setTitle`, and `open_url`;
- improve visible rendering for `setWidget` and status-style extension UI instead of only logging/status notices;
- keep unsupported UI methods truthfully cancelled rather than fake-successful.

This matters because extensions and upstream features increasingly assume RPC mode can ask the host UI for input. Fura should be a correct RPC host, not just a chat window.

### 6. ACP / ClientBridge evaluation

ACP is not a direct replacement for Fura today, but it is important architecture.

What to borrow:

- permission-bound host capabilities;
- explicit client bridge contracts;
- separation between agent runtime and client-owned operations.

What not to do yet:

- do not move Fura wholesale to ACP;
- do not add a second transport until the current Rust bridge/RPC path proves where it hurts;
- do not let ACP pull Fura into editor/IDE scope accidentally.

Potential future use: browser/bridge-owned code navigation, conflict resolution, or file actions may be safer if exposed through an OMP permission boundary instead of more ad-hoc fork-only RPC commands.

### 7. Code browser and analysis

Current Fura code browser is read-only and intentionally not an IDE. Next useful alignment:

- add on-demand Rust analyzer lifecycle/status from `plans/read-only-code-browser-rust-analyzer-plan.md`;
- keep analysis inside Fura bridge unless OMP exposes a stable LSP/RPC surface;
- do not add editing until conflict/session semantics are robust.

The product line should remain: Fura helps inspect and review what the agent did; it does not become a full editor until there is a deliberate editing contract.

## Recommended implementation order

1. Stabilize this OMP rebase and run Fura against it manually.
2. Add Goal Mode read-only projection to OMP RPC and Fura.
3. Add Fura Goal Mode desktop/mobile read-only UI.
4. Add goal actions: start, pause/resume, drop/complete, budget controls, only if supported cleanly by OMP.
5. Add plan “approve and compact context” support in Fura.
6. Upstream `set_active_tools` as a focused OMP PR.
7. Upstream RPC `fork` as a focused OMP PR.
8. Upstream goal-mode RPC projection/actions.
9. Upstream repo diff snapshot RPC.
10. Revisit session tree navigation.

## Verification expectations

For each protocol-affecting feature:

- OMP targeted tests for RPC type/behavior;
- Fura Rust protocol/projection tests;
- Fura frontend tests for desktop and mobile rendering/actions;
- one manual smoke against local OMP using `run-local-omp.sh`.
