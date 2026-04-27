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

## Requirements

### Rust toolchain

Install via [rustup](https://rustup.rs):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Requires **Rust 2024 edition** — rustup stable ≥ 1.85 is sufficient.

### Node.js and npm

Required to build the frontend. Version 18+ recommended.

- Fedora/RHEL: `sudo dnf install nodejs`
- Ubuntu/Debian: `sudo apt install nodejs npm`
- Or via [nvm](https://github.com/nvm-sh/nvm)

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

The bridge spawns `omp --mode rpc` by default. Install OMP and ensure `omp` is on your `PATH`,
or point `--rpc-program` at a custom script (see below).

### Bun (for local OMP development)

Required only when using `run-local-omp.sh` against a local OMP checkout.

```bash
curl -fsSL https://bun.sh/install | bash
```

## Building

```bash
# Build the frontend
npm --prefix frontend install
npm --prefix frontend run build

# Build and run the bridge
cargo build
```

## Running

### Against installed `omp`

```bash
FURA_TOKEN=dev cargo run -- --static-dir frontend/dist
```

Open: `http://127.0.0.1:3737/?token=dev`

### Against a local OMP checkout

```bash
./run-local-omp.sh
```

Environment overrides for `run-local-omp.sh`:

| Variable | Default | Description |
|---|---|---|
| `OMP_REPO` | `~/repos/oh-my-pi` | Path to the OMP monorepo checkout |
| `BUN_BIN` | `~/.bun/bin/bun` | Path to the `bun` executable |
| `FURA_TOKEN` | `dev` | Auth token for the WebSocket endpoint |
| `FURA_BRIDGE_DEBUG_FILE` | `./bridge-debug.jsonl` | Raw RPC frame log (contains prompts — do not commit) |
| `FURA_SKIP_FRONTEND_BUILD` | `0` | Set to `1` to skip rebuilding the frontend |

### Mock RPC (no OMP required)

```bash
npm --prefix frontend run build
FURA_TOKEN=dev cargo run -- \
  --static-dir frontend/dist \
  --rpc-program node \
  --no-default-rpc-args \
  --rpc-arg fixtures/mock-omp-rpc.mjs
```

## Configuration

All flags can also be set via environment variables:

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--host` | — | `127.0.0.1` | Bind address |
| `--port` | — | `3737` | Listen port |
| `--token` | `FURA_TOKEN` | random UUID (logged) | Auth token |
| `--static-dir` | — | `frontend/dist` | Frontend static files |
| `--rpc-program` | `FURA_RPC_PROGRAM` | `omp` | RPC child executable |
| `--rpc-arg` | `FURA_RPC_ARGS` | — | Extra args for RPC child (repeatable) |
| `--no-default-rpc-args` | `FURA_NO_DEFAULT_RPC_ARGS` | false | Omit `--mode rpc` default args |
| `--session-root` | `FURA_SESSION_ROOT` | `~/.omp/agent/sessions` | OMP session directory |
| `--log-frames` | `FURA_LOG_FRAMES` | false | Log raw RPC frames to stdout |
| `--bridge-debug-file` | `FURA_BRIDGE_DEBUG_FILE` | — | Dump raw RPC frames to JSONL file |

## Development

After non-trivial changes, run:

```bash
cargo fmt
cargo check
cargo test
npm --prefix frontend run build
```
