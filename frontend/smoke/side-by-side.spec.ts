import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ClientMessage, ServerMessage } from "../src/protocol";

// External Playwright config must supply an isolated Fura bridge using
// fixtures/mock-omp-rpc.mjs, never a real OMP runtime or a production data dir.
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
  root: string; base: string; head: string; tip: string; committed: string; working: string;
  put(file: string, content: string): void;
  cleanup(): void;
};
function fixture(): Repo {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-side-by-side-")));
  const put = (file: string, content: string) => writeFileSync(path.join(root, file), content);
  const commit = (subject: string) => {
    git(root, "add", "."); git(root, "commit", "-qm", subject);
    return git(root, "rev-parse", "HEAD");
  };
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Split Reviewer");
    git(root, "config", "user.email", "split@example.invalid");
    const original = Array.from({ length: 110 }, (_, index) => `export const context_${index + 1} = ${index + 1};`);
    original.splice(9, 2, "export const OLD_ONE = 1;", "export const OLD_TWO = 2;");
    original.splice(69, 3, "export const OLD_SEVENTY = 70;", "export const OLD_SEVENTY_ONE = 71;", "export const OLD_SEVENTY_TWO = 72;");
    put("old.ts", original.join("\n") + "\n");
    put("deleted.txt", "DELETE_FIRST\nDELETE_SECOND\n");
    put("no-newline.txt", "OLD_NO_NEWLINE");
    put("image.bin", "OLD\0BINARY");
    const base = commit("Split base");
    renameSync(path.join(root, "old.ts"), path.join(root, "renamed.ts"));
    const changed = original.slice();
    changed.splice(69, 3, "export const NEW_SEVENTY = 70;");
    changed.splice(9, 2, "export const NEW_ONE = 1;", "export const NEW_TWO = 2;", `export const NEW_THREE = '${"long_value_".repeat(30)}';`);
    const committed = changed.join("\n") + "\n";
    put("renamed.ts", committed);
    rmSync(path.join(root, "deleted.txt"));
    put("new.txt", "NEW_FIRST\nNEW_SECOND\n");
    put("no-newline.txt", "NEW_NO_NEWLINE");
    put("image.bin", "NEW\0BINARY");
    const head = commit("Split rename and unequal hunks\n\nReview immutable old and new paths.");
    put("later.txt", "LATER_COMMIT\n");
    const tip = commit("Split later commit");
    const working = committed.replace("NEW_ONE", "WORKTREE_ONE").replace("NEW_TWO", "WORKTREE_TWO").replace("NEW_SEVENTY", "WORKTREE_SEVENTY");
    put("renamed.ts", working);
    return { root, base, head, tip, committed, working, put, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
const diffs = (page: Page) => page.locator(".session-changes-view:visible");
const compare = (page: Page) => page.locator(".compare-view:visible");
const layout = (view: Locator) => view.getByRole("combobox", { name: "Diff layout", exact: true });
const tab = (page: Page, title: string) => page.locator(".dv-tab:visible").filter({ hasText: new RegExp(`^${title}$`) });
const group = (page: Page, title: string) => page.locator(".dv-groupview:visible").filter({ has: tab(page, title) });
const side = (view: Locator, value: "left" | "right") => view.locator(`.diff-split-cell[data-diff-side="${value}"]`);
async function authenticate(page: Page) {
  await page.goto("/");
  await page.locator("#authTokenInput").fill(process.env.FURA_SMOKE_TOKEN ?? "dev");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}
async function createSession(page: Page, repo: Repo) {
  const name = `Split ${path.basename(repo.root)}`;
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerNameInput").fill(name);
  await page.locator("#cwdPickerInput").fill(repo.root);
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(page.locator("#sessionTitle")).toContainText(name);
  await tab(page, "Git changes").click();
  return name;
}
async function file(view: Locator, name = "renamed.ts") {
  await view.locator(`.diffs-file-jump[data-diff-file-path="${name}"]`).click();
  await expect(view.locator(`.diffs-file-jump.active[data-diff-file-path="${name}"]`)).toBeVisible();
  await expect(view.locator(".diff-line-add, .diff-line-remove").first()).toBeVisible();
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const directory = process.env.FURA_SMOKE_EVIDENCE_DIR;
  if (directory) mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: directory ? path.join(directory, `${info.testId.replace(/[^a-z0-9_-]/gi, "_")}-${name}.png`) : info.outputPath(`${name}.png`), fullPage: true });
}
async function observe(page: Page) {
  const requests: ClientMessage[] = [], responses: ServerMessage[] = [];
  const control = { holding: false, held: [] as Array<() => void> };
  await page.routeWebSocket("**/ws**", route => {
    const server = route.connectToServer();
    route.onMessage(data => { requests.push(JSON.parse(data.toString())); server.send(data); });
    server.onMessage(data => {
      responses.push(JSON.parse(data.toString()));
      if (control.holding) control.held.push(() => route.send(data));
      else route.send(data);
    });
  });
  return {
    requests, responses, control,
    release() {
      control.holding = false;
      for (const send of control.held.splice(0)) send();
    },
  };
}

