# Command palette & server-side slash execution

Status: implemented. The inline `/` typeahead lists only Fura's curated **supported**
commands; a dedicated **Commands popup** (opened by `/commands` or `/help`) browses the full
set — curated commands, live OMP **skills**, and other live project commands — with
descriptions and click-to-insert. Also covers rendering of OMP server-side slash output
(`command_output`). Subagent-subscription visibility is intentionally out of scope here
(deferred; see `spec/subagent-visibility.md`).

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
  notice, `model`/`thinking`/`fork`/`rebase`/`session`/`usage`/`export`/`new` (alias
  `clear`)/`compact`/`handoff`/`rename`.
- **`handle`-bearing builtins Fura has no native UI for** (`tools`, `context`, `jobs`, `stats`,
  `changelog`, `fast`, `browser`, `dump`, `share`) fall through to OMP, which runs them
  server-side and returns `command_output`. They were removed from the TUI-only denylist.
- **Interactive commands without safe Fura projection state** still return a notice. Most are
  `handleTui`-only: `settings`, `copy`, `hotkeys`, `extensions`, `agents`, `branch`, `tree`,
  `login`, `logout`, `mcp`, `ssh`, `resume`, `btw`, `background`, `debug`, `memory`, `exit`,
  `quit`, `q`, `marketplace`, `plugins`, `reload-plugins`, `force`, `vibe`, `queue`, `pause`.
  `/move` has an OMP server-side `handle` in v16.2, but Fura keeps it blocked until OMP RPC exposes authoritative cwd after the move.

## Desktop palette + commands popup (frontend)

Two distinct surfaces:

- **Inline `/` typeahead** (`frontend/src/main.ts::updatePalette`): fuzzy-matches against
  `SUPPORTED_SLASH_COMMANDS` only (`SLASH_COMMANDS.filter(support === "supported")`). It does
  **not** include live OMP commands — no `skill:` / MCP / file clutter while typing.
- **Commands popup** (`#commandsPopupOverlay`, a `modal-overlay`/`modal-panel` modal cloned
  from the model picker): opened when the composer submits `/commands` or `/help`. The submit
  is intercepted in `frontend/src/composer.ts::resolvePromptSubmitAction`
  (`slashCommandName ∈ {commands, help}` → `{ type: "openCommandsPopup", sessionId }`) and
  routed in the `promptForm` submit `switch` to `openCommandsPopup`. The backend `/help`/
  `/commands` notice arm is left intact for non-UI callers but is never reached from Fura's UI.

`frontend/src/slashCommands.ts`:
- `SLASH_COMMANDS` — Fura's curated static list (Fura-native + builtins) with a
  `support: supported | tui-only` flag kept in sync with the backend reclassification.
- `SUPPORTED_SLASH_COMMANDS` — the precomputed `support === "supported"` subset (inline pool).
- `buildCommandsPopupSections(live)` — pure, returns the popup's grouped sections (no DOM):
  - **Commands** — curated supported commands, minus `help`/`commands` (self-referential).
  - **Skills** — live `availableCommands` with `source === "skill"` (omitted when empty).
  - **Other commands** — live `source ∈ builtin | file | custom | mcp_prompt | extension`
    not already curated (omitted when empty).
  Each row carries `{ label, description, insertText: "/<name> " }`.
- `fuzzyMatchCommands(query, pool = SLASH_COMMANDS)` still takes the pool (inline passes
  `SUPPORTED_SLASH_COMMANDS`).

`renderCommandsPopup` reads the active session's `projection.availableCommands` (snapshotted at
open and re-read on each search keystroke; no live-delta subscription), renders grouped rows
reusing the `model-picker-*` row classes plus `.commands-popup-section-title`, filters by the
search box, and on row click inserts `insertText` into the composer and closes (Escape and the
backdrop also close). **Skills are run, not just listed**: clicking a skill inserts
`/skill:<name> ` and submitting forwards it to OMP, whose `prompt` handler matches `/skill:`
(`tryRunRpcSkillCommand`) and re-injects that skill via `promptCustomMessage`. Typing
`/skill:<name>` directly does the same.

While a session is busy, Fura immediately submits recognized static commands and live
`builtin`, `skill`, or `extension` commands. Live prompt-template sources (`file`, `custom`,
`mcp_prompt`) remain in the composer with a warning: OMP requires an explicit
`streamingBehavior` to queue those prompts, and Fura does not silently choose steer versus
follow-up on the user's behalf.

`command_output` renders through the existing session-notice pipeline (`.message-command-notice`);
no dedicated UI.

**Mobile**: no palette/popup/command-output UI. Mobile still consumes the shared `protocol.ts`
types and `slashCommands.ts`.

## Invariants

- Fura never invents commands: the inline pool is Fura's curated supported list; the popup's
  Skills/Other sections come straight from OMP's advertised `availableCommands`.
- `available_commands` is a pure projection of OMP state; deltas carry it
  (`applySessionDelta` copies it) so it survives transcript updates.
- The `support` flag in `SLASH_COMMANDS` must track the backend denylist: a command marked
  `supported` must be either Fura-native-handled or a server-side `handle` builtin.
