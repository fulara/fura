# OMP Browser Dialog Double-Handle Plan

## Finding

The `diffs-comments` continuation did not die in Fura bridge code. The observed crash is in Oh My Pi's browser tool harness.

Evidence:
- Session `019ddf61-cbbf-7000-a14f-52964740d26e` ends while executing a `browser` tool call.
- `/home/aleksander/.omp/logs/omp.2026-04-30.log` records an `Unhandled rejection` from pid `88007` at `2026-04-30T19:22:42.233+02:00`.
- The stack is `Error: Cannot accept dialog which is already handled!` through `packages/coding-agent/src/tools/browser/vm.ts` and Puppeteer `Dialog.accept()`.
- Fura was only the page under test; the fatal rejection came from OMP browser tool dialog handling.

## Trigger

The test code installed its own `page.once('dialog', dialog => dialog.accept(...))` while the browser tool tab already had dialog auto-handling enabled. Puppeteer dialogs are single-use; a second `accept()` rejects with `Cannot accept dialog which is already handled!`.

## Desired OMP Fix

Make browser dialog handling idempotent and non-fatal:

1. Track whether a dialog was already handled before accepting/dismissing, if Puppeteer exposes that state.
2. Treat `Cannot accept dialog which is already handled!` / `Cannot dismiss dialog which is already handled!` as a handled debug condition, not an unhandled rejection.
3. Document that callers should use `open(..., dialogs: "accept" | "dismiss")` or a manual `page.on('dialog', ...)`, not both.
4. Add a regression test or browser-tool harness scenario where an auto dialog policy and a user handler race; expected result is no process-level unhandled rejection.

## Fura Workaround

For Fura verification, avoid `window.prompt` in browser tests. Drive snapshot creation through app state or selectors that do not require a native dialog, or open the browser tab without auto dialog handling before installing a manual prompt handler.
