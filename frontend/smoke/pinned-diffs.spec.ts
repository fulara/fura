import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { DockviewComponent } from "dockview-core";
import type { DesktopDockview } from "../src/desktopDockview";
import type { PinnedDiff } from "../src/pinnedDiff";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

// Real Git repositories and real Fura reads. Agent lifecycle is mock RPC, not real OMP.
const token = process.env.FURA_SMOKE_TOKEN ?? "dev";
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
}
function fixture(label: string) {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-pin-git-")));
  const repo = path.join(parent, label); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Pinned Review Test");
  git(repo, "config", "user.email", "pin@example.invalid");
  const text = (version: string) => Array.from({ length: 180 }, (_, i) => `export const row_${i} = '${label}_${version}_${i}';`).join("\n") + "\n";
  const change = (version: string) => { writeFileSync(path.join(repo, "same.ts"), text(version)); writeFileSync(path.join(repo, "other.ts"), `export const other = '${label}_${version}';\n`); };
  const commit = (subject: string) => { git(repo, "add", "."); git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", subject); return git(repo, "rev-parse", "HEAD"); };
  change("BASE");
  writeFileSync(path.join(repo, "removed.txt"), `${label}_OLD_SIDE_ONLY\n`);
  writeFileSync(path.join(repo, "before.ts"), `${label}_RENAMED_CONTENT\n`);
  const base = commit(`${label} base`);
  change("COMMIT");
  rmSync(path.join(repo, "removed.txt"));
  renameSync(path.join(repo, "before.ts"), path.join(repo, "after.ts"));
  const oid = commit(`${label} immutable commit`);
  change("CURRENT");
  return { repo, parent, base, oid, change, commit, cleanup() { rmSync(parent, { recursive: true, force: true }); } };
}
const ordinary = (page: Page) => page.locator(".session-changes-view:visible:not(.pinned-diff-view)");
const pins = (page: Page) => page.locator(".pinned-diff-view:visible");
const pinTabs = (page: Page) => page.locator(".workspace-panel-host-active .dv-tab").filter({ hasText: / · (?:Current |History |Fixed )/ });
async function activateOrdinary(page: Page) {
  const host = page.locator(".workspace-panel-host-active");
  const review = await host.getAttribute("id") === "diffReviewWorkspacePanelHost";
  await host.locator(".dv-tab").filter({ hasText: review ? /^Diff$/ : /^Git changes$/ }).click();
  await expect(ordinary(page)).toBeVisible();
}
async function activatePin(page: Page, label: string) {
  await pinTabs(page).filter({ hasText: label }).click();
  await expect(pins(page)).toBeVisible();
}
const sessionNames = new WeakMap<Page, Map<string, string>>();
async function authenticate(page: Page) {
  await page.goto("/");
  await page.locator("#authTokenInput").fill(token);
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}
async function createSession(page: Page, repo: string, name: string, review = false) {
  const names = sessionNames.get(page) ?? new Map<string, string>();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const uniqueName = review ? `diff: ${name} ${suffix} HEAD~1..HEAD` : `${name} ${suffix}`;
  names.set(name, uniqueName);
  sessionNames.set(page, names);
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerNameInput").fill(uniqueName);
  await page.locator("#cwdPickerInput").fill(repo);
  if (review) {
    await page.locator("#cwdPickerDiffTab").click();
    await page.locator("#cwdPickerDiffRepo").fill(repo);
    await page.locator("#cwdPickerDiffBase").fill("HEAD~1");
    await page.locator("#cwdPickerDiffHead").fill("HEAD");
    await page.locator("#cwdPickerDiffAgentSession").check();
  }
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(page.locator("#sessionTitle")).toContainText(name);
  await activateOrdinary(page);
}
async function chooseSession(page: Page, name: string) {
  const uniqueName = sessionNames.get(page)?.get(name);
  if (!uniqueName) throw new Error(`This test did not create ${name}`);
  await page.locator("#sessionsList .session-item > button").filter({ hasText: uniqueName }).click();
  await expect(page.locator("#sessionTitle")).toContainText(name);
}
async function chooseFile(view: Locator, file = "same.ts") {
  await view.locator(`.diffs-file-jump[data-diff-file-path="${file}"]`).click();
  await expect(view.locator(".diffs-main-body")).toContainText(file);
}
async function pin(page: Page, source = ordinary(page)) {
  await source.getByRole("button", { name: "Pin as new tab", exact: true }).click();
  const view = pins(page);
  await expect(view).toHaveCount(1);
  await expect(view.locator(".diffs-main-body")).toBeVisible();
  return view;
}
async function pinWindowButton(page: Page, view: Locator) {
  await expect(view).toBeVisible();
  const box = await view.boundingBox();
  if (!box) throw new Error("Pinned content has no visible bounds");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const groups = page.locator(".workspace-panel-host-active .dv-groupview");
  // renderer:"always" places content in an overlay, not under its header group.
  const index = await groups.evaluateAll((groups, point) => groups.findIndex(group => {
    const bounds = group.getBoundingClientRect();
    return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
  }), point);
  expect(index, "The pin must occupy one docked group's bounds").toBeGreaterThanOrEqual(0);
  const button = groups.nth(index).getByRole("button", { name: "Open in new window", exact: true });
  await expect(button).toBeVisible();
  return button;
}
async function popout(page: Page, view: Locator) {
  const button = await pinWindowButton(page, view);
  const opened = page.waitForEvent("popup");
  await button.click();
  const child = await opened;
  await child.setViewportSize({ width: 1500, height: 1000 });
  await expect(pins(child)).toHaveCount(1);
  return child;
}
async function captureWire(page: Page) {
  const requests: Array<{ type: string; clientId?: string; sessionId?: string; repoRoot?: string; commitOid?: string }> = [];
  const held: Array<() => void> = [];
  let holdClient: string | null = null;
  await page.routeWebSocket("**/ws**", route => {
    const server = route.connectToServer();
    route.onMessage(raw => {
      const value: unknown = JSON.parse(raw.toString());
      if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") throw new Error("Invalid outgoing protocol envelope");
      requests.push({
        type: value.type,
        clientId: "clientId" in value && typeof value.clientId === "string" ? value.clientId : undefined,
        sessionId: "sessionId" in value && typeof value.sessionId === "string" ? value.sessionId : undefined,
        repoRoot: "repoRoot" in value && typeof value.repoRoot === "string" ? value.repoRoot : undefined,
        commitOid: "commitOid" in value && typeof value.commitOid === "string" ? value.commitOid : undefined,
      });
      server.send(raw);
    });
    server.onMessage(raw => {
      const message: unknown = JSON.parse(raw.toString());
      if (!message || typeof message !== "object" || !("type" in message) || typeof message.type !== "string") throw new Error("Invalid incoming protocol envelope");
      const payload = "state" in message ? message.state : "content" in message ? message.content : message;
      const client = payload && typeof payload === "object" && "targetClientId" in payload ? payload.targetClientId : undefined;
      if (holdClient && client === holdClient && ["sessionChanges.summary", "compareDiff.summary", "diff.content", "diff.complete", "diff.error"].includes(message.type)) held.push(() => route.send(raw));
      else route.send(raw);
    });
  });
  return { requests, hold(client: string | null) { holdClient = client; }, release() { for (const deliver of held.splice(0)) deliver(); }, held };
}

test.use({ viewport: { width: 2100, height: 1200 }, serviceWorkers: "block" });
test.setTimeout(120_000);
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, context }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  context.on("page", child => child.on("pageerror", error => errors.push(error.message)));
});
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page), "Uncaught errors in main or popup window").toEqual([]);
});

