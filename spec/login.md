# Future Fura login support

## Current decision

Fura does not own OAuth/provider login yet. The supported authentication path remains the Oh My Pi TUI: sign in there, then run Fura against an OMP RPC process that already has the required credentials.

This pass intentionally does not add Fura login UI, slash commands, bridge auth commands, or frontend calls for provider discovery. `raw.rpc` remains a debug escape hatch only; it is not a login contract.

## OMP RPC flow to map later

When Fura owns login, the bridge should expose explicit protocol messages that map directly to OMP RPC without hiding provider semantics:

1. Frontend asks the bridge for providers, likely `auth.providers.list`.
2. Bridge sends OMP RPC `get_login_providers`.
3. Bridge returns provider summaries to the frontend, likely `auth.providers`.
4. Frontend starts a selected provider login, likely `auth.login.start` with `{ providerId }` plus any provider-specific fields OMP exposes.
5. Bridge sends OMP RPC `login` and keeps the request pending until OMP reports success, failure, cancellation, or timeout.
6. OMP may emit `extension_ui_request` with `method: "open_url"`; Fura should render a visible HTTPS/HTTP link and copy affordance rather than relying on popups.
7. Bridge completes the frontend request with a login result and refreshes any OMP state that depends on authentication.

Likely future names are deliberately documented here, not implemented:

```ts
type ClientMessage =
  | { type: "auth.providers.list"; requestId?: string }
  | { type: "auth.login.start"; requestId?: string; providerId: string; fields?: Record<string, unknown> }
  | { type: "auth.login.cancel"; requestId?: string; loginId: string };

type ServerMessage =
  | { type: "auth.providers"; requestId?: string; providers: AuthProviderSummary[] }
  | { type: "auth.login.status"; requestId?: string; loginId: string; status: "waiting" | "succeeded" | "failed" | "cancelled"; message?: string };
```

## `open_url` handling

`open_url` is notification-style extension UI. Fura should not send `extension_ui_response` for it unless OMP changes the contract to require a response.

Frontend requirements:

- accept `url` and optional `instructions` on `extension_ui_request` payloads;
- render links only for `http:` and `https:` URLs;
- show the raw URL as text even when it is not linkable, so failures are debuggable;
- provide a copy action when browser clipboard APIs are available;
- use the same link-first behavior on desktop and mobile because silent popup opening is unreliable.

## Timeouts and cancellation

Provider login can take much longer than normal prompt/dialog RPC work because the user may need to switch browser tabs, complete SSO, approve MFA, or wait for a callback. Future bridge requests should use a login-specific timeout, not a normal short dialog timeout. A login timeout should surface as a failed/cancelled login status without clearing unrelated session state.

If OMP emits cancellation for the extension UI request, Fura should dismiss the visible link card. If the user dismisses Fura's link card, that should only hide the card; it should not imply OAuth cancellation unless OMP adds an explicit cancellable login request id.

## Providers needing interactive prompts

Some providers may need terminal-style prompts, device-code confirmation, or other interactive fields that are not represented by current headless RPC login. Fura should not guess those flows. Provider summaries should expose whether the provider is browser/OAuth-compatible, needs additional fields, or is unsupported in headless RPC. Unsupported providers should be shown disabled with a truthful explanation.

## Mock fixture guidance

Do not add mock login behavior until Fura implements first-class login messages. When that happens, the mock RPC fixture should cover:

- `get_login_providers` returning at least one browser/OAuth provider and one unsupported interactive provider;
- `login` emitting `extension_ui_request` with `method: "open_url"`;
- success, failure, timeout, and cancellation paths.
