import { expect, type Page, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { expandSnippetTokens } from "../src/composerAttachments";
import type { ClientMessage, ServerMessage, SessionSummary } from "../src/protocol";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
type OwnedSession = { id: string; title: string };
type SentPrompt = { sessionId: string; imageCount: number; textLength: number; behavior?: string; imageDetails?: unknown[]; textMatchesFixture?: boolean };
type SessionSnapshot = Extract<ServerMessage, { type: "session.snapshot" }>;

declare global {
  interface Window {
    sessionDraftSmoke: {
      sockets: WebSocket[];
      sessions: SessionSummary[];
      snapshots: Map<string, SessionSnapshot>;
      sent: SentPrompt[];
      expectedPromptText: string | null;
      holdSession: string | null;
      holdCatalog: boolean;
      held: string[];
      emit(message: ServerMessage): void;
      releaseMessages(): void;
      deferImages: boolean;
      imageReads: Array<() => Promise<void>>;
      releaseImages(): Promise<void>;
    };
  }
}

// Keep the real bridge, authentication, WebSocket transport and mock RPC child.
// Only this document's incoming delivery order/FileReader timing is controlled.
// Full fixture snapshots stay in page memory; outgoing observations contain no text/data.
test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
  await page.addInitScript((png: string) => {
    const NativeWebSocket = window.WebSocket;
    const harness: Window["sessionDraftSmoke"] = {
      sockets: [], sessions: [], snapshots: new Map(), sent: [], expectedPromptText: null,
      holdSession: null, holdCatalog: false, held: [], deferImages: false, imageReads: [],
      emit(message) {
        this.sockets.at(-1)!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
      },
      releaseMessages() {
        this.holdSession = null;
        this.holdCatalog = false;
        for (const data of this.held.splice(0)) {
          this.sockets.at(-1)!.dispatchEvent(new MessageEvent("message", { data }));
        }
      },
      async releaseImages() {
        this.deferImages = false;
        await Promise.all(this.imageReads.splice(0).map(read => read()));
      },
    };
    window.sessionDraftSmoke = harness;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        harness.sockets.push(this);
        this.addEventListener("message", event => {
          if (!event.isTrusted || typeof event.data !== "string") return;
          const message = JSON.parse(event.data) as ServerMessage;
          if (message.type === "sessions.snapshot") harness.sessions = message.sessions;
          if (message.type === "session.snapshot") harness.snapshots.set(message.sessionId, message);
          if ((harness.holdCatalog && message.type === "sessions.snapshot")
            || (harness.holdSession && "sessionId" in message && message.sessionId === harness.holdSession
              && ["session.snapshot", "session.delta", "prompt.busy"].includes(message.type))) {
            harness.held.push(event.data);
            event.stopImmediatePropagation();
          }
        });
      }
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data === "string") {
          const message = JSON.parse(data) as ClientMessage;
          if (message.type === "prompt.send") {
            const imageDetails = message.images?.some(image => "detail" in (image as object))
              ? message.images.map(image => {
                const { data, ...metadata } = image as Record<string, unknown>;
                return { ...metadata, dataMatchesFixture: data === png };
              }) : undefined;
            harness.sent.push({ sessionId: message.sessionId, imageCount: message.images?.length ?? 0, textLength: message.text.length, ...(message.behavior ? { behavior: message.behavior } : {}), ...(imageDetails ? { imageDetails } : {}), ...(harness.expectedPromptText !== null ? { textMatchesFixture: message.text === harness.expectedPromptText } : {}) });
          }
        }
        super.send(data);
      }
    };
    const NativeFileReader = window.FileReader;
    window.FileReader = class extends NativeFileReader {
      override readAsDataURL(blob: Blob): void {
        if (!harness.deferImages) { super.readAsDataURL(blob); return; }
        harness.imageReads.push(() => new Promise<void>((resolve, reject) => {
          this.addEventListener("loadend", () => this.error ? reject(this.error) : resolve(), { once: true });
          super.readAsDataURL(blob);
        }));
      }
    };
  }, tinyPngBase64);
  await page.goto("/");
  await page.locator("#authTokenInput").fill("dev");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#authGate")).toBeHidden();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
});