test.use({ viewport: { width: 1600, height: 1100 }, serviceWorkers: "block" });
test.beforeEach(({ page }) => { page.on("pageerror", error => { throw error; }); });

test("Current changes defaults to Unified and Side by side survives inactive refresh and reload", async ({ page }, info) => {
  const repo = fixture();
  try {
    await authenticate(page);
    const name = await createSession(page, repo);
    const view = diffs(page);
    await view.getByRole("button", { name: "Current changes", exact: true }).click();
    await file(view);
    await expect(layout(view)).toHaveValue("unified");
    await expect(view.locator(".diff-lines-split")).toHaveCount(0);
    await expect(view.locator(".diff-line-add").first()).toContainText("WORKTREE_ONE");
    await screenshot(page, info, "current-unified");
    await view.getByRole("button", { name: "Expand review", exact: true }).click();
    await screenshot(page, info, "current-unified-expanded");
    await view.getByRole("button", { name: "Restore layout", exact: true }).click();
    await layout(view).selectOption("split");
    await expect(view.locator(".diff-lines-split")).toBeVisible();
    await expect(side(view, "left").locator(".diff-line-remove").first()).toContainText("NEW_ONE");
    await expect(side(view, "right").locator(".diff-line-add").first()).toContainText("WORKTREE_ONE");
    await expect(side(view, "left").locator(".diff-line-remove .diff-gutter").first()).toHaveText("10");
    await expect(side(view, "right").locator(".diff-line-add .diff-gutter").first()).toHaveText("10");
    for (const value of ["left", "right"] as const) {
      expect(await side(view, value).locator(".diff-line-content").first().evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(180);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await screenshot(page, info, "current-split");
    await view.getByRole("button", { name: "Expand review", exact: true }).click();
    await screenshot(page, info, "current-split-expanded");
    await view.getByRole("button", { name: "Restore layout", exact: true }).click();
    await tab(page, "Transcript").click();
    await page.locator("#promptInput").fill("Unsent split review draft");
    await page.locator("#promptInput").focus();
    await expect(group(page, "Git changes")).toHaveClass(/dv-inactive-group/);
    repo.put("renamed.ts", repo.working.replace("WORKTREE_ONE", "REFRESHED_ONE"));
    // Synthetic lifecycle notification only; Git, backend refresh and DOM are real.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(side(view, "right").locator(".diff-line-add").first()).toContainText("REFRESHED_ONE");
    await expect(group(page, "Git changes")).toHaveClass(/dv-inactive-group/);
    await expect(page.locator("#promptInput")).toBeFocused();
    await expect(page.locator("#promptInput")).toHaveValue("Unsent split review draft");
    await expect(layout(view)).toHaveValue("split");
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await page.locator("#sessionsList .session-item").filter({ hasText: name }).locator("button").first().click();
    await tab(page, "Git changes").click();
    await view.getByRole("button", { name: "Current changes", exact: true }).click();
    await file(view);
    await expect(layout(view)).toHaveValue("split");
    await expect(view.locator(".diff-lines-split")).toBeVisible();
    expect(readFileSync(path.join(repo.root, "renamed.ts"), "utf8")).toBe(repo.working.replace("WORKTREE_ONE", "REFRESHED_ONE"));
  } finally { repo.cleanup(); }
});

test("History split preserves unequal hunks, old-path comments, immutable file copy and native popout/redock", async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const repo = fixture(), wire = await observe(page);
  let child: Page | null = null;
  try {
    await authenticate(page); await createSession(page, repo);
    const view = diffs(page);
    await view.getByRole("button", { name: "History", exact: true }).click();
    await view.locator(`[data-commit-oid="${repo.head}"]`).click();
    await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.head);
    await file(view);
    await expect(layout(view)).toHaveValue("unified");
    const content = wire.responses.filter(message => message.type === "diff.content")
      .findLast(message => message.content.rows.some(row => row.type === "line" && row.location.text.includes("OLD_ONE")));
    expect(content).toBeDefined();
    const removed = content!.content.rows.find(row => row.type === "line" && row.location.text.includes("OLD_ONE"));
    if (!removed || removed.type !== "line") throw new Error("Git did not return the fixture removal");
    expect(removed.location).toMatchObject({ oldPath: "old.ts", newPath: "renamed.ts", oldLine: 10, side: "left", kind: "remove" });
    const summary = wire.responses.filter(message => message.type === "sessionChanges.summary")
      .findLast(message => message.state.status === "ready" && message.state.comparison.comparisonKey === content!.content.comparisonKey);
    if (!summary || summary.state.status !== "ready") throw new Error("Missing immutable History identity");
    expect(summary.state.comparison.leftTreeOrCommit).toBe(repo.base);
    expect(summary.state.comparison.rightTreeOrCommit).toBe(repo.head);
    const beforeToggle = wire.requests.length;
    await layout(view).selectOption("split");
    await expect(view.locator(".diff-lines-split")).toBeVisible();
    expect(wire.requests.slice(beforeToggle).filter(message => ["sessionChanges.request", "diff.content.request"].includes(message.type))).toEqual([]);
    const pairs = view.locator(".diff-split-row");
    const extraAddition = pairs.filter({ hasText: "NEW_THREE" });
    await expect(extraAddition.locator('[data-diff-side="left"].diff-split-gap')).toHaveAttribute("aria-label", "No line");
    await expect(extraAddition.locator('[data-diff-side="right"] .diff-gutter')).toHaveText("12");
    await expect(extraAddition.locator('[data-diff-side="right"] code')).toContainText("long_value_".repeat(30));
    const extraRemoval = pairs.filter({ hasText: "OLD_SEVENTY_ONE" });
    await expect(extraRemoval.locator('[data-diff-side="right"].diff-split-gap')).toHaveAttribute("aria-label", "No line");
    await expect(extraRemoval.locator('[data-diff-side="left"] .diff-gutter')).toHaveText("71");
    await expect(view.locator(".diff-split-gap .diff-gutter, .diff-split-gap code, .diff-split-gap button")).toHaveCount(0);
    await expect(view.locator(".diff-line-hunk")).toHaveCount(2);
    await expect(view.locator(".diff-split-cell .diff-line-hunk, .diff-split-cell .diff-line-file")).toHaveCount(0);
    const contextRow = pairs.filter({ has: page.locator('.diff-line-context code', { hasText: "context_12" }) });
    await expect(contextRow.locator('[data-diff-side="left"] .diff-gutter')).toHaveText("12");
    await expect(contextRow.locator('[data-diff-side="right"] .diff-gutter')).toHaveText("13");
    await expect(side(view, "left").locator(".diff-line-context button")).toHaveCount(0);
    await expect(contextRow.locator('[data-diff-side="right"] .diff-comment-btn')).toBeEnabled();
    const removal = side(view, "left").locator(".diff-line-remove").filter({ hasText: "OLD_ONE" });
    await removal.locator(".diff-comment-btn").click();
    await view.locator(".review-comment-composer-input").fill("OLD_PATH_IMMUTABLE_NOTE");
    await view.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(view).toContainText("OLD_PATH_IMMUTABLE_NOTE");
    const request = wire.requests.findLast(message => message.type === "review.comment.create");
    expect(request).toMatchObject({
      type: "review.comment.create", comparisonKey: content!.content.comparisonKey,
      repoRoot: repo.root, anchor: removed.location, body: "OLD_PATH_IMMUTABLE_NOTE",
    });
    if (request?.type === "review.comment.create") expect(request.anchor).toEqual(removed.location);
    for (const [kind, token, body] of [
      ["add", "NEW_ONE", "RIGHT_ADDITION_NOTE"],
      ["context", "context_12 = 12", "RIGHT_CONTEXT_NOTE"],
    ] as const) {
      const original = content!.content.rows.find(row => row.type === "line" && row.location.kind === kind && row.location.text.includes(token));
      if (!original || original.type !== "line") throw new Error(`Missing ${kind} anchor`);
      expect(original.location.side).toBe("right");
      await side(view, "right").locator(`.diff-line-${kind}`).filter({ hasText: token }).locator(".diff-comment-btn").click();
      await view.locator(".review-comment-composer-input").fill(body);
      await view.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(view.locator(".diff-lines").getByText(body, { exact: true })).toHaveCount(1);
      const saved = wire.requests.findLast(message => message.type === "review.comment.create");
      expect(saved).toMatchObject({ comparisonKey: content!.content.comparisonKey, repoRoot: repo.root, body });
      if (saved?.type !== "review.comment.create") throw new Error("No review request");
      expect(saved.anchor).toEqual(original.location);
    }
    await layout(view).selectOption("unified");
    await expect(view.locator(".diff-line-remove").filter({ hasText: "OLD_ONE" }).locator(".diff-comment-btn")).toHaveText("1");
    await layout(view).selectOption("split");
    await expect(view.locator(".diff-lines").getByText("OLD_PATH_IMMUTABLE_NOTE", { exact: true })).toHaveCount(1);
    await expect(view.locator(".diff-lines").getByText("RIGHT_CONTEXT_NOTE", { exact: true })).toHaveCount(1);
    await screenshot(page, info, "history-unequal-rename");

    for (const [name, present, absent, expected] of [
      ["new.txt", "right", "left", "NEW_FIRST"],
      ["deleted.txt", "left", "right", "DELETE_FIRST"],
    ] as const) {
      await file(view, name);
      await expect(side(view, present).locator("code").first()).toContainText(expected);
      await expect(side(view, absent).locator("code, .diff-gutter, button")).toHaveCount(0);
      await expect(side(view, absent)).toHaveCount(2);
    }
    await file(view, "no-newline.txt");
    for (const value of ["left", "right"] as const) {
      await expect(side(view, value)).toContainText("\\ No newline at end of file");
      await expect(side(view, value).locator(".diff-gutter")).toHaveText("1");
    }
    await screenshot(page, info, "no-newline");
    await view.locator('.diffs-file-jump[data-diff-file-path="image.bin"]').click();
    await expect(view.locator(".diff-lines")).toContainText("Binary files");
    await expect(view.locator(".diff-layout-note")).toContainText("remain unified");
    await expect(view.locator(".diff-split-row, .diff-split-cell")).toHaveCount(0);
    await screenshot(page, info, "binary-metadata");
    await file(view);
    await view.getByRole("button", { name: "View committed file", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Committed file", exact: true });
    await expect(modal.locator(".git-file-content")).toHaveText(repo.committed);
    await expect(modal).not.toContainText("WORKTREE_ONE");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await modal.getByRole("button", { name: "Copy file", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(repo.committed);
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await view.getByRole("button", { name: "Newer commit", exact: true }).click();
    await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.tip);
    await expect(view).not.toContainText("OLD_PATH_IMMUTABLE_NOTE");
    await view.getByRole("button", { name: "Older commit", exact: true }).click();
    await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.head);
    await file(view);
    await expect(view).toContainText("OLD_PATH_IMMUTABLE_NOTE");
    await expect(layout(view)).toHaveValue("split");
    await view.getByRole("button", { name: "Show more context", exact: true }).first().click();
    await expect(view.locator(".diffs-main-body")).toContainText("context_1 = 1");

    await view.locator(".diffs-main-body").evaluate(element => { element.scrollTop = 40; });
    await expect.poll(() => view.locator(".diffs-main-body").evaluate(element => element.scrollTop)).toBe(40);
    await layout(view).focus();
    for (const mode of ["unified", "split"]) {
      await layout(view).selectOption(mode);
      await expect(layout(view)).toBeFocused();
      await expect.poll(() => view.locator(".diffs-main-body").evaluate(element => element.scrollTop)).toBe(40);
      await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.head);
    }
    const opened = page.waitForEvent("popup");
    await group(page, "Git changes").locator(".panel-popout-btn").click();
    child = await opened;
    child.on("pageerror", error => { throw error; });
    const popped = diffs(child);
    await expect(popped.locator(".git-selected-commit-meta")).toContainText(repo.head);
    await expect(popped.locator('.diffs-file-jump.active[data-diff-file-path="renamed.ts"]')).toBeVisible();
    await expect(layout(popped)).toHaveValue("split");
    await expect.poll(() => popped.locator(".diffs-main-body").evaluate(element => element.scrollTop)).toBe(40);
    await child.bringToFront();
    await layout(popped).focus();
    for (const mode of ["unified", "split"]) {
      await layout(popped).selectOption(mode);
      await expect(layout(popped)).toBeFocused();
      await expect.poll(() => popped.locator(".diffs-main-body").evaluate(element => element.scrollTop)).toBe(40);
      await expect(popped.locator(".git-selected-commit-meta")).toContainText(repo.head);
    }
    await tab(page, "Transcript").click();
    await page.locator("#promptInput").fill("Focus survives split redock");
    await page.locator("#promptInput").focus();
    await screenshot(child, info, "history-popout");
    // Real browser window.close invokes Dockview's beforeunload adoption path.
    await child.evaluate(() => {
      window.addEventListener("beforeunload", () => {
        window.opener.document.documentElement.dataset.splitNativeRedock = "yes";
      }, { once: true });
    });
    const closed = child.waitForEvent("close");
    await child.evaluate(() => window.close());
    await closed; child = null;
    await expect(page.locator("html")).toHaveAttribute("data-split-native-redock", "yes");
    await expect(view.locator(".git-selected-commit-meta")).toContainText(repo.head);
    await expect(view.locator('.diffs-file-jump.active[data-diff-file-path="renamed.ts"]')).toBeVisible();
    await expect(layout(view)).toHaveValue("split");
    await expect.poll(() => view.locator(".diffs-main-body").evaluate(element => element.scrollTop)).toBe(40);
    await expect(page.locator("#promptInput")).toBeFocused();
    await expect(page.locator("#promptInput")).toHaveValue("Focus survives split redock");
    await screenshot(page, info, "history-redocked");
    expect(git(repo.root, "rev-parse", "HEAD")).toBe(repo.tip);
    expect(readFileSync(path.join(repo.root, "renamed.ts"), "utf8")).toBe(repo.working);
    expect(wire.requests.filter(message => ["prompt.send", "review.agentReview.start", "diff.reviewWorktree.ensure", "diff.reviewWorktree.checkout"].includes(message.type))).toEqual([]);
  } finally {
    await child?.close();
    repo.cleanup();
  }
});

test("ordinary ref Compare shares split preference while range-diff stays native unified", async ({ page }, info) => {
  const repo = fixture(), wire = await observe(page);
  try {
    await authenticate(page); await createSession(page, repo);
    await diffs(page).getByRole("button", { name: "Current changes", exact: true }).click();
    await file(diffs(page));
    await layout(diffs(page)).selectOption("split");
    const boundary = wire.requests.length;
    await page.locator("#createSessionButton").click();
    await page.locator("#cwdPickerDiffTab").click();
    await page.locator("#cwdPickerDiffMode").selectOption("full");
    await page.locator("#cwdPickerDiffRepo").fill(repo.root);
    await page.locator("#cwdPickerDiffBase").fill(repo.base);
    await page.locator("#cwdPickerDiffHead").fill(repo.head);
    await page.locator("#cwdPickerDiffAgentSession").uncheck();
    await page.locator("#cwdPickerCreate").click();
    await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
    const view = compare(page);
    await file(view);
    await expect(layout(view)).toHaveValue("split");
    await expect(side(view, "left").locator(".diff-line-remove").first()).toContainText("OLD_ONE");
    await expect(side(view, "right").locator(".diff-line-add").first()).toContainText("NEW_ONE");
    await expect(view).not.toContainText("WORKTREE_ONE");
    const response = wire.responses.filter(message => message.type === "compareDiff.summary").at(-1);
    expect(response?.state.comparison).toMatchObject({ leftTreeOrCommit: repo.base, rightTreeOrCommit: repo.head });
    await screenshot(page, info, "compare-split");
    await layout(view).selectOption("unified");
    await expect(view.locator(".diff-lines-split")).toHaveCount(0);
    await tab(page, "Git changes").click();
    await expect(layout(diffs(page))).toHaveValue("unified");
    await expect(diffs(page).locator(".diff-lines-split")).toHaveCount(0);
    await layout(diffs(page)).selectOption("split");
    await tab(page, "Compare").click();
    await expect(layout(view)).toHaveValue("split");

    wire.control.holding = true;
    const refreshBoundary = wire.responses.length;
    await view.getByRole("button", { name: "Compare", exact: true }).click();
    await expect.poll(() => wire.responses.slice(refreshBoundary).some(message => message.type === "compareDiff.summary")).toBe(true);
    await tab(page, "Transcript").click();
    await page.locator("#promptInput").fill("Inactive Compare keeps this draft");
    await page.locator("#promptInput").focus();
    await expect(group(page, "Compare")).toHaveClass(/dv-inactive-group/);
    await expect(view.locator(".diff-refresh-status")).toBeVisible();
    wire.release();
    await expect(view.locator(".diff-refresh-status")).toHaveCount(0);
    await expect(side(view, "right").locator(".diff-line-add").first()).toContainText("NEW_ONE");
    await expect(layout(view)).toHaveValue("split");
    await expect(page.locator("#promptInput")).toBeFocused();

    await tab(page, "Compare").click();
    await view.getByRole("combobox", { name: "Compare mode", exact: true }).selectOption("rangeDiff");
    await view.getByRole("textbox", { name: "Repository", exact: true }).fill(repo.root);
    await view.getByRole("textbox", { name: "Base", exact: true }).fill(repo.base);
    await view.getByRole("textbox", { name: "Old", exact: true }).fill(repo.head);
    await view.getByRole("textbox", { name: "New", exact: true }).fill(repo.tip);
    await view.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(view.locator(".range-diff-output")).toContainText("Split later commit");
    await expect(view).toContainText(/range.diff[\s\S]*(unified|side.by.side)|(unified|side.by.side)[\s\S]*range.diff/i);
    await expect(view.locator(".diff-lines-split, .diff-split-row, .diff-split-cell")).toHaveCount(0);
    const range = wire.responses.filter(message => message.type === "git.rangeDiff").at(-1);
    expect(range?.error).toBeNull();
    expect(range?.result).toMatchObject({ base: { oid: repo.base }, old: { oid: repo.head }, new: { oid: repo.tip } });
    await expect.poll(async () => (await view.locator(".range-diff-output").textContent())?.replaceAll(" (no change)", ""))
      .toBe(stripVTControlCharacters(range!.result!.output));
    await screenshot(page, info, "range-native-unified");
    await view.getByRole("combobox", { name: "Compare mode", exact: true }).selectOption("files");
    await file(view);
    await expect(layout(view)).toHaveValue("split");
    await expect(view.locator(".diff-lines-split")).toBeVisible();
    expect(wire.requests.slice(boundary).filter(message => ["session.create", "prompt.send", "review.agentReview.start", "diff.reviewWorktree.ensure"].includes(message.type))).toEqual([]);
    expect(git(repo.root, "rev-parse", "HEAD")).toBe(repo.tip);
    expect(readFileSync(path.join(repo.root, "renamed.ts"), "utf8")).toBe(repo.working);
  } finally { repo.cleanup(); }
});
