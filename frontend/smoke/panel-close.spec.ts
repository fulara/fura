import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import type { DockviewComponent } from "dockview-core";
import type { ClientMessage, ServerMessage } from "../src/protocol";

// External config supplies a private bridge and mock OMP. Advanced API cases
// require external build instrumentation registering the real installed Dockview
// components after construction; production code has no testing globals.
// Browser window.close/beforeunload and document adoption are real. DOM focus
// assertions do not establish physical macOS activation or background throttling.
declare global {
  interface Window {
    __panelCloseDockviews: Array<{ hostId: string; component: DockviewComponent }>;
    __panelCloseDelivered: string[];
  }
}
type Mode = "normal" | "diffReview";
const host = (mode: Mode) => mode === "normal" ? "normalWorkspacePanelHost" : "diffReviewWorkspacePanelHost";
const storageKey = (mode: Mode) => mode === "normal" ? "fura.dockview.layout" : "fura.dockview.diffReview.layout";
const tab = (page: Page, title: string) => page.locator(".dv-tab:visible").filter({ hasText: new RegExp(`^${title}$`) });
const group = (page: Page, title: string) => page.locator(".dv-groupview:visible").filter({ has: tab(page, title) });
const diffs = (page: Page) => page.locator(".session-changes-view:visible");
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
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-panel-close-")));
  const put = (value: string) => writeFileSync(path.join(root, "review.txt"),
    Array.from({ length: 100 }, (_, n) => `${value}_${n}`).join("\n") + "\n");
  const commit = (value: string) => {
    put(value); git(root, "add", "."); git(root, "commit", "-qm", value);
    return git(root, "rev-parse", "HEAD");
  };
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Panel Close Reviewer");
    git(root, "config", "user.email", "panel-close@example.invalid");
    const base = commit("BASE");
    const commits = Array.from({ length: 18 }, (_, n) => commit(`COMMIT_${n + 1}`));
    put("WORKTREE");
    return { root, base, pinned: commits[9], head: commits[17], put,
      cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
type Repo = { root: string; base: string; pinned: string; head: string; put(value: string): void; cleanup(): void };
async function authenticate(page: Page) {
  await page.goto("/");
  // Install after Playwright routing but before authentication opens the socket.
  await page.evaluate(() => {
    const delivered: string[] = [];
    window.__panelCloseDelivered = delivered;
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const fence = new MessageChannel();
        fence.port1.onmessage = event => delivered.push(String(event.data));
        this.addEventListener("message", event => fence.port2.postMessage(String(event.data)));
        this.addEventListener("close", () => { fence.port1.close(); fence.port2.close(); });
      }
    };
  });
  await page.locator("#authTokenInput").fill(process.env.FURA_SMOKE_TOKEN ?? "dev");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}
