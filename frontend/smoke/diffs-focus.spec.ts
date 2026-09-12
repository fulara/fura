import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import type { ClientMessage, ServerMessage } from "../src/protocol";

// External Playwright config supplies baseURL and an isolated mock-OMP bridge.
// Window lifecycle events below are explicitly synthetic: Playwright focus
// emulation cannot establish native OS blur, Alt-Tab, or background throttling.
declare global {
  interface Window {
    __diffFocusDelivered: string[];
    __diffFocusInputEvents: string[];
    __diffFocusNativeClose: boolean;
    __diffFocusPopout: Window;
  }
}
const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "",
};
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-c", "commit.gpgsign=false", "-C", root, ...args], {
    env: gitEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
type Repo = {
  root: string;
  label: string;
  base: string;
  head: string;
  topic: string[];
  put(value: string): void;
  cleanup(): void;
};
function fixture(label: string): Repo {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `fura-diffs-focus-${label}-`)));
  const put = (value: string) => writeFileSync(path.join(root, "review.txt"),
    Array.from({ length: 100 }, (_, index) => `${label}_${value}_${index}`).join("\n") + "\n");
  const commit = (value: string) => {
    put(value);
    writeFileSync(path.join(root, "other.txt"), `${label}_${value}_OTHER\n`);
    git(root, "add", ".");
    git(root, "commit", "-qm", `${label} ${value}\n\nDESCRIPTION_${value}`);
    return git(root, "rev-parse", "HEAD");
  };
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Diff Focus Reviewer");
    git(root, "config", "user.email", "diff-focus@example.invalid");
    const base = commit("BASE");
    git(root, "checkout", "-qb", "topic");
    const topic = Array.from({ length: 18 }, (_, index) => commit(`TOPIC_${index + 1}`));
    git(root, "checkout", "-q", "main");
    const head = commit("MAIN");
    put("WORKTREE");
    return { root, label, base, head, topic, put, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
type DiffRequest = Extract<ClientMessage, { type: "sessionChanges.request" | "compareDiff.request" | "git.rangeDiff.request" }>;
function requestId(message: DiffRequest) { return "diffId" in message ? message.diffId : message.requestId; }
function answers(message: ServerMessage, request: DiffRequest) {
  if (message.type === "sessionChanges.summary" || message.type === "compareDiff.summary") return message.state.diffId === requestId(request);
  if (message.type === "git.rangeDiff") return message.requestId === requestId(request);
  return false;
}
type Wire = {
  requests: ClientMessage[];
  responses: ServerMessage[];
  held: Array<{ message: ServerMessage; send(): void }>;
  delivered(): Promise<void>;
  hold(): Promise<number>;
  pending(boundary: number, type?: DiffRequest["type"]): Promise<DiffRequest>;
  release(): Promise<void>;
};
async function transport(page: Page): Promise<Wire> {
  const requests: ClientMessage[] = [], responses: ServerMessage[] = [];
  const forwarded: string[] = [], held: Array<{ message: ServerMessage; send(): void }> = [];
  let holding = false;
  // Observer only: no app globals, code replacement, or invented server replies.
  await page.routeWebSocket("**/ws**", route => {
    const server = route.connectToServer();
    route.onMessage(data => { requests.push(JSON.parse(data.toString())); server.send(data); });
    server.onMessage(data => {
      const text = data.toString(), message: ServerMessage = JSON.parse(text);
      responses.push(message);
      const send = () => { forwarded.push(text); route.send(data); };
      if (holding) held.push({ message, send });
      else send();
    });
  });
  const delivered = async () => {
    const expected = forwarded.slice();
    await expect.poll(() => page.evaluate(count => window.__diffFocusDelivered.slice(0, count), expected.length)).toEqual(expected);
  };
  return {
    requests, responses, held, delivered,
    async hold() {
      await delivered();
      holding = true;
      return requests.length;
    },
    async pending(boundary: number, type: DiffRequest["type"] = "sessionChanges.request") {
      await expect.poll(() => requests.slice(boundary).find(message => message.type === type)).toBeDefined();
      const request = requests.slice(boundary).find(message => message.type === type);
      if (!request || (request.type !== "sessionChanges.request" && request.type !== "compareDiff.request" && request.type !== "git.rangeDiff.request")) {
        throw new Error(`Missing observed ${type}`);
      }
      await expect.poll(() => held.some(frame => answers(frame.message, request))).toBe(true);
      // A real response exists in the FIFO and none of the held frames has been
      // delivered. This is the pending boundary used by all DOM assertions.
      await delivered();
      expect(await page.evaluate(() => window.__diffFocusDelivered)).toEqual(forwarded);
      expect(held.length).toBeGreaterThan(0);
      return request;
    },
    async release() {
      expect(holding).toBe(true);
      const batch = held.splice(0);
      for (const frame of batch) frame.send();
      holding = false;
      await delivered();
      expect(held).toEqual([]);
    },
  };
}
const diffs = (page: Page) => page.locator(".session-changes-view:visible");
const compare = (page: Page) => page.locator(".compare-view:visible");
const tab = (page: Page, title: string) => page.locator(".dv-tab:visible").filter({ hasText: new RegExp(`^${title}$`) });
const group = (page: Page, title: string) => page.locator(".dv-groupview:visible").filter({ has: tab(page, title) });
async function authenticate(page: Page) {
  await page.goto("/");
  // Install after Playwright's routing shim, before authentication creates the
  // application's socket. Init-script order otherwise observes pre-routing data.
  await page.evaluate(() => {
    const delivered: string[] = [];
    window.__diffFocusDelivered = delivered;
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const deliveredTask = new MessageChannel();
        deliveredTask.port1.onmessage = event => delivered.push(String(event.data));
        this.addEventListener("message", event => {
          // A task fence runs after the complete WebSocket dispatch, including
          // application listeners. Unlike a microtask it cannot run between
          // separate listeners. No delay or polling guesses delivery order.
          deliveredTask.port2.postMessage(String(event.data));
        });
        this.addEventListener("close", () => {
          deliveredTask.port1.close();
          deliveredTask.port2.close();
        });
      }
    };
  });
  await page.locator("#authTokenInput").fill(process.env.FURA_SMOKE_TOKEN ?? "dev");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}
