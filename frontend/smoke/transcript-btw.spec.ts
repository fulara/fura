import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Real isolated Fura + controlled JSONL producer. Provider evidence is recorded
// separately; fault injection here must never be described as a real model run.
const fixtureRoot = process.env.FURA_BTW_FIXTURE_ROOT!;
const evidence = process.env.FURA_BTW_EVIDENCE_DIR!;
type Command = { type: string; btwId?: string; id?: string; question?: string; message?: string };
type Inspection = { received: Command[]; retained: string[]; busy: boolean };
declare global { interface Window {
  btwSmokeSockets: WebSocket[];
  btwSmokeClientId: string;
  btwSmokeUpdates: Array<{ requestId: string; state: string }>;
} }
async function control(source: string, operation: Record<string, unknown> = { op: "inspect" }): Promise<Inspection> {
  const metadata = JSON.parse(await readFile(path.join(fixtureRoot, `control-${source}.json`), "utf8"));
  const url = new URL(metadata.url);
  if (url.hostname !== "127.0.0.1") throw new Error("foreign fixture controller");
  const response = await fetch(url, { method: "POST", body: JSON.stringify(operation) });
  if (!response.ok) throw new Error(await response.text());
  return await response.json() as Inspection;
}
async function login(page: Page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.btwSmokeSockets = [];
    window.btwSmokeUpdates = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        window.btwSmokeSockets.push(this);
        this.addEventListener("message", event => {
          const frame = JSON.parse(event.data);
          if (frame.type === "session.btw.update") window.btwSmokeUpdates.push({ requestId: frame.requestId, state: frame.state });
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.clientId) window.btwSmokeClientId = frame.clientId;
        }
        super.send(data);
      }
    };
  });
  await page.goto("/");
  await page.locator("#authTokenInput").fill("btw-fixture-only");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}
async function select(page: Page, name: string) {
  await page.locator("#sessionsList button.session").filter({ has: page.locator(".session-id", { hasText: name }) }).click();
  await expect(page.locator("#sessionTitle")).toContainText(name);
  await page.locator(".dv-tab:visible").filter({ hasText: /^Transcript$/ }).click();
}
const conversation = (page: Page) => page.getByRole("tab", { name: /^Conversation/ });
const sideTab = (page: Page, question: string) => page.getByRole("tab", { name: `BTW: ${question}`, exact: true });
async function ask(page: Page, source: string, question: string) {
  if (await conversation(page).count()) await conversation(page).click();
  await page.locator("#promptInput").fill(question);
  await page.getByRole("button", { name: "Ask on the side", exact: true }).click();
  await expect(sideTab(page, question)).toHaveAttribute("aria-selected", "true");
  let id = "";
  await expect.poll(async () => {
    const state = await control(source);
    id = state.received.findLast(command => command.type === "btw_start" && command.question === question)?.btwId ?? "";
    return id;
  }).not.toBe("");
  return id;
}
async function complete(source: string, id: string, answer: string) {
  await control(source, { op: "side", id, state: "completed", fields: { answer, canPromote: false } });
}
async function save(page: Page, name: string) {
  await page.screenshot({ path: path.join(evidence, name + ".png"), fullPage: true });
}

