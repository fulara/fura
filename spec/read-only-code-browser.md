# Fura Read-only Code Browser

## Goal

Add a read-only code browser to Fura for reviewing code generated or modified by the model. This is not an editor and should not grow into a full IDE.

The browser should support:

- browsing a session/worktree repository tree,
- opening files read-only,
- viewing an outline/document symbols,
- viewing diagnostics,
- hover,
- go-to-definition,
- truthful errors for unavailable, stale, external, binary, or too-large content.

## Current implementation status

Implemented in commit `e3a446c Add read-only code viewer`:

- Desktop Dockview tab/panel named **Code**.
- Filesystem-only read-only browser; rust-analyzer is not started yet.
- Bridge protocol messages: `code.workspace.open`, `code.tree.list`, `code.file.open`, `code.file.close`, `code.workspace.ready`, `code.tree`, `code.file`, and `code.error`.
- Backend module `src/code.rs` owns workspace resolution, path validation, tree listing, file reads, file limits, binary detection, and `Cargo.toml` discovery.
- Workspace roots are resolved from active session worktree path or cwd.
- Tree listing is on-demand per directory and filters generated/heavy directories including `.git`, `target`, `node_modules`, `.next`, `dist`, `build`, and `coverage`.
- File opening is read-only, UTF-8 only, rejects binary files, and rejects files larger than 1 MB.
- Frontend module `frontend/src/codeViewer.ts` renders the Code panel, directory navigation, one active read-only file, syntax highlighting, and copy actions.
- Protocol and viewer tests were added.

`Cargo.toml` discovery gates lazy rust-analyzer startup. **Go-to-definition, find-references, hover, and `code.status` are now implemented** (see the "Active slice" section below). Diagnostics and document symbols remain pending.

Observed verification for `e3a446c`:

```text
cargo fmt
cargo check
cargo test                         # 90 passed
npm --prefix frontend test          # 28 files, 199 tests passed
npm --prefix frontend run build      # passed; existing Mermaid chunk-size warning remains
```

### Status update: Open in Code (diff → Code) is implemented and fixed

"Open in Code" from the diff view already exists (listed under Milestone 5 below). Two fixes landed since:

- Working-tree path: the requested file was dropped because `resetCodeViewForSession` cleared the pending open before `code.workspace.ready`. The pending request is now assigned after the reset, so the clicked file actually opens.
- Review-commit path: simplified to a single opener. `openCodeRequest` only prepares the review worktree (checkout if cached, else ensure) and the `diff.reviewWorktree.state` handler is the sole place that sends `code.workspace.openRoot`. This removes a duplicate open and routes the cached-worktree case through a checkout to the correct ref.

Both are covered by regression tests in `frontend/src/main.test.ts`.


## Core decisions

### Use rust-analyzer, not RLS

Do not build against old Rust RLS. RLS is deprecated; the bridge-side language backend should use `rust-analyzer` through LSP.

Use “rust-analyzer/LSP worker” terminology in code and docs rather than “RLS”.

### Name the feature Code, not Editor

Use **Code** as the UI panel/tab name and `code.*` as the protocol namespace. Use **read-only code browser** in planning/docs.

Do not call the feature an editor in UI, code, or docs. “Editor” implies file mutation, cursor ownership, save semantics, completion, rename, formatting, and code actions; those are explicit non-goals.

### Keep rust-analyzer inside the bridge

Architecture:

```text
Browser
  |
  | Fura code protocol
  v
Fura bridge
  |
  | internal LSP JSON-RPC
  v
rust-analyzer
```

Do not expose raw LSP as the normal browser protocol:

```text
Browser <-> raw LSP <-> rust-analyzer
```

The frontend should not own LSP capability negotiation, document sync, cancellation, request routing, URI mapping, or rust-analyzer-specific quirks.

### Panel rust-analyzer is separate from the agent's LSP

There are two distinct rust-analyzer instances and they are not shared:

1. The OMP agent's rust-analyzer lives inside the OMP child process and serves the model (the `lsp` tool, diagnostics-on-write). It is toggled by the OMP `--no-lsp` flag.
2. The Code panel's rust-analyzer is spawned and owned by the Fura bridge and serves the human reviewing code.

