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

Open: `http://127.0.0.1:3737/`, then enter bridge token `dev` in the auth screen.

### Against a local OMP checkout

```bash
./run-local-omp.sh
```

Environment overrides for `run-local-omp.sh`:

| Variable | Default | Description |
|---|---|---|
| `OMP_REPO` | `~/repos/oh-my-pi` | Path to the OMP monorepo checkout |
| `BUN_BIN` | `~/.bun/bin/bun` | Path to the `bun` executable |
| `FURA_TOKEN` | `dev` | Bridge token entered in the browser auth screen |
| `FURA_BRIDGE_DEBUG_FILE` | `./bridge-debug.jsonl` | Raw RPC frame log (contains prompts — do not commit) |
| `FURA_SKIP_FRONTEND_BUILD` | `0` | Set to `1` to skip rebuilding the frontend |

### Against a local OMP checkout over Tailscale + HTTPS

```bash
./run-local-with-tailscale.sh
```

Defaults: keep local development on `http://127.0.0.1:3737/`, add a remote HTTPS listener on `https://serwer-mini.caracal-porgy.ts.net:4450/mobile.html`, and bind that remote listener to this machine's `tailscale ip -4`. The script expects matching TLS files at `./.cert/serwer-mini.caracal-porgy.ts.net.crt` and `.key` unless you override them. If `FURA_TOKEN` is unset, Fura generates a random bridge token and logs it at startup for you to copy into the phone auth screen.

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

Environment overrides for `run-mock-rpc.sh`:

| Variable | Default | Description |
|---|---|---|
| `FURA_TOKEN` | `dev` | Bridge token entered in the browser auth screen |
| `FURA_PORT` | `38737` | Listen port for mock smoke runs; intentionally avoids the normal `3737` dev port |
| `FURA_SKIP_FRONTEND_BUILD` | `0` | Set to `1` to skip rebuilding the frontend |

## Configuration

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
| `--bridge-debug-file` | `FURA_BRIDGE_DEBUG_FILE` | — | Dump raw RPC frames to JSONL file |

## Development

After non-trivial changes, run:

```bash
cargo fmt
cargo check
cargo test
npm --prefix frontend run build
```
