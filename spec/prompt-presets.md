# Fura Prompt Presets (`/presets`)

## Goal

Let the user save named prompt templates ("presets") and run them from the composer via `/presets`. A preset is just a remembered prompt with optional `{param}` placeholders the user fills at send time. Presets are a **Fura-only convenience**; they are not an OMP feature and OMP performs no expansion for them.

This is deliberately small: a preset stores text, optionally substitutes `{param}` values, and sends the result as an ordinary prompt. It is not a workflow engine, not an agent, and must not grow OMP-side semantics.

## Current implementation status

Implemented in commit `e92038f Add /presets prompt presets with param substitution and editor`:

- Storage: one markdown file per preset under `~/.fura/presets/<name>.md` (YAML frontmatter `description` + `defaults`, then the body). User-global (derived from the `~/.fura/config.yaml` sibling).
- Backend module `src/presets.rs` owns scan/parse/serialize/validate/save/delete plus the `PresetSummary` DTO.
- Presets ride inside `ClientConfig` (`config.rs`), delivered in `hello` and every `config.updated` broadcast. `client_config` reads the `~/.fura/presets` directory fresh each time it builds the config — there is **no in-memory cache**. They are **not** persisted in `.fura/config.yaml` (file-backed, not config-backed).
- Protocol (Fura-only, mirrored in `src/protocol.rs` + `frontend/src/protocol.ts`):
  - client → bridge: `preset.save { name, description?, body, defaults? }`, `preset.delete { name }`, `presets.refresh` (no payload — request a fresh read)
  - bridge → client: `presets.list { presets }` is the **direct, correlated reply** to `presets.refresh` (sent only to the requester, un-conflated); presets are also a field on `ClientConfig` (`config.updated` / `hello`). CRUD failures come back as `error`.
- `commands.rs`: `handle_preset_save`/`handle_preset_delete` (after writing the file) call `broadcast_config` (rebuilds `ClientConfig` by re-reading the dir → all clients update). The `presets.refresh` arm instead returns a direct `presets.list` reply with a fresh disk read (no broadcast). There is no `state.presets` field — the files on disk are the single source of truth.
- Shared frontend logic in `frontend/src/presets.ts`: `parsePresetParams`, `substitutePresetParams`, `isValidPresetName`, `presetNameFromInput`, `requiredParamsFilled`, `pruneDefaults`, `buildPresetSaveMessage`, `resolvePresetCommand`.
- Desktop (`main.ts`): `/presets` dispatch + picker + param-fill modal (live preview, required gating, Send / Insert into composer) + editor (New / Edit / Delete). `slashCommands.ts` registers `presets` (alias `preset`).
- Mobile (`mobileApp.ts`): run-only (picker + param modal + Send / Insert). **No editor on mobile** — deferred. Stays off Dockview/desktop chrome (`mobileBoundary.test.ts`).

Observed verification for `e92038f` (rebased onto current master):

```text
cargo fmt
cargo test                         # 286 passed
npm --prefix frontend test          # 41 files, 406 tests passed
npm --prefix frontend run build      # passed; existing Mermaid chunk-size warning remains
```

(Local note: only `bun` is installed on the dev box, not `node`/`npm`; the `npm --prefix frontend …` steps are run via `bun run …`, and any generated `bun.lock` is removed afterward to keep the repo npm-based.)

## Core decisions

### Presets are Fura artifacts, not OMP commands

Earlier exploration considered storing presets in OMP's `~/.omp/agent/commands/` so OMP would expand them. That was abandoned once Fura took over `{param}` substitution: OMP does not understand `{param}`, so Fura must expand and send the resolved text itself. Therefore presets live in Fura's own space (`~/.fura/presets/`), never under `~/.omp` and never in `.fura/config.yaml`.

Consequence: a Fura preset does not work in the OMP TUI. If the user wants a shortcut usable in both TUI and Fura, that belongs in an OMP markdown command (`commands/*.md`), not a Fura preset.

### Execution model: Fura expands, then sends a normal prompt

`runPreset` (desktop) / `runMobilePreset` (mobile) does `substitutePresetParams(body, values)` and sends the result through the normal `prompt.send` path. The bridge never sees `{param}`. There is no dedicated "run preset" RPC — it is an ordinary prompt.

A body that itself begins with `/` is sent verbatim, so the bridge's `handle_slash_command` interprets it and (for names Fura does not own) forwards it to OMP. This is **intentional** and is what lets a preset wrap an OMP command, e.g. body `/review focus on auth` runs the OMP `/review` command (whose own template then appends the focus as "Additional Instructions"). Do not "fix" this.

### The body is the source of truth for parameters