They cannot be the same process: OMP's RPC surface exposes no LSP command (the `lsp` tool is only invokable by the model, not over RPC), so the bridge cannot drive the agent's analyzer for the Code panel. The Code panel runs its own rust-analyzer per workspace root, consistent with "OMP is the source of truth for agent execution; Fura projects state." Enabling the agent's LSP has no effect on the Code panel and vice versa.

### Deliver go-to-definition and find-references first

The first analysis features shipped are **go-to-definition** (`textDocument/definition`) and **find-references / callsites** (`textDocument/references`). These are point queries with no asynchronous `publishDiagnostics` push, which makes them the cleanest way to validate the analyzer lifecycle on a narrow surface. The bridge keeps the analyzer's view of a queried file current with `didOpen`/`didChange` from on-disk content; the user never edits in the viewer.

Diagnostics, document symbols, and hover are explicitly deferred behind this slice. They are not prerequisites for the two navigation features and add stateful plumbing (diagnostics push, version-keyed symbol caches) that is not needed yet.

Definition and references do not require `rust-analyzer.checkOnSave`/flycheck; they come from rust-analyzer's own semantic index. Keep `checkOnSave` off to stay light.

### Desktop-only v1

The first implementation is desktop-only. It belongs in the existing Dockview workspace as a **Code** panel/tab, not in the mobile shell.

Mobile support is intentionally out of scope for v1. Mobile code browsing is a separate UX problem and should not block the desktop workflow.

### Bridge owns the projection/cache

The bridge should cache projected code-browser state:

- workspace registry,
- rust-analyzer process handles,
- file tree snapshots,
- open file content metadata,
- diagnostics by file,
- symbols by file/version,
- short-lived hover/definition results,
- mapping between `file://` URIs and workspace-relative paths.

The cache is not the source of truth.

Sources of truth:

- filesystem for saved file contents,
- rust-analyzer for semantic analysis,
- session/worktree cwd for workspace discovery.

Every cached analysis result should be tied to:

```text
workspaceId
path
version/content hash
```

If a result is stale, the bridge must report or refresh it rather than returning plausible but outdated data.

### Read-only means read-only

For the initial product scope, do not implement:

- file editing,
- saving,
- interactive text editing,
- completion,
- rename,
- code actions,
- formatting,
- full semantic token rendering,
- browser-side raw LSP.

The browser may open documents in rust-analyzer using `didOpen`, but only from the current filesystem content.


### Lazy analyzer startup

Opening the Code panel must not require rust-analyzer. Filesystem browsing should work immediately from the bridge.

rust-analyzer should start lazily only when all of these are true:

- desktop Code panel is opened/activated or an `Open in Code` action requires code analysis,
- the bridge resolves a valid workspace root for the active session/worktree,
- the workspace is detected as a Rust workspace,
- a feature that needs analysis is requested or enabled: diagnostics, document symbols, hover, or go-to-definition.

Do not start a rust-analyzer **LSP session** on Fura startup, WebSocket connect, session creation, or ordinary session attach. (A one-shot `rust-analyzer --version` availability probe does run at startup — it prints and exits without starting an LSP session or indexing — and aborts startup unless `--skip-rls-unavailable` is set.)

### Rust workspace detection

Only start rust-analyzer for workspaces with a discovered `Cargo.toml`. Detection should be conservative:

1. Start from the session cwd or worktree path.
2. Prefer the git/worktree root if it contains `Cargo.toml`.
3. Otherwise walk ancestors from cwd until the workspace boundary and use the nearest directory containing `Cargo.toml`.
4. If no `Cargo.toml` is found, keep the Code panel in files-only mode and do not start rust-analyzer.

No `Cargo.toml` is not an error for the Code panel. It means: browse files, but no Rust diagnostics/symbols/hover/definition.

Expose this state truthfully in UI, for example:

```text
Files only
Rust analysis starting…
Rust analysis ready
Rust analysis unavailable: Cargo.toml not found
Rust analysis failed: rust-analyzer not found
Rust analysis limited: safe mode
```