test("pinned A survives session, repository, workspace and focus changes docked and popped out", async ({ page }, info) => {
  const a = fixture("PIN_A"), b = fixture("PIN_B");
  let child: Page | undefined;
  try {
    const wire = await captureWire(page);
    await authenticate(page);
    await createSession(page, a.repo, "Pinned source A");
    await expect(ordinary(page)).toContainText("PIN_A_CURRENT");
    await chooseFile(ordinary(page));
    await ordinary(page).locator(".diff-layout-select").selectOption("split");
    await ordinary(page).locator(".diffs-main-body").evaluate(el => { el.scrollTop = 330; });
    const initialScroll = await ordinary(page).locator(".diffs-main-body").evaluate(el => el.scrollTop);
    const view = await pin(page);
    await expect(view.locator(".diff-layout-select")).toHaveValue("split");
    await expect(view.locator('.diffs-file-jump[data-diff-file-path="same.ts"]')).toHaveClass(/active/);
    await expect.poll(() => view.locator(".diffs-main-body").evaluate(el => el.scrollTop)).toBe(initialScroll);
    const id = await view.getAttribute("data-panel-id");
    await createSession(page, b.repo, "Other source B");
    await expect(ordinary(page)).toContainText("PIN_B_CURRENT");
    await activatePin(page, "PIN_A");
    await expect(view).toContainText("PIN_A_CURRENT");
    await view.locator(".diffs-main-body").evaluate(el => { el.scrollTop = 330; });
    for (let i = 0; i < 3; i++) {
      await chooseSession(page, "Pinned source A");
      await chooseSession(page, "Other source B");
      await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
      await expect(view).toContainText("PIN_A_CURRENT");
      await expect(view).not.toContainText("PIN_B_CURRENT");
      expect(await view.locator(".diffs-main-body").evaluate(el => el.scrollTop)).toBe(330);
    }
    await activateOrdinary(page);
    await ordinary(page).locator(".git-review-options > summary").click();
    page.once("dialog", dialog => dialog.accept(a.repo));
    await ordinary(page).getByRole("button", { name: "Add", exact: true }).click();
    await ordinary(page).getByRole("combobox", { name: "Repository", exact: true }).selectOption(a.repo);
    await expect(ordinary(page)).toContainText("PIN_A_CURRENT");
    await ordinary(page).getByRole("combobox", { name: "Repository", exact: true }).selectOption(b.repo);
    await expect(ordinary(page)).toContainText("PIN_B_CURRENT");
    await activatePin(page, "PIN_A");
    await expect(view).toContainText("PIN_A_CURRENT");
    child = await popout(page, view);
    await pins(child).locator(".diffs-main-body").evaluate(el => { el.scrollTop = 410; });
    await createSession(page, b.repo, "Dedicated review B", true);
    await expect(ordinary(page).locator(".diffs-main-body")).toContainText("PIN_B_COMMIT");
    await expect(pins(child)).toContainText("PIN_A_CURRENT");
    await chooseSession(page, "Other source B");
    await chooseSession(page, "Dedicated review B");
    await expect(ordinary(page).locator(".diffs-main-body")).toContainText("PIN_B_COMMIT");
    await child.bringToFront();
    await page.bringToFront();
    await expect(pins(child)).toContainText("PIN_A_CURRENT");
    expect(await pins(child).locator(".diffs-main-body").evaluate(el => el.scrollTop)).toBe(410);
    await child.screenshot({ path: info.outputPath("pinned-A-popout-during-review-B.png") });
    const closed = child.waitForEvent("close");
    await child.getByRole("button", { name: "Return to main", exact: true }).click();
    await closed; child = undefined;
    await expect(pins(page)).toContainText("PIN_A_CURRENT");
    expect(await pins(page).getAttribute("data-panel-id")).toBe(id);
    await expect.poll(() => pins(page).locator(".diffs-main-body").evaluate(el => el.scrollTop)).toBe(410);
    await page.screenshot({ path: info.outputPath("pinned-A-redocked-review-B.png") });
    expect(wire.requests.filter(request => request.type === "review.agentReview.start" || request.type.startsWith("diff.reviewWorktree"))).toEqual([]);
  } finally { await child?.close(); a.cleanup(); b.cleanup(); }
});

test("two pins isolate selection, whitespace, pending replies, closing and reload", async ({ page }, info) => {
  const a = fixture("MULTI_A"), b = fixture("MULTI_B");
  try {
    const wire = await captureWire(page);
    await authenticate(page); await createSession(page, a.repo, "Multi source A");
    await chooseFile(ordinary(page)); await pin(page);
    const first = pins(page);
    await first.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(first).toContainText("MULTI_A_CURRENT");
    const firstClient = wire.requests.filter(r => r.type === "sessionChanges.request").at(-1)?.clientId;
    if (!firstClient) throw new Error("Pinned refresh did not issue a source-owned request");
    await expect.poll(() => first.getAttribute("aria-busy")).not.toBe("true");
    await createSession(page, b.repo, "Multi source B");
    await chooseFile(ordinary(page)); await pin(page);
    const tabs = pinTabs(page);
    await expect(tabs).toHaveCount(2);
    await expect(pins(page)).toContainText("MULTI_B_CURRENT");
    await chooseFile(pins(page), "other.ts");
    await pins(page).locator(".diff-layout-select").selectOption("unified");
    await pins(page).locator(".diff-ignore-whitespace").check();
    await expect(pins(page).locator(".diffs-main-body")).toContainText("MULTI_B_CURRENT");
    await tabs.filter({ hasText: "MULTI_A" }).click();
    await expect(pins(page).locator('.diffs-file-jump[data-diff-file-path="same.ts"]')).toHaveClass(/active/);
    await expect(pins(page).locator(".diff-ignore-whitespace")).not.toBeChecked();
    wire.hold(firstClient);
    a.change("LATE");
    await pins(page).getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => wire.held.length).toBeGreaterThan(0);
    await tabs.filter({ hasText: "MULTI_A" }).getByRole("button", { name: /close/i }).click();
    await expect(tabs).toHaveCount(1);
    wire.hold(null); wire.release();
    await expect(pins(page)).toContainText("MULTI_B_CURRENT");
    await expect(pins(page)).not.toContainText("MULTI_A_LATE");
    await page.screenshot({ path: info.outputPath("remaining-pin-after-late-close.png") });
    await activateOrdinary(page);
    await expect(ordinary(page)).toContainText("MULTI_B_CURRENT");
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await expect(page.locator(".pinned-diff-view")).toHaveCount(0);
    await expect(pinTabs(page)).toHaveCount(0);
    await expect(page.locator("#normalWorkspacePanelHost .dv-tab").filter({ hasText: "Git changes" })).toHaveCount(1);
  } finally { a.cleanup(); b.cleanup(); }
});

