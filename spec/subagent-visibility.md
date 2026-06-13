# Subagent visibility

How Fura surfaces OMP subagents (the workers spawned by the `task` tool), and the
deferred OMP subagent-subscription channel.

## Current behavior (implemented)

When the agent uses the `task` tool, OMP spawns subagents. The **task tool result**
carries `details.progress[]` (live `AgentProgress`) and `details.results[]`
(`TaskResult[]`), streamed on the parent task tool card via `tool_execution_update`
/ `tool_execution_end`. Fura renders this inline — no dedicated subagent channel:

- Backend: projected as an ordinary tool card; `src/projection.rs` carries the result
  `Value` through (no subagent-specific handling).
- Frontend: `frontend/src/toolCards.ts` `renderTaskCard` / `renderTaskAgent` read
  `card.result.details.progress` / `.results` and render per-subagent rows (status,
  current tool, token/cost stats, recent output) plus final results.

Verified to still work against the rebased OMP — the `details.progress` / `details.results`
shapes are unchanged.

## Deferred: subagent subscription (NOT implemented)

The rebased OMP exposes a dedicated RPC channel for observing subagents:

- Commands: `set_subagent_subscription { level: off | progress | events }`,
  `get_subagents` → `{ subagents: RpcSubagentSnapshot[] }`,
  `get_subagent_messages { subagentId?, sessionFile?, fromByte? }` → byte-paginated transcript.
- Async frames: `subagent_lifecycle` `{ id, agent, agentSource, status, description?, sessionFile?, parentToolCallId?, index, detached? }`,
  `subagent_progress` (carries `AgentProgress`), `subagent_event` `{ id, event: AgentSessionEvent }`.
- Wired in `omp --mode rpc-ui` via the event bus (available, not stubbed).

### Why it was deferred (user-confirmed)

- **It is observability only** — it does not change agent behavior or add capability;
  subagents run the same with or without a subscriber. It is "watch what they do", not "do more".
- Fura's **inline task-card display already shows live subagent progress** for foreground
  `task` calls, using the same `AgentProgress` shape. So for visible tasks the subscription
  is redundant.
- Its only *unique* value is:
  1. **Detached / background subagents** — spawned without a blocking `task` tool call (e.g.
     background-fork flows), so they have no inline card to attach progress to.
  2. **Transcript drill-down** — `get_subagent_messages` opens a subagent's *full* transcript;
     the card only shows a summary (recent tools/output).
  3. `events`-level full live event stream per subagent.

Per the integration decision (keep the current inline approach; minimal scope), wiring a
redundant real-time channel plus new UI — for value that is either already shown (foreground)
or itself deferred (detached + drill-down) — was not justified. The cut was explicitly confirmed.

### If adopted later (minimal path)

- Backend: add the frame/command DTOs in `src/omp_rpc.rs`; `subagent_snapshots` on `SessionRecord`
  + projection; subscribe at `progress` on attach; project deltas.
- Frontend: the only piece with real new value is **drill-down** — clicking a subagent row on the
  task card issues `get_subagent_messages` and expands that subagent's transcript inline. Optionally
  a compact session-level strip for detached subagents.
- Keep it **inline** (no dedicated Dockview panel), consistent with the current-approach decision
  recorded in `plans/` and `spec/command-palette.md`.