### Security default is conservative

rust-analyzer assumes trusted code. Cargo metadata, build scripts, proc macros, project config, and toolchain config can cause code execution or executable overrides.

Default mode should be conservative:

- disable proc macros initially,
- avoid automatic build-script/check execution where practical,
- show limited-analysis status honestly,
- add a separate explicit trusted-workspace mode only if needed later.

Do not silently enable full trusted rust-analyzer behavior for arbitrary worktrees.

## Backend design

### New module

Add a dedicated backend module, likely:

```text
src/code.rs
```

This module owns:

- workspace discovery,
- path validation,
- file tree listing,
- file reads,
- binary/large-file classification,
- rust-analyzer lifecycle,
- LSP transport,
- LSP-to-Fura projection,
- cache invalidation.

Avoid making this a generic utility module or leaking responsibilities into `commands.rs` beyond dispatch.

### AppState addition

Add a code workspace registry to `AppState`, conceptually:

```rust
code_workspaces: Arc<RwLock<CodeWorkspaceRegistry>>
```

Conceptual internal types:

```rust
struct CodeWorkspaceRegistry {
    by_id: HashMap<String, CodeWorkspace>,
    by_root: HashMap<PathBuf, String>,
}

struct CodeWorkspace {
    workspace_id: String,
    root: PathBuf,
    analyzer: Option<AnalyzerHandle>,
    files: FileTreeCache,
    open_documents: HashMap<RelativePath, OpenDocument>,
    diagnostics: HashMap<RelativePath, Vec<CodeDiagnostic>>,
}

struct OpenDocument {
    path: RelativePath,
    version: u64,
    content_hash: String,
    text_len: usize,
}
```

Do not let the browser select arbitrary host paths. The browser may request a workspace for a session, but the bridge resolves and validates the root.

### Workspace identity

Prefer workspace identity by canonical repository/worktree root rather than by session id.

Reason: multiple sessions may point at the same repo/worktree. Reusing one analyzer per root avoids unnecessary rust-analyzer processes.

A simple v1 can still expose `workspaceId` as an opaque bridge-generated id.

## Protocol plan

Extend `src/protocol.rs` and `frontend/src/protocol.ts` with Fura-domain code browser messages.

### Client to bridge

```ts
| { type: "code.workspace.open"; sessionId: string }
| { type: "code.tree.list"; workspaceId: string; path?: string }
| { type: "code.file.open"; workspaceId: string; path: string }
| { type: "code.file.close"; workspaceId: string; path: string }
| { type: "code.symbols"; workspaceId: string; path: string }
| { type: "code.hover"; workspaceId: string; path: string; line: number; character: number; requestId: string }
| { type: "code.definition"; workspaceId: string; path: string; line: number; character: number; requestId: string }
| { type: "code.references"; workspaceId: string; path: string; line: number; character: number; requestId: string }
| { type: "code.diagnostics"; workspaceId: string; path?: string }
```

### Bridge to client

```ts
| { type: "code.workspace.ready"; workspace: CodeWorkspaceSummary }
| { type: "code.tree"; workspaceId: string; path: string; entries: CodeTreeEntry[] }
| { type: "code.file"; workspaceId: string; file: CodeFileContent }
| { type: "code.symbols"; workspaceId: string; path: string; symbols: CodeSymbol[] }
| { type: "code.hover"; workspaceId: string; requestId: string; path: string; contents?: string | null; range?: CodeRange | null }
| { type: "code.definition"; workspaceId: string; requestId: string; path: string; locations: CodeLocation[] }
| { type: "code.references"; workspaceId: string; requestId: string; path: string; locations: CodeLocation[] }
| { type: "code.diagnostics"; workspaceId: string; diagnostics: CodeDiagnostic[] }
| { type: "code.status"; workspaceId: string; status: "filesOnly" | "starting" | "indexing" | "ready" | "unavailable" | "error"; message?: string }
| { type: "code.error"; workspaceId?: string; path?: string; message: string }
```

