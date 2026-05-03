# Fura Mobile Auth Cleanup Plan

## Goal

Make Fura safe and understandable for desktop + mobile browser use over localhost or Tailscale by removing bridge tokens from URLs, keeping the existing cookie-backed WebSocket model, and tightening startup output/tests.

## Current Repo State

Observed in `fura-tailgate` after the auth hardening slice:

- Backend has `POST /auth/session` and an HttpOnly `fura_session` cookie in `src/web.rs`.
- WebSocket URL construction uses `/ws` without query tokens in `frontend/src/connection.ts`.
- WebSocket auth is cookie-based: `src/web.rs::ws_handler` requires a valid `fura_session` cookie before upgrade.
- Mobile UI exists as a separate frontend mode (`frontend/mobile.html`, `frontend/src/mobileApp.ts`, `frontend/src/mobile.css`).
- Token-in-URL bootstrap has been removed from desktop, mobile, native GUI URL construction, and README run docs.
- Opening an old URL containing `?token=...` strips the query parameter without using or storing it.
- The frontend stores manually entered bridge tokens in `sessionStorage` by default, not `localStorage`.
- Startup logging no longer emits configured tokens or URL query tokens; generated tokens are printed separately as a local terminal secret.
- WebSocket handshakes now require an exact allowed `Origin` before cookie authentication.
- Client text WebSocket frames are capped at 32 MiB and oversized frames close with WebSocket close code 1009.

## Decisions

- Keep the existing `POST /auth/session` -> HttpOnly cookie -> `/ws` architecture.
- Do not implement a separate WebSocket `auth.authenticate` handshake in this pass; it would replace a working cookie-session boundary without clear benefit.
- Remove URL tokens as a supported bootstrap mechanism.
- Default token storage in the frontend to `sessionStorage` only.
- Do not add “remember this device” in the first implementation slice. If added later, it means an explicit checkbox that stores the bridge token in `localStorage`, so the same browser can re-authenticate after a restart without typing the token again.
- Startup logs must not echo configured tokens. Generated tokens may be printed separately once because otherwise the user has no way to know the random token.
- Fura still does not install or manage Tailscale. Tailscale is the private network path; Fura remains the app served over that path.
- Target mobile-over-internet usage should use Tailscale plus browser-visible HTTPS. Plain HTTP remains acceptable for localhost and intentionally trusted local development paths.
- Public internet exposure without Tailscale remains a non-goal.

## Terminology

### `sessionStorage`

Browser storage scoped to the current tab/session. For this feature it means:

- after the user types the bridge token, the frontend can retry/reload in that tab without asking again immediately;
- the token is not kept as a long-term browser preference;
- closing the tab/browser session clears it in normal browser behavior.

This is safer than `localStorage` because it avoids leaving the bridge token on the phone/browser indefinitely.

### “Remember this device”

Not currently implemented in this first slice. If added later, it should be a visible checkbox on the token entry screen:

```text
[ ] Remember this device
```

If checked, Fura would store the bridge token in `localStorage`, which persists across browser restarts. That is more convenient but less safe on shared/lost devices. If unchecked, use `sessionStorage` only.

## Phase 1: Remove Token-in-URL Bootstrap (implemented)

### Frontend behavior

Change bootstrap/auth flow so that:

- opening `/?token=secret` or `/mobile.html?token=secret` removes `token` from the address bar;
- the URL token is not used for authentication;
- the URL token is not written to `sessionStorage` or `localStorage`;
- if a token exists in `sessionStorage`, the app may use it to call `POST /auth/session`;
- if no token exists, show a token entry gate instead of rendering session data;
- after successful `POST /auth/session`, connect to `/ws` with the cookie session;
- after failed `POST /auth/session`, clear the attempted session token and show a precise invalid-token message without infinite retry.

### Files expected to change

- `frontend/src/bootstrapAuth.ts`
- `frontend/src/bootstrapAuth.test.ts`
- `frontend/src/connection.ts` only if its API needs to support the auth gate more cleanly
- `frontend/src/connection.test.ts` if connection expectations change
- `frontend/src/main.ts`
- `frontend/src/mobileApp.ts`
- `frontend/src/mobileApp.test.ts`
- desktop/mobile CSS files if the token gate needs styling

### Acceptance criteria

- `/?token=secret` does not authenticate.
- `/mobile.html?token=secret` does not authenticate.
- token query parameter is removed from the address bar.
- no bridge token is written to `localStorage` by default.
- valid manually-entered token authenticates and renders the app.
- invalid manually-entered token shows an auth error and does not render sessions.

## Phase 2: Remove Token from Native GUI URL and Startup Output (implemented)

### Native GUI

Update `src/bin/gui.rs` so the opened URL does not contain `?token=...`.

The native GUI must either:

- rely on the same token-entry/auth gate as browser clients, or
- intentionally establish auth through another explicit mechanism if native UX requires it later.

For this slice, use the same browser-auth gate unless a current native-client constraint proves otherwise.

### Startup logging

Change startup output so URLs never include the token and tracing fields do not contain the token.