test("pinned History retains resolved OID, committed Code and Copy after branch movement and session switch", async ({ page, context }, info) => {
  const a = fixture("HISTORY_A"), b = fixture("HISTORY_B");
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const wire = await captureWire(page);
    await authenticate(page); await createSession(page, a.repo, "History source A");
    await ordinary(page).getByRole("button", { name: "History", exact: true }).click();
    await expect(ordinary(page).locator(".git-selected-commit-meta")).toContainText(a.oid);
    await chooseFile(ordinary(page)); await pin(page);
    a.change("MOVED_BRANCH"); a.commit("Advance branch after pin");
    await createSession(page, b.repo, "History other B");
    await activatePin(page, "HISTORY_A");
    const view = pins(page);
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(view.locator(".git-selected-commit-meta")).toContainText(a.oid);
    await expect(view.locator(".diffs-main-body")).toContainText("HISTORY_A_COMMIT");
    await expect(view.locator(".diffs-main-body")).not.toContainText("MOVED_BRANCH");
    await view.getByRole("button", { name: "View committed file", exact: true }).click();
    const file = page.locator(".git-file-dialog");
    await expect(file.locator(".git-file-origin")).toContainText(a.oid);
    await expect(file).toContainText("HISTORY_A_COMMIT");
    await file.getByRole("button", { name: "Copy file", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("HISTORY_A_COMMIT"); expect(copied).not.toContain("HISTORY_B");
    await file.getByRole("button", { name: "Close", exact: true }).click();
    const same = view.locator('.diffs-file-jump[data-diff-file-path="same.ts"]');
    await same.click({ button: "right" });
    await page.getByRole("button", { name: "View this revision in Code", exact: true }).click();
    await expect(page.locator(".code-revision-view:visible, .code-revision:visible")).toContainText("HISTORY_A_COMMIT");
    expect(wire.requests.filter(r => r.type === "git.file.request").every(r => r.repoRoot === a.repo && r.commitOid === a.oid)).toBe(true);
    await page.screenshot({ path: info.outputPath("pinned-history-immutable-code.png") });
    await chooseFile(view, "removed.txt");
    await view.getByRole("button", { name: "View committed file", exact: true }).click();
    await expect(file.locator(".git-file-origin")).toContainText(a.base);
    await expect(file).toContainText("HISTORY_A_OLD_SIDE_ONLY");
    await file.getByRole("button", { name: "Close", exact: true }).click();
    await chooseFile(view, "after.ts");
    await view.getByRole("button", { name: "View committed file", exact: true }).click();
    await expect(file.locator(".git-file-origin")).toContainText(a.oid);
    await expect(file.locator(".git-file-origin")).toContainText("after.ts");
    await expect(file).toContainText("HISTORY_A_RENAMED_CONTENT");
    await file.getByRole("button", { name: "Close", exact: true }).click();
  } finally { a.cleanup(); b.cleanup(); }
});

test("same-worktree pins refresh only explicitly and preserve review recipient after switching agents", async ({ page }, info) => {
  const a = fixture("SHARED_A");
  try {
    const wire = await captureWire(page);
    await authenticate(page); await createSession(page, a.repo, "Shared agent A");
    const sourceId = wire.requests.filter(r => r.type === "sessionChanges.request").at(-1)?.sessionId;
    await chooseFile(ordinary(page)); await pin(page);
    await createSession(page, a.repo, "Shared agent B");
    await activatePin(page, "SHARED_A");
    const view = pins(page);
    await view.locator(".diff-line-add .diff-comment-btn").first().click();
    await view.locator(".review-comment-composer-input").fill("PIN_NOTE_FOR_A");
    await view.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(view).toContainText("PIN_NOTE_FOR_A");
    expect(wire.requests.filter(r => r.type === "review.comment.create").at(-1)?.sessionId).toBe(sourceId);
    await view.getByRole("button", { name: /Preview comments/ }).click();
    await expect(page.locator("#diffPreviewOverlay")).toContainText("Shared agent A");
    await page.locator("#diffPreviewSend").click();
    await expect.poll(() => wire.requests.filter(r => r.type === "prompt.send").at(-1)?.sessionId).toBe(sourceId);
    await expect(page.locator("#sessionTitle")).toContainText("Shared agent B");
    const reviewButton = view.getByRole("button", { name: /Request agent review/ });
    await expect(reviewButton).toBeEnabled();
    await reviewButton.click();
    await expect(page.locator("#diffPreviewOverlay")).toContainText("Shared agent A");
    await page.locator("#diffPreviewSend").click();
    await expect.poll(() => wire.requests.filter(r => r.type === "review.agentReview.start").at(-1)?.sessionId).toBe(sourceId);
    await expect(page.locator("#sessionTitle")).toContainText("Shared agent B");
    a.change("REAL_EDIT");
    await activateOrdinary(page);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(ordinary(page)).toContainText("SHARED_A_REAL_EDIT");
    await activatePin(page, "SHARED_A");
    await expect(view).toContainText("SHARED_A_CURRENT");
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(view.locator(".diffs-main-body")).toContainText("SHARED_A_REAL_EDIT");
    await view.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.locator(".code-viewer:visible")).toContainText("SHARED_A_REAL_EDIT");
    await expect(page.locator("#sessionTitle")).toContainText("Shared agent B");
    await chooseSession(page, "Shared agent A");
    await page.locator("#stopButton").click();
    await chooseSession(page, "Shared agent B");
    await expect(view).toContainText(/stopped|unavailable|resume|not running|no live/i);
    await expect(view.getByRole("button", { name: /Request agent review/ })).toBeDisabled();
    const before = wire.requests.filter(r => r.type === "session.open" || r.type === "session.create").length;
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(view).toContainText("SHARED_A_REAL_EDIT");
    expect(wire.requests.filter(r => r.type === "session.open" || r.type === "session.create").length).toBe(before);
    await page.screenshot({ path: info.outputPath("stopped-source-safe-pin.png") });
    const deleteSource = page.getByRole("button", { name: `Delete session ${sessionNames.get(page)!.get("Shared agent A")}`, exact: true });
    await deleteSource.click();
    await page.locator("#deleteSessionConfirm").click();
    await expect(deleteSource).toHaveCount(0);
    await expect(view).toContainText(/deleted|unavailable|no longer/i);
    await expect(view.locator(".diffs-main-body")).toContainText("SHARED_A_REAL_EDIT");
    await expect(view.getByRole("button", { name: /Request agent review/ })).toBeDisabled();
    await expect(page.locator("#sessionTitle")).toContainText("Shared agent B");
    await page.screenshot({ path: info.outputPath("deleted-source-safe-pin.png") });
  } finally { a.cleanup(); }
});

test("missing repository cannot replace a pin with another source", async ({ page }, info) => {
  const a = fixture("MISSING_A"), b = fixture("MISSING_B");
  try {
    await authenticate(page); await createSession(page, a.repo, "Missing source A");
    await pin(page); await createSession(page, b.repo, "Available source B");
    await activatePin(page, "MISSING_A");
    rmSync(a.repo, { recursive: true });
    await pins(page).getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(pins(page)).toContainText(/unavailable|failed|not found|missing|not available/i);
    await expect(pins(page)).toContainText(a.repo);
    await expect(pins(page)).not.toContainText("MISSING_B_CURRENT");
    await page.screenshot({ path: info.outputPath("missing-repository-retains-source.png") });
    await activateOrdinary(page);
    await expect(ordinary(page)).toContainText("MISSING_B_CURRENT");
  } finally { a.cleanup(); b.cleanup(); }
});

test("ordinary Compare pins resolved refs and native popup close redocks only its own instance", async ({ page }, info) => {
  const a = fixture("COMPARE_A"), b = fixture("COMPARE_B");
  let child: Page | undefined;
  try {
    await authenticate(page); await createSession(page, a.repo, "Compare source A");
    await ordinary(page).locator(".git-review-options > summary").click();
    await ordinary(page).getByRole("button", { name: "Advanced Compare", exact: true }).click();
    await page.locator("#cwdPickerDiffBase").fill(a.base);
    await page.locator("#cwdPickerDiffHead").fill("HEAD");
    await page.locator("#cwdPickerDiffAgentSession").uncheck();
    await page.locator("#cwdPickerCreate").click();
    const compare = page.locator(".compare-view:visible");
    await expect(compare.locator(".diffs-main-body")).toContainText("COMPARE_A_COMMIT");
    await chooseFile(compare);
    await pin(page, compare);
    await createSession(page, b.repo, "Compare other B");
    await activatePin(page, "COMPARE_A");
    a.change("ADVANCED_HEAD"); a.commit("Move symbolic Compare endpoint");
    await pins(page).getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(pins(page)).toContainText("COMPARE_A_COMMIT");
    await expect(pins(page)).not.toContainText("ADVANCED_HEAD");
    const id = await pins(page).getAttribute("data-panel-id");
    child = await popout(page, pins(page));
    const closed = child.waitForEvent("close");
    await child.evaluate(() => window.close());
    await closed; child = undefined;
    await expect(pins(page)).toContainText("COMPARE_A_COMMIT");
    expect(await pins(page).getAttribute("data-panel-id")).toBe(id);
    await expect(pinTabs(page)).toHaveCount(1);
    await pinTabs(page).getByRole("button", { name: /close/i }).click();
    await expect(page.locator(".pinned-diff-view")).toHaveCount(0);
    await expect(page.locator("#normalWorkspacePanelHost .dv-tab").filter({ hasText: "Git changes" })).toHaveCount(1);
    await expect(page.locator("#normalWorkspacePanelHost .dv-tab").filter({ hasText: "Compare" })).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("compare-survives-pin-close.png") });
  } finally { await child?.close(); a.cleanup(); b.cleanup(); }
});