Use domain-preserving DTOs. Do not forward arbitrary rust-analyzer payloads as the public contract.

## Implementation milestones

### Milestone 1: read-only filesystem browser — done in `e3a446c`

Deliverables:

- `code.workspace.open`,
- `code.tree.list`,
- `code.file.open`,
- desktop Code panel,
- syntax highlighting using existing frontend code/highlight.js patterns,
- no rust-analyzer dependency yet.

Backend behavior:

- resolve workspace root from session cwd/worktree,
- validate all paths stay inside root,
- reject path traversal,
- filter `.git`, `target`, `node_modules`, and other heavy generated directories,
- reject binary files truthfully,
- reject too-large files truthfully,
- sort tree entries consistently.

Frontend behavior:

- desktop-only Dockview panel named Code,
- file tree on the left,
- read-only viewer on the right,
- copy button for file contents,
- clear empty/error states.

Reason: this provides product value and validates UI shape before LSP complexity.

Implemented notes:

- `code.workspace.open`, `code.tree.list`, `code.file.open`, and `code.file.close` are wired through `ClientMessage`, `commands.rs`, and backend handlers.
- `code.workspace.ready`, `code.tree`, `code.file`, and `code.error` are emitted as domain DTOs, not raw filesystem or LSP payloads.
- The Code panel is added to Dockview with `renderer: "always"`, adjacent to Transcript.
- Viewer renders one active file and avoids editor semantics: no user mutation, save, or cursor protocol. (The bridge does send `didOpen`/`didChange` to keep the analyzer synced with on-disk content; the viewer itself stays read-only.)

### Milestone 2: rust-analyzer lifecycle and status — partially prepared, not implemented

Deliverables:

- discover `Cargo.toml` before launching rust-analyzer,
- launch rust-analyzer lazily per Rust workspace root,
- keep non-Rust workspaces in files-only mode,
- internal LSP stdio transport using `Content-Length`,
- `initialize` / `initialized`,
- conservative rust-analyzer configuration,
- `code.status` events including files-only/unavailable states,
- clean shutdown or idle timeout.

Behavior:

- one analyzer per workspace root where practical,
- truthful status if rust-analyzer binary is missing,
- truthful status if the process exits,
- no UI feature should hang indefinitely waiting for analyzer readiness,
- opening Code for a non-Rust workspace must not start rust-analyzer,
- opening Code must still allow file tree and read-only file viewing before analyzer readiness.

Prepared in `e3a446c`:

- `Cargo.toml` discovery exists in `src/code.rs`.
- Non-Rust workspaces remain usable in files-only mode.
- Workspace summaries include `rustRoot` and `status: "filesOnly"`.

Still pending:

- diagnostics and document symbols.
- request cancellation and analyzer idle shutdown.

(rust-analyzer process lifecycle, LSP stdio transport/init, analyzer status events, hover, go-to-definition, and find-references are implemented — see the "Active slice … DONE" section.)

### Active slice: lazy right-click navigation (go-to-definition + find-references + hover) — DONE

Prioritized slice on top of Milestone 2's lifecycle. Delivers right-click navigation — go-to-definition, find-references, and a hover "what is this" popup — and nothing else.

Shipped (as built):

- The analyzer lives in `src/code_lsp.rs` (`Analyzer`: rust-analyzer child + `Content-Length` LSP transport + request-id correlation + `experimental/serverStatus`-driven readiness). It is stored in `CodeWorkspaceRegistry.analyzers` keyed by canonical `rust_root` and shared via `Arc` — not on `CodeWorkspace`, which derives `Clone`. `src/code.rs` orchestrates (lazy get-or-spawn, DTO projection, broadcast).
- LSP wire shapes come from the `lsp-types` crate; `definition.linkSupport` is forced off so responses are `Location[]`. `file://` URIs are mapped to/from paths with a hand-written percent codec.
- The analyzer binary is configurable via `--rust-analyzer-bin` / `FURA_RUST_ANALYZER_BIN` (default `rust-analyzer`).
- Requests run in a background task; `code.status` and results are broadcast via the WS event coordinator. `ContentModified` (-32801) is retried with backoff so mid-index queries resolve instead of failing. Each `code.definition`/`code.references`/`code.hover` carries a client-generated `requestId` echoed on the response, so a client ignores superseded or other-client replies; navigation status/errors are reported via `code.status`.
- Verified by `src/code_lsp.rs` + `src/code.rs` tests (LSP framing, URI mapping, external classification, lazy gating, hover-content flattening, and a mock rust-analyzer driving the full def/refs/hover lifecycle) plus `frontend` vitest coverage (UTF-16 column mapping, right-click context menu, hover popup, references list, status strip, definition navigation, scroll preservation).

