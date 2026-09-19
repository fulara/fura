import { expect, test, type Locator, type Page } from "@playwright/test";
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
  if (!review) await page.locator("#normalWorkspacePanelHost .dv-tab").filter({ hasText: "Git changes" }).click();
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
  await source.getByRole("button", { name: "Pin as new panel", exact: true }).click();
  const view = pins(page);
  await expect(view).toHaveCount(1);
  await expect(view.locator(".diffs-main-body")).toBeVisible();
  return view;
}
async function popout(page: Page, view: Locator) {
  await expect(view).toBeVisible();
  const opened = page.waitForEvent("popup");
  await page.locator("#pinnedWorkspacePanelHost").getByRole("button", { name: "Pop out", exact: true }).click();
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

test.use({ viewport: { width: 2100, height: 1200 } });
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
    await ordinary(page).locator(".git-review-options > summary").click();
    page.once("dialog", dialog => dialog.accept(a.repo));
    await ordinary(page).getByRole("button", { name: "Add", exact: true }).click();
    await ordinary(page).getByRole("combobox", { name: "Repository", exact: true }).selectOption(a.repo);
    await expect(ordinary(page)).toContainText("PIN_A_CURRENT");
    await ordinary(page).getByRole("combobox", { name: "Repository", exact: true }).selectOption(b.repo);
    await expect(ordinary(page)).toContainText("PIN_B_CURRENT");
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
    const pinnedHost = page.locator("#pinnedWorkspacePanelHost");
    const tabs = pinnedHost.locator(".dv-tab");
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
    await expect(ordinary(page)).toContainText("MULTI_B_CURRENT");
    await page.screenshot({ path: info.outputPath("remaining-pin-after-late-close.png") });
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await expect(page.locator(".pinned-diff-view")).toHaveCount(0);
    await expect(page.locator("#pinnedWorkspacePanelHost .dv-tab")).toHaveCount(0);
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
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(ordinary(page)).toContainText("SHARED_A_REAL_EDIT");
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
    rmSync(a.repo, { recursive: true });
    await pins(page).getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(pins(page)).toContainText(/unavailable|failed|not found|missing|not available/i);
    await expect(pins(page)).toContainText(a.repo);
    await expect(pins(page)).not.toContainText("MISSING_B_CURRENT");
    await expect(ordinary(page)).toContainText("MISSING_B_CURRENT");
    await page.screenshot({ path: info.outputPath("missing-repository-retains-source.png") });
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
    await expect(page.locator("#pinnedWorkspacePanelHost .dv-tab")).toHaveCount(1);
    await page.locator("#pinnedWorkspacePanelHost .dv-tab").getByRole("button", { name: /close/i }).click();
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
    const toolbar = page.locator("#pinnedWorkspacePanelHost .panel-popout-btn");
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
    await expect(ordinary(page)).toContainText("DEDICATED_B_CURRENT");
    await page.screenshot({ path: info.outputPath("dedicated-source-deleted-read-only.png") });
  } finally { a.cleanup(); b.cleanup(); }
});