async function createSession(page: Page, repo: Repo, name = `${repo.label} ${Date.now()}`) {
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerNameInput").fill(name);
  await page.locator("#cwdPickerInput").fill(repo.root);
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(page.locator("#sessionTitle")).toContainText(name);
  return name;
}
async function selectSession(page: Page, name: string) {
  await page.locator("#sessionsList .session-item").filter({ hasText: name }).locator("button").first().click();
  await expect(page.locator("#sessionTitle")).toContainText(name);
}
async function selectFile(view: Locator) {
  await view.locator('.diffs-file-jump[data-diff-file-path="review.txt"]').click();
  await expect(view.locator('.diffs-file-jump.active[data-diff-file-path="review.txt"]')).toBeVisible();
  await expect(view.locator(".diff-line-add").first()).toBeVisible();
}
async function openDiffs(page: Page, repo: Repo, mode: "History" | "Current changes") {
  await tab(page, "Git changes").click();
  await expect(diffs(page).getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await diffs(page).getByRole("button", { name: mode, exact: true }).click();
  if (mode === "History") {
    await diffs(page).getByRole("button", { name: "History branch", exact: true }).click();
    await diffs(page).getByRole("combobox", { name: "Filter History branches", exact: true }).fill("refs/heads/topic");
    await diffs(page).getByRole("option").and(diffs(page).getByTitle("refs/heads/topic", { exact: true })).click();
    await diffs(page).locator(`[data-commit-oid="${repo.topic[9]}"]`).click();
    await expect(diffs(page).locator(".diff-commit-message")).toContainText(repo.topic[9]);
    await diffs(page).locator(".diff-commit-message > summary").click();
  }
  await selectFile(diffs(page));
  const restore = diffs(page).getByRole("button", { name: "Restore layout", exact: true });
  if (await restore.isVisible()) await restore.click();
  await expect(diffs(page).locator(".diff-line-add").first()).toBeVisible();
}
async function historyIdentity(page: Page, repo: Repo) {
  const view = diffs(page);
  await expect(view.getByRole("button", { name: "History", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(view.getByRole("button", { name: "History branch", exact: true })).toHaveAttribute("title", "refs/heads/topic");
  await expect(view.locator(".git-root-path")).toHaveText(repo.root);
  await expect(view.locator(".diff-commit-message")).toContainText(repo.topic[9]);
  await expect(view.locator(".diff-commit-message")).toHaveJSProperty("open", true);
  await expect(view.locator(".diff-commit-message pre")).toContainText("DESCRIPTION_TOPIC_10");
  await expect(view.locator('.diffs-file-jump.active[data-diff-file-path="review.txt"]')).toBeVisible();
  await expect(view.locator(".diffs-main")).toContainText(`${repo.label}_TOPIC_10_`);
}
async function activateTranscript(page: Page) {
  await tab(page, "Transcript").click();
  await page.locator(".panel-content-transcript:visible").click({ position: { x: 20, y: 30 } });
  await expect(group(page, "Transcript")).toHaveClass(/dv-active-group/);
}
async function inactive(page: Page, title: string, view: Locator) {
  await expect(group(page, title)).toHaveClass(/dv-inactive-group/);
  await expect(tab(page, title)).toHaveClass(/dv-active-tab/);
  await expect(view).toBeVisible();
  await expect.poll(() => view.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.isConnected && rect.width > 0 && rect.height > 0;
  })).toBe(true);
}
async function popout(page: Page, title: string) {
  const opened = page.waitForEvent("popup");
  await group(page, title).locator(".panel-popout-btn").click();
  const child = await opened;
  child.on("pageerror", error => { throw error; });
  await expect(tab(child, title)).toBeVisible();
  return child;
}
type Layout = "docked split" | "review popout" | "Transcript popout";
async function layout(page: Page, title: string, kind: Layout) {
  const child = kind === "docked split" ? null : await popout(page, kind === "review popout" ? title : "Transcript");
  return { review: kind === "review popout" ? child! : page, transcript: kind === "Transcript popout" ? child! : page, child };
}
async function resizeReview(review: Page, main: Page, size: { width: number; height: number }) {
  if (review !== main) {
    // Drain any older layout save first, otherwise it could serialize the new
    // size before Dockview's resize-end callback has actually completed.
    for (const [title, id] of [["Goal", "goal"], ["Transcript", "transcript"]]) {
      await tab(main, title).click();
      await expect.poll(() => main.evaluate(expected => {
        const saved = JSON.parse(localStorage.getItem("fura.dockview.layout") ?? "{}");
        function selected(value: unknown): boolean {
          return Boolean(value && typeof value === "object"
            && (("activeView" in value && value.activeView === expected) || Object.values(value).some(selected)));
        }
        return selected(saved.layout);
      }, id)).toBe(true);
    }
  }
  await review.setViewportSize(size);
  if (review === main) return;
  // Observe Dockview/Fura's persisted resize completion, not an arbitrary sleep.
  // Dockview 5.2 can otherwise run its uncancelled resize-end callback after close.
  const actual = await review.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await expect.poll(() => main.evaluate(expected => {
    const saved = JSON.parse(localStorage.getItem("fura.dockview.layout") ?? "{}");
    return saved.layout?.popoutGroups?.some((group: { position?: { width: number; height: number } }) =>
      group.position?.width === expected.width && group.position?.height === expected.height) ?? false;
  }, actual)).toBe(true);
}

async function nativeRedock(child: Page, page: Page, title: string, visible = true) {
  await page.evaluate(() => { window.__diffFocusNativeClose = false; });
  await child.evaluate(() => {
    window.addEventListener("beforeunload", () => {
      window.opener.__diffFocusNativeClose = true;
    }, { capture: true, once: true });
  });
  const closed = child.waitForEvent("close");
  // Use the browser's close lifecycle. CDP Page.close can bypass beforeunload
  // in Chromium; the opener-side assertion proves this is a real redock.
  await child.evaluate(() => window.close());
  await closed;
  expect(await page.evaluate(() => window.__diffFocusNativeClose)).toBe(true);
  if (visible) await expect(tab(page, title)).toBeVisible();
}
async function acceptedContent(wire: Wire, request: DiffRequest) {
  await expect.poll(() => wire.responses.some(message => message.type === "diff.content" && message.content.diffId === requestId(request))).toBe(true);
  await wire.delivered();
}
async function refreshing(view: Locator) {
  // A retained patch must not masquerade as a completed refresh. Accept either
  // semantic busy state or readable progress; do not pin incidental wording.
  await expect.poll(async () => await view.locator('[aria-busy="true"]').count() > 0
    || await view.getAttribute("aria-busy") === "true"
    || /refreshing|updating|loading/i.test(await view.innerText())).toBe(true);
}
async function openCompare(page: Page, repo: Repo, mode: "files" | "rangeDiff") {
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerDiffTab").click();
  await page.locator("#cwdPickerDiffMode").selectOption(mode === "files" ? "full" : "rangeDiff");
  await page.locator("#cwdPickerDiffRepo").fill(repo.root);
  await page.locator("#cwdPickerDiffBase").fill(repo.base);
  if (mode === "rangeDiff") await page.locator("#cwdPickerDiffOld").fill(repo.topic[8]);
  await page.locator("#cwdPickerDiffHead").fill(repo.topic[9]);
  if (mode === "files") await page.locator("#cwdPickerDiffAgentSession").uncheck();
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  if (mode === "files") await selectFile(compare(page));
  else await expect(compare(page).locator(".range-diff-output")).toContainText(`${repo.label} TOPIC_10`);
}

test.use({ viewport: { width: 1600, height: 1100 }, serviceWorkers: "block" });
test.beforeEach(({ page }) => {
  test.setTimeout(90_000);
  page.on("pageerror", error => { throw error; });
});

for (const mode of ["History", "Current changes"] as const) {
  for (const kind of ["docked split", "review popout", "Transcript popout"] as const) {
    test(`${mode}: Refresh then Transcript renders accepted FIFO results while visible inactive (${kind})`, async ({ page }) => {
      const repo = fixture("refresh"), wire = await transport(page);
      try {
        await authenticate(page); await createSession(page, repo); await openDiffs(page, repo, mode);
        const windows = await layout(page, "Git changes", kind), view = diffs(windows.review);
        const marker = `${repo.label}_${mode === "History" ? "TOPIC_10" : "WORKTREE"}_`;
        await expect(view.locator(".diffs-main")).toContainText(marker);
        if (mode === "Current changes") repo.put("REFRESHED");
        const boundary = await wire.hold();
        await view.getByRole("button", { name: "Refresh", exact: true }).click();
        const request = await wire.pending(boundary);
        await activateTranscript(windows.transcript);
        await inactive(windows.review, "Git changes", view);
        // Soft pending assertions keep the independent accepted-result boundary
        // observable even when the initial retention regression is still RED.
        await expect.soft(view.locator(".diffs-main")).toContainText(marker);
        await refreshing(view);
        await wire.release();
        if (mode === "Current changes") await acceptedContent(wire, request);
        await inactive(windows.review, "Git changes", view);
        await expect(view.locator(".diffs-main")).toContainText(mode === "History" ? marker : `${repo.label}_REFRESHED_`);
        if (mode === "History") await historyIdentity(windows.review, repo);
        await expect(view.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
        await resizeReview(windows.review, page, { width: 1450, height: 950 });
        await inactive(windows.review, "Git changes", view);
        await expect(view.locator(".diff-line-add").first()).toBeVisible();
        if (windows.child) {
          await nativeRedock(windows.child, page, kind === "review popout" ? "Git changes" : "Transcript");
          await expect(diffs(page).locator(".diffs-main")).toContainText(mode === "History" ? marker : `${repo.label}_REFRESHED_`);
        }
      } finally { repo.cleanup(); }
    });
  }
}

for (const kind of ["review popout", "Transcript popout"] as const) {
  test(`loaded History retains ref/OID/file/description and both scrolls through stream, transfer and refocus (${kind})`, async ({ page }) => {
    const repo = fixture("scroll"), wire = await transport(page);
    try {
      await authenticate(page); await createSession(page, repo); await openDiffs(page, repo, "History");
      const selectors = [".diffs-main-body", ".git-history-list"];
      for (const selector of selectors) {
        await diffs(page).locator(selector).evaluate(element => { element.scrollTop = 40; });
        await expect.poll(() => diffs(page).locator(selector).evaluate(element => element.scrollTop)).toBe(40);
      }
      const windows = await layout(page, "Git changes", kind);
      await historyIdentity(windows.review, repo);
      for (const selector of selectors) await expect.poll(() => diffs(windows.review).locator(selector).evaluate(element => element.scrollTop)).toBe(40);
      await activateTranscript(windows.transcript);
      await inactive(windows.review, "Git changes", diffs(windows.review));
      // Real fixture stream: partial tool updates plus transcript completion,
      // not a forged projection or a timer used to infer readiness.
      await page.locator("#promptInput").fill("mock highlight focus regression");
      await page.locator("#sendButton").click();
      await expect(windows.transcript.locator(".message.assistant")).toContainText("Highlight fixture complete.");
      await wire.delivered();
      await historyIdentity(windows.review, repo);
      for (const selector of selectors) await expect.poll(() => diffs(windows.review).locator(selector).evaluate(element => element.scrollTop)).toBe(40);
      // All retained-content assertions above precede reactivation.
      await tab(windows.review, "Git changes").click();
      await historyIdentity(windows.review, repo);
      for (const selector of selectors) await expect.poll(() => diffs(windows.review).locator(selector).evaluate(element => element.scrollTop)).toBe(40);
      await activateTranscript(windows.transcript);
      await nativeRedock(windows.child!, page, kind === "review popout" ? "Git changes" : "Transcript");
      await historyIdentity(page, repo);
      for (const selector of selectors) await expect.poll(() => diffs(page).locator(selector).evaluate(element => element.scrollTop)).toBe(40);
    } finally { repo.cleanup(); }
  });
}

for (const mode of ["files", "rangeDiff"] as const) {
  for (const kind of ["docked split", "review popout", "Transcript popout"] as const) {
    test(`Compare ${mode}: pending and ready remain readable without activation (${kind})`, async ({ page }) => {
      const repo = fixture("compare"), wire = await transport(page);
      try {
        await authenticate(page); await createSession(page, repo); await openCompare(page, repo, mode);
        const windows = await layout(page, "Compare", kind), view = compare(windows.review);
        const output = view.locator(mode === "files" ? ".diffs-main" : ".range-diff-output");
        const marker = mode === "files" ? `${repo.label}_TOPIC_10_` : `${repo.label} TOPIC_10`;
        await activateTranscript(windows.transcript);
        await inactive(windows.review, "Compare", view);
        await expect(output).toContainText(marker);
        await tab(windows.review, "Compare").click();
        const boundary = await wire.hold();
        await view.getByRole("button", { name: "Compare", exact: true }).click();
        await wire.pending(boundary, mode === "files" ? "compareDiff.request" : "git.rangeDiff.request");
        await activateTranscript(windows.transcript);
        await inactive(windows.review, "Compare", view);
        await expect.soft(output).toContainText(marker);
        await refreshing(view);
        await wire.release();
        await expect(output).toContainText(marker);
        await expect(view).not.toContainText(/Loading (compare diff|range-diff)/);
        await inactive(windows.review, "Compare", view);
        await resizeReview(windows.review, page, { width: 1500, height: 1000 });
        await expect(output).toContainText(marker);
        if (windows.child) {
          await nativeRedock(windows.child, page, kind === "review popout" ? "Compare" : "Transcript");
          await expect(compare(page).locator(mode === "files" ? ".diffs-main" : ".range-diff-output")).toContainText(marker);
        }
      } finally { repo.cleanup(); }
    });
  }
}

for (const event of ["window focus", "document visibility return"] as const) {
  for (const mode of ["History", "Current changes"] as const) {
    for (const popped of [false, true]) {
      test(`synthetic ${event}: ${mode} refreshes visible inactive ${popped ? "popout" : "main document"} without stealing input`, async ({ page }) => {
        const repo = fixture("lifecycle"), wire = await transport(page);
        try {
          await authenticate(page); await createSession(page, repo); await openDiffs(page, repo, mode);
          const child = popped ? await popout(page, "Git changes") : null;
          const review = child ?? page, view = diffs(review);
          // Leave a focused search input in the review document, then move
          // actual DOM focus to the main composer before asynchronous rendering.
          await view.locator(".diff-filter-input").fill("review");
          await activateTranscript(page);
          await page.locator("#promptInput").fill("keep this draft");
          await page.locator("#promptInput").focus();
          const draft = await page.locator("#promptInput").elementHandle();
          if (mode === "History") {
            // Advance the selected branch without checkout. The old selected
            // commit remains immutable even though the branch tip moves.
            const tree = git(repo.root, "rev-parse", `${repo.topic[17]}^{tree}`);
            const next = git(repo.root, "commit-tree", tree, "-p", repo.topic[17], "-m", "New topic tip");
            git(repo.root, "update-ref", "refs/heads/topic", next);
          }
          repo.put("LIFECYCLE_NEW");
          const boundary = await wire.hold();
          await review.evaluate(kind => {
            if (kind === "window focus") window.dispatchEvent(new Event("focus"));
            else {
              Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
              document.dispatchEvent(new Event("visibilitychange"));
              Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
              document.dispatchEvent(new Event("visibilitychange"));
              Reflect.deleteProperty(document, "visibilityState");
            }
          }, event);
          const request = await wire.pending(boundary);
          await activateTranscript(page);
          await page.locator("#promptInput").focus();
          await review.evaluate(() => {
            window.__diffFocusInputEvents = [];
            document.addEventListener("focusin", event => {
              if (event.target instanceof Element && event.target.closest(".session-changes-view")) {
                window.__diffFocusInputEvents.push(event.target.tagName);
              }
            });
          });
          expect(request.type).toBe("sessionChanges.request");
          if (request.type === "sessionChanges.request") expect(request.currentCommitOid ?? null).toBe(mode === "History" ? repo.topic[9] : null);
          await inactive(review, "Git changes", view);
          await expect.soft(view.locator(".diffs-main")).toContainText(`${repo.label}_${mode === "History" ? "TOPIC_10" : "WORKTREE"}_`);
          await refreshing(view);
          await wire.release();
          if (mode === "Current changes") await acceptedContent(wire, request);
          await inactive(review, "Git changes", view);
          if (mode === "History") await historyIdentity(review, repo);
          else await expect(view.locator(".diffs-main")).toContainText(`${repo.label}_LIFECYCLE_NEW_`);
          await expect(page.locator("#promptInput")).toBeFocused();
          expect(await page.evaluate(element => document.activeElement === element, draft)).toBe(true);
          expect(await review.evaluate(() => window.__diffFocusInputEvents)).toEqual([]);
          await expect(page.locator("#promptInput")).toHaveValue("keep this draft");
          if (child) {
            // Browsers can retain activeElement in both documents; a real
            // focus event on this stale review input would still steal focus.
            await expect(view.locator(".diff-filter-input")).toHaveValue("review");
            await nativeRedock(child, page, "Git changes");
          }
        } finally { repo.cleanup(); }
      });
    }
  }
}

test("visible inactive Diffs follows session A/B/A and rejects a held response from A", async ({ page }) => {
  const a = fixture("session-A"), b = fixture("session-B"), wire = await transport(page);
  try {
    await authenticate(page);
    const nameA = await createSession(page, a), nameB = await createSession(page, b);
    await openDiffs(page, b, "History");
    await selectSession(page, nameA); await openDiffs(page, a, "History");
    const boundary = await wire.hold();
    await diffs(page).getByRole("button", { name: "Refresh", exact: true }).click();
    await wire.pending(boundary);
    await activateTranscript(page);
    await selectSession(page, nameB);
    await inactive(page, "Git changes", diffs(page));
    // A cannot remain readable under B's identity while B's reply is withheld.
    await expect.soft(diffs(page).locator(".diffs-main")).not.toContainText("session-A_TOPIC_10_");
    await wire.release();
    await expect(diffs(page).locator(".git-root-path")).toHaveText(b.root);
    await expect(diffs(page).locator(".diffs-main")).toContainText("session-B_");
    await expect(diffs(page).locator(".diffs-main")).not.toContainText("session-A_");
    await inactive(page, "Git changes", diffs(page));
    await selectSession(page, nameA);
    await expect(diffs(page).locator(".git-root-path")).toHaveText(a.root);
    await expect(diffs(page).locator(".diffs-main")).toContainText("session-A_");
    await expect(diffs(page).locator(".diffs-main")).not.toContainText("session-B_");
    await inactive(page, "Git changes", diffs(page));
  } finally { a.cleanup(); b.cleanup(); }
});

test("repository switch completes while inactive and cannot revive the held previous repository", async ({ page }) => {
  const a = fixture("repo-A"), b = fixture("repo-B"), wire = await transport(page);
  try {
    await authenticate(page); await createSession(page, a); await openDiffs(page, a, "History");
    await diffs(page).locator(".git-review-options > summary").click();
    page.once("dialog", dialog => dialog.accept(b.root));
    await diffs(page).getByRole("button", { name: "Add", exact: true }).click();
    const selector = diffs(page).getByRole("combobox", { name: "Repository", exact: true });
    await expect(selector.locator("option").filter({ hasText: path.basename(b.root) })).toHaveCount(1);
    await selector.selectOption(a.root);
    await expect(diffs(page).getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    const boundary = await wire.hold();
    await diffs(page).getByRole("button", { name: "Refresh", exact: true }).click();
    await wire.pending(boundary);
    await selector.selectOption(b.root);
    await activateTranscript(page);
    await inactive(page, "Git changes", diffs(page));
    await expect.soft(diffs(page).locator(".diffs-main")).not.toContainText("repo-A_TOPIC_10_");
    await wire.release();
    await expect(diffs(page).locator(".git-root-path")).toHaveText(b.root);
    await expect(diffs(page).locator(".diffs-main")).toContainText("repo-B_");
    await expect(diffs(page).locator(".diffs-main")).not.toContainText("repo-A_");
    await inactive(page, "Git changes", diffs(page));
  } finally { a.cleanup(); b.cleanup(); }
});

for (const mode of ["files", "rangeDiff"] as const) {
  test(`explicit Compare ${mode} ignores global session changes and rejects superseded FIFO results`, async ({ page }) => {
    const a = fixture("context-A"), b = fixture("context-B"), wire = await transport(page);
    try {
      await authenticate(page);
      const nameA = await createSession(page, a);
      const nameB = await createSession(page, b);
      await selectSession(page, nameA);
      await openCompare(page, a, mode);
      await activateTranscript(page);
      await selectSession(page, nameB);
      await inactive(page, "Compare", compare(page));
      await expect(compare(page).getByRole("textbox", { name: "Repository", exact: true })).toHaveValue(a.root);
      const output = compare(page).locator(mode === "files" ? ".diffs-main" : ".range-diff-output");
      await expect(output).toContainText(mode === "files" ? "context-A_TOPIC_10_" : "context-A TOPIC_10");
      await tab(page, "Compare").click();
      const boundary = await wire.hold();
      await compare(page).getByRole("button", { name: "Compare", exact: true }).click();
      await wire.pending(boundary, mode === "files" ? "compareDiff.request" : "git.rangeDiff.request");
      await compare(page).getByRole("textbox", { name: "Repository", exact: true }).fill(b.root);
      await compare(page).getByRole("textbox", { name: "Base", exact: true }).fill(b.base);
      if (mode === "rangeDiff") await compare(page).getByRole("textbox", { name: "Old", exact: true }).fill(b.topic[8]);
      await compare(page).getByRole("textbox", { name: mode === "files" ? "Head" : "New", exact: true }).fill(b.topic[9]);
      const nextBoundary = wire.requests.length;
      await compare(page).getByRole("button", { name: "Compare", exact: true }).click();
      const next = await wire.pending(nextBoundary, mode === "files" ? "compareDiff.request" : "git.rangeDiff.request");
      await activateTranscript(page);
      await expect.soft(compare(page)).not.toContainText(mode === "files" ? "context-A_TOPIC_10_" : "context-A TOPIC_10");
      await wire.release();
      if (mode === "files") await acceptedContent(wire, next);
      await inactive(page, "Compare", compare(page));
      await expect(output).toContainText(mode === "files" ? "context-B_TOPIC_10_" : "context-B TOPIC_10");
      await expect(output).not.toContainText("context-A");
      await expect(compare(page).getByRole("textbox", { name: "Repository", exact: true })).toHaveValue(b.root);
    } finally { a.cleanup(); b.cleanup(); }
  });
}

for (const dirty of [true, false]) {
  test(`genuinely showing a hidden Diffs tab chooses ${dirty ? "Current changes" : "History"}; hidden tabs do not fetch patches`, async ({ page }) => {
    const repo = fixture("entry"), wire = await transport(page);
    try {
      await authenticate(page); await createSession(page, repo); await openDiffs(page, repo, "History");
      // Compare is a real sibling tab in the same installed Dockview group.
      await openCompare(page, repo, "files");
      await expect(diffs(page)).toBeHidden();
      if (!dirty) git(repo.root, "restore", "--worktree", ".");
      const boundary = wire.requests.length;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      // A completed unrelated wire round trip bounds the negative assertion;
      // never use a sleep to guess that the lifecycle handler has run.
      const compareBoundary = await wire.hold();
      await compare(page).getByRole("button", { name: "Compare", exact: true }).click();
      await wire.pending(compareBoundary, "compareDiff.request");
      await wire.release();
      await expect(compare(page).locator(".diff-line-add").first()).toBeVisible();
      expect(wire.requests.slice(boundary).filter(message => message.type === "diff.content.request" && message.scope === "sessionChanges")).toEqual([]);
      await expect(diffs(page)).toBeHidden();
      await tab(page, "Git changes").click();
      await expect(diffs(page).getByRole("button", { name: dirty ? "Current changes" : "History", exact: true })).toHaveAttribute("aria-pressed", "true");
      if (dirty) await expect(diffs(page).locator(".diffs-main")).toContainText("entry_WORKTREE_");
      else {
        await expect(diffs(page).locator(".diff-commit-message")).toBeVisible();
        await expect(diffs(page).locator(".diff-line-add").first()).toBeVisible();
        await expect(diffs(page).locator(".diffs-main")).not.toContainText("entry_WORKTREE_");
      }
    } finally { repo.cleanup(); }
  });
}

test("same-target Current refresh retains readable content and a real Git error while inactive, then recovers", async ({ page }) => {
  const repo = fixture("error"), wire = await transport(page);
  const indexPath = path.join(repo.root, ".git", "index"), index = readFileSync(indexPath);
  try {
    await authenticate(page); await createSession(page, repo); await openDiffs(page, repo, "Current changes");
    const child = await popout(page, "Git changes"), view = diffs(child);
    // Break only this disposable fixture's index. The bridge produces the real
    // Git failure; no synthetic diff.error payload or transport disconnect.
    writeFileSync(indexPath, "deliberately invalid fixture index");
    const boundary = await wire.hold();
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => wire.requests.slice(boundary).some(message => message.type === "sessionChanges.request")).toBe(true);
    const failed = wire.requests.slice(boundary).find(message => message.type === "sessionChanges.request");
    if (!failed || failed.type !== "sessionChanges.request") throw new Error("Missing failing refresh request");
    await expect.poll(() => wire.held.some(frame => frame.message.type === "diff.error" && frame.message.diffId === failed.diffId)).toBe(true);
    await wire.delivered();
    await activateTranscript(page);
    await inactive(child, "Git changes", view);
    await wire.release();
    await expect(view.locator(".diffs-main")).toContainText("error_WORKTREE_");
    await expect(view.locator(".diffs-error, [role='alert']").first()).toBeVisible();
    await expect(view.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await inactive(child, "Git changes", view);
    writeFileSync(indexPath, index);
    repo.put("RECOVERED");
    const retryBoundary = await wire.hold();
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    const retry = await wire.pending(retryBoundary);
    await activateTranscript(page);
    await wire.release();
    await acceptedContent(wire, retry);
    await expect(view.locator(".diffs-main")).toContainText("error_RECOVERED_");
    await expect(view.locator(".diffs-error, [role='alert']")).toHaveCount(0);
    await inactive(child, "Git changes", view);
    await nativeRedock(child, page, "Git changes");
  } finally { repo.cleanup(); }
});

for (const mode of ["files", "rangeDiff"] as const) {
  test(`hidden Compare ${mode} defers rendering until genuinely shown and keeps explicit context`, async ({ page }) => {
    const repo = fixture("hidden-compare"), wire = await transport(page);
    try {
      await authenticate(page); await createSession(page, repo); await openDiffs(page, repo, "History");
      await openCompare(page, repo, mode);
      const boundary = await wire.hold();
      await compare(page).getByRole("button", { name: "Compare", exact: true }).click();
      const request = await wire.pending(boundary, mode === "files" ? "compareDiff.request" : "git.rangeDiff.request");
      await tab(page, "Git changes").click();
      await expect(compare(page)).toBeHidden();
      await activateTranscript(page);
      await page.locator("#promptInput").fill("hidden Compare must not steal this");
      await page.locator("#promptInput").focus();
      const hiddenBoundary = wire.requests.length;
      await wire.release();
      await expect(compare(page)).toBeHidden();
      await expect(page.locator("#promptInput")).toBeFocused();
      expect(wire.requests.slice(hiddenBoundary).filter(message => message.type === "diff.content.request"
        && message.scope === "compareDiff" && message.diffId === requestId(request))).toEqual([]);
      await tab(page, "Compare").click();
      await expect(compare(page).getByRole("textbox", { name: "Repository", exact: true })).toHaveValue(repo.root);
      await expect(compare(page).locator(mode === "files" ? ".diffs-main" : ".range-diff-output"))
        .toContainText(mode === "files" ? "hidden-compare_TOPIC_10_" : "hidden-compare TOPIC_10");
    } finally { repo.cleanup(); }
  });
}

for (const mode of ["files", "rangeDiff"] as const) {
  test(`normal Compare ${mode} keeps its own context across a dedicated review workspace`, async ({ page }) => {
    const a = fixture("workspace-A"), b = fixture("workspace-B"), wire = await transport(page);
    try {
      await authenticate(page);
      const nameA = await createSession(page, a);
      await openCompare(page, a, mode);
      const normalRoot = await compare(page).elementHandle();
      await page.locator("#createSessionButton").click();
      await page.locator("#cwdPickerDiffTab").click();
      await page.locator("#cwdPickerDiffMode").selectOption("full");
      await page.locator("#cwdPickerDiffRepo").fill(b.root);
      await page.locator("#cwdPickerDiffBase").fill(b.base);
      await page.locator("#cwdPickerDiffHead").fill(b.topic[9]);
      await page.locator("#cwdPickerDiffAgentSession").check();
      await page.locator("#cwdPickerCreate").click();
      await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
      await expect(page.locator("#diffReviewWorkspacePanelHost")).toHaveClass(/workspace-panel-host-active/);
      await expect(diffs(page).locator(".diffs-main")).toContainText("workspace-B_TOPIC_10_");
      await activateTranscript(page);
      await inactive(page, "Diff", diffs(page));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await wire.delivered();
      expect(await normalRoot!.evaluate(element => element === document.querySelector("#normalWorkspacePanelHost .compare-view"))).toBe(true);
      await expect(page.locator("#normalWorkspacePanelHost .compare-view").getByRole("textbox", { name: "Repository", exact: true, includeHidden: true })).toHaveValue(a.root);
      await selectSession(page, nameA);
      await activateTranscript(page);
      await inactive(page, "Compare", compare(page));
      await expect(compare(page).getByRole("textbox", { name: "Repository", exact: true })).toHaveValue(a.root);
      const output = compare(page).locator(mode === "files" ? ".diffs-main" : ".range-diff-output");
      await expect(output).toContainText(mode === "files" ? "workspace-A_TOPIC_10_" : "workspace-A TOPIC_10");
      await expect(output).not.toContainText("workspace-B");
    } finally { a.cleanup(); b.cleanup(); }
  });
}

test("inactive Compare preserves unsubmitted control drafts across a same-target reply", async ({ page }) => {
  const repo = fixture("control-draft"), wire = await transport(page);
  try {
    await authenticate(page); await createSession(page, repo); await openCompare(page, repo, "files");
    const boundary = await wire.hold();
    await compare(page).getByRole("button", { name: "Compare", exact: true }).click();
    await wire.pending(boundary, "compareDiff.request");
    await compare(page).getByRole("textbox", { name: "Repository", exact: true }).fill("/unsubmitted/repository");
    await compare(page).getByRole("textbox", { name: "Base", exact: true }).fill("unsubmitted-base");
    await compare(page).getByRole("textbox", { name: "Head", exact: true }).fill("unsubmitted-head");
    await compare(page).getByRole("textbox", { name: "Head", exact: true }).evaluate((element: HTMLInputElement) => element.setSelectionRange(2, 7));
    await activateTranscript(page);
    await page.locator("#promptInput").fill("Keep composer focus");
    await page.locator("#promptInput").focus();
    await wire.release();
    await expect(compare(page).getByRole("textbox", { name: "Repository", exact: true })).toHaveValue("/unsubmitted/repository");
    await expect(compare(page).getByRole("textbox", { name: "Base", exact: true })).toHaveValue("unsubmitted-base");
    await expect(compare(page).getByRole("textbox", { name: "Head", exact: true })).toHaveValue("unsubmitted-head");
    expect(await compare(page).getByRole("textbox", { name: "Head", exact: true }).evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([2, 7]);
    await expect(compare(page).locator(".diffs-main")).toContainText("control-draft_TOPIC_10_");
    await expect(page.locator("#promptInput")).toBeFocused();
    expect(wire.requests.filter(message => message.type === "compareDiff.request").some(message => message.repoRoot === "/unsubmitted/repository")).toBe(false);
  } finally { repo.cleanup(); }
});

test("internal cross-document Dockview drop retains History identity and scroll", async ({ page }) => {
  const repo = fixture("internal-drop"), wire = await transport(page);
  try {
    await authenticate(page); await createSession(page, repo); await openDiffs(page, repo, "History");
    const child = await popout(page, "Git changes");
    await historyIdentity(child, repo);
    for (const selector of [".diffs-main-body", ".git-history-list"]) {
      await diffs(child).locator(selector).evaluate(element => { element.scrollTop = 40; });
      await expect.poll(() => diffs(child).locator(selector).evaluate(element => element.scrollTop)).toBe(40);
    }
    await child.evaluate(() => { window.opener.__diffFocusPopout = window; });
    // Real Dockview internal drag handlers and document adoption; synthesized DOM
    // drag events are not a claim of native OS cross-window pointer automation.
    await page.evaluate(() => {
      const popout = window.__diffFocusPopout as Window & typeof globalThis;
      const source = popout.document.querySelector<HTMLElement>(".dv-tab")!;
      const target = [...document.querySelectorAll<HTMLElement>("#normalWorkspacePanelHost .dv-groupview")]
        .find(group => [...group.querySelectorAll(".dv-tab")].some(tab => tab.textContent === "Transcript"))!;
      const rect = target.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new popout.DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer,
          clientX: rect.left + rect.width / 2, clientY: rect.bottom - 5 }));
      }
    });
    await expect(tab(page, "Git changes")).toBeVisible();
    await activateTranscript(page);
    await wire.delivered();
    await inactive(page, "Git changes", diffs(page));
    await historyIdentity(page, repo);
    for (const selector of [".diffs-main-body", ".git-history-list"]) {
      await expect.poll(() => diffs(page).locator(selector).evaluate(element => element.scrollTop)).toBe(40);
    }
  } finally { repo.cleanup(); }
});

test("redocking a hidden normal Compare restores visibility when its workspace returns", async ({ page }) => {
  const a = fixture("hidden-popout-A"), b = fixture("hidden-popout-B");
  await transport(page);
  try {
    await authenticate(page);
    const nameA = await createSession(page, a);
    await openCompare(page, a, "files");
    const child = await popout(page, "Compare");
    await page.locator("#createSessionButton").click();
    await page.locator("#cwdPickerDiffTab").click();
    await page.locator("#cwdPickerDiffMode").selectOption("full");
    await page.locator("#cwdPickerDiffRepo").fill(b.root);
    await page.locator("#cwdPickerDiffBase").fill(b.base);
    await page.locator("#cwdPickerDiffHead").fill(b.topic[9]);
    await page.locator("#cwdPickerDiffAgentSession").check();
    await page.locator("#cwdPickerCreate").click();
    await expect(diffs(page).locator(".diffs-main")).toContainText("hidden-popout-B_TOPIC_10_");
    await expect(child.locator(".compare-view")).toBeHidden();
    await nativeRedock(child, page, "Compare", false);
    await selectSession(page, nameA);
    await expect(compare(page).locator(".diffs-main")).toContainText("hidden-popout-A_TOPIC_10_");
  } finally { a.cleanup(); b.cleanup(); }
});