Which params exist = the unique `{param}` tokens in the body (`parsePresetParams`). `defaults` only decorates params by name; stale/extra default keys are ignored, and adding a `{newparam}` to the body just surfaces a new field. There is no separately-maintained variable list to drift.

- Placeholder syntax: `{name}` where `name` matches `[A-Za-z][A-Za-z0-9_-]*`. Literal `{`, `{}`, `{ "k": 1 }`, `{123}` are not captured.
- A param **with** a default is optional (field pre-filled, counts as satisfied even if cleared); **without** a default it is required (Send/Insert disabled until non-empty). See `requiredParamsFilled`.

### Slug rules mirrored on both sides

`validate_preset_name` (Rust) and `isValidPresetName` (TS) must stay in sync: `^[a-z0-9]+(?:[-_][a-z0-9]+)*$` and length ≤ 64. The slug is also the path-containment guarantee (no separators/dots → file stays in `~/.fura/presets`). `save_preset` additionally asserts the resolved path's parent equals the dir and writes atomically (unique temp file + rename).

## Non-obvious behaviors / gotchas

- **No in-memory cache — files are the source of truth.** `client_config` scans `~/.fura/presets` every time it builds the config, so any new connection's `hello` already reflects on-disk files, including ones written after startup. For `/presets`, the frontend sends `presets.refresh` and defers the command (picker / named) via `pendingPresetCommand`, resolving it against the **direct `presets.list` reply** (a correlated, un-conflated response — never an unrelated `config.updated`, which avoids resolving against a stale in-flight broadcast). It also resolves on `hello` if a command is pending (reconnect safety, since `hello` carries a fresh disk read), and falls back to the cached list when `send` fails. So a preset written directly to `~/.fura/presets` (by hand or by the agent) shows up on the next connect or `/presets`, no restart needed. `client_config` is only built on `hello` and config/preset changes (never a hot path), so the per-build directory scan is cheap. There is still no filesystem watcher, so an already-open picker does not live-update until the next invocation.
- **`load_presets` skips non-slug filenames.** Hand-created files whose stem is not a valid slug (e.g. `Upper.md`, `a--b.md`) are ignored, so the UI never lists a preset it cannot edit/delete through the validated API.
- **CRLF is normalized** in `parse_preset` (`\r\n`/`\r` → `\n`), so Windows-authored files don't leak carriage returns into prompts.
- **Slash bodies need an idle agent.** A `/`-prefixed body is treated as a slash command; while the agent is busy, Fura blocks it with a notice (slash commands can't be steer/follow-up). Non-slash bodies use normal busy handling.
- **Image attachments are rejected, not dropped.** Submitting `/presets …` with a pending image warns via a session notice and aborts (desktop and mobile) instead of silently discarding the image.
- **`presetPending` correlation.** A pending save/delete is cleared only when a `config.updated` reflects it (name present for save / absent for delete), so an unrelated config change (e.g. another client toggling `showTools`) does not prematurely clear it. Editing an existing preset can still resolve cosmetically early on an unrelated update, but no data is lost. `closePresetsOverlay` is always allowed and resets pending (no stuck modal if the bridge reply is lost).
- **Deleted-while-open.** `syncPresetsUi` / `syncMobilePresets` return to the picker if the open run target was removed by another client, so a deleted preset can't be sent.
- **Prototype-key safety.** `substitutePresetParams` and the run-value seeding use `Object.prototype.hasOwnProperty` checks so tokens like `{toString}`/`{constructor}` are not replaced by inherited members.

## Relationship to OMP `/review` and markdown commands

`/review` is an OMP bundled command that (in `rpc-ui`, where `hasUI` is true) pops a mode menu, computes the git diff, picks a reviewer-agent count, renders `prompts/review-request.md` (files table + embedded diff + distribution guidance), and the main agent fans out to `reviewer` subagents. A Fura preset cannot replicate that (no diff precompute, no menu) — but it can **invoke** it (body `/review <focus>`), where the focus lands in the template's "Additional Instructions". Prefer wrapping over reimplementing.

## Mock fixture guidance

Presets are file-backed and exercised through the bridge's own protocol, not OMP RPC, so `fixtures/mock-omp-rpc.mjs` is not involved. Backend behavior is covered by `src/presets.rs` unit tests (parse/serialize/validate/save/delete/scan, CRLF, slug-skip) and frontend logic by `frontend/src/presets.test.ts`. Live/manual checks write to the real `~/.fura/presets` and must clean up after themselves.

## Future / non-goals

- Directory watcher for live pickup of externally-written presets.
- "Resolvable" defaults (e.g. a default computed from git/cwd) — the data model leaves room without a format change; not implemented.
- Mobile editor (CRUD) — desktop-only for now; mobile is run-only.
- No OMP-side semantics, no per-preset tools/agents, no workflow logic. A preset is text + `{param}` substitution.