test("narrow desktop keeps pin controls reachable and Find stays with the focused pin", async ({ page }, info) => {
  const a = fixture("NARROW_A");
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await authenticate(page); await createSession(page, a.repo, "Narrow source A");
    await chooseFile(ordinary(page)); await pin(page);
    const view = pins(page);
    const toolbar = await pinWindowButton(page, view);
    const box = await toolbar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
    await expect(view.locator(".diffs-main-body")).toBeVisible();
    await view.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.locator(".code-viewer:visible")).toContainText("NARROW_A_CURRENT");
    await view.focus();
    await page.keyboard.press("Control+f");
    await expect(page.locator(".code-search-overlay")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("narrow-pinned-controls.png") });
  } finally { a.cleanup(); }
});

test("dedicated review pin keeps repository reads after its recipient is deleted", async ({ page }, info) => {
  const a = fixture("DEDICATED_A"), b = fixture("DEDICATED_B");
  try {
    const wire = await captureWire(page);
    await authenticate(page); await createSession(page, a.repo, "Dedicated source A", true);
    await expect(ordinary(page).locator(".diffs-main-body")).toContainText("DEDICATED_A_COMMIT");
    await chooseFile(ordinary(page)); await pin(page);
    await createSession(page, b.repo, "Dedicated other B");
    await activatePin(page, "DEDICATED_A");
    const view = pins(page);
    const deleteSource = page.getByRole("button", { name: `Delete session ${sessionNames.get(page)!.get("Dedicated source A")}`, exact: true });
    await deleteSource.click();
    await page.locator("#deleteSessionConfirm").click();
    await expect(deleteSource).toHaveCount(0);
    await expect(view).toContainText(/unavailable|stopped/);
    await expect(view.getByRole("button", { name: "Request agent review", exact: true })).toBeDisabled();
    await expect(view.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    const priorReads = wire.requests.filter(request => request.type === "compareDiff.request").length;
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => wire.requests.filter(request => request.type === "compareDiff.request").length).toBe(priorReads + 1);
    await expect(view.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(view.locator(".diffs-main-body")).toContainText("DEDICATED_A_COMMIT");
    await page.screenshot({ path: info.outputPath("dedicated-source-deleted-read-only.png") });
    await activateOrdinary(page);
    await expect(ordinary(page)).toContainText("DEDICATED_B_CURRENT");
  } finally { a.cleanup(); b.cleanup(); }
});

// Only the private acceptance build installs this overlay. Production has no test hook.
type PinWorkspace = "normal" | "diffReview";
type PinBox = { x: number; y: number; width: number; height: number };
type PinGeometry = {
  workspace: PinWorkspace;
  viewport: { width: number; height: number };
  host: PinBox;
  groups: Array<{ id: string; box: PinBox; panels: string[]; active?: string }>;
  pins: Array<{ id: string; mounted: string[]; popped?: boolean }>;
};
declare global {
  interface Window {
    __furaPinTest: {
      dockviews: Record<PinWorkspace, DockviewComponent>;
      pins: Map<string, PinnedDiff>;
      owners: Map<string, DesktopDockview>;
    };
  }
}

async function pinGeometry(page: Page, workspace: PinWorkspace): Promise<PinGeometry> {
  return page.evaluate(async workspace => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const hook = window.__furaPinTest;
    if (!hook) throw new Error("The @adapter acceptance build must install window.__furaPinTest");
    const host = document.getElementById(workspace === "normal" ? "normalWorkspacePanelHost" : "diffReviewWorkspacePanelHost")!;
    const box = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      workspace, viewport: { width: innerWidth, height: innerHeight }, host: box(host),
      groups: hook.dockviews[workspace].groups.filter(group => group.api.location.type === "grid").map(group => ({
        id: group.id, box: box(group.element), panels: group.panels.map(panel => panel.id), active: group.activePanel?.id,
      })).sort((a, b) => a.id.localeCompare(b.id)),
      pins: [...hook.pins.values()].map(pin => ({
        id: pin.id,
        mounted: Object.entries(hook.dockviews).filter(([, api]) => api.getGroupPanel(pin.id)).map(([mode]) => mode),
        popped: hook.owners.get(pin.id)?.isPanelPoppedOut(pin.id),
      })),
    };
  }, workspace);
}

function expectFilledWorkspace(geometry: PinGeometry) {
  const tolerance = 2;
  const host = geometry.host;
  expect(host.width, "Workspace host must have positive width").toBeGreaterThan(0);
  expect(host.height, "Workspace host must have positive height").toBeGreaterThan(0);
  const visible = geometry.groups.filter(group => group.box.width > 1 && group.box.height > 1);
  expect(visible.every(group => group.panels.length > 0), "No empty group may reserve layout area").toBe(true);
  for (const [index, group] of visible.entries()) {
    expect(group.box.x, `${group.id} left must remain inside the host`).toBeGreaterThanOrEqual(host.x - tolerance);
    expect(group.box.y, `${group.id} top must remain inside the host`).toBeGreaterThanOrEqual(host.y - tolerance);
    expect(group.box.x + group.box.width, `${group.id} right must remain inside the host`).toBeLessThanOrEqual(host.x + host.width + tolerance);
    expect(group.box.y + group.box.height, `${group.id} bottom must remain inside the host`).toBeLessThanOrEqual(host.y + host.height + tolerance);
    for (const other of visible.slice(index + 1)) {
      const overlapWidth = Math.min(group.box.x + group.box.width, other.box.x + other.box.width) - Math.max(group.box.x, other.box.x);
      const overlapHeight = Math.min(group.box.y + group.box.height, other.box.y + other.box.height) - Math.max(group.box.y, other.box.y);
      expect(overlapWidth <= tolerance || overlapHeight <= tolerance, `${group.id} and ${other.id} must not overlap`).toBe(true);
    }
  }
  const covered = visible.reduce((area, group) => area + group.box.width * group.box.height, 0);
  expect(covered / (geometry.host.width * geometry.host.height), "Docked groups must fill the host, allowing splitter borders").toBeGreaterThan(0.97);
  expect(geometry.pins.every(pin => pin.mounted.length === 1), "Each pin has exactly one native owner").toBe(true);
}

function expectSameGeometry(actual: PinGeometry, expected: PinGeometry) {
  const visible = (geometry: typeof actual) => geometry.groups.filter(group => group.box.width > 1 && group.box.height > 1);
  expect(visible(actual).map(group => group.id), "Pinning must not introduce a group or remove a user group").toEqual(visible(expected).map(group => group.id));
  const actualBoxes = [actual.host, ...visible(actual).map(group => group.box)];
  const expectedBoxes = [expected.host, ...visible(expected).map(group => group.box)];
  actualBoxes.forEach((box, index) => {
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(box[dimension] - expectedBoxes[index][dimension]), `Box ${index} ${dimension} must retain the user boundary`).toBeLessThanOrEqual(2);
    }
  });
  expectFilledWorkspace(actual);
}

