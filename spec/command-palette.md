# Dynamic command palette & server-side slash execution

Status: implemented. Covers the desktop command palette fed by OMP's advertised
slash commands, plus rendering of OMP server-side slash output (`command_output`).
Subagent-subscription visibility is intentionally **out of scope** here (deferred;
Fura's inline task-card progress already covers live subagent progress).

## OMP contract consumed

OMP (`--mode rpc-ui`) advertises and runs slash commands:

- **`get_available_commands`** (request) → `{ commands: RpcAvailableSlashCommand[] }`.
- **`available_commands_update`** (async frame) → `{ commands: RpcAvailableSlashCommand[] }`,
  pushed at OMP startup and whenever the set changes (cwd/session/plugin changes).
- `RpcAvailableSlashCommand = { name, aliases?, description?, input?: { hint? }, subcommands?: [{ name, description?, usage? }], source }`
  where `source ∈ builtin | skill | extension | custom | mcp_prompt | file`.
- **Server-side execution**: OMP's `prompt` handler runs `/skill:*` and any builtin
  that has a server-side `handle` (e.g. `tools`, `context`, `usage`, `jobs`, `stats`,
  `changelog`, `fast`, `browser`, `dump`, `share`) and streams the result back as a
  **`command_output`** frame `{ text }` (plus `session_info_update` / `config_update`
  when the command changes title/model/thinking). Builtins with only a `handleTui`
  (interactive) handler are NOT run server-side.

## Fura projection (backend)

- `OmpRpcFrame` gains `AvailableCommandsUpdate`, `CommandOutput`, `SessionInfoUpdate`,
  `ConfigUpdate` (`src/omp_rpc.rs`). `RpcAvailableSlashCommand` mirrors the OMP shape.
- `SessionRecord.available_commands` caches the advertised list; it is projected into
  `SessionProjection.available_commands` (and the delta), so a late-attaching client
  receives it in the session snapshot. **Projection-only**: it is overwritten on every
  `available_commands_update` / `get_available_commands` response, never edited locally.
- `refresh_rpc_state` issues `get_available_commands` alongside `get_state`/`get_messages`/
  `get_session_stats` on attach/ready/refresh, so the palette loads without a separate hook.
- Frame dispatch (`src/rpc.rs::apply_rpc_frame`):
  - `available_commands_update` → `mutate_session_snapshot` setting `available_commands`.
  - `command_output` → emitted as a **`SessionNotice`** (reuses the existing notice path;
    no new browser message type).
  - `session_info_update` / `config_update` → trigger `refresh_rpc_state` so the
    projection picks up title/model/thinking changes after a server-side slash command.
- Controller (Ask Fura) transport ignores these frames.

## Slash routing (backend, `src/commands.rs::handle_slash_command`)

- **Fura-native** (dedicated UX) stays intercepted: `plan`→`set_plan_mode`, `goal`→Goal-card
  notice, `model`/`thinking`/`fork`/`rebase`/`session`/`usage`/`export`/`new`/`compact`/
  `handoff`/`rename`.
- **`handle`-bearing builtins Fura has no native UI for** (`tools`, `context`, `jobs`, `stats`,
  `changelog`, `fast`, `browser`, `dump`, `share`) fall through to OMP, which runs them
  server-side and returns `command_output`. They were removed from the TUI-only denylist.
- **`handleTui`-only / interactive** commands still return a notice (no server-side handle):
  `settings`, `copy`, `hotkeys`, `extensions`, `agents`, `branch`, `tree`, `login`, `logout`,
  `mcp`, `ssh`, `resume`, `btw`, `background`, `debug`, `memory`, `move`, `exit`, `marketplace`,
  `plugins`, `reload-plugins`, `force`. (Sending these to OMP would forward them to the model
  as literal text, since OMP only auto-runs `handle` builtins.)

## Desktop palette (frontend)

- `frontend/src/slashCommands.ts`:
  - `SLASH_COMMANDS` is Fura's curated static list (Fura-native + builtins, with a
    `support: supported | tui-only` flag kept in sync with the backend reclassification).
  - `buildPaletteCommands(live)` = curated **supported** static commands **plus** the live
    **non-builtin** advertised commands (`skill` / `mcp_prompt` / `file` / `custom` / `extension`)
    not already in the static list. Builtins stay represented by the curated entries (so the
    palette is stable and avoids suggesting interactive-only commands).
  - `fuzzyMatchCommands(query, pool = SLASH_COMMANDS)` takes the pool.
- `frontend/src/main.ts::updatePalette` feeds the pool from the active session's
  `projection.availableCommands` (falls back to the static supported list when absent).
- `command_output` renders through the existing session-notice pipeline
  (`.message-command-notice`); no dedicated UI.
- **Mobile**: no palette/command-output UI (no new mobile features). Mobile still consumes
  the shared `protocol.ts` types and `slashCommands.ts` (`fuzzyMatchCommands` is backward
  compatible).

## Invariants

- Fura never invents commands: the palette is OMP's advertised set plus Fura-native entries.
- `available_commands` is a pure projection of OMP state; deltas carry it
  (`applySessionDelta` copies it) so it survives transcript updates.
- The `support` flag in `SLASH_COMMANDS` must track the backend denylist: a command marked
  `supported` must be either Fura-native-handled or a server-side `handle` builtin.