test("main and BTW stream independently; terminal result is local, readable and one-shot", async ({ page }) => {
  await login(page);
  await select(page, "BTW source A");
  await page.locator("#promptInput").fill("Main stream continuity fixture");
  await page.locator("#sendButton").click();
  await control("btw-source-a", { op: "main", delta: "Main before BTW. " });
  const question = "Why is the main task doing this?";
  const id = await ask(page, "btw-source-a", question);
  await expect(page.locator("#promptForm")).toBeHidden();
  await expect(page.getByText(/continuing this conversation is not supported/i).first()).toBeVisible();
  await control("btw-source-a", { op: "side", id, state: "streaming", fields: { delta: "Provisional answer that must be replaced." } });
  await expect(page.getByText("Provisional answer that must be replaced.", { exact: true })).toBeVisible();
  await conversation(page).click();
  await expect(page.locator("#promptForm")).toBeVisible();
  await control("btw-source-a", { op: "main", delta: "Main progresses while BTW is open. " });
  await expect(page.locator(".message.assistant").filter({ hasText: "Main progresses while BTW is open." })).toBeVisible();
  await complete("btw-source-a", id, "Normalized final answer.");
  await expect.poll(async () => (await control("btw-source-a")).retained.includes(id)).toBe(false);
  await expect(sideTab(page, question).locator("..")).toContainText(/unread/i);
  await sideTab(page, question).click();
  await expect(page.getByText("Normalized final answer.", { exact: true })).toBeVisible();
  await expect(page.getByText("Provisional answer that must be replaced.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /copy answer/i })).toBeEnabled();
  await save(page, "one-shot-tabs-and-limitation");
  const before = (await control("btw-source-a")).received.filter(command => command.type === "btw_start").length;
  await conversation(page).click();
  await sideTab(page, question).click();
  expect((await control("btw-source-a")).received.filter(command => command.type === "btw_start")).toHaveLength(before);
  await control("btw-source-a", { op: "main", delta: "Main final.", complete: true });
  expect((await control("btw-source-a")).received.some(command => command.type === "abort")).toBe(false);
});

test("multiple results, per-session drafts, Unicode tabs and keyboard focus survive round trips", async ({ page }) => {
  await login(page);
  await select(page, "BTW source A");
  const first = ("Zażółć gęślą jaźń 日本語 👩🏽‍💻 — " + "bardzo długie pytanie ".repeat(12)).trim();
  const firstId = await ask(page, "btw-source-a", first);
  await complete("btw-source-a", firstId, "Unicode result retained.");
  await conversation(page).click();
  const second = "An independent question";
  const secondId = await ask(page, "btw-source-a", second);
  await conversation(page).click();
  await page.locator("#promptInput").fill("Unsaved main A draft");
  await expect(page.getByRole("button", { name: "Ask on the side", exact: true })).toBeDisabled();
  await select(page, "BTW source B");
  await expect(page.getByRole("tab", { name: /^BTW:/ })).toHaveCount(0);
  await page.locator("#promptInput").fill("Unsaved main B draft");
  await select(page, "BTW source A");
  await expect(page.locator("#promptInput")).toHaveValue("Unsaved main A draft");
  await complete("btw-source-a", secondId, "Second independent result.");
  const tab = conversation(page);
  await tab.focus();
  await tab.press("End");
  await expect(sideTab(page, second)).toBeFocused();
  await sideTab(page, second).press("Home");
  await expect(conversation(page)).toBeFocused();
  await conversation(page).press("ArrowRight");
  await expect(sideTab(page, first)).toBeFocused();
  await expect(page.locator("#promptForm")).toBeHidden();
  const tablist = sideTab(page, first).locator("..").locator("..");
  expect(await tablist.evaluate(element => element.scrollWidth >= element.clientWidth)).toBe(true);
  await save(page, "unicode-keyboard-tabs");
  await page.getByRole("button", { name: `Close ${second}`, exact: true }).click();
  await expect(sideTab(page, first)).toBeVisible();
  await conversation(page).click();
  await expect(page.locator("#promptInput")).toHaveValue("Unsaved main A draft");
  await select(page, "BTW source B");
  await expect(page.locator("#promptInput")).toHaveValue("Unsaved main B draft");
});

test("acceptance race, rejection, attachments, close and late events cannot retarget main", async ({ page }) => {
  await login(page);
  await select(page, "BTW source A");
  await control("btw-source-a", { op: "mode", mode: "delayed" });
  const question = "Accept only after native ACK";
  const id = await ask(page, "btw-source-a", question);
  await conversation(page).click();
  await expect(page.locator("#promptInput")).toHaveValue(question);
  await page.locator("#promptInput").fill("Newer draft must survive old ACK");
  await control("btw-source-a", { op: "ack", id });
  await expect(page.locator("#promptInput")).toHaveValue("Newer draft must survive old ACK");
  await page.getByRole("button", { name: `Close ${question}`, exact: true }).click();
  await expect.poll(async () => (await control("btw-source-a")).retained.includes(id)).toBe(false);
  await control("btw-source-a", { op: "side", id, state: "streaming", fields: { delta: "GHOST_LATE_TEXT" } });
  await expect(page.getByText("GHOST_LATE_TEXT")).toHaveCount(0);
  await control("btw-source-a", { op: "mode", mode: "normal", error: "Rejected fixture request" });
  await ask(page, "btw-source-a", "Rejected question draft");
  await expect(page.getByText("Rejected fixture request", { exact: true })).toBeVisible();
  await conversation(page).click();
  await expect(page.locator("#promptInput")).toHaveValue("Rejected question draft");
  await page.locator("#promptInput").evaluate(element => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137,80,78,71])], "attachment.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }));
  });
  await expect(page.getByRole("button", { name: "Ask on the side", exact: true })).toBeDisabled();
  await expect(page.locator("#imagePreviews")).toBeVisible();
  expect((await control("btw-source-a")).received.some(command => command.message === "Rejected question draft")).toBe(false);
});