async function geometryEvidence(page: Page, info: TestInfo, workspace: PinWorkspace, label: string) {
  const geometry = await pinGeometry(page, workspace);
  await info.attach(`${label}-geometry`, { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
  const screenshot = info.outputPath(`${label}.png`);
  await page.screenshot({ path: screenshot });
  await info.attach(label, { path: screenshot, contentType: "image/png" });
  return geometry;
}

async function resizeWorkspace(page: Page, info: TestInfo, workspace: PinWorkspace) {
  const intent = await page.evaluate(workspace => {
    const api = window.__furaPinTest.dockviews[workspace];
    const diff = api.getGroupPanel(workspace === "normal" ? "diffs" : "sessionChanges")!;
    const side = api.getGroupPanel(workspace === "normal" ? "transcript" : "sessionChanges")!;
    const width = Math.round(api.width * (workspace === "normal" ? 0.43 : 0.61));
    const height = Math.round(api.height * (workspace === "normal" ? 0.58 : 0.33));
    side.group.api.setSize({ width });
    const vertical = workspace === "normal" ? diff : api.getGroupPanel("tools")!;
    vertical.group.api.setSize({ height });
    return { action: "Manual Dockview group.api.setSize", workspace, width: { group: side.group.id, pixels: width }, height: { group: vertical.group.id, pixels: height } };
  }, workspace);
  await info.attach(`${workspace}-resize-intent`, { body: JSON.stringify(intent, null, 2), contentType: "application/json" });
}

async function closePopup(child: Page, method: "return" | "close") {
  const closed = child.waitForEvent("close");
  if (method === "return") await child.getByRole("button", { name: "Return to main", exact: true }).click();
  else await child.evaluate(() => window.close());
  await closed;
}

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 900 }]) {
  for (const workspace of ["normal", "diffReview"] as const) {
    test(`@adapter ${workspace} ${viewport.width}x${viewport.height}: tab-only pins preserve resized geometry and reclaim every evacuated group`, async ({ page }, info) => {
      const a = fixture(`GEOMETRY_${workspace}`);
      const children: Page[] = [];
      try {
        await page.setViewportSize(viewport);
        await authenticate(page);
        await createSession(page, a.repo, "Geometry source", workspace === "diffReview");
        await expect(ordinary(page).locator(".diffs-main-body")).toContainText(`GEOMETRY_${workspace}`);
        const defaults = await geometryEvidence(page, info, workspace, "before-manual-resize");
        await resizeWorkspace(page, info, workspace);
        const before = await geometryEvidence(page, info, workspace, "before-pins");
        expect(before.groups.map(group => group.box), "Manual resize must change actual group boundaries").not.toEqual(defaults.groups.map(group => group.box));
        const first = await pin(page);
        const firstId = (await first.getAttribute("data-panel-id"))!;
        await expect(ordinary(page)).toHaveCount(0);
        const afterFirst = await geometryEvidence(page, info, workspace, "first-pin");
        expectSameGeometry(afterFirst, before);
        const originalGroup = before.groups.find(group => group.panels.includes(workspace === "normal" ? "diffs" : "sessionChanges"))!;
        expect(afterFirst.groups.find(group => group.panels.includes(firstId))?.id).toBe(originalGroup.id);
        await activateOrdinary(page);
        const second = await pin(page);
        const secondId = (await second.getAttribute("data-panel-id"))!;
        expect(secondId).not.toBe(firstId);
        expectSameGeometry(await geometryEvidence(page, info, workspace, "second-pin"), before);
        expect(await page.evaluate(({ workspace, secondId }) => window.__furaPinTest.dockviews[workspace].getGroupPanel(secondId)!.group.activePanel?.id, { workspace, secondId })).toBe(secondId);

        const secondPopup = await popout(page, pins(page)); children.push(secondPopup);
        await page.evaluate(({ workspace, firstId }) => window.__furaPinTest.dockviews[workspace].getGroupPanel(firstId)!.api.setActive(), { workspace, firstId });
        const firstPopup = await popout(page, pins(page)); children.push(firstPopup);
        await expect(pins(page)).toHaveCount(0);
        expectSameGeometry(await geometryEvidence(page, info, workspace, "all-pins-popped"), before);
        await closePopup(firstPopup, "return");
        await expect(pins(page)).toHaveAttribute("data-panel-id", firstId);
        await pinTabs(page).getByRole("button", { name: /close/i }).click();
        await expect(pins(secondPopup)).toBeVisible();
        expectSameGeometry(await geometryEvidence(page, info, workspace, "last-docked-closed-other-popped"), before);
        await closePopup(secondPopup, "close");
        await expect(pins(page)).toHaveAttribute("data-panel-id", secondId);
        await pinTabs(page).getByRole("button", { name: /close/i }).click();
        await expect.poll(() => page.evaluate(() => window.__furaPinTest.pins.size)).toBe(0);
        expectSameGeometry(await geometryEvidence(page, info, workspace, "all-pins-closed"), before);

        await activateOrdinary(page);
        const splitPin = await pin(page);
        const splitId = (await splitPin.getAttribute("data-panel-id"))!;
        const splitGroup = await page.evaluate(({ workspace, splitId }) => {
          const api = window.__furaPinTest.dockviews[workspace];
          const panel = api.getGroupPanel(splitId)!;
          panel.api.moveTo({ group: panel.group, position: "right" });
          panel.group.api.setSize({ width: Math.round(api.width * 0.27) });
          return panel.group.id;
        }, { workspace, splitId });
        const split = await geometryEvidence(page, info, workspace, "manual-pin-only-split");
        expect(split.groups.filter(group => group.box.width > 1 && group.box.height > 1)).toHaveLength(before.groups.length + 1);
        const splitPopup = await popout(page, pins(page)); children.push(splitPopup);
        const evacuated = await geometryEvidence(page, info, workspace, "manual-split-popped");
        expectFilledWorkspace(evacuated);
        expect(evacuated.groups.find(group => group.id === splitGroup)?.box.width ?? 0).toBeLessThanOrEqual(1);
        await closePopup(splitPopup, "return");
        await expect(pins(page)).toHaveAttribute("data-panel-id", splitId);
        expectSameGeometry(await geometryEvidence(page, info, workspace, "manual-split-returned"), split);
        await activateOrdinary(page);
        await ordinary(page).getByRole("button", { name: "Pin as new tab", exact: true }).click();
        const siblingId = await page.evaluate(({ workspace, splitId }) => {
          const hook = window.__furaPinTest;
          const api = hook.dockviews[workspace];
          const siblingId = [...hook.pins.keys()].find(id => id !== splitId)!;
          api.getGroupPanel(siblingId)!.api.moveTo({ group: api.getGroupPanel(splitId)!.group, position: "center" });
          return siblingId;
        }, { workspace, splitId });
        const sharedSplit = await geometryEvidence(page, info, workspace, "two-pins-in-one-manual-split");
        expect(sharedSplit.groups.find(group => group.id === splitGroup)?.panels.sort()).toEqual([splitId, siblingId].sort());
        expectSameGeometry(sharedSplit, split);
        const siblingPopup = await popout(page, pins(page)); children.push(siblingPopup);
        await expect(pins(page)).toHaveAttribute("data-panel-id", splitId);
        expectSameGeometry(await geometryEvidence(page, info, workspace, "manual-split-one-popped-one-docked"), split);
        await pinTabs(page).getByRole("button", { name: /close/i }).click();
        await expect(pins(siblingPopup)).toHaveAttribute("data-panel-id", siblingId);
        await expect(pins(siblingPopup)).toContainText(`GEOMETRY_${workspace}`);
        const removed = await geometryEvidence(page, info, workspace, "manual-split-last-docked-closed-other-popped");
        expectFilledWorkspace(removed);
        expect(removed.groups.find(group => group.id === splitGroup)?.box.width ?? 0).toBeLessThanOrEqual(1);
        expect(removed.groups.filter(group => group.box.width > 1 && group.box.height > 1)).toHaveLength(before.groups.length);
        expect(removed.pins).toEqual([{ id: siblingId, mounted: [workspace], popped: true }]);
        await closePopup(siblingPopup, "return");
        await expect(pins(page)).toHaveAttribute("data-panel-id", siblingId);
        await pinTabs(page).getByRole("button", { name: /close/i }).click();
        await expect.poll(() => page.evaluate(() => window.__furaPinTest.pins.size)).toBe(0);
        expectFilledWorkspace(await geometryEvidence(page, info, workspace, "manual-split-all-pins-closed"));
      } finally {
        for (const child of children) if (!child.isClosed()) await child.close();
        a.cleanup();
      }
    });
  }
}