async function createSession(page: Page, repo: Repo, mode: Mode = "normal") {
  const name = `Panel close ${path.basename(repo.root)}`;
  await page.locator("#createSessionButton").click();
  if (mode === "normal") {
    await page.locator("#cwdPickerNameInput").fill(name);
    await page.locator("#cwdPickerInput").fill(repo.root);
  } else {
    await page.locator("#cwdPickerDiffTab").click();
    await page.locator("#cwdPickerDiffMode").selectOption("full");
    await page.locator("#cwdPickerDiffRepo").fill(repo.root);
    await page.locator("#cwdPickerDiffBase").fill(repo.base);
    await page.locator("#cwdPickerDiffHead").fill(repo.pinned);
    await page.locator("#cwdPickerDiffAgentSession").check();
  }
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(page.locator(`#${host(mode)}`)).toHaveClass(/workspace-panel-host-active/);
  if (mode === "normal") await expect(page.locator("#sessionTitle")).toContainText(name);
  return name;
}
async function selectSession(page: Page, name: string) {
  await page.locator("#sessionsList .session-item").filter({ hasText: name }).locator("button").first().click();
  await expect(page.locator("#sessionTitle")).toContainText(name);
}
async function registry(page: Page, mode: Mode = "normal") {
  await expect.poll(() => page.evaluate(id => window.__panelCloseDockviews?.some(entry => entry.hostId === id) ?? false, host(mode)), {
    message: "External harness must register actual DockviewComponent instances",
  }).toBe(true);
}
async function saved(page: Page, mode: Mode = "normal") {
  await registry(page, mode);
  await expect.poll(() => page.evaluate(({ id, key }) => {
    const component = window.__panelCloseDockviews.find(entry => entry.hostId === id)!.component;
    return JSON.stringify(JSON.parse(localStorage.getItem(key) ?? "{}").layout) === JSON.stringify(component.toJSON());
  }, { id: host(mode), key: storageKey(mode) })).toBe(true);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const directory = process.env.PANEL_CLOSE_SCREENSHOTS;
  if (directory) mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: directory ? path.join(directory, `${info.testId.replace(/[^a-z0-9_-]/gi, "_")}-${name}.png`) : info.outputPath(`${name}.png`) });
}
async function noDestructiveTabs(root: Locator) {
  // Hidden-but-enabled X controls are a failure: CSS alone is not close policy.
  expect(await root.locator(".dv-default-tab-action").evaluateAll(elements => elements.every(element =>
    element.matches(":disabled") || element.getAttribute("aria-disabled") === "true"))).toBe(true);
}
async function popout(page: Page, title: string) {
  await tab(page, title).click();
  const opened = page.waitForEvent("popup");
  await group(page, title).getByRole("button", { name: "Pop out", exact: true }).click();
  const child = await opened;
  child.on("pageerror", error => { throw error; });
  await expect(tab(child, title)).toBeVisible();
  return child;
}
async function settlePopup(page: Page, child: Page, mode: Mode = "normal", width = 1300) {
  // Drain the existing layout save before introducing a new resize. Dockview
  // 5.2's resize-end timer must finish before close; no arbitrary delay.
  await saved(page, mode);
  await child.setViewportSize({ width, height: 900 });
  const actual = await child.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await expect.poll(() => page.evaluate(({ key, actual }) => {
    const layout = JSON.parse(localStorage.getItem(key) ?? "{}").layout;
    return layout?.popoutGroups?.some((entry: { position?: { width: number; height: number } }) =>
      entry.position?.width === actual.width && entry.position?.height === actual.height) ?? false;
  }, { key: storageKey(mode), actual })).toBe(true);
}
async function nativeReturn(page: Page, child: Page) {
  await page.locator("html").evaluate(element => { delete element.dataset.panelCloseBeforeunload; });
  await child.evaluate(() => window.addEventListener("beforeunload", () => {
    window.opener.document.documentElement.dataset.panelCloseBeforeunload = "yes";
  }, { capture: true, once: true }));
  const closed = child.waitForEvent("close");
  await child.evaluate(() => window.close());
  await closed;
  await expect(page.locator("html")).toHaveAttribute("data-panel-close-beforeunload", "yes");
}
async function transport(page: Page) {
  const requests: ClientMessage[] = [], forwarded: string[] = [];
  const held: Array<{ message: ServerMessage; send(): void }> = [];
  let holding = false;
  await page.routeWebSocket("**/ws**", route => {
    const server = route.connectToServer();
    route.onMessage(raw => { requests.push(JSON.parse(raw.toString())); server.send(raw); });
    server.onMessage(raw => {
      const text = raw.toString(), message: ServerMessage = JSON.parse(text);
      const send = () => { forwarded.push(text); route.send(raw); };
      if (holding && message.type === "sessionChanges.summary") held.push({ message, send });
      else send();
    });
  });
  const delivered = async () => {
    const expected = forwarded.slice();
    await expect.poll(() => page.evaluate(count => window.__panelCloseDelivered.slice(0, count), expected.length)).toEqual(expected);
  };
  return { requests, held, delivered,
    async hold() { await delivered(); holding = true; return requests.length; },
    async release() { holding = false; for (const frame of held.splice(0)) frame.send(); await delivered(); },
  };
}
async function history(page: Page, repo: Repo) {
  await tab(page, "Git changes").click();
  const view = diffs(page);
  await view.getByRole("button", { name: "History", exact: true }).click();
  await view.locator(`[data-commit-oid="${repo.pinned}"]`).click();
  await view.locator('.diffs-file-jump[data-diff-file-path="review.txt"]').click();
  await expect(view.locator(".diffs-main")).toContainText("COMMIT_10_0");
  const restore = view.getByRole("button", { name: "Restore layout", exact: true });
  if (await restore.isVisible()) await restore.click();
}
async function historyIdentity(page: Page, repo: Repo) {
  const view = diffs(page);
  await expect(view.getByRole("button", { name: "History", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(view.locator(".git-root-path")).toHaveText(repo.root);
  await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.pinned);
  await expect(view.locator('.diffs-file-jump.active[data-diff-file-path="review.txt"]')).toBeVisible();
  await expect(view.locator(".diffs-main")).toContainText("COMMIT_10_0");
  await expect(view.getByRole("checkbox", { name: "Ignore whitespace", exact: true })).toBeChecked();
  await expect(view.getByRole("combobox", { name: "Diff layout", exact: true })).toHaveValue("split");
  await expect(view).toContainText("PANEL_CLOSE_COMMENT");
}

test.use({ viewport: { width: 1600, height: 1100 }, serviceWorkers: "block" });
test.setTimeout(90_000);
test.beforeEach(({ page }) => { page.on("pageerror", error => { throw error; }); });

test("baseline RED: docked workspace tabs have no enabled destructive X", async ({ page }, info) => {
  const repo = fixture();
  try {
    await authenticate(page); await createSession(page, repo);
    await expect(tab(page, "Git changes")).toBeVisible();
    await screenshot(page, info, "docked-close-policy");
    await noDestructiveTabs(page.locator("#normalWorkspacePanelHost"));
  } finally { repo.cleanup(); }
});

for (const mode of ["normal", "diffReview"] as const) {
  test(`@adapter ${mode}: supported panel/group close, middle click and tab keys retain panels after rearrangement`, async ({ page }, info) => {
    const repo = fixture();
    try {
      await authenticate(page); await createSession(page, repo, mode); await registry(page, mode);
      const panels = mode === "normal" ? ["Transcript", "Code", "Tools", "Git changes"] : ["Transcript", "Code", "Tools", "Diff"];
      await noDestructiveTabs(page.locator(`#${host(mode)}`));
      for (const title of panels) {
        await tab(page, title).click({ button: "middle" });
        await expect(tab(page, title)).toBeVisible();
        // Dockview 5.2 has no context-menu/keyboard close command. Exercise its
        // ordinary tab events, and the actual close APIs used by user actions.
        await tab(page, title).press("Delete");
        await tab(page, title).press("Control+F4");
        await tab(page, title).dispatchEvent("contextmenu", { bubbles: true, cancelable: true });
      }
      await page.evaluate(id => {
        const api = window.__panelCloseDockviews.find(entry => entry.hostId === id)!.component;
        api.getGroupPanel("code")!.api.moveTo({ group: api.getGroupPanel("tools")!.group, position: "center", index: 0 });
        for (const panel of [...api.panels]) panel.api.close();
        for (const group of [...api.groups]) group.api.close();
      }, host(mode));
      for (const title of panels) await expect(tab(page, title)).toHaveCount(1);
      await tab(page, "Transcript").click();
      await page.locator("#promptInput").fill(`${mode} draft remains editable`);
      await expect(page.locator("#promptInput")).toHaveValue(`${mode} draft remains editable`);
      await saved(page, mode);
      await screenshot(page, info, `${mode}-rearranged-close-blocked`);
      await page.reload();
      await expect(page.locator("#connectionStatus")).toHaveText("connected");
      if (mode === "normal") await selectSession(page, `Panel close ${path.basename(repo.root)}`);
      else await page.locator("#sessionsList .session-item").filter({ hasText: "diff:" }).locator("button").first().click();
      for (const title of panels) await expect(tab(page, title)).toHaveCount(1);
      await noDestructiveTabs(page.locator(`#${host(mode)}`));
    } finally { repo.cleanup(); }
  });
}

test("@adapter native popup close and Return to main preserve pinned History, pending reply, comments, scroll and draft", async ({ page }, info) => {
  const repo = fixture(), wire = await transport(page);
  try {
    await authenticate(page); await createSession(page, repo); await history(page, repo);
    let view = diffs(page);
    await view.getByRole("checkbox", { name: "Ignore whitespace", exact: true }).check();
    await expect(view.locator(".diffs-main")).toContainText("COMMIT_10_0");
    await view.getByRole("combobox", { name: "Diff layout", exact: true }).selectOption("split");
    await view.locator(".diff-line-add").filter({ hasText: "COMMIT_10_0" }).locator(".diff-comment-btn").click();
    await view.locator(".review-comment-composer-input").fill("PANEL_CLOSE_COMMENT");
    await view.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(view).toContainText("PANEL_CLOSE_COMMENT");
    const panel = await page.locator(".panel-content-diffs:visible").elementHandle();
    await tab(page, "Transcript").click();
    await page.locator("#promptInput").fill("Unsent draft stays in main");
    for (const [index, action] of ["native", "return", "native"].entries()) {
      const child = await popout(page, "Git changes");
      await settlePopup(page, child, "normal", 1300 + index * 10);
      await historyIdentity(child, repo);
      view = diffs(child);
      await view.locator(".diffs-main-body").evaluate(element => { element.scrollTop = 160; });
      await expect.poll(() => view.locator(".diffs-main-body").evaluate(element => element.scrollTop)).toBe(160);
      const boundary = await wire.hold();
      await view.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(() => wire.requests.slice(boundary).find(message => message.type === "sessionChanges.request")).toBeDefined();
      await expect.poll(() => wire.held.some(frame => frame.message.type === "sessionChanges.summary" && frame.message.state.status === "ready")).toBe(true);
      await screenshot(child, info, `history-${action}-${index}-pending`);
      await tab(page, "Transcript").click();
      await page.locator("#promptInput").focus();
      if (action === "native") await nativeReturn(page, child);
      else {
        const closed = child.waitForEvent("close");
        await child.getByRole("button", { name: "Return to main", exact: true }).click();
        await closed;
      }
      await expect(tab(page, "Git changes")).toHaveCount(1);
      await expect(page.locator("#promptInput")).toHaveValue("Unsent draft stays in main");
      if (action === "native") await expect(page.locator("#promptInput")).toBeFocused();
      await expect.poll(() => diffs(page).locator(".diffs-main-body").evaluate(element => element.scrollTop)).toBe(160);
      expect(await panel!.evaluate(element => element.isConnected && element.ownerDocument === document)).toBe(true);
      await wire.release();
      await expect(diffs(page).locator(".diff-refresh-status")).toHaveCount(0);
      await historyIdentity(page, repo);
      await expect.poll(() => diffs(page).locator(".diffs-main-body").evaluate(element => element.scrollTop)).toBe(160);
      await saved(page);
    }
    await screenshot(page, info, "history-redocked");
    expect(wire.requests.filter(message => ["prompt.send", "review.agentReview.start", "diff.reviewWorktree.ensure", "diff.reviewWorktree.checkout"].includes(message.type))).toEqual([]);
  } finally { repo.cleanup(); }
});

for (const target of ["rearranged", "removed"] as const) {
  test(`@adapter multiple popup panels return once when original group is ${target}`, async ({ page }, info) => {
    const repo = fixture();
    try {
      await authenticate(page); await createSession(page, repo); await registry(page);
      // Put Transcript between siblings so restoration must recover tab index,
      // not simply append to the original group's tail.
      await page.evaluate(() => {
        const api = window.__panelCloseDockviews.find(entry => entry.hostId === "normalWorkspacePanelHost")!.component;
        api.addPanel({ id: "compare", component: "compare", title: "Compare", position: { referencePanel: "transcript", direction: "within", index: 0 } });
      });
      const original = await page.evaluate(() => {
        const api = window.__panelCloseDockviews.find(entry => entry.hostId === "normalWorkspacePanelHost")!.component;
        return api.getGroupPanel("transcript")!.group.id;
      });
      const transcript = await page.locator("#normalWorkspacePanelHost .panel-content-transcript").elementHandle();
      const first = await popout(page, "Transcript");
      await settlePopup(page, first);
      const second = await popout(page, "Tools");
      await settlePopup(page, second, "normal", 1340);
      // Move Code into the first popup through the installed transfer API.
      // This forms a genuine multi-panel popup without inventing a second app.
      await page.evaluate(({ original, target }) => {
        const api = window.__panelCloseDockviews.find(entry => entry.hostId === "normalWorkspacePanelHost")!.component;
        api.getGroupPanel("code")!.api.moveTo({ group: api.getGroupPanel("transcript")!.group, position: "center" });
        const source = api.groups.find(group => group.id === original)!;
        const destination = api.getGroupPanel("diffs")!.group;
        if (target === "removed") {
          // Transfer its last remaining panel; Dockview removes the now-empty
          // original group itself, preserving that panel's content.
          api.getGroupPanel("compare")!.api.moveTo({ group: destination, position: "center", index: 0 });
        } else source.api.moveTo({ group: destination, position: "right" });
      }, { original, target });
      await expect(tab(first, "Code")).toBeVisible();
      await tab(first, "Transcript").click();
      await screenshot(first, info, `${target}-multi-panel-popup`);
      await saved(page);
      await nativeReturn(page, second);
      await expect(tab(page, "Tools")).toHaveCount(1);
      await nativeReturn(page, first);
      for (const title of ["Transcript", "Code", "Compare", "Tools", "Git changes"]) await expect(tab(page, title)).toHaveCount(1);
      await tab(page, "Transcript").click();
      expect(await transcript!.evaluate(element => element.isConnected && element.ownerDocument === document)).toBe(true);
      const returned = await page.evaluate(() => {
        const api = window.__panelCloseDockviews.find(entry => entry.hostId === "normalWorkspacePanelHost")!.component;
        const panel = api.getGroupPanel("transcript")!;
        return { group: panel.group.id, tabs: panel.group.panels.map(panel => panel.id), popouts: api.toJSON().popoutGroups?.length ?? 0 };
      });
      expect(returned.popouts).toBe(0);
      if (target === "rearranged") { expect(returned.group).toBe(original); expect(returned.tabs).toEqual(["compare", "transcript", "code"]); }
      else expect(returned.group).not.toBe(original);
      await saved(page);
      await screenshot(page, info, `${target}-all-panels-returned`);
    } finally { repo.cleanup(); }
  });
}

test("@adapter hidden normal popup returns only to its workspace while diffReview remains active", async ({ page }, info) => {
  const normal = fixture(), review = fixture();
  try {
    await authenticate(page); const name = await createSession(page, normal);
    const child = await popout(page, "Code");
    await settlePopup(page, child);
    await createSession(page, review, "diffReview");
    await expect(child.locator(".panel-content-code .panel-scroll")).toBeHidden();
    await nativeReturn(page, child);
    await expect(page.locator("#diffReviewWorkspacePanelHost")).toHaveClass(/workspace-panel-host-active/);
    await expect(tab(page, "Code")).toHaveCount(1);
    const reviewChild = await popout(page, "Diff");
    await settlePopup(page, reviewChild, "diffReview");
    await noDestructiveTabs(reviewChild.locator("body"));
    await expect(diffs(reviewChild).locator(".diffs-main")).toContainText("COMMIT_10_0");
    const closed = reviewChild.waitForEvent("close");
    await reviewChild.getByRole("button", { name: "Return to main", exact: true }).click();
    await closed;
    await expect(tab(page, "Diff")).toHaveCount(1);
    await expect(diffs(page).locator(".diffs-main")).toContainText("COMMIT_10_0");
    await selectSession(page, name);
    await expect(tab(page, "Code")).toHaveCount(1);
    await expect(page.locator("#normalWorkspacePanelHost .panel-content-code")).toHaveCount(1);
    await expect(page.locator("#diffReviewWorkspacePanelHost .panel-content-code")).toHaveCount(1);
    await screenshot(page, info, "separate-workspaces-returned");
  } finally { normal.cleanup(); review.cleanup(); }
});

test("@adapter main reload closes owned popups without dialogs or reopening and restores accessible saved panels", async ({ page, context }, info) => {
  const repo = fixture();
  try {
    await authenticate(page); const name = await createSession(page, repo);
    await registry(page);
    const original = await page.evaluate(() => {
      const api = window.__panelCloseDockviews.find(entry => entry.hostId === "normalWorkspacePanelHost")!.component;
      const group = api.getGroupPanel("transcript")!.group;
      // Leave a main tab behind so mixed-origin Code still has a valid return target.
      api.getGroupPanel("diffs")!.api.moveTo({ group, position: "center" });
      return { order: group.panels.map(panel => panel.id), groups: api.panels.map(panel => [panel.id, panel.group.id]) };
    });
    const children: Page[] = [];
    for (const title of ["Transcript", "Tools"]) {
      const child = await popout(page, title);
      await settlePopup(page, child);
      children.push(child);
    }
    await page.evaluate(() => {
      const api = window.__panelCloseDockviews.find(entry => entry.hostId === "normalWorkspacePanelHost")!.component;
      api.getGroupPanel("code")!.api.moveTo({ group: api.getGroupPanel("tools")!.group, position: "center" });
    });
    await saved(page);
    const dialogs: string[] = [], newPages: Page[] = [];
    page.on("dialog", dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    context.on("page", opened => newPages.push(opened));
    const closed = children.map(child => child.waitForEvent("close"));
    await page.reload();
    await Promise.all(closed);
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await selectSession(page, name);
    for (const title of ["Transcript", "Code", "Tools", "Git changes"]) await expect(tab(page, title)).toHaveCount(1);
    const restored = await page.evaluate(() => {
      const api = window.__panelCloseDockviews.find(entry => entry.hostId === "normalWorkspacePanelHost")!.component;
      return { order: api.getGroupPanel("transcript")!.group.panels.map(panel => panel.id), groups: api.panels.map(panel => [panel.id, panel.group.id]) };
    });
    expect(restored.order).toEqual(original.order);
    expect(restored.groups.sort()).toEqual(original.groups.sort());
    // Restored Code may already be selected. Force a real layout transition
    // before comparing the next native autosave with its serialized snapshot.
    await tab(page, "Transcript").click();
    await tab(page, "Code").click();
    await expect(page.locator(".panel-content-code:visible")).toBeVisible();
    await saved(page);
    expect(dialogs).toEqual([]);
    expect(newPages).toEqual([]);
    expect(context.pages()).toEqual([page]);
    await screenshot(page, info, "main-reload-no-orphan-popups");
  } finally { repo.cleanup(); }
});

test("@adapter popup panel close returns only that panel; popup group close returns remaining siblings", async ({ page }, info) => {
  const repo = fixture();
  try {
    await authenticate(page); await createSession(page, repo); await registry(page);
    const child = await popout(page, "Transcript");
    await settlePopup(page, child);
    await page.evaluate(() => {
      const api = window.__panelCloseDockviews.find(entry => entry.hostId === "normalWorkspacePanelHost")!.component;
      api.getGroupPanel("code")!.api.moveTo({ group: api.getGroupPanel("transcript")!.group, position: "center" });
      api.getGroupPanel("tools")!.api.moveTo({ group: api.getGroupPanel("transcript")!.group, position: "center" });
    });
    await expect(tab(child, "Code")).toBeVisible();
    await expect(tab(child, "Tools")).toBeVisible();
    await saved(page);
    await page.evaluate(() => {
      window.__panelCloseDockviews.find(entry => entry.hostId === "normalWorkspacePanelHost")!.component.getGroupPanel("code")!.api.close();
    });
    await expect(tab(page, "Code")).toHaveCount(1);
    await expect(tab(child, "Code")).toHaveCount(0);
    await expect(tab(child, "Transcript")).toHaveCount(1);
    await expect(tab(child, "Tools")).toHaveCount(1);
    expect(child.isClosed()).toBe(false);
    await screenshot(child, info, "popup-panel-close-keeps-siblings");
    const closed = child.waitForEvent("close");
    await page.evaluate(() => {
      window.__panelCloseDockviews.find(entry => entry.hostId === "normalWorkspacePanelHost")!.component.getGroupPanel("transcript")!.group.api.close();
    });
    await closed;
    for (const title of ["Transcript", "Code", "Tools"]) await expect(tab(page, title)).toHaveCount(1);
    await noDestructiveTabs(page.locator("#normalWorkspacePanelHost"));
  } finally { repo.cleanup(); }
});

test("@adapter native main window close also closes its popup without reopening or confirmation", async ({ page, context }) => {
  const repo = fixture();
  try {
    await authenticate(page);
    const opened = page.waitForEvent("popup");
    await page.evaluate(() => { window.open("/", "_blank"); });
    const main = await opened;
    main.on("pageerror", error => { throw error; });
    await expect(main.locator("#connectionStatus")).toHaveText("connected");
    await createSession(main, repo);
    const child = await popout(main, "Code");
    await settlePopup(main, child);
    const dialogs: string[] = [], reopened: Page[] = [];
    main.on("dialog", dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
    context.on("page", opened => reopened.push(opened));
    await main.evaluate(() => window.addEventListener("beforeunload", () => {
      window.opener.document.documentElement.dataset.panelCloseMainShutdown = "yes";
    }, { capture: true, once: true }));
    const mainClosed = main.waitForEvent("close"), childClosed = child.waitForEvent("close");
    await main.evaluate(() => window.close());
    await Promise.all([mainClosed, childClosed]);
    await expect(page.locator("html")).toHaveAttribute("data-panel-close-main-shutdown", "yes");
    expect(dialogs).toEqual([]);
    expect(reopened).toEqual([]);
    expect(context.pages()).toEqual([page]);
  } finally { repo.cleanup(); }
});

test("black-box native close and Return to main preserve Transcript content and the main draft", async ({ page }, info) => {
  const repo = fixture();
  try {
    await authenticate(page); await createSession(page, repo);
    await tab(page, "Transcript").click();
    await page.locator("#promptInput").fill("PANEL_CLOSE_TRANSCRIPT_MESSAGE");
    await page.locator("#sendButton").click();
    await expect(page.locator(".panel-content-transcript:visible")).toContainText("PANEL_CLOSE_TRANSCRIPT_MESSAGE");
    await expect(page.locator("#statusBar")).not.toHaveClass(/\bbusy\b/);
    await page.locator("#promptInput").fill("PANEL_CLOSE_UNSENT_DRAFT");
    const shell = await page.locator(".panel-content-transcript:visible").elementHandle();
    const originalTabs = await group(page, "Transcript").locator(".dv-tab").allTextContents();
    for (const [index, action] of ["native", "return"].entries()) {
      const child = await popout(page, "Transcript");
      await expect(child.locator(".panel-content-transcript")).toContainText("PANEL_CLOSE_TRANSCRIPT_MESSAGE");
      await noDestructiveTabs(child.locator("body"));
      // Drain earlier saves through surviving main panels before measuring
      // native resize; only Code remains in Transcript's original group.
      for (const [title, id] of [["Tools", "tools"], ["Code", "code"]]) {
        await tab(page, title).click();
        await expect.poll(() => page.evaluate(expected => {
          const saved = JSON.parse(localStorage.getItem("fura.dockview.layout") ?? "{}");
          function selected(value: unknown): boolean {
            return Boolean(value && typeof value === "object"
              && (("activeView" in value && value.activeView === expected) || Object.values(value).some(selected)));
          }
          return selected(saved.layout);
        }, id)).toBe(true);
      }
      await child.setViewportSize({ width: 1260 + index * 20, height: 900 });
      const actual = await child.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      await expect.poll(() => page.evaluate(expected => {
        const saved = JSON.parse(localStorage.getItem("fura.dockview.layout") ?? "{}");
        return saved.layout?.popoutGroups?.some((entry: { position?: { width: number; height: number } }) =>
          entry.position?.width === expected.width && entry.position?.height === expected.height) ?? false;
      }, actual)).toBe(true);
      await page.locator("#promptInput").focus();
      await screenshot(child, info, `black-box-${action}-popup`);
      if (action === "native") await nativeReturn(page, child);
      else {
        const button = child.getByRole("button", { name: "Return to main", exact: true });
        await expect(button).toBeEnabled();
        await button.focus();
        const closed = child.waitForEvent("close");
        // Closing the input target can outlive Playwright's keyup/navigation
        // acknowledgement. The actual close event is the completion boundary.
        await Promise.race([button.press("Enter", { noWaitAfter: true }), closed]);
        await closed;
      }
      await expect(tab(page, "Transcript")).toHaveCount(1);
      await expect(group(page, "Transcript").locator(".dv-tab")).toHaveText(originalTabs);
      await tab(page, "Transcript").click();
      await expect(page.locator(".panel-content-transcript:visible")).toContainText("PANEL_CLOSE_TRANSCRIPT_MESSAGE");
      expect(await shell!.evaluate(element => element.isConnected && element.ownerDocument === document)).toBe(true);
      await expect(page.locator("#promptInput")).toHaveValue("PANEL_CLOSE_UNSENT_DRAFT");
      await noDestructiveTabs(page.locator("#normalWorkspacePanelHost"));
      await expect.poll(() => page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("fura.dockview.layout") ?? "{}");
        return saved.layout ? (saved.layout.popoutGroups?.length ?? 0) : -1;
      })).toBe(0);
    }
    await screenshot(page, info, "black-box-returned-transcript");
  } finally { repo.cleanup(); }
});

test("@adapter optional Compare retains selected refs, file and unsubmitted control draft through return and saved layout", async ({ page }, info) => {
  const repo = fixture();
  try {
    await authenticate(page); const name = await createSession(page, repo);
    await page.locator("#createSessionButton").click();
    await page.locator("#cwdPickerDiffTab").click();
    await page.locator("#cwdPickerDiffMode").selectOption("full");
    await page.locator("#cwdPickerDiffRepo").fill(repo.root);
    await page.locator("#cwdPickerDiffBase").fill(repo.base);
    await page.locator("#cwdPickerDiffHead").fill(repo.pinned);
    await page.locator("#cwdPickerDiffAgentSession").uncheck();
    await page.locator("#cwdPickerCreate").click();
    await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
    const view = page.locator(".compare-view:visible");
    await view.locator('.diffs-file-jump[data-diff-file-path="review.txt"]').click();
    await expect(view.locator(".diffs-main")).toContainText("COMMIT_10_0");
    await view.getByRole("textbox", { name: "Head", exact: true }).fill("unsubmitted-head-draft");
    const child = await popout(page, "Compare");
    await settlePopup(page, child);
    const popped = child.locator(".compare-view:visible");
    await expect(popped.getByRole("textbox", { name: "Repository", exact: true })).toHaveValue(repo.root);
    await expect(popped.getByRole("textbox", { name: "Base", exact: true })).toHaveValue(repo.base);
    await expect(popped.getByRole("textbox", { name: "Head", exact: true })).toHaveValue("unsubmitted-head-draft");
    await expect(popped.locator(".diffs-main")).toContainText("COMMIT_10_0");
    const closed = child.waitForEvent("close");
    await child.getByRole("button", { name: "Return to main", exact: true }).click();
    await closed;
    await expect(view.getByRole("textbox", { name: "Head", exact: true })).toHaveValue("unsubmitted-head-draft");
    await expect(view.locator('.diffs-file-jump.active[data-diff-file-path="review.txt"]')).toBeVisible();
    await expect(view.locator(".diffs-main")).toContainText("COMMIT_10_0");
    await saved(page);
    await screenshot(page, info, "compare-returned-with-control-draft");
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await selectSession(page, name);
    await expect(tab(page, "Compare")).toHaveCount(1);
    await tab(page, "Compare").click();
    await expect(page.locator(".panel-content-compare:visible")).toBeVisible();
    await noDestructiveTabs(page.locator("#normalWorkspacePanelHost"));
  } finally { repo.cleanup(); }
});
