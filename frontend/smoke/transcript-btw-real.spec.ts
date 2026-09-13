import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServerMessage } from "../src/protocol";

const runtime = process.env.FURA_BTW_RUNTIME!;
const evidence = process.env.FURA_BTW_EVIDENCE_DIR!;
type Witness = { event: string; model?: string; side?: boolean; markers?: Record<string, boolean>; toolName?: string; toolCount?: number | null };
type TimelineEvent = { kind: "main" | "side"; at: number; state?: string; topic?: string };
declare global { interface Window { btwRealSentTypes: string[]; btwRealTimeline: TimelineEvent[] } }
const conversation = (page: Page) => page.getByRole("tab", { name: "Conversation", exact: true });
const activeAnswer = (page: Page) => page.locator('.btw-side:not([hidden]) .btw-answer');
async function side(page: Page, question: string) {
  if (await conversation(page).count()) await conversation(page).click();
  await page.locator("#promptInput").fill(question);
  await expect(page.getByRole("button", { name: "Ask on the side", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Ask on the side", exact: true }).click();
  await expect(page.getByRole("tab", { name: `BTW: ${question}`, exact: true })).toHaveAttribute("aria-selected", "true");
}
async function main(page: Page, text: string) {
  if (await conversation(page).count()) await conversation(page).click();
  await expect(page.locator("#statusBar")).not.toHaveClass(/\bbusy\b/, { timeout: 90000 });
  await page.locator("#promptInput").fill(text);
  await page.locator("#sendButton").click();
}
async function witness(): Promise<Witness[]> {
  try { return (await readFile(path.join(runtime, "provider-witness.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

test("actual vendored OMP and configured provider preserve snapshot and main execution boundaries", async ({ page }) => {
  test.setTimeout(360_000);
  test.skip(process.env.FURA_BTW_REAL !== "1", "explicit private real-provider runtime required");
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.btwRealSentTypes = [];
    window.btwRealTimeline = [];
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const topics = new Map<string, string>();
        let lastMainPayload = "";
        this.addEventListener("message", event => {
          const frame = JSON.parse(event.data) as ServerMessage;
          if (frame.type === "session.btw.update") {
            if (frame.question) topics.set(frame.requestId, frame.question.split(":")[0]);
            window.btwRealTimeline.push({ kind: "side", at: Date.now(), state: frame.state, topic: topics.get(frame.requestId) });
          } else if (frame.type === "session.delta") {
            const text = JSON.stringify(frame.state.transcriptAppend.filter(entry => entry.kind === "message" && entry.role === "assistant"));
            if (text.includes("MAIN_STREAM_STARTED_BTW") && text !== lastMainPayload) {
              window.btwRealTimeline.push({ kind: "main", at: Date.now() });
              lastMainPayload = text;
            }
          }
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") { try { window.btwRealSentTypes.push(JSON.parse(data).type); } catch { /* not JSON */ } }
        super.send(data);
      }
    };
  });
  await page.goto("/");
  await page.locator("#authTokenInput").fill("btw-fixture-only");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
  await page.locator("#sessionsList button.session").filter({ hasText: "BTW real provider isolation" }).click();
  await page.locator(".dv-tab:visible").filter({ hasText: /^Transcript$/ }).click();
  await expect(page.locator("#sessionMeta")).toContainText("Live", { timeout: 90000 });
  await expect(page.locator("#statusBar .model")).toBeVisible();
  await expect(page.locator("#statusBar .model")).not.toHaveText("model unknown", { timeout: 90000 });
  await expect(page.locator("#promptInput")).toBeEnabled({ timeout: 90000 });

  await main(page, "Remember the main seed MAIN_SEED_ALPHA_BTW. Do not use tools. Reply exactly READY_ALPHA_BTW.");
  await expect(page.locator(".message.assistant").filter({ hasText: "READY_ALPHA_BTW" })).toBeVisible({ timeout: 90000 });
  await expect(page.locator("#sessionsList .session.active .session-status")).toHaveText("Ready", { timeout: 90000 });
  const first = "SIDE_QUESTION_ONE_BTW: What is the main seed? Reply with that seed and SIDE_ANSWER_ONE_BTW. No tools.";
  await side(page, first);
  await expect(activeAnswer(page)).toContainText("MAIN_SEED_ALPHA_BTW", { timeout: 90000 });
  await expect(activeAnswer(page)).toContainText("SIDE_ANSWER_ONE_BTW", { timeout: 90000 });
  await expect(page.locator('.btw-side:not([hidden]) [role="status"]')).toHaveText("Completed", { timeout: 90000 });
  await page.screenshot({ path: path.join(evidence, "real-provider-one-shot.png"), fullPage: true });

  const longMain = "MAIN_CONTINUITY_BTW: Replace the main seed with MAIN_SEED_BETA_BTW. Do not use tools. Start with MAIN_STREAM_STARTED_BTW, then write 300 individually numbered lines, each containing at least twelve words explaining a distinct simple property of its number. Do not abbreviate or summarize the list. End with MAIN_DONE_BTW.";
  await main(page, longMain);
  await expect(page.locator(".message.assistant").filter({ hasText: "MAIN_STREAM_STARTED_BTW" }).last()).toBeVisible({ timeout: 90000 });
  const second = "SIDE_QUESTION_TWO_BTW: What is the latest main seed? Reply with only that seed. No tools.";
  await side(page, second);
  await expect(activeAnswer(page)).toContainText("MAIN_SEED_BETA_BTW", { timeout: 90000 });
  await expect(page.locator('.btw-side:not([hidden]) [role="status"]')).toHaveText("Completed", { timeout: 90000 });
  await conversation(page).click();
  const duringSide = await page.evaluate(() => window.btwRealTimeline);
  const sideStartedAt = duringSide.find(event => event.topic === "SIDE_QUESTION_TWO_BTW" && event.state === "started")?.at;
  const sideCompletedAt = duringSide.find(event => event.topic === "SIDE_QUESTION_TWO_BTW" && event.state === "completed")?.at;
  expect(duringSide.some(event => event.kind === "main" && event.at > sideStartedAt! && event.at < sideCompletedAt!)).toBe(true);
  const status = page.locator("#sessionsList .session.active .session-status");
  let mainDoneMarker = "MAIN_DONE_BTW";
  if ((await status.innerText()) === "Ready") {
    mainDoneMarker = "MAIN_DONE_SECOND_BTW";
    await main(page, longMain.replace("MAIN_DONE_BTW", mainDoneMarker));
    await expect(status).toHaveText("Working", { timeout: 30000 });
  }
  const closing = "SIDE_QUESTION_CLOSE_BTW: Begin SIDE_CANCEL_STARTED_BTW then write a detailed 250-line explanation of prime numbers. No tools.";
  await side(page, closing);
  await expect(activeAnswer(page)).toContainText("SIDE_CANCEL_STARTED_BTW", { timeout: 90000 });
  await expect(status).toHaveText("Working");
  const closeAt = await page.evaluate(() => Date.now());
  await page.getByRole("button", { name: `Close ${closing}`, exact: true }).click();
  await conversation(page).click();
  await expect(page.locator(".message.assistant").filter({ hasText: mainDoneMarker }).last()).toBeVisible({ timeout: 180000 });
  await expect(status).toHaveText("Ready", { timeout: 90000 });
  await main(page, "MAIN_POST_SIDE_BTW: Reply exactly CHECK_DONE_BTW and the latest main seed. Do not use tools.");
  await expect(page.locator(".message.assistant").filter({ hasText: "CHECK_DONE_BTW" })).toBeVisible({ timeout: 90000 });
  await expect(status).toHaveText("Ready", { timeout: 90000 });

  const records = await witness();
  const requests = records.filter(record => record.event === "provider_request");
  const firstInput = requests.find(record => record.side && record.markers?.SIDE_QUESTION_ONE_BTW);
  const secondInput = requests.find(record => record.side && record.markers?.SIDE_QUESTION_TWO_BTW);
  const finalMain = requests.findLast(record => !record.side && record.markers?.MAIN_POST_SIDE_BTW);
  expect(firstInput?.markers?.MAIN_SEED_ALPHA_BTW).toBe(true);
  expect(firstInput?.markers?.MAIN_SEED_BETA_BTW).toBe(false);
  expect(secondInput?.markers?.MAIN_SEED_BETA_BTW).toBe(true);
  expect(secondInput?.markers?.SIDE_QUESTION_ONE_BTW).toBe(false);
  expect(secondInput?.markers?.SIDE_ANSWER_ONE_BTW).toBe(false);
  expect(finalMain?.markers?.SIDE_QUESTION_ONE_BTW).toBe(false);
  expect(finalMain?.markers?.SIDE_QUESTION_TWO_BTW).toBe(false);
  expect(finalMain?.markers?.SIDE_QUESTION_CLOSE_BTW).toBe(false);
  expect(finalMain?.markers?.SIDE_ANSWER_ONE_BTW).toBe(false);
  expect(records.filter(record => record.event === "tool_call" || record.event === "tool_result")).toEqual([]);
  const sent = await page.evaluate(() => window.btwRealSentTypes);
  expect(sent).not.toContain("prompt.abort");
  expect(sent).not.toContain("raw.rpc");
  expect(sent).not.toContain("session.btw.promote");
  expect(sent).toContain("session.btw.release");
  const timeline = await page.evaluate(() => window.btwRealTimeline);
  expect(timeline.some(event => event.kind === "main" && event.at > closeAt)).toBe(true);
  await page.screenshot({ path: path.join(evidence, "real-main-after-side.png"), fullPage: true });
  await writeFile(path.join(evidence, "real-provider-evidence.json"), JSON.stringify({ actualBridge: true, actualVendoredOmp: true, model: firstInput?.model, initialSnapshotCorrect: true, independentNextSnapshotCorrect: true, noSideQuestionOrAnswerInMainProviderInput: true, noToolExecutionObserved: true, mainProgressWhileSide: true, closeDidNotSendMainAbort: true, providerRequests: requests, timeline, nativeOsFocusVerified: false }, null, 2));
});