Backend:

- `Analyzer` owned by the registry (keyed by canonical `rust_root`, shared via `Arc`), owning the rust-analyzer child, the LSP stdio transport, request-id correlation, and readiness state. Not on `CodeWorkspace`, which derives `Clone`.
- Lazy start of the LSP session gated on all of: a discovered `rust_root` (re-checked from disk per request, not cached), an analysis request arriving, and the workspace being a Rust workspace. Never an LSP session on Fura startup, WebSocket connect, or session attach — the startup `--version` probe is a one-shot that does not start a session.
- `textDocument/didOpen` from on-disk content for any file a query targets, plus `didChange` (bumped version) when that file's content changed since it was last pushed (the viewer is read-only, but a session worktree's files change as the agent edits).
- `code.definition` → `textDocument/definition`; `code.references` → `textDocument/references` with `context.includeDeclaration: true`; `code.hover` → `textDocument/hover` (flattened to a single markdown string, empty → no hover).
- Project results into domain DTOs: map `file://` URIs back to workspace-relative paths; classify out-of-workspace targets as `external`. Never forward raw LSP locations.
- Minimal `code.status`: `starting` | `indexing` | `ready` | `unavailable` | `error`. References can block until indexing completes, so the UI must show progress rather than hang.
- Conservative analyzer config: proc-macros off, no automatic build-script/check execution, `checkOnSave` off.

Frontend:

- Map a **right-click** in the read-only viewer to an LSP position `{ line, character }` (LSP columns are UTF-16 code units — compute accordingly) and open a cursor-anchored context popup; left-click stays plain text selection. The popup is a floating overlay decoupled from the code-panel render, so opening it (or updating its hover) never rebuilds the scroll-bearing lines container.
- The popup shows hover ("what is this") via `code.hover` — rust-analyzer markdown rendered with the shared markdown renderer — plus actions Go to definition / Find references. It is dismissed on outside-click, Escape, scroll, or after an action.
- Go-to-definition: request `code.definition`; on a local result open the target file and scroll to the line (add scroll-to-line to the viewer); on `external` show a truthful, non-navigable label.
- Find-references: request `code.references`; render locations as a results list grouped by file; clicking an entry jumps to that file+line.
- The viewer preserves scroll position across same-file re-renders (status/references updates) so navigation never bounces the reader to the top; an explicit scroll-to-line still overrides.
- Surface `code.status` so the panel shows "analysis starting / indexing / unavailable" instead of appearing frozen; a failure status also resolves an open popup's pending hover.

Out of this slice: diagnostics, document symbols/outline, formatting, rename, code actions, semantic tokens, and mouse-hover (mouseover) tooltips. Milestone 3 (diagnostics, symbols) stays deferred until this slice ships.

Acceptance:

- Opening a non-Rust workspace never starts rust-analyzer; files-only browsing still works.
- Definition on a local symbol opens the right file at the right line.
- References returns the call sites across the workspace and each entry navigates correctly.
- Missing `rust-analyzer` binary or analyzer crash yields a truthful `code.status: "error"`, not a hang.

### Milestone 3: diagnostics and document symbols

Deliverables:

- `code.diagnostics`,
- diagnostics cache by file,
- diagnostics list/badges in the Code panel,
- `code.symbols`,
- outline for the current file.

Behavior:

- debounce diagnostics broadcasts,
- do not spam the full workspace to the browser,
- cache symbols by file version/content hash,
- stale symbols must be refreshed or rejected.

