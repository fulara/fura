# Transcript side questions

Desktop-only, one-shot BTW lives inside the existing Transcript panel. It does not create a Dockview tab, modal, side panel, controller conversation, main prompt, or durable session.

## Interaction

- **Ask on the side** beside the main composer submits its text through `session.btw.start`. Existing snippet expansion supplies plain question text. Images and pending image decoding block this action without consuming the draft. The main Send path, slash commands, Steer, Follow-up, and raw RPC are not used.
- Opening selects a closeable side tab. While any side tabs exist, **Conversation** remains a permanent, non-closeable tab. Titles retain Unicode, use CSS ellipsis, and expose their full text through the title/accessibility name.
- The internal `tablist` uses roving tabindex, `aria-selected`, `aria-controls`, and labelled `tabpanel` regions. Left/Right wrap; Home/End select the first/last tab. Close controls are separate buttons, not nested inside tabs.
- A selected side tab hides the entire main composer. It offers **Back to conversation**, the question, status, rendered answer, and **Copy answer**. It has no continuation input, promotion, or handback action.
- Exact explanation: **“One-shot question. Continuing this conversation is not supported by the current OMP integration. No follow-ups or tools; this does not enter the main conversation. The main conversation keeps running. Results are not saved.”**
- Tooltip: **“Uses conversation context captured at start. Codex-like continuing side chats require a richer backend contract; upgrading OMP alone does not enable them.”** OMP TUI follow-ups do not imply a Fura-facing topic-continuation API. Never route the main composer as a substitute.

## State and identity

Browser memory owns the tab collection, selected tab, local question/answer, and view scroll/focus per source session. Completed tabs have no eviction limit; they last until explicitly closed or the browser page is discarded. Nothing is stored in localStorage, sessionStorage, the main transcript, or OMP history for this feature.

Each request has a globally unique ID, original source session, owning client ID, and socket generation. Updates with a wrong owner/source, an unknown request, or an old generation are ignored. Session navigation and controller navigation retain side tabs and main drafts without cancellation. Main transcript projections continue ingesting while hidden. Returning does not recreate the Dockview panel. DOM creation, clipboard operations, and focus restoration use the actual Transcript `ownerDocument`, including popout/redock.

One native side request per source is allowed. This includes start pending and native release pending. The tab and session row show running/cleanup state separately from unread completed answers. Completion in a background session, background side tab, or hidden Transcript becomes unread; viewing that answer clears it. None of these states changes the main busy projection.

“No tools” means no execution, not an empty provider tool catalog. OMP retains the main tool definitions for prompt-cache reuse; its ephemeral stream has no tool-execution loop and removes emitted tool calls from the result.

## Protocol and draft boundary

Browser commands mirror the existing bridge DTOs:

- `session.btw.start { clientId, sessionId, requestId, question }`
- `session.btw.cancel { clientId, requestId }`
- `session.btw.release { clientId, requestId }`

`session.btw.update` carries `targetClientId`, `sourceSessionId`, `requestId`, `state`, and optional `question`, `delta`, `answer`, `canPromote`, `error`. The UI deliberately ignores `canPromote`.

Generation states are `started`, `streaming`, `completed`, `cancelled`, and `error`. Bridge lifecycle acknowledgements add `accepted`, `released`, and `release_error` without changing native command names.

- Only **accepted** consumes the submitted main draft, and only if its original draft object, revision, text, and attachment state still match. Later edits are never overwritten, including edit-away-and-back to identical text. Switching source/controller does not change which draft an ACK addresses.
- `started`, streaming, and even a terminal answer may precede `accepted`. Terminal state is never reset by a late ACK.
- Start refusal preserves the question. A generation failure after consumption safely restores it only if the original draft remains unchanged and empty. Otherwise the question remains readable locally without overwriting later work.
- Streaming appends deltas. `completed.answer` replaces the whole buffer, including when it is shorter. Late generation events cannot modify a terminal answer.
- Terminal results automatically request native release while retaining local readable/copyable output. Only `released` acknowledges cleanup. A release failure does not convert a completed answer into generation failure.

## Close, disconnect, and source changes

Switching tabs never cancels. Closing hides/removes the side tab immediately. A running/queued request sends cancel and release only for that request identity; no `prompt.abort` is sent. A minimal hidden ownership/cleanup record remains until release settles. A cleanup failure is explicit and keeps the source blocked because native ownership is uncertain; the main composer stays usable. Recovery is reconnect, not automatic retry or a new generation.

Disconnect interrupts in-flight tabs, keeps partial text and completed answers, and abandons old native controls. There is no replay, resume, automatic retry, or claim that the provider already stopped. The bridge owns disconnect cleanup. A fresh socket cannot apply an old request's events. Source stop, disappearance, or logical rebind interrupts its in-flight result and releases the original identity; later generation events are rejected.

The OMP fork keeps session-generation settlement separate from outer transition
readiness. Fura's pre-switch BTW reconciliation brackets the transition without
replacing either upstream barrier. Fork and branch invalidate admitted prompt
setup only at the commit boundary; a cancelled hook leaves the source prompt valid.

## Verification boundaries

`frontend/src/main.test.ts` exercises the actual desktop DOM with the existing connection/Dockview harness: internal entry and tab structure, composer targeting, keyboard navigation, ACK/draft races, terminal replacement, main stream continuity, source/controller swaps, background badges, close/cleanup ordering, reconnect/stale ownership, snippets, image decoding, source stop, and adopted-document clipboard/focus. Main runs validation and isolated browser smoke; no provider or live-session verification is implied by these tests.

`frontend/smoke/transcript-btw.spec.ts` drives an actual isolated Fura binary and browser against `fixtures/btw-omp-rpc.mjs`, a synthetic JSONL producer with explicit fault controls. It covers real layout/scroll, internal tab identity, popout/redock, multiple browser owners, queued close, native rebind, and reconnect without representing mock responses as provider evidence.

`frontend/smoke/transcript-btw-real.spec.ts` is a separately gated browser → Fura → vendored OMP → real-provider scenario. It requires an explicitly prepared private credential store, synthetic source session, and passive marker-only request witness. It checks independent snapshots, no side content in subsequent main requests, no observed tool execution, concurrent main progress, and close without main abort.

`scripts/btw_smoke.py` runs either gate as a finite identity-checked process tree. Binary, static output, runtime, and evidence must be outside the repository. The runner never discovers credentials, builds artifacts, resumes production sessions, or invokes live launchers. Headless DOM focus and actual window adoption/redock do not establish native OS window activation.