for (const method of ["return", "close"] as const) {
  test(`@adapter popup ${method} restores active-workspace neighbors and survives source-group loss`, async ({ page }, info) => {
    const a = fixture("REDOCK_A"), b = fixture("REDOCK_B");
    let child: Page | undefined;
    try {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await authenticate(page);
      await createSession(page, a.repo, "Redock source A");
      await createSession(page, b.repo, "Redock review B", true);
      await resizeWorkspace(page, info, "diffReview");
      await chooseSession(page, "Redock source A");
      await activateOrdinary(page);
      await resizeWorkspace(page, info, "normal");
      const first = await pin(page);
      const firstId = (await first.getAttribute("data-panel-id"))!;
      await activateOrdinary(page);
      const second = await pin(page);
      const secondId = (await second.getAttribute("data-panel-id"))!;
      const normalOrder = await page.evaluate(firstId => {
        const api = window.__furaPinTest.dockviews.normal;
        const panel = api.getGroupPanel(firstId)!;
        panel.api.moveTo({ group: panel.group, position: "center", index: 0 });
        return panel.group.panels.map(panel => panel.id);
      }, firstId);
      const normal = await geometryEvidence(page, info, "normal", "normal-custom-tab-order");
      await chooseSession(page, "Redock review B");
      const reviewOrder = await page.evaluate(firstId => {
        const api = window.__furaPinTest.dockviews.diffReview;
        const panel = api.getGroupPanel(firstId)!;
        panel.api.moveTo({ group: api.getGroupPanel("transcript")!.group, position: "center", index: 0 });
        return panel.group.panels.map(panel => panel.id);
      }, firstId);
      const review = await geometryEvidence(page, info, "diffReview", "review-custom-tab-order");
      await chooseSession(page, "Redock source A");
      expect(await page.evaluate(firstId => window.__furaPinTest.dockviews.normal.getGroupPanel(firstId)!.group.panels.map(panel => panel.id), firstId)).toEqual(normalOrder);
      expectSameGeometry(await geometryEvidence(page, info, "normal", "normal-layout-restored"), normal);
      await page.evaluate(firstId => window.__furaPinTest.dockviews.normal.getGroupPanel(firstId)!.api.setActive(), firstId);
      child = await popout(page, page.locator(`.pinned-diff-view[data-panel-id="${firstId}"]`));
      await chooseSession(page, "Redock review B");
      await expect(pins(child)).toContainText("REDOCK_A");
      expect(await page.evaluate(firstId => ({
        normal: Boolean(window.__furaPinTest.dockviews.normal.getGroupPanel(firstId)),
        review: Boolean(window.__furaPinTest.dockviews.diffReview.getGroupPanel(firstId)),
      }), firstId)).toEqual({ normal: true, review: false });
      await closePopup(child, method); child = undefined;
      await expect(page.locator(`.pinned-diff-view[data-panel-id="${firstId}"]`)).toBeVisible();
      expect(await page.evaluate(firstId => window.__furaPinTest.dockviews.diffReview.getGroupPanel(firstId)!.group.panels.map(panel => panel.id), firstId)).toEqual(reviewOrder);
      expectSameGeometry(await geometryEvidence(page, info, "diffReview", "redocked-active-review-layout"), review);
      await expect(page.locator("#sessionTitle")).toContainText("Redock review B");

      const sourceGroup = await page.evaluate(firstId => {
        const api = window.__furaPinTest.dockviews.diffReview;
        const panel = api.getGroupPanel(firstId)!;
        panel.api.moveTo({ group: api.getGroupPanel("sessionChanges")!.group, position: "right" });
        panel.group.api.setSize({ width: Math.round(api.width * 0.29) });
        return panel.group.id;
      }, firstId);
      child = await popout(page, page.locator(`.pinned-diff-view[data-panel-id="${firstId}"]`));
      await page.evaluate(sourceGroup => {
        const api = window.__furaPinTest.dockviews.diffReview;
        const group = api.groups.find(group => group.id === sourceGroup);
        if (group) api.removeGroup(group);
      }, sourceGroup);
      const lost = await geometryEvidence(page, info, "diffReview", "source-group-removed");
      expectFilledWorkspace(lost);
      expect(lost.groups.some(group => group.id === sourceGroup)).toBe(false);
      await closePopup(child, method); child = undefined;
      const fallback = await page.evaluate(({ firstId, secondId }) => {
        const hook = window.__furaPinTest;
        const api = hook.dockviews.diffReview;
        return {
          pinGroup: api.getGroupPanel(firstId)!.group.id,
          diffGroup: api.getGroupPanel("sessionChanges")!.group.id,
          firstMounted: Object.values(hook.dockviews).filter(host => host.getGroupPanel(firstId)).length,
          secondMounted: Object.values(hook.dockviews).filter(host => host.getGroupPanel(secondId)).length,
        };
      }, { firstId, secondId });
      expect(fallback.pinGroup).toBe(fallback.diffGroup);
      expect([fallback.firstMounted, fallback.secondMounted]).toEqual([1, 1]);
      expectSameGeometry(await geometryEvidence(page, info, "diffReview", "redocked-fallback-to-diffs"), lost);
      await expect(page.locator("#sessionTitle")).toContainText("Redock review B");
    } finally { await child?.close(); a.cleanup(); b.cleanup(); }
  });
}

test("@adapter blocked popup leaves the same functional tab without changing group geometry", async ({ page }, info) => {
  const a = fixture("BLOCKED_A");
  try {
    const wire = await captureWire(page);
    await authenticate(page);
    await createSession(page, a.repo, "Blocked source A");
    await pin(page);
    const id = (await pins(page).getAttribute("data-panel-id"))!;
    const before = await geometryEvidence(page, info, "normal", "before-blocked-popup");
    const original = await page.evaluateHandle(id => ({
      open: window.open,
      controller: window.__furaPinTest.pins.get(id)!,
      content: document.querySelector<HTMLElement>(`.pinned-diff-view[data-panel-id="${id}"]`)!.parentElement!,
    }), id);
    try {
      await page.evaluate(() => { window.open = () => null; });
      await (await pinWindowButton(page, pins(page))).click();
      await expect(pins(page)).toContainText("BLOCKED_A_CURRENT");
      expectSameGeometry(await geometryEvidence(page, info, "normal", "popup-blocked-tab-retained"), before);
      expect(await original.evaluate(original => {
        const hook = window.__furaPinTest;
        return hook.pins.get(original.controller.id) === original.controller
          && !hook.owners.get(original.controller.id)!.isPanelPoppedOut(original.controller.id)
          && hook.owners.get(original.controller.id)!.panelContains(original.controller.id, original.content);
      })).toBe(true);
      const reads = wire.requests.filter(request => request.type === "sessionChanges.request").length;
      a.change("AFTER_BLOCK");
      await pins(page).getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(pins(page).locator(".diffs-main-body")).toContainText("BLOCKED_A_AFTER_BLOCK");
      expect(wire.requests.filter(request => request.type === "sessionChanges.request")).toHaveLength(reads + 1);
    } finally {
      await original.evaluate(original => { window.open = original.open; });
      await original.dispose();
    }
  } finally { a.cleanup(); }
});