### Milestone 4: hover — DONE (shipped in the right-click navigation popup above)

Delivered:

- `code.hover` → `textDocument/hover`, flattened to a single markdown string and rendered truthfully in the right-click popup ("what is this"); empty hover shows "No type information".

External-target handling (shared with the active slice's definition/references):

```ts
{ kind: "external"; uri: string; label: string }
```

Out-of-workspace definition/reference targets are classified as external and shown as non-navigable labels. Do not expand v1 into browsing the full Cargo registry unless explicitly chosen later.

### Milestone 5: product integration polish

Deliverables:

- “Open in Code” from diff file paths — DONE (working-tree + review-commit paths; see status update above),
- “Open in Code” from relevant tool/read outputs,
- file-change invalidation,
- analyzer idle shutdown,
- possible trusted-workspace toggle decision.

This milestone should happen after the core panel is useful and stable.

## UI scope

Start desktop-only.

Do not add mobile support in v1. Mobile code browsing is a separate UX problem and should not block desktop value.

Place the feature as a Dockview panel/tab named **Code**, adjacent to the existing Transcript panel. It should not be a modal, overlay, or header-owned “editor” window.

Recommended Dockview shape:

```text
Dockview
├─ main group
│  ├─ Transcript
│  └─ Code
└─ side group
   ├─ Tools
   └─ Diffs
```

The panel activates lazily. Opening Code should immediately show filesystem browsing if a workspace is available; rust-analyzer status appears separately and must not block file viewing.

Initial Code panel layout:

```text
Code panel
├─ workspace/session indicator
├─ file tree
├─ read-only file viewer
└─ outline / diagnostics area
```

Avoid file tabs initially unless needed. A single active file is enough for v1.

A header button is optional later as a shortcut to activate the Code panel, but the primary UI affordance should be the Dockview tab.

## Test plan

### Backend tests

Path validation:

- normal relative path is accepted,
- `../` traversal is rejected,
- absolute path from client is rejected,
- symlink escape is rejected or explicitly handled by canonicalization,
- missing file reports not found.

File classification:

- text file opens,
- binary file is rejected,
- too-large file is rejected,
- UTF-8 handling is explicit.

Tree listing:

- `.git` hidden,
- `target` hidden,
- regular files/directories returned in stable order,
- large ignored directories do not explode response size.

LSP projection:

- workspace-relative path maps to `file://` URI,
- diagnostic URI maps back to workspace path,
- external URI is classified as external,
- malformed LSP response becomes a truthful `code.error`.

Lifecycle:

- missing rust-analyzer reports an error,
- analyzer exit updates status,
- requests while analyzer is unavailable return a truthful error.
- analyzer is not launched when `Cargo.toml` is absent,
- analyzer is not launched before Code/analysis activation,
- files-only mode remains usable without rust-analyzer.

### Frontend tests

- protocol type coverage for new messages,
- file tree rendering,
- open-file rendering,
- diagnostics rendering,
- outline rendering/click behavior,
- no mobile boundary regression if shared modules are introduced.

### Manual smoke

- launch Fura,
- open a Rust session/worktree,
- open Code panel,
- confirm file tree and file open work before rust-analyzer readiness,
- browse `src/main.rs`,
- open a file,
- see outline,
- see diagnostics/status,
- hover a symbol,
- go to a local definition,
- try a large/binary file and confirm UI does not freeze.

## Explicit non-goals

Do not implement in this plan:

- editing,
- save,
- completion,
- rename,
- code actions,
- formatting,
- inlay hints,
- semantic tokens,
- multi-language LSP abstraction,
- public raw LSP protocol,
- mobile code browser.

These are separate product decisions, not prerequisites for reviewing generated code.

## Main risks

1. Security: rust-analyzer/Cargo can execute workspace-controlled code in trusted modes.
2. Lifecycle: rust-analyzer can be heavy on large workspaces.
3. Stale cache: browser must not show old analysis as if fresh.
4. Scope creep: read-only browser can easily become a partial editor.

The implementation should preserve the product boundary: Fura helps inspect and navigate generated code; it does not become a full IDE.