test("reconnect retains terminal text but interrupts pending work; reload releases ownership", async ({ page }) => {
  await login(page);
  await select(page, "BTW source B");
  const doneQuestion = "Completed before reconnect";
  const doneId = await ask(page, "btw-source-b", doneQuestion);
  await complete("btw-source-b", doneId, "Saved only in this browser memory.");
  const pendingQuestion = "Interrupted by reconnect";
  const pendingId = await ask(page, "btw-source-b", pendingQuestion);
  await control("btw-source-b", { op: "side", id: pendingId, state: "streaming", fields: { delta: "Partial text stays readable." } });
  await expect(page.getByText("Partial text stays readable.", { exact: true })).toBeVisible();
  // Chromium's offline emulation does not reliably close established loopback
  // WebSockets. Close this browser's actual owned socket instead.
  await page.evaluate(() => window.btwSmokeSockets.findLast(socket => socket.readyState === WebSocket.OPEN)?.close(4000, "isolated reconnect regression"));
  await expect(page.locator("#connectionStatus")).not.toHaveText("connected");
  await expect(page.locator("#connectionStatus")).toHaveText("connected", { timeout: 30000 });
  await expect(page.getByText("Partial text stays readable.", { exact: true })).toBeVisible();
  await expect(page.getByText(/interrupted|connection lost/i).first()).toBeVisible();
  await sideTab(page, doneQuestion).click();
  await expect(page.getByText("Saved only in this browser memory.", { exact: true })).toBeVisible();
  await expect.poll(async () => (await control("btw-source-b")).retained).toEqual([]);
  await page.reload();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
  await select(page, "BTW source B");
  await expect(page.getByRole("tab", { name: /^BTW:/ })).toHaveCount(0);
  await writeFile(path.join(evidence, "mock-lifecycle.json"), JSON.stringify({ provider: "synthetic fault injection, not model evidence", reconnectPreservedLocalResult: true, pendingInterrupted: true, reloadLostTabsHonestly: true }, null, 2));
});