test("@adapter one controller and content retain inactive draft, selection, settings and scroll across workspaces, popup and delayed replies", async ({ page }, info) => {
  const a = fixture("IDENTITY_A"), b = fixture("IDENTITY_B");
  let child: Page | undefined;
  try {
    const wire = await captureWire(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await authenticate(page);
    await createSession(page, a.repo, "Identity source A");
    await chooseFile(ordinary(page));
    await ordinary(page).locator(".diff-layout-select").selectOption("split");
    await ordinary(page).locator(".diff-ignore-whitespace").check();
    await expect(ordinary(page)).toHaveAttribute("data-ignore-whitespace", "true");
    await expect(ordinary(page).locator(".diffs-main-body")).toContainText("IDENTITY_A_CURRENT");
    await pin(page);
    const id = (await pins(page).getAttribute("data-panel-id"))!;
    await pins(page).locator(".diff-line-add .diff-comment-btn").first().click();
    await pins(page).locator(".review-comment-composer-input").fill("UNSENT_FOR_A_ONLY");
    await pins(page).locator(".review-comment-composer-input").evaluate(input => (input as HTMLTextAreaElement).setSelectionRange(2, 9));
    await pins(page).locator(".diffs-main-body").evaluate(body => { body.scrollTop = 247; });
    const initial = await page.evaluateHandle(id => {
      const pin = window.__furaPinTest.pins.get(id)!;
      const root = document.querySelector<HTMLElement>(`.pinned-diff-view[data-panel-id="${id}"]`)!;
      const content = root.parentElement!;
      return {
        pin, content, root, target: JSON.stringify(pin.target), recipient: pin.ownerSessionId,
        draft: root.querySelector<HTMLTextAreaElement>(".review-comment-composer-input")!,
        body: root.querySelector<HTMLElement>(".diffs-main-body")!,
      };
    }, id);
    const clientId = await initial.evaluate(initial => initial.pin.clientId);
    const requestsBefore = wire.requests.filter(request => request.clientId === clientId).length;
    try {
      await createSession(page, b.repo, "Identity normal B");
      await expect(pins(page)).toHaveCount(0);
      await createSession(page, b.repo, "Identity review B", true);
      await expect(pins(page)).toHaveCount(0);
      for (const session of ["Identity normal B", "Identity review B", "Identity normal B", "Identity review B"]) {
        await chooseSession(page, session);
        await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
        const expectedWorkspace = session === "Identity normal B" ? "normal" : "diffReview";
        expect(await initial.evaluate(initial => {
          const hook = window.__furaPinTest;
          const pin = hook.pins.get(initial.pin.id)!;
          return {
            sameController: pin === initial.pin,
            sameContent: hook.owners.get(pin.id)!.panelContains(pin.id, initial.content),
            sameRoot: initial.content.querySelector(".pinned-diff-view") === initial.root,
            sameDraft: initial.content.querySelector(".review-comment-composer-input") === initial.draft,
            connected: initial.content.isConnected,
            target: JSON.stringify(pin.target) === initial.target,
            recipient: pin.ownerSessionId === initial.recipient,
            selectedFile: pin.selectedFile, layout: pin.layout, whitespace: pin.ignoreWhitespace,
            draft: initial.draft.value, selection: [initial.draft.selectionStart, initial.draft.selectionEnd],
            owners: Object.entries(hook.dockviews).filter(([, api]) => api.getGroupPanel(pin.id)).map(([mode]) => mode),
          };
        })).toEqual({
          sameController: true, sameContent: true, sameRoot: true, sameDraft: true, connected: true, target: true, recipient: true,
          selectedFile: "same.ts", layout: "split", whitespace: true, draft: "UNSENT_FOR_A_ONLY", selection: [2, 9], owners: [expectedWorkspace],
        });
      }
      await activatePin(page, "IDENTITY_A");
      await expect.poll(() => pins(page).locator(".diffs-main-body").evaluate(body => body.scrollTop)).toBe(247);
      expect(wire.requests.filter(request => request.clientId === clientId)).toHaveLength(requestsBefore);
      child = await popout(page, pins(page));
      await chooseSession(page, "Identity normal B");
      await expect(pins(child)).toContainText("IDENTITY_A_CURRENT");
      await expect(pins(child).locator(".review-comment-composer-input")).toHaveValue("UNSENT_FOR_A_ONLY");
      await child.bringToFront();
      await page.bringToFront();
      await info.attach("popup-stays-visible-in-other-workspace", { body: await child.screenshot(), contentType: "image/png" });
      await closePopup(child, "return"); child = undefined;
      await expect(pins(page)).toHaveAttribute("data-panel-id", id);
      await expect.poll(() => pins(page).locator(".diffs-main-body").evaluate(body => body.scrollTop)).toBe(247);
      expect(await initial.evaluate(initial => ({
        controller: window.__furaPinTest.pins.get(initial.pin.id) === initial.pin,
        content: window.__furaPinTest.owners.get(initial.pin.id)!.panelContains(initial.pin.id, initial.content),
        root: initial.content.querySelector(".pinned-diff-view") === initial.root,
        draft: initial.content.querySelector(".review-comment-composer-input") === initial.draft,
        selection: [initial.draft.selectionStart, initial.draft.selectionEnd],
      }))).toEqual({ controller: true, content: true, root: true, draft: true, selection: [2, 9] });
      expect(wire.requests.filter(request => request.clientId === clientId)).toHaveLength(requestsBefore);
      await geometryEvidence(page, info, "normal", "inactive-pin-restored");

      wire.hold(clientId);
      a.change("LATE_EXPLICIT");
      await pins(page).getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(() => wire.held.length).toBeGreaterThan(0);
      await activateOrdinary(page);
      await chooseSession(page, "Identity review B");
      await expect(pins(page)).toHaveCount(0);
      wire.hold(null); wire.release();
      const hidden = page.locator(`.pinned-diff-view[data-panel-id="${id}"]`);
      await expect(hidden.locator(".diffs-main-body")).toContainText("IDENTITY_A_LATE_EXPLICIT");
      await expect(hidden).not.toContainText("IDENTITY_B");
      expect(await initial.evaluate(initial => {
        const hook = window.__furaPinTest;
        return hook.pins.get(initial.pin.id) === initial.pin
          && hook.owners.get(initial.pin.id)!.panelContains(initial.pin.id, initial.content)
          && JSON.stringify(initial.pin.target) === initial.target;
      })).toBe(true);
      await activatePin(page, "IDENTITY_A");
      await expect(pins(page)).toContainText("IDENTITY_A_LATE_EXPLICIT");
      await expect(page.locator("#sessionTitle")).toContainText("Identity review B");
      await geometryEvidence(page, info, "diffReview", "delayed-A-reply-in-review-B");
    } finally { wire.hold(null); wire.release(); await initial.dispose(); }
  } finally { await child?.close(); a.cleanup(); b.cleanup(); }
});

for (const outcome of ["load", "close-before-load"] as const) {
  test(`@adapter delayed popup ${outcome} keeps one owner across a workspace switch`, async ({ page, context }, info) => {
    const a = fixture("OPENING_A"), b = fixture("OPENING_B");
    let child: Page | undefined;
    let resumeNavigation: (() => Promise<void>) | undefined;
    try {
      const wire = await captureWire(page);
      await authenticate(page);
      await createSession(page, a.repo, "Opening source A");
      await createSession(page, b.repo, "Opening review B", true);
      await chooseSession(page, "Opening source A");
      await activateOrdinary(page);
      await chooseFile(ordinary(page));
      await pin(page);
      const id = (await pins(page).getAttribute("data-panel-id"))!;
      const initial = await page.evaluateHandle(id => {
        const hook = window.__furaPinTest;
        return {
          pin: hook.pins.get(id)!,
          owner: hook.owners.get(id)!,
          content: document.querySelector<HTMLElement>(`.pinned-diff-view[data-panel-id="${id}"]`)!.parentElement!,
          open: window.open,
          popup: null as Window | null,
        };
      }, id);
      const clientId = await initial.evaluate(initial => initial.pin.clientId);
      await expect(pins(page).locator(".diffs-main-body")).toContainText("OPENING_A_CURRENT");
      await expect.poll(() => initial.evaluate(initial => initial.pin.loading), "Initial pin request must settle before measuring transition traffic").toBe(false);
      const requestsBefore = wire.requests.filter(request => request.clientId === clientId).length;
      try {
        await initial.evaluate(initial => {
          // Capture the actual native Window; do not mock or short-circuit opening.
          window.open = (...args) => {
            initial.popup = initial.open.apply(window, args);
            return initial.popup;
          };
        });
        await context.route("**/popout.html", route => {
          // Leave the real navigation pending until the workspace switch completes.
          resumeNavigation = () => route.continue();
        });
        const opened = outcome === "load" ? page.waitForEvent("popup") : null;
        await (await pinWindowButton(page, pins(page))).click({ noWaitAfter: true });
        await expect.poll(() => Boolean(resumeNavigation), "Popup navigation must still be held when switching workspaces").toBe(true);
        await chooseSession(page, "Opening review B");
        expect(await initial.evaluate(initial => {
          const hook = window.__furaPinTest;
          return {
            controller: hook.pins.get(initial.pin.id) === initial.pin,
            owner: hook.owners.get(initial.pin.id) === initial.owner,
            content: initial.owner.panelContains(initial.pin.id, initial.content),
            mounted: Object.entries(hook.dockviews).filter(([, api]) => api.getGroupPanel(initial.pin.id)).map(([mode]) => mode),
          };
        })).toEqual({ controller: true, owner: true, content: true, mounted: ["normal"] });
        await geometryEvidence(page, info, "diffReview", "popup-opening-during-workspace-switch");
        if (outcome === "close-before-load") {
          await initial.evaluate(initial => initial.popup!.close());
          await expect.poll(() => initial.evaluate(initial => initial.popup!.closed)).toBe(true);
          await expect(pins(page)).toHaveAttribute("data-panel-id", id);
          await expect(pins(page).locator(".diffs-main-body")).toContainText("OPENING_A_CURRENT");
          expect(await initial.evaluate(initial => {
            const hook = window.__furaPinTest;
            return {
              controller: hook.pins.get(initial.pin.id) === initial.pin,
              content: hook.owners.get(initial.pin.id)!.panelContains(initial.pin.id, initial.content),
              popped: hook.owners.get(initial.pin.id)!.isPanelPoppedOut(initial.pin.id),
              mounted: Object.entries(hook.dockviews).filter(([, api]) => api.getGroupPanel(initial.pin.id)).map(([mode]) => mode),
            };
          })).toEqual({ controller: true, content: true, popped: false, mounted: ["diffReview"] });
          await geometryEvidence(page, info, "diffReview", "popup-closed-before-load-content-recovered");
          await context.unroute("**/popout.html");
          await initial.evaluate(initial => { window.open = initial.open; });
          child = await popout(page, pins(page));
          await expect(pins(child).locator(".diffs-main-body")).toContainText("OPENING_A_CURRENT");
          await info.attach("reopened-after-cancelled-popup", { body: await child.screenshot(), contentType: "image/png" });
        } else {
          await resumeNavigation!();
          child = await opened!;
          await child.setViewportSize({ width: 1500, height: 1000 });
          await expect(pins(child)).toHaveAttribute("data-panel-id", id);
          await expect(pins(child).locator(".diffs-main-body")).toContainText("OPENING_A_CURRENT");
          await expect(pins(child)).not.toContainText("OPENING_B");
          expect(await initial.evaluate(initial => {
            const hook = window.__furaPinTest;
            return {
              controller: hook.pins.get(initial.pin.id) === initial.pin,
              owner: hook.owners.get(initial.pin.id) === initial.owner,
              content: initial.owner.panelContains(initial.pin.id, initial.content),
              popupDocument: initial.content.ownerDocument !== document,
              popped: initial.owner.isPanelPoppedOut(initial.pin.id),
              mounted: Object.entries(hook.dockviews).filter(([, api]) => api.getGroupPanel(initial.pin.id)).map(([mode]) => mode),
            };
          })).toEqual({ controller: true, owner: true, content: true, popupDocument: true, popped: true, mounted: ["normal"] });
          await info.attach("delayed-popup-real-content", { body: await child.screenshot(), contentType: "image/png" });
        }
        expect(wire.requests.filter(request => request.clientId === clientId)).toHaveLength(requestsBefore);
        await expect(page.locator("#sessionTitle")).toContainText("Opening review B");
        await closePopup(child, "return"); child = undefined;
        await expect(pins(page)).toHaveAttribute("data-panel-id", id);
        await expect(pins(page)).toContainText("OPENING_A_CURRENT");
        expect(await initial.evaluate(initial => {
          const hook = window.__furaPinTest;
          return {
            controller: hook.pins.get(initial.pin.id) === initial.pin,
            content: hook.owners.get(initial.pin.id)!.panelContains(initial.pin.id, initial.content),
            mounted: Object.entries(hook.dockviews).filter(([, api]) => api.getGroupPanel(initial.pin.id)).map(([mode]) => mode),
          };
        })).toEqual({ controller: true, content: true, mounted: ["diffReview"] });
        await geometryEvidence(page, info, "diffReview", "delayed-popup-redocked-to-active-workspace");
      } finally {
        await initial.evaluate(initial => {
          window.open = initial.open;
          if (initial.popup && !initial.popup.closed) initial.popup.close();
        });
        await initial.dispose();
      }
    } finally {
      await context.unroute("**/popout.html");
      await child?.close();
      a.cleanup(); b.cleanup();
    }
  });
}

test("@adapter inactive pin returns visibly to its saved manual split without stealing active-group focus", async ({ page }, info) => {
  const a = fixture("INACTIVE_SPLIT_A"), b = fixture("INACTIVE_SPLIT_B");
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await authenticate(page);
    await createSession(page, a.repo, "Inactive split source A");
    await createSession(page, b.repo, "Inactive split review B", true);
    await chooseSession(page, "Inactive split source A");
    await activateOrdinary(page);
    await pin(page);
    const id = (await pins(page).getAttribute("data-panel-id"))!;
    const savedGroup = await page.evaluate(id => {
      const api = window.__furaPinTest.dockviews.normal;
      const panel = api.getGroupPanel(id)!;
      panel.api.moveTo({ group: panel.group, position: "right" });
      panel.group.api.setSize({ width: Math.round(api.width * 0.28) });
      api.getGroupPanel("transcript")!.api.setActive();
      return panel.group.id;
    }, id);
    await expect(pins(page)).toContainText("INACTIVE_SPLIT_A_CURRENT");
    expect(await page.evaluate(() => window.__furaPinTest.dockviews.normal.activePanel?.id)).toBe("transcript");
    const before = await geometryEvidence(page, info, "normal", "inactive-return-manual-split-before");
    await chooseSession(page, "Inactive split review B");
    await activateOrdinary(page);
    await expect(pins(page)).toHaveCount(0);
    expect(await page.evaluate(id => {
      const api = window.__furaPinTest.dockviews.diffReview;
      return { active: api.activePanel?.id, local: api.getGroupPanel(id)!.group.activePanel?.id };
    }, id)).toEqual({ active: "sessionChanges", local: "sessionChanges" });
    await chooseSession(page, "Inactive split source A");
    const restored = page.locator(`.pinned-diff-view[data-panel-id="${id}"]`);
    await expect(restored).toBeVisible();
    await expect(restored.locator(".diffs-main-body")).toContainText("INACTIVE_SPLIT_A_CURRENT");
    expect(await page.evaluate(id => {
      const api = window.__furaPinTest.dockviews.normal;
      const panel = api.getGroupPanel(id)!;
      return {
        group: panel.group.id,
        local: panel.group.activePanel?.id,
        active: api.activePanel?.id,
        focusInsidePin: Boolean(document.activeElement?.closest(".pinned-diff-view")),
      };
    }, id)).toEqual({ group: savedGroup, local: id, active: "transcript", focusInsidePin: false });
    expectSameGeometry(await geometryEvidence(page, info, "normal", "inactive-return-manual-split-restored"), before);
    await expect(page.locator("#sessionTitle")).toContainText("Inactive split source A");
  } finally { a.cleanup(); b.cleanup(); }
});