Required behavior:

- local URL printed/logged without token;
- configured token from `FURA_TOKEN` / `--token` is not echoed;
- generated token is printed separately once with a warning that it is a secret;
- non-loopback bind warning remains;
- `0.0.0.0` bind should warn more strongly if/when Tailscale launch flags are added.

### Files expected to change

- `src/main.rs`
- `src/bin/gui.rs`
- Rust tests near existing `main.rs` / `web.rs` tests

### Acceptance criteria

- startup URL output does not contain `?token=`.
- structured tracing field named `token` does not contain the secret.
- generated token can still be found by the local terminal user.
- supplied token is not echoed.

## Phase 3: Update Tests (implemented for auth cleanup)

### Frontend tests

Update/add tests for:

- token query stripping without token reuse;
- `sessionStorage` token use;
- no default `localStorage` persistence;
- invalid token failure state;
- mobile app no longer assuming `?token=dev` in its harness.

### Rust tests

Update/add tests for:

- `/ws?token=valid` does not bypass cookie auth;
- unauthenticated `/ws` is rejected before session data can be sent;
- valid `POST /auth/session` still creates HttpOnly `fura_session` cookie;
- startup/log helper output does not put token in URLs.

### Observed commands after implementation

```bash
cargo fmt
cargo check
cargo test
npm --prefix frontend test
npm --prefix frontend run build
```

## Phase 4: WebSocket Origin and Size Hardening (implemented)

Implemented behavior:

- default allowed browser origins are `http://127.0.0.1:<port>` and `http://localhost:<port>`;
- `--allowed-origin` / `FURA_ALLOWED_ORIGINS` adds exact allowed origins for Tailscale/HTTPS deployments;
- missing, invalid, or unlisted `Origin` is rejected before cookie authentication;
- no wildcard or substring origin matching;
- text WebSocket frames larger than 32 MiB are rejected with close code 1009;
- oversized payloads are not echoed in logs or error responses.

Observed commands after implementation:

```bash
cargo fmt
cargo check
cargo test
```


## Phase 5: Dual Local/Remote Listener Model (implemented)

Implemented contract:

```bash
fura \
  --bind 127.0.0.1:3737 \
  --remote-bind <tailscale-ip>:4450 \
  --remote-host <machine>.<tailnet>.ts.net \
  --tls-cert /path/to/<machine>.<tailnet>.ts.net.crt \
  --tls-key /path/to/<machine>.<tailnet>.ts.net.key
```

Behavior:

- local listener stays plain HTTP for laptop development;
- remote listener requires HTTPS and certificate-backed host naming;
- remote listener requires exact allowed origins derived from `--remote-host`;
- local listener does not enforce the remote browser Origin allowlist;
- remote auth cookies are `Secure`; local auth cookies are not;
- `--remote-bind`, `--remote-host`, `--tls-cert`, and `--tls-key` form one all-or-nothing remote TLS group.

Recommended remote URL shape:

```text
https://<machine>.<tailnet>.ts.net:4450/mobile.html
wss://<machine>.<tailnet>.ts.net:4450/ws
```

Preferred certificate source remains Tailscale HTTPS certificates for the machine's MagicDNS full domain name.
Fura implementation options to evaluate in this phase:

- native TLS flags such as `--tls-cert <path>` and `--tls-key <path>`;
- or documented reverse-proxy/Tailscale Serve setup if keeping TLS outside Fura is simpler and safer;
- set auth cookie `Secure` when served over HTTPS;
- require exact `https://...` origins for browser WebSocket clients;
- startup output should clearly distinguish Local URL and HTTPS Mobile URL.

Tailscale HTTPS setup notes from official docs:

- HTTPS certificates require MagicDNS and enabling HTTPS Certificates in the Tailscale admin console.
- certificates are issued for the full `*.ts.net` machine domain, not a bare machine name.
- certificate names are published to Certificate Transparency logs, so machine names must not contain secrets.
- `tailscale cert` obtains Let's Encrypt certificates and stores private material locally on the machine.

Acceptance criteria:

- localhost/local dev still works without TLS when explicitly using local HTTP;
- configured mobile URL uses `https://` and WebSocket uses `wss://`;
- auth cookie is `Secure` on HTTPS;
- Origin allowlist tests cover HTTPS origins;
- docs/startup output warn against public internet exposure without Tailscale.

## Tailscale Cost / Setup Note

Fura will not require a paid Tailscale plan for normal personal use. Tailscale Personal is listed by Tailscale as `$0 Free forever`, with unlimited user devices, up to 6 users, and access to nearly all Tailscale features. MagicDNS is documented as available on all plans. The HTTPS certificate docs do not show a separate paid-plan requirement in the observed source; treat HTTPS-over-Tailscale as expected to work on Personal unless implementation finds a current plan gate.

The user still needs to install/sign in to Tailscale on both devices, keep them in the same tailnet, enable MagicDNS/HTTPS Certificates for HTTPS, and avoid sensitive machine names because TLS certificate names are public. Fura should assume that network path exists; it should not install or administer Tailscale.