async function createSession(page: Page, label: string): Promise<OwnedSession> {
  const title = `Draft ${label} ${randomUUID()}`;
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerNameInput").fill(title);
  await page.locator("#cwdPickerInput").fill("/tmp");
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(page.locator("#sessionTitle")).toHaveText(title);
  await expect.poll(() => page.evaluate(name =>
    [...window.sessionDraftSmoke.snapshots.values()].some(snapshot => snapshot.state.summary.title === name), title)).toBe(true);
  const id = await page.evaluate(name =>
    [...window.sessionDraftSmoke.snapshots.values()].find(snapshot => snapshot.state.summary.title === name)!.sessionId, title);
  return { id, title };
}

function sessionRow(page: Page, session: OwnedSession) {
  return page.locator("#sessionsList .session-item").filter({ has: page.locator(".session-id", { hasText: session.title }) });
}

async function selectSession(page: Page, session: OwnedSession): Promise<void> {
  await sessionRow(page, session).locator("button").first().click();
  await expect(page.locator("#sessionTitle")).toHaveText(session.title);
}

async function paste(page: Page, text?: string): Promise<void> {
  await page.locator("#promptInput").evaluate((element, input) => {
    const transfer = new DataTransfer();
    if (input.text !== undefined) transfer.setData("text/plain", input.text);
    else transfer.items.add(new File([
      Uint8Array.from(atob(input.png), character => character.charCodeAt(0)),
    ], "draft.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, { text, png: tinyPngBase64 });
}

async function replaySnapshot(page: Page, session: OwnedSession): Promise<void> {
  await page.evaluate(id => {
    const snapshot = window.sessionDraftSmoke.snapshots.get(id);
    if (!snapshot) throw new Error("Owned session snapshot was not captured");
    window.sessionDraftSmoke.emit(snapshot);
  }, session.id);
}

async function sentPrompts(page: Page): Promise<SentPrompt[]> {
  return page.evaluate(() => window.sessionDraftSmoke.sent);
}

test("desktop keeps exact drafts across sessions, controller, snapshots, panels and transient absence", async ({ page }, testInfo) => {
  const a = await createSession(page, "A");
  const prompt = page.locator("#promptInput");
  const textA = "  A\tZażółć gęślą 🧪\n\n日本語 e\u0301\n  ";
  const textB = "\n B\tΔοκιμή\nsecond line  \n\t";
  const controller = "  Controller only\n¿qué tal?  \n";
  await prompt.fill(textA);
  const b = await createSession(page, "B");
  await expect(prompt).toHaveValue("");
  await prompt.fill(textB);
  await selectSession(page, a);
  await expect(prompt).toHaveValue(textA);
  await page.screenshot({ path: testInfo.outputPath("draft-a.png") });
  await selectSession(page, b);
  await expect(prompt).toHaveValue(textB);
  await page.screenshot({ path: testInfo.outputPath("draft-b.png") });
  const c = await createSession(page, "empty C");
  await expect(prompt).toHaveValue("");
  await selectSession(page, a);
  await page.locator("#askFuraButton").click();
  await expect(prompt).toHaveValue("");
  await prompt.fill(controller);
  await selectSession(page, b);
  await expect(prompt).toHaveValue(textB);
  await page.locator("#askFuraButton").click();
  await expect(prompt).toHaveValue(controller);
  await replaySnapshot(page, a);
  await expect(prompt).toHaveValue(controller);

  await selectSession(page, a);
  await replaySnapshot(page, a);
  await page.locator("#normalWorkspacePanelHost .dv-tab").filter({ hasText: "Git changes" }).click();
  await expect(prompt).toHaveValue(textA);
  await page.locator("#normalWorkspacePanelHost .dv-tab").filter({ hasText: "Transcript" }).click();
  await selectSession(page, a);
  await expect(prompt).toHaveValue(textA);

  // Keep native attach refreshes from ending the controlled absence before its assertions.
  await page.evaluate(id => {
    const h = window.sessionDraftSmoke;
    h.holdCatalog = true;
    h.holdSession = id;
    h.emit({ type: "sessions.snapshot", sessions: h.sessions.filter(session => session.sessionId !== id) });
  }, a.id);
  await expect(prompt).toBeDisabled();
  await expect(prompt).toHaveValue("");
  await page.evaluate(() => {
    const h = window.sessionDraftSmoke;
    h.emit({ type: "sessions.snapshot", sessions: h.sessions });
    h.releaseMessages();
  });
  await selectSession(page, a);
  await expect(prompt).toHaveValue(textA);

  // Delete only a session this scenario created, never a discovered catalog entry.
  await selectSession(page, c);
  await prompt.fill("discard with owned C");
  await page.locator("#workspaceOptionsToggle").click();
  await page.locator("#deleteSessionButton").click();
  await expect(page.locator("#deleteSessionMessage")).toContainText(c.title);
  await page.locator("#deleteSessionConfirm").click();
  await expect(sessionRow(page, c)).toHaveCount(0);
  // A late snapshot for the explicitly deleted identity must not revive its draft.
  await replaySnapshot(page, c);
  await expect(prompt).toHaveValue("");
  await selectSession(page, a);
  await expect(prompt).toHaveValue(textA);
  await selectSession(page, b);
  await expect(prompt).toHaveValue(textB);
  expect(await sentPrompts(page)).toEqual([]);
  await page.reload();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
  await selectSession(page, a);
  await expect(prompt).toHaveValue("");
});

test("busy slash classification tolerates whitespace without changing the retained draft", async ({ page }) => {
  const a = await createSession(page, "busy slash");
  await page.evaluate(id => {
    const h = window.sessionDraftSmoke;
    const snapshot = structuredClone(h.snapshots.get(id)!);
    snapshot.state.isBusy = true;
    snapshot.state.summary.status = "busy";
    h.emit(snapshot);
  }, a.id);
  await page.locator("#promptInput").fill(" \t/tools \n");
  await page.locator("#sendButton").click();
  await expect(page.locator("#busyPromptOverlay")).toBeHidden();
  await expect.poll(async () => (await sentPrompts(page)).length).toBe(1);
  await expect(page.locator("#promptInput")).toHaveValue("");
});

test("busy choices preserve failed submissions and dispatch steer and follow-up without clearing newer text", async ({ page }) => {
  const a = await createSession(page, "busy queue");
  const prompt = page.locator("#promptInput");
  const raw = "  local busy draft\nΩ  ";
  await page.evaluate(id => {
    const h = window.sessionDraftSmoke;
    const snapshot = structuredClone(h.snapshots.get(id)!);
    snapshot.state.isBusy = true;
    h.emit(snapshot);
  }, a.id);
  await prompt.fill(raw);
  await page.locator("#sendButton").click();
  await expect(page.locator("#busyPromptText")).toHaveValue(raw);
  await page.evaluate(() => {
    Object.defineProperty(window.sessionDraftSmoke.sockets.at(-1)!, "readyState", { configurable: true, value: WebSocket.CLOSED });
  });
  await page.locator("#busyPromptSteer").click();
  await expect(page.locator("#busyPromptText")).toHaveValue(raw);
  expect(await sentPrompts(page)).toEqual([]);
  await page.evaluate(() => { Reflect.deleteProperty(window.sessionDraftSmoke.sockets.at(-1)!, "readyState"); });
  await page.locator("#busyPromptFollowUp").click();
  await expect(page.locator("#busyPromptOverlay")).toBeHidden();
  await expect(page.locator(".message.assistant")).toHaveCount(1);
  await prompt.fill("newer draft remains");
  await page.evaluate(id => {
    const h = window.sessionDraftSmoke;
    h.emit({ type: "prompt.busy", sessionId: id, text: "first delayed rejection" });
    h.emit({ type: "prompt.busy", sessionId: id, text: "second delayed rejection" });
  }, a.id);
  await expect(page.locator("#busyPromptText")).toHaveValue("first delayed rejection");
  await page.locator("#busyPromptSteer").click();
  await expect(page.locator("#busyPromptText")).toHaveValue("second delayed rejection");
  await page.locator("#busyPromptCancel").click();
  await expect(prompt).toHaveValue("second delayed rejection\n\nnewer draft remains");
  expect((await sentPrompts(page)).map(message => message.behavior)).toEqual(["followUp", "steer"]);
});

test("late voice text stays with its captured composer and cannot revive a submitted draft", async ({ page }) => {
  const a = await createSession(page, "voice A");
  const b = await createSession(page, "voice B");
  const prompt = page.locator("#promptInput");
  await prompt.fill("B untouched");
  await selectSession(page, a);
  await prompt.fill("A before voice\n");
  // Capture the real voice-input owner without opening a microphone or provider.
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise<MediaStream>(() => {});
  });
  await page.locator("#voiceButton").click();
  await selectSession(page, b);
  await page.evaluate(() => {
    window.sessionDraftSmoke.emit({ type: "voice.delta", targetClientId: sessionStorage.getItem("fura.controlClientId")!, itemId: "owned-voice", text: "voice A" });
  });
  await expect(prompt).toHaveValue("B untouched");
  await selectSession(page, a);
  await expect(prompt).toHaveValue("A before voice\nvoice A");
  await page.locator("#sendButton").click();
  await expect(prompt).toHaveValue("");
  await prompt.fill("new A");
  await selectSession(page, b);
  await page.evaluate(() => {
    window.sessionDraftSmoke.emit({ type: "voice.final", targetClientId: sessionStorage.getItem("fura.controlClientId")!, itemId: "owned-voice", text: "late final A" });
  });
  await expect(prompt).toHaveValue("B untouched");
  await selectSession(page, a);
  await expect(prompt).toHaveValue("new A");
});

test("accepted click and keyboard sends clear only their origin; delayed busy choices retain each session's newer draft", async ({ page }) => {
  const a = await createSession(page, "send A");
  const b = await createSession(page, "send B");
  const prompt = page.locator("#promptInput");
  const textB = "  B unsent\nkeep this Ω  ";
  const newerA = "\n  newer A\t東京  \n";
  await prompt.fill(textB);
  await selectSession(page, a);
  await page.evaluate(id => { window.sessionDraftSmoke.holdSession = id; }, a.id);
  await prompt.fill("A accepted click");
  await page.locator("#sendButton").click();
  await expect(prompt).toHaveValue("");
  await prompt.fill(newerA);
  await selectSession(page, b);
  await expect(prompt).toHaveValue(textB);
  await expect.poll(() => page.evaluate(() => window.sessionDraftSmoke.held.length)).toBeGreaterThan(0);
  await page.evaluate(() => window.sessionDraftSmoke.releaseMessages());
  await expect(prompt).toHaveValue(textB);
  await selectSession(page, a);
  await expect(prompt).toHaveValue(newerA);
  await expect(page.locator(".message.assistant").last()).toContainText("Mock assistant received");
  await expect(page.locator("#statusBar")).not.toHaveClass(/\bbusy\b/);

  for (const [index, shortcut] of ["Control+Enter", "Meta+Enter"].entries()) {
    await selectSession(page, b);
    await prompt.press(shortcut);
    await expect(prompt).toHaveValue("");
    await expect(page.locator(".message.assistant")).toHaveCount(index + 1);
    await expect(page.locator(".message.assistant").last()).toContainText("Mock assistant received");
    await expect(page.locator("#statusBar")).not.toHaveClass(/\bbusy\b/);
    await prompt.fill(textB);
    await selectSession(page, a);
    await expect(prompt).toHaveValue(newerA);
  }
  expect((await sentPrompts(page)).map(message => message.sessionId)).toEqual([a.id, b.id, b.id]);

  await page.locator("#askFuraButton").click();
  const controller = "  controller while replies arrive\n  ";
  await prompt.fill(controller);
  const rejectedA = "  A delayed busy\nα  ";
  const rejectedB = "\n B delayed busy\tβ ";
  await page.evaluate(({ a, b, rejectedA, rejectedB }) => {
    const h = window.sessionDraftSmoke;
    h.emit({ type: "prompt.busy", sessionId: a, text: rejectedA });
    h.emit({ type: "prompt.busy", sessionId: b, text: rejectedB });
  }, { a: a.id, b: b.id, rejectedA, rejectedB });
  await expect(page.locator("#busyPromptOverlay")).toBeHidden();
  await expect(prompt).toHaveValue(controller);
  await replaySnapshot(page, a);
  await selectSession(page, a);
  await expect(page.locator("#busyPromptText")).toHaveValue(rejectedA);
  await page.locator("#busyPromptCancel").click();
  await expect(prompt).toHaveValue(`${rejectedA}\n\n${newerA}`);
  await selectSession(page, b);
  await expect(page.locator("#busyPromptText")).toHaveValue(rejectedB);
  await page.locator("#busyPromptCancel").click();
  await expect(prompt).toHaveValue(`${rejectedB}\n\n${textB}`);
  await page.locator("#askFuraButton").click();
  await expect(prompt).toHaveValue(controller);
});

test("failed disconnected send and real same-document reconnect preserve text and attachments", async ({ page }) => {
  const a = await createSession(page, "reconnect A");
  const b = await createSession(page, "reconnect B");
  const prompt = page.locator("#promptInput");
  const textB = "\n  B survives reconnect\t  ";
  await prompt.fill(textB);
  await selectSession(page, a);
  await prompt.fill("  A offline image\n  ");
  await paste(page);
  await expect(page.locator("#imagePreviews img")).toHaveCount(1);
  const exactA = await prompt.inputValue();
  // Force connection.send's false path without disabling the form via status changes.
  await page.evaluate(() => {
    Object.defineProperty(window.sessionDraftSmoke.sockets.at(-1)!, "readyState", { configurable: true, value: WebSocket.CLOSED });
  });
  await page.locator("#sendButton").click();
  await expect(prompt).toHaveValue(exactA);
  await expect(page.locator("#imagePreviews img")).toHaveCount(1);
  expect(await sentPrompts(page)).toEqual([]);
  await page.evaluate(() => {
    const socket = window.sessionDraftSmoke.sockets.at(-1)!;
    Reflect.deleteProperty(socket, "readyState");
    socket.close();
  });
  await expect.poll(() => page.evaluate(() => window.sessionDraftSmoke.sockets.length)).toBe(2);
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
  await expect(prompt).toHaveValue(exactA);
  await selectSession(page, b);
  await expect(prompt).toHaveValue(textB);
  await expect(page.locator("#imagePreviews")).toBeHidden();
  await selectSession(page, a);
  await expect(prompt).toHaveValue(exactA);
  await expect(page.locator("#imagePreviews img")).toHaveCount(1);
  await page.locator("#sendButton").click();
  await expect(prompt).toHaveValue("");
  await expect(page.locator(".message.user img")).toHaveCount(1);
  expect(await sentPrompts(page)).toEqual([{ sessionId: a.id, imageCount: 1, textLength: exactA.trim().length }]);
  await selectSession(page, b);
  await expect(prompt).toHaveValue(textB);
});

test("images and long snippets stay with their owner; late image reads cannot resurrect an accepted draft", async ({ page }) => {
  const a = await createSession(page, "attachments A");
  const b = await createSession(page, "attachments B");
  const prompt = page.locator("#promptInput");
  const textB = "  B has no attachments\n  ";
  await prompt.fill(textB);
  await selectSession(page, a);
  await prompt.fill("A attachment draft ");
  const snippet = `SNIPPET_OWNER_A\n${"  exact Ω 日本語\t\n".repeat(50)}END_SNIPPET_A`;
  await paste(page, snippet);
  await expect(page.locator("#imagePreviews .snippet-chip")).toHaveCount(1);
  await page.evaluate(() => { window.sessionDraftSmoke.deferImages = true; });
  await paste(page);
  await expect.poll(() => page.evaluate(() => window.sessionDraftSmoke.imageReads.length)).toBe(1);
  await selectSession(page, b);
  await page.evaluate(() => window.sessionDraftSmoke.releaseImages());
  await expect(prompt).toHaveValue(textB);
  await expect(page.locator("#imagePreviews")).toBeHidden();
  await page.locator("#askFuraButton").click();
  await expect(prompt).toHaveValue("");
  await expect(page.locator("#imagePreviews")).toBeHidden();
  await selectSession(page, a);
  await expect(page.locator("#imagePreviews img")).toHaveCount(1);
  await expect(page.locator("#imagePreviews .snippet-chip")).toHaveCount(1);
  const exactA = await prompt.inputValue();
  await selectSession(page, b);
  await selectSession(page, a);
  await expect(prompt).toHaveValue(exactA);
  // The second image is still reading when the first image/snippet draft is sent.
  await page.evaluate(() => { window.sessionDraftSmoke.deferImages = true; });
  await paste(page);
  await expect.poll(() => page.evaluate(() => window.sessionDraftSmoke.imageReads.length)).toBe(1);
  await page.locator("#sendButton").click();
  await expect(prompt).toHaveValue("");
  const newerA = "\n  new generation A\t  ";
  await prompt.fill(newerA);
  await selectSession(page, b);
  await page.evaluate(() => window.sessionDraftSmoke.releaseImages());
  await expect(prompt).toHaveValue(textB);
  await expect(page.locator("#imagePreviews")).toBeHidden();
  await selectSession(page, a);
  await expect(prompt).toHaveValue(newerA);
  await expect(page.locator("#imagePreviews")).toBeHidden();
  await expect(page.locator(".message.user").last()).toContainText("SNIPPET_OWNER_A");
  await expect(page.locator(".message.user").last()).toContainText("END_SNIPPET_A");
  await expect(page.locator(".message.user img")).toHaveCount(1);
  await expect(page.locator(".message.user").last()).not.toContainText("[Snippet");
  const sent = await sentPrompts(page);
  expect(sent).toHaveLength(1);
  expect(sent[0].sessionId).toBe(a.id);
  expect(sent[0].imageCount).toBe(1);
});

test("busy restoration retains the current draft through late image and voice results, failed send, and retirement", async ({ page }) => {
  const a = await createSession(page, "combined A");
  const b = await createSession(page, "combined B");
  const prompt = page.locator("#promptInput");
  const textB = "  unrelated B\n\t";
  await prompt.fill(textB);
  await selectSession(page, a);
  await prompt.fill("Rejected prior A ");
  await paste(page);
  await expect(page.locator("#imagePreviews img")).toHaveCount(1);
  const rejectedText = (await prompt.inputValue()).trim();
  await page.evaluate(id => { window.sessionDraftSmoke.holdSession = id; }, a.id);
  await page.locator("#sendButton").click();
  await expect(prompt).toHaveValue("");
  const newerA = "\n  LOCAL_AFTER_SEND_A Ω\t  ";
  await prompt.fill(newerA);
  const snippetText = `COMBINED_SNIPPET_A\n${"  exact 日本語\t\n".repeat(50)}END_COMBINED_SNIPPET_A`;
  await paste(page, snippetText);
  await expect(page.locator("#imagePreviews .snippet-chip")).toHaveCount(1);
  const localDraftBeforeBusy = await prompt.inputValue();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise<MediaStream>(() => {});
    window.sessionDraftSmoke.deferImages = true;
  });
  await page.locator("#voiceButton").click();
  await paste(page);
  await expect.poll(() => page.evaluate(() => window.sessionDraftSmoke.imageReads.length)).toBe(1);
  await selectSession(page, b);
  await page.evaluate(input => window.sessionDraftSmoke.emit({
    type: "prompt.busy", sessionId: input.id, text: input.text,
    images: [{ type: "image", data: input.png, mimeType: "image/png", detail: "high" }],
  }), { id: a.id, text: rejectedText, png: tinyPngBase64 });
  await expect(prompt).toHaveValue(textB);
  await selectSession(page, a);
  await expect(page.locator("#busyPromptOverlay")).toBeVisible();
  await page.locator("#busyPromptCancel").click();
  await expect(page.locator("#busyPromptOverlay")).toBeHidden();
  await expect(page.locator("#imagePreviews img")).toHaveCount(1);
  await expect(page.locator("#imagePreviews .snippet-chip")).toHaveCount(1);
  const restoredBeforeAsync = `${rejectedText}\n\n${localDraftBeforeBusy}`;
  await expect(prompt).toHaveValue(restoredBeforeAsync);
  await selectSession(page, b);
  await page.evaluate(async () => {
    window.sessionDraftSmoke.emit({ type: "voice.delta", targetClientId: sessionStorage.getItem("fura.controlClientId")!, itemId: "combined-voice", text: "ASYNC_VOICE_A" });
    await window.sessionDraftSmoke.releaseImages();
  });
  await expect(prompt).toHaveValue(textB);
  await expect(page.locator("#imagePreviews")).toBeHidden();
  await selectSession(page, a);
  await expect(page.locator("#imagePreviews img")).toHaveCount(2);
  await expect(page.locator("#imagePreviews .snippet-chip")).toHaveCount(1);
  const imageMarker = `[${await page.locator("#imagePreviews img").nth(1).getAttribute("alt")}]`;
  const restoredA = `${restoredBeforeAsync} ASYNC_VOICE_A ${imageMarker}`;
  await expect(prompt).toHaveValue(restoredA);
  await paste(page, "REMOVE_ONLY_THIS_SNIPPET\n".repeat(30));
  await expect(page.locator("#imagePreviews .snippet-chip")).toHaveCount(2);
  await page.locator("#imagePreviews .snippet-chip .image-remove").last().click();
  await expect(page.locator("#imagePreviews .snippet-chip")).toHaveCount(1);
  await expect(prompt).toHaveValue(restoredA);
  await paste(page);
  await expect(page.locator("#imagePreviews img")).toHaveCount(3);
  await page.locator("#imagePreviews .image-thumb .image-remove").last().click();
  await expect(page.locator("#imagePreviews img")).toHaveCount(2);
  await expect(prompt).toHaveValue(restoredA);
  await page.evaluate(text => { window.sessionDraftSmoke.expectedPromptText = text; },
    expandSnippetTokens(restoredA, [{ type: "snippet", marker: localDraftBeforeBusy.slice(newerA.length), text: snippetText }]));
  const beforeFailedSend = await sentPrompts(page);
  await page.evaluate(() => { Object.defineProperty(window.sessionDraftSmoke.sockets.at(-1)!, "readyState", { configurable: true, value: WebSocket.CLOSED }); });
  await page.locator("#sendButton").click();
  await expect(prompt).toHaveValue(restoredA);
  expect(await sentPrompts(page)).toEqual(beforeFailedSend);
  await expect(page.locator("#imagePreviews img")).toHaveCount(2);
  await expect(page.locator("#imagePreviews .snippet-chip")).toHaveCount(1);
  await page.evaluate(() => {
    Reflect.deleteProperty(window.sessionDraftSmoke.sockets.at(-1)!, "readyState");
    window.sessionDraftSmoke.deferImages = true;
  });
  await paste(page);
  await expect.poll(() => page.evaluate(() => window.sessionDraftSmoke.imageReads.length)).toBe(1);
  await page.locator("#sendButton").click();
  await expect(prompt).toHaveValue("");
  await prompt.fill("  retired owner must not replace new A\t");
  await selectSession(page, b);
  await page.evaluate(async () => {
    window.sessionDraftSmoke.emit({ type: "voice.final", targetClientId: sessionStorage.getItem("fura.controlClientId")!, itemId: "combined-voice", text: "RETIRED_VOICE_RESULT" });
    await window.sessionDraftSmoke.releaseImages();
    window.sessionDraftSmoke.releaseMessages();
  });
  await expect(prompt).toHaveValue(textB);
  await expect(page.locator("#imagePreviews")).toBeHidden();
  await selectSession(page, a);
  await expect(prompt).toHaveValue("  retired owner must not replace new A\t");
  await expect(page.locator("#imagePreviews")).toBeHidden();
  await expect(page.locator(".message.user").last()).toContainText("COMBINED_SNIPPET_A");
  await expect(page.locator(".message.user").last()).toContainText("END_COMBINED_SNIPPET_A");
  await expect(page.locator(".message.user").last()).not.toContainText("[Snippet");
  const sent = (await sentPrompts(page)).at(-1)!;
  expect(sent).toMatchObject({ sessionId: a.id, imageCount: 2, textMatchesFixture: true });
  expect(sent.imageDetails).toEqual([
    { type: "image", mimeType: "image/png", detail: "high", dataMatchesFixture: true },
    { type: "image", mimeType: "image/png", dataMatchesFixture: true },
  ]);
  await page.screenshot({ path: test.info().outputPath("combined-draft-after-retirement.png"), fullPage: true });
});