test("real layout preserves hidden main scroll and tabpanel identity through session switches and last close", async ({ page }) => {
  await login(page);
  await select(page, "BTW source A");
  await page.locator("#promptInput").fill("Long scroll fixture");
  await page.locator("#sendButton").click();
  await control("btw-source-a", { op: "main", delta: Array.from({ length: 120 }, (_, n) => `Paragraph ${n}: preserved main reading position and message controls.`).join("\n\n"), complete: true });
  const mainPanel = page.locator(".panel-content-transcript:visible .btw-conversation");
  await expect(mainPanel).toBeVisible();
  await expect(mainPanel.locator(".message.assistant").last()).toContainText("Paragraph 119:");
  await expect(page.locator("#sessionsList .session.active .session-status")).toHaveText("Ready");
  const bubble = await mainPanel.locator(".message.assistant").last().elementHandle();
  await mainPanel.evaluate(element => { element.scrollTop = 500; });
  await expect.poll(() => mainPanel.evaluate(element => element.scrollTop)).toBe(500);
  const question = "Keep the main reading position";
  const id = await ask(page, "btw-source-a", question);
  await complete("btw-source-a", id, "Reading position is independent.");
  expect(await bubble!.evaluate(element => element.isConnected)).toBe(true);
  await select(page, "BTW source B");
  await select(page, "BTW source A");
  await expect(sideTab(page, question)).toHaveAttribute("aria-selected", "true");
  const back = page.getByRole("button", { name: "Back to conversation", exact: true });
  await back.focus();
  await back.press("Enter");
  expect(await mainPanel.evaluate(element => element.ownerDocument.activeElement === element)).toBe(true);
  await expect.poll(() => mainPanel.evaluate(element => element.scrollTop)).toBe(500);
  for (const tab of await page.getByRole("tablist", { name: "Transcript conversations" }).getByRole("tab").all()) {
    const target = await tab.getAttribute("aria-controls");
    await expect(page.locator(`[id="${target}"]`)).toHaveCount(1);
  }
  const close = page.getByRole("button", { name: `Close ${question}`, exact: true });
  await close.focus();
  await close.press("Enter");
  expect(await page.evaluate(() => document.activeElement !== document.body && !document.activeElement?.closest("[hidden]"))).toBe(true);
  await expect(mainPanel).toBeVisible();
});

