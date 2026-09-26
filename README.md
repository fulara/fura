# Fura

Standalone browser bridge for [Oh My Pi](https://github.com/your-org/oh-my-pi) sessions.
Fura supervises `omp --mode rpc` child processes over stdio, exposes a local WebSocket API,
and serves a plain browser frontend. Sessions survive frontend disconnects and browser refreshes.

## Architecture

```
Browser  ←→  Fura (Rust/Axum)  ←→  omp --mode rpc (child process, stdio JSONL)
```

- **Bridge**: Rust binary (`src/main.rs`) — HTTP + WebSocket server, child process supervision, session projection.
- **Frontend**: Plain TypeScript + Vite (`frontend/`) — no framework; DOM-only rendering.

The desktop uses a compact session list, shared tab-header actions and a resizable
prompt composer. Git review keeps repository context and navigation above the patch;
full commit metadata expands on demand. The **⋯ / Review options** menu contains
repository management, **Open diff…**, and **Advanced Compare**. Touch/pointer-coarse controls retain
larger targets; the separate mobile layout is unchanged.

Manual `/compact` uses OMP's builtin parser, including its compaction modes.
Its RPC acknowledgement accepts background work; it does not signal completion.
Fura keeps the composer locked until authoritative state reports that compaction
has ended, refreshing after command output or cancellation. Success and failure
restore controls without a browser reload; output text is not parsed as lifecycle state.

Queued Steer and Follow-up prompts keep a `sending` marker until OMP accepts that
exact submission into the conversation. This is optimistic transcript state, not
an OMP queue listing. Fura reconciles by `clientMessageId`, including skill expansion
and history refresh; an RPC acknowledgement or queue count alone does not clear it.

## Session activity and saved summary

Desktop Transcript and mobile show a collapsible **Activity** strip above the
scrolling conversation. It lists the selected session's registered background
jobs, subagents and services, with bounded recent history and read-only output.
Background activity is separate from agent Busy: a ready service can outlive a
turn. Disconnection marks cached state stale instead of claiming work completed.
There are no process stop/restart controls in this strip.

**Summary**, next to the session title, reads OMP's latest persisted idle recap,
including its creation time and freshness. Opening it or reconnecting never
requests inference. Generation is automatic in `rpc-ui`, using OMP's existing
recap settings and current model; the default idle delay is 240 seconds. This
background generation can incur model usage even if Summary remains closed.
Disable it with OMP's `recap.enabled: false` or `--no-recap`; saved recaps remain
readable. Fura's hidden control/model-catalog hosts always use `--no-recap`.
See [the UI contract](spec/ui-preferences.md#session-activity-and-saved-summary).

## Skills

User-invoked `/skill:name` prompts appear as compact user cards, separate from
assistant answers. The original command and effective expanded content have
separate copy actions; expansion is explicit and attached images remain visible.
Prompt-history recall uses known original input, not reconstructed skill bodies.
Review retains the full effective content. Hidden autoload messages stay hidden.

Saved-session replay restores skill messages from the active journal ancestry,
including persisted images in OMP's blob store, without merging unrelated branches.
The live transcript still follows OMP's current context; saved ancestry is not a
separate archive endpoint.

Desktop **Skills** configures an independent, durable selection for the live session.
Search and checkboxes edit a staged set; **Apply** commits the complete set and
**Cancel** changes nothing. Neither action sends a prompt or executes a skill task.
The selector leaves the composer draft, images and snippets alone.

Selected definitions are pinned snapshots. They survive compaction and reopening;
forks inherit the selection at their branch point and rewind restores that point's
selection. Changed or missing source files do not silently replace pinned guidance:
Apply explicitly refreshes selected definitions, and missing selections can be removed.
Conflicting or uncertain results require **Reload** before another Apply.

The UI separates the confirmed selection from the snapshot active in an in-flight
request. Apply during work affects the next main request preparation, not the
request already sent. BTW captures its own selection without contaminating the
main conversation. Guidance is user-level context, not enforced model output;
referenced scripts and other resources are not pinned. This selector is desktop-only.

## Git changes

The Git changes panel separates **Current changes** (unstaged, staged and nonignored
untracked files) from **History**. History lists recent commits without typing refs,
supports older pages and first-parent review, and preserves comments/questions by repository
and exact version. Repository, branch and HEAD remain visible.

Both views retain file filtering, lazy patches, statistics and wider context without
staging files or creating Git objects/refs. Historical files open directly from immutable
blobs, without checkout. **Advanced Compare** remains separate and inherits the selected
repository. See [the diff contract](spec/diff-and-snapshots.md) for read limits and Git-helper policy.

**⋯ / Review options → Open diff…** browses files on the **Fura server**, not the
browser computer. The dialog remembers the last successful directory in this
browser across reloads. Choose a `.diff`/`.patch` file or type a server file path;
UTF-8 Git and unified patches open read-only in Unified or Side by side layout.
Nothing is applied. **Close file** returns to Git review. Files are limited to
2 MiB and 20,000 lines, with an additional expanded-rendering safety limit.

In a historical file's context menu, **View committed file** keeps the existing modal;
**View this revision in Code** opens the full revision in Fura's read-only Code panel.
Repository, path and SHA remain explicit. **Back to working-tree Code** restores ordinary
browsing; historical content never becomes a working file.

Repositories come from the session cwd/worktree, declared additional directories,
initialized submodules and supported tool-path metadata. Add, Hide selected and
Set default persist per session. Discovery is best-effort; repository changes are
not attributed exclusively to the selected session.

OMP repository snapshot creation and the Snapshot now flow are removed. Existing
snapshot refs/session entries remain untouched; inline tool diffs and OMP's
independent context/editor checkpoint mechanisms remain. See the
[Git diff specification](spec/diff-and-snapshots.md).

## Requirements

### Rust toolchain

Install via [rustup](https://rustup.rs):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Requires **Rust 2024 edition** — rustup stable ≥ 1.85 is sufficient.

### Node.js and npm (optional)

The manual frontend workflow supports Node.js 18+ and npm. `setup.sh` uses npm
when available and otherwise builds the frontend with Bun, so Node.js is not
required for bootstrap.

### System libraries (Linux only)

The GUI binary (`src/bin/gui.rs`) depends on WebKitGTK. These packages are needed to compile:

**Fedora / RHEL / CentOS:**
```bash
sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel
```

**Ubuntu / Debian:**
```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev
```

These are only required for the native window binary. The default bridge binary (`fura`) has no such requirement.

### Oh My Pi

The bridge spawns an installed `omp --mode rpc-ui` by default. The local development
launchers use the `vendor/oh-my-pi` submodule, pinned to Fura's compatible OMP commit
and configured to track the `fork-stuff` branch.
Prompt consumption tracking requires the pinned fork's `clientMessageId` extension;
update the bridge and its pinned OMP together rather than mixing it with an older RPC runtime.

### Bun

Required by `setup.sh` and the bundled OMP checkout.

```bash
curl -fsSL https://bun.sh/install | bash
```

## Setup

After cloning, run the idempotent bootstrap:

```bash
git clone git@github.com:fulara/fura.git
cd fura
./setup.sh
```

`setup.sh` initializes the pinned OMP submodule, creates `.env` with local defaults
when needed, installs OMP and frontend dependencies, builds the OMP native addon,
checks RPC contract parity, builds the frontend, and builds the Fura release binary.
Existing `.env` values are preserved. Machine-specific Tailscale/TLS settings remain
an explicit local configuration.

## Building

```bash
# Build the frontend
npm --prefix frontend ci
npm --prefix frontend run build

# Build and run the bridge
cargo build
```

## Running

### Against installed `omp`

```bash
FURA_TOKEN=dev cargo run -- --static-dir frontend/dist
```

Open: `http://127.0.0.1:3737/`, then enter bridge token `dev` in the auth screen.

### Against the bundled OMP fork

```bash
./run-local-omp.sh
```

`vendor/oh-my-pi` is the only OMP checkout used by the local launchers. To advance
the pinned commit to the latest `fork-stuff` revision and check contract parity:

```bash
git submodule update --remote vendor/oh-my-pi
(
  cd vendor/oh-my-pi
  bun install --frozen-lockfile
  env -u CARGO -u RUSTUP_TOOLCHAIN RUSTC_WRAPPER= bun run build:native
)
bun scripts/check-omp-rpc-contract.ts
```

Native addons stay loaded for each process's lifetime. Refreshing shared sources
without restarting does not deploy the new runtime: newly loaded workers may
refuse an older addon. Build a matching addon and restart only during an explicit
deployment, never as part of refresh verification.

The current fork tracks OMP 18.3.2 through the pinned upstream `7853b4e499`.
The launcher preflight exercises the current `*** Edit File` / `*** Find` /
`*** Replace` parser before starting a bridge, so a same-version stale addon
cannot pass on its version string alone.

The fork uses upstream's typed settings registry, canonical internal-URL router,
and ticket-based RPC prompt completion. Fura's durable `clientMessageId`, skill
attachments, session-scoped guidance, BTW isolation, activity and persisted recaps
remain separate contracts. Stream `messageId` and `session_settled` do not replace
submission identity or redefine the bridge's Busy state.

Private verification installs that use `bun install --ignore-scripts` must also
run `bun run gen:tool-views` in their isolated OMP copy; the generated HTML-export
runtime is required even for CLI/RPC startup. Retain its measured bytes with the
source/build evidence, rather than copying an unverified generated file from live.

Shell and PTY cleanup require spawn-pinned process identities; a discovered PID,
foreground group, or registry group number alone never authorizes a signal.
Pinned descendants survive TERM-to-KILL escalation, and Eval shutdown retains
unconfirmed workers across retries even after the kernel itself exits. PTY
cancellation escalates for children that ignore TERM/HUP without reverting to
raw `Child::kill()` calls. Refresh verification uses private builds and owned
test groups, then checks a real assistant response and reconnect before push;
publication does not restart or deploy the live instance.

Desktop Fura exposes one-shot BTW through
**Ask on the side** and closeable internal Transcript tabs, with a permanent
Conversation tab while side results exist. Questions use the main-context snapshot
captured at start; results remain only in browser memory. Upstream TUI BTW history
and follow-ups do not enable continuing side conversations in Fura; that requires
a richer backend contract, not an OMP upgrade alone. See
[Transcript side questions](spec/transcript-btw.md) for ownership, draft, cleanup,
and reconnect behavior. The integration preserves both snapshot and
structured-history support in OMP's side-turn pipeline.

The fork preserves Fura's BTW transition cleanup alongside upstream's separate
session-generation and outer-transition barriers. Pending prompts cannot cross a
committed fork/branch, while cancelled transitions retain the source context.
Upstream Collab auto-hosting applies to interactive OMP sessions, not Fura's
`rpc-ui` children; refreshing the submodule does not enable a second access channel.

OMP 18.2.0 preserves the typed skill prompt input through RPC; Fura's client
message identity remains attached through skill expansion and queued consumption.
The fork still needs its process-identity/ancestor protection, kernel cleanup,
BTW lifecycle and explicit headless-shell profile patches: upstream's fail-closed
Eval startup and Chrome-only managed installer address different concerns.
Upstream model-substitution warnings and skill chips are TUI features, not
automatically enabled Fura UI.

Fura surfaces OMP persistence `notice` errors through existing session notices
(or the originating Ask Fura controller status), rather than silently dropping
them. `/delete` remains TUI-only; use Fura's existing deletion controls.
RPC plan approval suppresses compact's automatic continuation because approval
dispatches its own execution turn. Prompt correlation and upstream user/agent
attribution are preserved together. The fork also retains P2 skill ancestry
validation and user-invoked skill attachment resolution.

OMP 18.2.3 resolves configured authentication headers asynchronously at request
time; Fura still consumes model metadata, not credentials. Secret login prompts
remain terminal-only. Exact `^provider/model` mentions are interpreted by OMP
and keep Fura's `clientMessageId` through expansion and persistence; this refresh
does not add model-mention autocomplete or chips to Fura. The branch-local mention
registry stays synchronized on resume, failed-switch rollback and fork alongside
Fura's BTW transition barrier. Upstream's complete macOS PID enumeration and
cancelled-job retention complement, rather than replace, the fork's pinned
process ownership and kernel cleanup.

OMP 18.2.5 moves shared terminal and domain types into `@oh-my-pi/pi-tui`.
The fork imports those canonical types directly while preserving Fura's RPC
payloads, client prompt identity, session skills and BTW transition barriers.
Session events now reach subscribers independently of extension-hook completion;
Fura still waits for authoritative terminal state rather than inferring completion
from individual messages. The new per-session token-rate meter is preserved across
fork transitions, but RPC's existing `tokensPerSecond` calculation is unchanged.

Terminal livestreaming (`omp stream`) and the smoothed live token-rate display
are not enabled in Fura. Upstream's automatic web-search order now prefers
keyless Parallel over Perplexity; existing explicit search settings still apply.
Typed judgments may fall back to configured online models. This refresh does not
change model/provider settings, credentials, or enable a new sharing endpoint.

OMP 18.2.6 stabilizes Anthropic's prompt-cache head across memory-recall refreshes
and removes the redundant current-time stamp from recall blocks. These changes
apply inside OMP without changing Fura's RPC contract or model/provider settings.
Concurrent clipboard image/text reads fix terminal paste stalls; Fura keeps its
browser-native clipboard path. All local RPC, session-skill, BTW and process
ownership patches remain necessary; this update does not enable new UI features.
The 18.2.6 native-addon version sentinel requires a matching isolated native build
for verification and a matching production build at the next explicit deployment.

The post-18.2.6 update replaces Sloppy Edit's XML payload with `*** SM:EDIT`,
`*** SM:FIND` and `*** SM:PUT` headers, without changing the package version.
Both local launchers therefore inspect a synthetic header payload before building
Fura; a stale same-version addon fails closed. This probe never reads or writes
the named file. A version sentinel alone is not proof of parser compatibility.
Existing processes retain their already-loaded addon until explicit deployment.

Upstream also removes the Bash tool's separate `env` parameter; extensions must
use the current tool contract rather than replaying that field. Empty-session
filtering affects OMP's picker and automatic continue, not explicit file resume
or Fura's independent session catalog. No session files are deleted by that
filter. Browser relay target discovery and model-discovery routing improvements
stay inside OMP; this update adds no sharing endpoint, provider setting or UI.

The 18.2.7–18.2.8 refresh keeps Fura's RPC contract and all local lifecycle,
prompt-correlation, session-skill and BTW patches. Semantic `find` is a new tool,
not the old `glob` alias; it remains disabled by default and can send source
excerpts to the configured judge when enabled. No search, model-role or provider
settings are changed by this refresh. The chat model selector still receives
OMP's chat-only catalog, not image, speech, judge or video models.

Agent-side integrations should use `await judge(...)` for direct answers or
`judge_batch(...)` / `judgeBatch(...)` for batches; `JudgmentHandle` is removed.
`agent://` slash segments now select JSON paths; nested agents use dotted names
and the former `?q=` selector is no longer supported. These changes do not alter
Fura's WebSocket DTOs. Background completions now wake interruptible waits.

OMP also adds system-prompt templates, browser diagnostics and specialist model
roles. Fura does not replace session skills with templates, expose gateway
endpoints, or enable new UI controls. Its browser Mermaid/SVG renderer remains
independent of OMP's new native terminal renderer. A matching native addon is
required at the next explicit deployment; verification builds stay private.

The 18.2.9–18.2.10 refresh preserves Fura's local RPC, BTW, session-skill,
prompt-correlation and process-ownership extensions. Upstream's new `get_entries`,
`get_tree` and `get_available_thinking_levels` commands are additive; Fura keeps
its existing active-branch projection. Frozen skill hints and cancellable prompt
setup remain separate from Fura's persistent session-skill selection.

Upstream now defaults `find.enabled` to `auto`: an explicitly configured boolean
is migrated to `on`/`off`, while an unset value can enable semantic search when
the judge role resolves to a native System One/TypeSafe API. Here “native” does
not mean local or offline. Using that tool can send source excerpts to the judge.
New `ttsr.judge=auto` can likewise evaluate matching `question` rules remotely.
The refresh does not edit model/provider settings, credentials, or rules; unchanged
configuration is not a guarantee of unchanged upstream defaults. Provider defaults,
fallbacks and the SingularityAPI provider-ID migration need review at deployment.

Eval gains explicit `%load` and `%bun add` commands; managed JavaScript installs
disable lifecycle scripts and do not run merely because OMP starts. Skillshare
management and terminal `/record`/`omp clip` remain upstream capabilities, not
new Fura controls. Recording is local; `omp clip` explicitly publishes a public
clip, so neither command is an automatic Fura export or sharing workflow.
Verification uses private builds and copied credentials; publishing this refresh
does not restart Fura or replace its active binary, frontend, or native addon.

Environment overrides for `run-local-omp.sh`:

| Variable | Default | Description |
|---|---|---|
| `BUN_BIN` | detected `bun` | Path to the `bun` executable |
| `FURA_TOKEN` | generated by `setup.sh` | Bridge token entered in the browser auth screen |
| `FURA_BRIDGE_DEBUG_FILE` | `./bridge-debug.jsonl` | Bridge debug JSONL log (raw RPC frames plus WebSocket traffic summaries; contains prompts and other sensitive data — do not commit) |
| `FURA_EVENT_DEBUG_FILE` | `./fura-events.jsonl` | Compact bridge event log with large text fields truncated |
| `FURA_SKIP_FRONTEND_BUILD` | `0` | Set to `1` to skip rebuilding the frontend |

### Against the bundled OMP fork over Tailscale + HTTPS

```bash
./run-local-with-tailscale.sh
```

Defaults: keep local development on `http://127.0.0.1:3737/`, add a remote HTTPS listener on `https://serwer-mini.caracal-porgy.ts.net:4450/mobile.html`, and bind that remote listener to this machine's `tailscale ip -4`. The script expects matching TLS files at `./.cert/serwer-mini.caracal-porgy.ts.net.crt` and `.key` unless you override them. Fura refuses to start the remote listener if that certificate is expired or has less than 5 days of validity remaining.

Override the remote host, TLS file paths, or token explicitly if needed:


```bash
FURA_TOKEN=<explicit-token> \
FURA_REMOTE_HOST=<machine>.<tailnet>.ts.net \
FURA_TLS_CERT=/path/to/<machine>.<tailnet>.ts.net.crt \
FURA_TLS_KEY=/path/to/<machine>.<tailnet>.ts.net.key \
./run-local-with-tailscale.sh
```


### Mock RPC (no OMP required)

```bash
./run-mock-rpc.sh
```

Open: `http://127.0.0.1:38737/`, then enter bridge token `dev` in the auth screen.

The mock launcher requires Python 3 on POSIX. It does not load `.env` or inherit
`FURA_*` configuration or the caller's `PI_*` session paths and tool-bridge
capabilities. Set `FURA_SMOKE_PORT` to override the default port (`38737`);
authentication is always the mock-only token `dev`.

Each run builds the frontend and bridge into a private temporary directory and
uses its own home, session store, XDG directories, process group and session.
An occupied port fails startup; an existing server is never reused. Cleanup
checks the retained supervisor identity and ownership record before signalling
its group. If ownership cannot be verified, it refuses cleanup and leaves the
temporary directory and ownership record for inspection. Successful cleanup
also retains nonsecret `process.json`, `exit.json` (when the command exited),
and `cleanup.json`; the mock launcher prints their directory while deleting
private workload data and build outputs.
The supervisor inherits blocked cleanup signals until its handlers are installed,
and a pipe handoff prevents workload execution before ownership is established.
Failed handoffs close the pipe and let the supervisor exit without signaling.
Observed descendants that escape the owned group are reported in `cleanup.json`,
never targeted by PID discovery. Cleanup stops the verified group, then fails
while observed survivors remain; repeated cleanup cannot silently forget them.
This is process-group ownership, not OS containment: polling cannot prove the
absence of an unobserved fast double-fork/`setsid` escape. In particular, real OMP
eval kernels and launched daemons can create separate sessions. Use a disposable
container/VM for arbitrary detaching workloads rather than treating group cleanup
as proof that every descendant is gone.
The BTW and session-recency browser gates handle TERM/INT/HUP and protect their
ownership handoffs. Final cleanup ignores further interrupts, so repeated
signals cannot skip cleanup or its completion evidence. Their regressions use
disposable servers, workers and protected sentinels only.
If startup fails after spawning but before ownership is established, the
launcher also retains the temporary directory and reports its path. Inspect
these resources manually; a PID record alone never authorizes termination.


```bash
FURA_SMOKE_PORT=38888 ./run-mock-rpc.sh
npm --prefix frontend run smoke
python3 -m unittest scripts/test_smoke_process.py -v
python3 -m unittest scripts/test_native_preflight.py -v
```

The general Playwright config excludes the dedicated BTW and recency suites:
their separate configs and launchers require different tokens and seeded sessions.
Do not run them against the general mock server. For OMP browser tests on a host
where full Chrome stops rendering background frames, use an installed
`chrome-headless-shell` through `PUPPETEER_EXECUTABLE_PATH`; keep headful window
tests separate. The fork normalizes headless-shell profiles like Chromium so
explicit test profiles cannot silently fall back to a shared default profile.

Use this launcher for mock smoke tests, not a production restart helper. For
other isolated commands, `scripts/smoke_process.py --state-dir <private-dir>
--timeout <seconds> -- <command>` provides the same process-group ownership
guard; callers must separately supply private data/configuration directories.

For real-OMP maintenance smoke, use a private bridge target, frontend output,
OMP dependency/native build, home and agent directory. Snapshot SQLite
credentials with the online backup API rather than copying a live database
without its WAL. Preserve the configured model/provider and never reuse the
production session store or an occupied test port.
Remove inherited `FURA_*` listener/TLS settings as well; tool environment overrides
may merge with the parent's environment rather than replace it. Construct the
child's complete environment at the launcher boundary, then add only private
test settings.
Also remove inherited OMP session/profile and tool-bridge environment before
starting the real smoke workload; changing `HOME` alone does not override
`PI_CODING_AGENT_DIR`. For browser reconnect, reload the authenticated tab
(which retains its sessionStorage token), or authenticate a new tab explicitly.
Confirm the same session ID, the assistant message and settled state over RPC.
Stopping a session leaves its composer editable; verify the `exited` session
status rather than expecting a disabled textarea.

Build the native addon from the tested fork, not just an upstream release:
the local lifecycle guards require `Process.identity()` as well as the matching
version sentinel. A source rebase does not update the addon already loaded by
running agents. Test the matched source/addon pair beside the live service;
publication is not deployment and does not restart existing sessions.

Both real launchers reject addons without the fork's `Process.identity` method
before building or starting Fura. The OMP process broker also refuses such an
addon before spawning any child; an upstream version sentinel alone is not
enough to establish compatibility with the fork.
These guards do not replace an addon already loaded by a running agent or
broker. If supervised launch reports a missing identity method, do not retry
through a production restart helper: use the isolated, finite smoke harness
with the matched addon and leave live processes untouched.
The native-preflight regression requires Bun on `PATH` or in `BUN_BIN`.

## Configuration

Voice transcription uses OpenAI Realtime transcription, but it intentionally reads only `FURA_VOICE_OPENAI_API_KEY`. It does not read the global `OPENAI_API_KEY`, so voice billing must be wired to a Fura-specific key/account.

All flags can also be set via environment variables:

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--bind` | `FURA_BIND` | `127.0.0.1:3737` | Local HTTP bind address used for laptop development |
| `--remote-bind` | `FURA_REMOTE_BIND` | — | Optional remote HTTPS bind address, typically a Tailscale IP plus phone port |
| `--remote-host` | `FURA_REMOTE_HOST` | — | Public HTTPS host name used by remote browsers; must match the TLS certificate host name |
| `--allowed-origin` | `FURA_ALLOWED_ORIGINS` | — | Additional exact remote HTTPS origins allowed for the remote listener |
| `--tls-cert` | `FURA_TLS_CERT` | — | PEM certificate file for the remote HTTPS listener |
| `--tls-key` | `FURA_TLS_KEY` | — | PEM private key file for the remote HTTPS listener |
| `--token` | `FURA_TOKEN` | random UUID (logged separately when generated) | Bridge token entered in the browser auth screen |
| `--static-dir` | — | `frontend/dist` | Frontend static files |
| `--rpc-program` | `FURA_RPC_PROGRAM` | `omp` | RPC child executable |
| `--rpc-arg` | `FURA_RPC_ARGS` | — | Extra args for RPC child (repeatable) |
| `--no-default-rpc-args` | `FURA_NO_DEFAULT_RPC_ARGS` | false | Omit `--mode rpc` default args |
| `--session-root` | `FURA_SESSION_ROOT` | `~/.omp/agent/sessions` | OMP session directory |
| `--log-frames` | `FURA_LOG_FRAMES` | false | Log raw RPC frames to stdout |
| `--bridge-debug-file` | `FURA_BRIDGE_DEBUG_FILE` | — | Dump bridge debug JSONL records (raw RPC frames plus WebSocket traffic summaries) |
| `--event-debug-file` | `FURA_EVENT_DEBUG_FILE` | — | Dump compact bridge events to JSONL with large text fields truncated |

## Development

After non-trivial changes, run:

```bash
cargo fmt
cargo check
cargo test
npm --prefix frontend run build
```
