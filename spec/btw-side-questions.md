# BTW side questions

## Purpose

BTW runs a short, read-only side question against a captured OMP conversation point without pausing, steering, or appending to the source session. Desktop Fura presents each request as a temporary Dockview tab beside Transcript.

## Lifecycle

1. The browser creates a unique request ID and sends `session.btw.start` with its client ID, the live source session ID, and a text-only question.
2. Fura binds that request to the originating browser client and source RPC transport, then sends OMP `btw_start`.
3. OMP captures an in-memory detached branch snapshot, including any visible in-flight assistant response, and runs an ephemeral model request with a developer reminder forbidding tool use. Tool definitions remain in the request for prompt-cache stability, but any returned tool calls are discarded rather than executed. OMP emits `btw_update` states `started`, `streaming`, and one terminal state.
4. Fura forwards updates only to the owning browser. The tab renders streamed text independently of the source transcript.
5. Closing a tab cancels a running request and always releases its OMP state. Browser disconnect performs the same release.

Only one BTW request may run per source OMP session. Different live sessions may run independent requests. Image attachments are not supported.

## Terminal states

- `completed`: the answer is available for copy, retry, dismissal, and sometimes promotion.
- `cancelled`: the ephemeral provider request was aborted; the source session is unchanged.
- `error`: provider, transport, validation, or stale-promotion failure; the source session is unchanged.

Completed, cancelled, and failed requests remain only as browser tabs until dismissed. They are not restored after reconnect.

## Promotion

A completed request is promotable only while the source session leaf still matches its captured leaf. OMP rechecks this condition when promotion is requested; the browser's `canPromote` flag is advisory.

Promotion writes a new persisted OMP session containing:

- the captured source branch and effective labels;
- any captured in-flight assistant message;
- the side question as a user message;
- the sanitized side answer as an assistant message.

It copies the source artifact directory, sets the source session file as `parentSession`, and does not switch or mutate the source OMP runtime. Fura opens the new session through the normal `session.open` path and names it from the BTW question.

## Ownership and teardown

Fura records the browser client ID, source session ID, and RPC transport for every active request. Cancel, release, and promote commands from another browser client are rejected. Updates without a current route are ignored.

Stopping, deleting, replacing, or losing the source RPC transport removes its routes and reports an error to each owning browser. Disconnect releases every request owned by that browser. No BTW route may outlive its transport.

## Non-goals

- BTW does not write to the source transcript or session file.
- BTW does not execute tool calls returned by the side request.
- BTW does not support mobile UI in this version.
- BTW tabs and in-memory answers are not durable browser state.