test("real popout and redock retain the Transcript panel while main and side streams progress", async ({ page }) => {
  await login(page);
  await select(page, "BTW source A");
  await page.locator("#promptInput").fill("Main during popout");
  await page.locator("#sendButton").click();
  await control("btw-source-a", { op: "main", delta: "POPOUT_MAIN_ONE " });
  const question = "Side in an adopted document";
  const id = await ask(page, "btw-source-a", question);
  const panel = await page.locator(".panel-content-transcript:visible").elementHandle();
  const group = page.locator(".dv-groupview:visible").filter({ has: page.locator(".dv-tab:visible").filter({ hasText: /^Transcript$/ }) });
  const popupPromise = page.waitForEvent("popup");
  await group.getByRole("button", { name: "Pop out", exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  await expect(sideTab(popup, question)).toBeVisible();
  await control("btw-source-a", { op: "side", id, state: "streaming", fields: { delta: "POPOUT_SIDE_ONE " } });
  await control("btw-source-a", { op: "main", delta: "POPOUT_MAIN_TWO " });
  await expect(popup.getByText("POPOUT_SIDE_ONE", { exact: true })).toBeVisible();
  await conversation(popup).click();
  await expect(popup.locator(".message.assistant").filter({ hasText: "POPOUT_MAIN_TWO" })).toBeVisible();
  await page.locator("#promptInput").fill("Main draft survives adopted Transcript");
  await sideTab(popup, question).click();
  await control("btw-source-a", { op: "main", delta: "POPOUT_MAIN_THREE " });
  await popup.screenshot({ path: path.join(evidence, "actual-popout-btw.png"), fullPage: true });
  const closed = popup.waitForEvent("close");
  await popup.evaluate(() => window.close());
  await closed;
  await expect(sideTab(page, question)).toBeVisible();
  expect(await panel!.evaluate(element => element.isConnected && element.ownerDocument === document)).toBe(true);
  await complete("btw-source-a", id, "POPOUT_SIDE_FINAL");
  await expect(page.getByText("POPOUT_SIDE_FINAL", { exact: true })).toBeVisible();
  await conversation(page).click();
  await control("btw-source-a", { op: "main", delta: "POPOUT_MAIN_FINAL", complete: true });
  await expect(page.locator(".message.assistant").filter({ hasText: "POPOUT_MAIN_FINAL" })).toBeVisible();
  await expect(page.locator("#promptInput")).toHaveValue("Main draft survives adopted Transcript");
  await save(page, "redocked-main-with-retained-btw");
  await writeFile(path.join(evidence, "popout-evidence.json"), JSON.stringify({ actualBrowserWindows: 2, actualAdoptionAndRedock: true, mainAndSideProgressed: true, panelIdentityRetained: true, nativeOsActivationVerified: false }, null, 2));
});

test("two real browser connections cannot control or receive another owner's BTW", async ({ page, browser }) => {
  await login(page);
  await select(page, "BTW source A");
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const other = await otherContext.newPage();
  try {
    await login(other);
    await select(other, "BTW source B");
    await select(other, "BTW source A");
    const question = "Owned by first connection";
    const id = await ask(page, "btw-source-a", question);
    const stolenClientId = await page.evaluate(() => window.btwSmokeClientId);
    const before = (await control("btw-source-a")).received.filter(command => command.type === "btw_cancel").length;
    await other.evaluate(({ id, clientId }) => {
      window.btwSmokeSockets.findLast(socket => socket.readyState === WebSocket.OPEN)!.send(JSON.stringify({ type: "session.btw.cancel", requestId: id, clientId }));
    }, { id, clientId: stolenClientId });
    await expect.poll(() => other.evaluate(id => window.btwSmokeUpdates.some(event => event.requestId === id && event.state === "error"), id)).toBe(true);
    expect((await control("btw-source-a")).received.filter(command => command.type === "btw_cancel")).toHaveLength(before);
    await control("btw-source-b", { op: "frame", frame: { type: "btw_update", btwId: id, state: "streaming", delta: "WRONG_TRANSPORT_TEXT" } });
    await control("btw-source-a", { op: "side", id, state: "streaming", fields: { delta: "Only the owner receives this." } });
    await expect(page.getByText("Only the owner receives this.", { exact: true })).toBeVisible();
    await expect(page.getByText("WRONG_TRANSPORT_TEXT")).toHaveCount(0);
    await complete("btw-source-a", id, "Owner-only terminal answer.");
    await expect(page.getByText("Owner-only terminal answer.", { exact: true })).toBeVisible();
    expect(await other.evaluate(id => window.btwSmokeUpdates.filter(event => event.requestId === id && ["started", "streaming", "completed", "accepted"].includes(event.state)), id)).toEqual([]);
  } finally { await otherContext.close(); }
});

test("close during queued maintenance and native source rebind discard only owned side work", async ({ page }) => {
  await login(page);
  await select(page, "BTW source A");
  await control("btw-source-a", { op: "mode", mode: "queued" });
  const question = "Queued before compact";
  const id = await ask(page, "btw-source-a", question);
  await control("btw-source-a", { op: "compact", active: true });
  await page.getByRole("button", { name: `Close ${question}`, exact: true }).click();
  await expect.poll(async () => (await control("btw-source-a")).retained.includes(id)).toBe(false);
  await control("btw-source-a", { op: "side", id, state: "completed", fields: { answer: "LATE_CLOSED_RESULT", canPromote: false } });
  await expect(page.getByText("LATE_CLOSED_RESULT")).toHaveCount(0);
  await control("btw-source-a", { op: "compact", active: false });
  await control("btw-source-a", { op: "mode", mode: "normal" });
  const reboundQuestion = "Source identity is fixed";
  const reboundId = await ask(page, "btw-source-a", reboundQuestion);
  await control("btw-source-a", { op: "rebind", sessionId: "btw-rebound-source" });
  await page.evaluate(() => window.btwSmokeSockets.findLast(socket => socket.readyState === WebSocket.OPEN)!.send(JSON.stringify({ type: "state.refresh", clientId: window.btwSmokeClientId, sessionId: "btw-source-a" })));
  await expect.poll(async () => (await control("btw-source-a")).retained.includes(reboundId)).toBe(false);
  await control("btw-source-a", { op: "side", id: reboundId, state: "streaming", fields: { delta: "LATE_REBOUND_RESULT" } });
  await expect(page.getByText("LATE_REBOUND_RESULT")).toHaveCount(0);
  expect((await control("btw-source-a")).received.some(command => command.type === "abort")).toBe(false);
});
