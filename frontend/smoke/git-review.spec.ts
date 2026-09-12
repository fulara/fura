import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

const token = process.env.FURA_SMOKE_TOKEN ?? "dev";
const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-C", repo, ...args], { env: gitEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture(label: string, changes = 1, merge = false) {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-commit-review-")));
  const repo = path.join(parent, label); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Commit Reviewer");
  git(repo, "config", "user.email", "review@example.invalid");
  const contents = (value: string) => Array.from({ length: 20 }, (_, index) => index === 9 ? `export const value = '${value}';` : `export const context_${index + 1} = ${index + 1};`).join("\n") + "\n";
  const commit = (subject: string) => { git(repo, "add", "."); git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", subject); return git(repo, "rev-parse", "HEAD"); };
  writeFileSync(path.join(repo, "same.ts"), contents(`${label}_base`));
  const initial = commit(`Initial ${label}`);
  const commits = [initial];
  for (let index = 1; index <= changes; index += 1) {
    writeFileSync(path.join(repo, "same.ts"), contents(`${label}_${index}`));
    commits.push(commit(`Change ${label} ${index}\n\nDetailed review context for ${label} ${index}.`));
  }
  if (merge) {
    git(repo, "checkout", "-qb", "feature", "HEAD~1");
    writeFileSync(path.join(repo, "feature.ts"), "export const feature = true;\n");
    commit("Feature side commit");
    git(repo, "checkout", "-q", "main");
    writeFileSync(path.join(repo, "main.ts"), "export const mainOnly = true;\n");
    commit("Main side commit");
    git(repo, "-c", "commit.gpgsign=false", "merge", "--no-ff", "feature", "-m", "Merge feature for review");
  }
  const head = git(repo, "rev-parse", "HEAD");
  writeFileSync(path.join(repo, "same.ts"), contents(`${label}_WORKTREE_ONLY`));
  return { parent, repo, initial, head, commits, contents, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}
function bytes(root: string): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  function visit(directory: string, relative = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name), key = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(file, key);
      else result.push([key, createHash("sha256").update(entry.isSymbolicLink() ? readlinkSync(file) : readFileSync(file)).digest("hex")]);
    }
  }
  visit(root); return result;
}
async function authenticate(page: Page) {
  await page.goto("/");
  await page.locator("#authTokenInput").fill(token);
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}
async function createSession(page: Page, repo: string, name: string) {
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerNameInput").fill(name);
  await page.locator("#cwdPickerInput").fill(repo);
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(page.locator("#sessionTitle")).toContainText(name);
  await page.locator(".dv-tab").filter({ hasText: "Git changes" }).click();
}
function panel(page: Page) { return page.locator(".session-changes-view:visible"); }
async function addRepo(page: Page, repo: string) {
  await panel(page).locator(".git-review-options > summary").click();
  page.once("dialog", dialog => dialog.accept(repo));
  await panel(page).getByRole("button", { name: "Add", exact: true }).click();
  const selector = panel(page).getByRole("combobox", { name: "Repository", exact: true });
  await expect(selector.locator("option", { hasText: path.basename(repo) })).toHaveCount(1);
  await selector.selectOption(repo);
}
async function openWorkingFile(page: Page, expectedContent?: string) {
  if (expectedContent) await expect(panel(page).locator(".diffs-main-body")).toContainText(expectedContent);
  await panel(page).locator('.diffs-file-jump[data-diff-file-path="same.ts"]').click();
  await panel(page).getByRole("button", { name: "Code", exact: true }).click();
}

test("F2 Code comments and prompts remain isolated between repositories", async ({ page }, info) => {
  const a = fixture("repo-A"), b = fixture("repo-B");
  try {
    await authenticate(page); await createSession(page, a.repo, `Code comments ${Date.now()}`);
    await openWorkingFile(page);
    const code = page.locator(".code-viewer:visible");
    await expect(code).toContainText("repo-A_WORKTREE_ONLY");
    page.once("dialog", dialog => dialog.accept("COMMENT_ONLY_FOR_A"));
    await code.locator('[title="Comment on this code line"]').nth(9).click();
    await page.locator(".dv-tab").filter({ hasText: "Git changes" }).click();
    await addRepo(page, b.repo); await openWorkingFile(page, "repo-B_WORKTREE_ONLY");
    await expect(code).toContainText("repo-B_WORKTREE_ONLY");
    await expect(code).not.toContainText("COMMENT_ONLY_FOR_A");
    page.once("dialog", dialog => dialog.accept("COMMENT_ONLY_FOR_B"));
    await code.locator('[title="Comment on this code line"]').nth(9).click();
    await code.getByRole("button", { name: "Preview comments", exact: true }).click();
    const prompt = await page.locator("#diffPreviewText").inputValue();
    expect(prompt).toContain(b.repo); expect(prompt).toContain("COMMENT_ONLY_FOR_B");
    expect(prompt).not.toContain("COMMENT_ONLY_FOR_A"); expect(prompt).not.toContain("repo-A_WORKTREE_ONLY");
    expect(await page.locator("#diffPreviewText").evaluate(element => element.scrollLeft)).toBe(0);
    await page.screenshot({ path: info.outputPath("code-comments-isolated.png") });
  } finally { a.cleanup(); b.cleanup(); }
});

test("F5 Code Refresh retains the external repository and selected file", async ({ page }, info) => {
  const a = fixture("refresh-A"), b = fixture("refresh-B");
  try {
    writeFileSync(path.join(b.repo, "same.ts"), b.contents("refresh-B_WORKTREE_ONLY") + `// ${"long source line ".repeat(80)}\n`);
    await authenticate(page); await createSession(page, a.repo, `Code refresh ${Date.now()}`);
    await addRepo(page, b.repo); await openWorkingFile(page, "refresh-B_WORKTREE_ONLY");
    const code = page.locator(".code-viewer:visible");
    await expect(code).toContainText("refresh-B_WORKTREE_ONLY");
    const lines = code.locator(".code-review-lines");
    await lines.evaluate(element => { element.scrollLeft = 240; });
    await expect.poll(() => lines.evaluate(element => element.scrollLeft)).toBe(240);
    await code.getByRole("button", { name: "Refresh tree", exact: true }).click();
    await expect(code.locator(".code-tree-entry").filter({ hasText: "same.ts" })).toBeVisible();
    await expect.poll(() => lines.evaluate(element => element.scrollLeft)).toBe(240);
    await code.getByRole("button", { name: "Refresh", exact: true }).click();
    await code.locator(".code-tree-entry").filter({ hasText: "same.ts" }).click();
    await expect(code).toContainText("refresh-B_WORKTREE_ONLY");
    await expect(code).not.toContainText("refresh-A_WORKTREE_ONLY");
    await expect(panel(page).getByRole("combobox", { name: "Repository", exact: true })).toHaveValue(b.repo);
    await page.screenshot({ path: info.outputPath("code-refresh-keeps-root.png") });
  } finally { a.cleanup(); b.cleanup(); }
});

test("review commits without refs, retain notes, load older history and read immutable files", async ({ page }, info) => {
  test.setTimeout(90000);
  const a = fixture("history-A", 34, true), b = fixture("history-B");
  const beforeA = bytes(a.repo), beforeB = bytes(b.repo);
  const name = `Commit workflow ${Date.now()}`;
  try {
    await authenticate(page); await createSession(page, a.repo, name);
    const view = panel(page);
    await expect(view.locator(".git-head-label")).toContainText(`main · ${a.head.slice(0, 12)}`);
    await expect(view.locator(".git-root-path")).toHaveText(a.repo);
    await view.getByRole("button", { name: "History", exact: true }).click();
    await expect(view.locator(".git-history-commit")).toHaveCount(30);
    await expect(view.locator(".diff-commit-message")).toContainText("Merge commit — diff against first parent");
    await page.screenshot({ path: info.outputPath("history-merge.png") });
    await view.locator(`[data-commit-oid="${a.commits[34]}"]`).click();
    await expect(view.locator(".diff-commit-message")).toContainText("Detailed review context for history-A 34.");
    await expect(view.locator(".diffs-main-body")).not.toContainText("context_1 = 1");
    await view.getByRole("button", { name: "Show more context", exact: true }).click();
    await expect(view.locator(".diffs-main-body")).toContainText("context_1 = 1");
    await expect(view.locator(".diffs-all-files-jump")).toHaveClass(/active/);
    await view.locator('.diffs-file-jump[data-diff-file-path="same.ts"]').click();
    await expect(view.locator(".diff-commit-message")).toContainText(a.commits[34]);
    await expect(view.locator(".diffs-main-body")).toContainText("history-A_34");
    await expect(view.locator(".diffs-main-body")).not.toContainText("WORKTREE_ONLY");
    await expect(view.locator(".diff-line-remove .diff-gutter")).toHaveText("10");
    await view.getByRole("button", { name: "Show more context", exact: true }).click();
    await expect(view.locator(".diffs-main-body")).toContainText("context_1 = 1");
    await view.locator(".diff-line-add .diff-comment-btn").first().click();
    await view.locator(".review-comment-composer-input").fill("NOTE_ONLY_FOR_COMMIT_34");
    await view.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(view).toContainText("NOTE_ONLY_FOR_COMMIT_34");
    page.once("dialog", dialog => dialog.accept("QUESTION_ONLY_FOR_COMMIT_34"));
    await view.locator(".diff-line-add .diff-question-btn").first().click();
    await view.getByRole("button", { name: "Preview questions (1)", exact: true }).click();
    const prompt = await page.locator("#diffPreviewText").inputValue();
    expect(prompt).toContain(a.repo); expect(prompt).toContain(a.commits[34]); expect(prompt).toContain(a.commits[33]);
    expect(prompt).toContain("QUESTION_ONLY_FOR_COMMIT_34");
    await page.locator("#diffPreviewClose").click();
    await page.screenshot({ path: info.outputPath("commit-review-comments.png") });
    await view.getByRole("button", { name: "Older commit", exact: true }).click();
    await expect(view.locator(".diff-commit-message")).toContainText("Detailed review context for history-A 33.");
    await expect(view).not.toContainText("NOTE_ONLY_FOR_COMMIT_34");
    await view.getByRole("button", { name: "Newer commit", exact: true }).click();
    await expect(view).toContainText("NOTE_ONLY_FOR_COMMIT_34");
    await view.locator(".git-review-options > summary").click();
    await view.getByRole("button", { name: "Advanced Compare", exact: true }).click();
    await expect(page.locator("#cwdPickerDiffRepo")).toHaveValue(a.repo);
    await expect(page.locator("#cwdPickerDiffHead")).toHaveValue(a.commits[34]);
    await page.locator("#cwdPickerCancel").click();
    await view.getByRole("button", { name: "Load older commits", exact: true }).click();
    await expect(view.locator(".git-history-commit")).toHaveCount(38);
    await view.locator(`[data-commit-oid="${a.initial}"]`).click();
    await expect(view.locator(".diff-commit-message")).toContainText("Initial commit — diff against the empty tree");
    await view.locator('.diffs-file-jump[data-diff-file-path="same.ts"]').click();
    await view.getByRole("button", { name: "View committed file", exact: true }).click();
    const file = page.getByRole("dialog", { name: "Committed file", exact: true });
    await expect(file.locator(".git-file-content")).toHaveText(a.contents("history-A_base"));
    await expect(file).toContainText(a.initial); await expect(file).not.toContainText("WORKTREE_ONLY");
    await page.screenshot({ path: info.outputPath("initial-commit-file.png") });
    await file.getByRole("button", { name: "Close", exact: true }).click();
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(view.locator(".git-history-commit")).toHaveCount(30);
    await expect(view.locator(".diff-commit-message")).toContainText(a.initial);
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await page.locator("#sessionsList .session-item").filter({ hasText: name }).locator("button").first().click();
    await page.locator(".dv-tab").filter({ hasText: "Git changes" }).click();
    await view.getByRole("button", { name: "History", exact: true }).click();
    await expect(view.locator(".diff-commit-message")).toContainText(a.initial);
    await addRepo(page, b.repo);
    await view.getByRole("button", { name: "History", exact: true }).click();
    await expect(view.locator(".diff-commit-message")).toContainText("Change history-B 1");
    await expect(view).not.toContainText("NOTE_ONLY_FOR_COMMIT_34");
    await view.getByRole("combobox", { name: "Repository", exact: true }).selectOption(a.repo);
    await view.getByRole("button", { name: "History", exact: true }).click();
    await expect(view.locator(".diff-commit-message")).toContainText(a.initial);
    await page.screenshot({ path: info.outputPath("review-restored.png") });
    expect(bytes(a.repo)).toEqual(beforeA); expect(bytes(b.repo)).toEqual(beforeB);
  } finally { a.cleanup(); b.cleanup(); }
});

test("unborn and detached HEAD remain explicit and reviewable", async ({ page }, info) => {
  const detached = fixture("detached");
  const unbornParent = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-unborn-")));
  git(unbornParent, "init", "-q", "-b", "new-branch");
  writeFileSync(path.join(unbornParent, "new.txt"), "untracked without a commit\n");
  git(detached.repo, "checkout", "--detach", detached.head);
  try {
    await authenticate(page); await createSession(page, unbornParent, `Unborn ${Date.now()}`);
    await expect(panel(page).locator(".git-head-label")).toContainText("new-branch · No commits yet");
    await panel(page).getByRole("button", { name: "History", exact: true }).click();
    await expect(panel(page).locator(".git-history-list")).toContainText("No commits yet");
    await page.screenshot({ path: info.outputPath("unborn-history.png") });
    await panel(page).getByRole("button", { name: "Current changes", exact: true }).click();
    await panel(page).getByRole("combobox", { name: "Git change group" }).selectOption("untracked");
    await expect(panel(page).locator(".diffs-main-body")).toContainText("untracked without a commit");
    await addRepo(page, detached.repo);
    await expect(panel(page).locator(".git-head-label")).toContainText(`Detached HEAD · ${detached.head.slice(0, 12)}`);
    await panel(page).getByRole("button", { name: "History", exact: true }).click();
    await expect(panel(page).locator(".diff-commit-message")).toContainText(detached.head);
    await page.screenshot({ path: info.outputPath("detached-history.png") });
  } finally { detached.cleanup(); rmSync(unbornParent, { recursive: true, force: true }); }
});

test("late real history and commit frames cannot replace the selected repository or commit", async ({ page }) => {
  const a = fixture("stale-A"), b = fixture("stale-B");
  const heldHistory: Array<() => void> = [], heldCommit: Array<() => void> = [];
  let holdCommit: string | null = null;
  await page.routeWebSocket("**/ws**", route => {
    const server = route.connectToServer();
    route.onMessage(data => server.send(data));
    server.onMessage(data => {
      const message = JSON.parse(data.toString());
      if (message.type === "git.history" && message.page?.repoRoot === a.repo) heldHistory.push(() => route.send(data));
      else if (holdCommit !== null && message.type === "sessionChanges.summary" && message.state?.review?.currentCommitOid === holdCommit) heldCommit.push(() => route.send(data));
      else route.send(data);
    });
  });
  try {
    await authenticate(page); await createSession(page, a.repo, `Stale frames ${Date.now()}`);
    await expect.poll(() => heldHistory.length).toBeGreaterThan(0);
    await addRepo(page, b.repo);
    await expect(panel(page).locator(".git-root-path")).toHaveText(b.repo);
    await expect(panel(page).locator(".git-head-label")).toContainText(b.head.slice(0, 12));
    heldHistory.forEach(release => release());
    await expect(panel(page).locator(".git-root-path")).toHaveText(b.repo);
    await panel(page).getByRole("button", { name: "History", exact: true }).click();
    await expect(panel(page).locator(".diff-commit-message")).toContainText(b.head);
    holdCommit = b.initial;
    await panel(page).locator(`[data-commit-oid="${b.initial}"]`).click();
    await expect.poll(() => heldCommit.length).toBeGreaterThan(0);
    await panel(page).locator(`[data-commit-oid="${b.head}"]`).click();
    await expect(panel(page).locator(".diff-commit-message")).toContainText(b.head);
    heldCommit.forEach(release => release());
    await expect(panel(page).locator(".diff-commit-message")).toContainText(b.head);
    await expect(panel(page).locator(".diff-commit-message")).not.toContainText(`Initial stale-B`);
  } finally { a.cleanup(); b.cleanup(); }
});

test("returning to a session reloads an interrupted commit selection", async ({ page }) => {
  const a = fixture("resume-A"), b = fixture("resume-B");
  let hold = false;
  const held: Array<string | Buffer> = [];
  await page.routeWebSocket("**/ws**", route => {
    const server = route.connectToServer();
    route.onMessage(data => server.send(data));
    server.onMessage(data => {
      const message = JSON.parse(data.toString());
      if (hold && message.type === "sessionChanges.summary" && message.state?.review?.currentCommitOid === a.initial) held.push(data);
      else route.send(data);
    });
  });
  const nameA = `Resume A ${Date.now()}`, nameB = `Resume B ${Date.now()}`;
  try {
    await authenticate(page);
    await createSession(page, a.repo, nameA);
    await createSession(page, b.repo, nameB);
    await page.locator("#sessionsList .session-item").filter({ hasText: nameA }).locator("button").first().click();
    await panel(page).getByRole("button", { name: "History", exact: true }).click();
    await expect(panel(page).locator(".diff-commit-message")).toContainText(a.head);
    hold = true;
    await panel(page).locator(`[data-commit-oid="${a.initial}"]`).click();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.locator("#sessionsList .session-item").filter({ hasText: nameB }).locator("button").first().click();
    await expect(page.locator("#sessionTitle")).toContainText(nameB);
    hold = false;
    await page.locator("#sessionsList .session-item").filter({ hasText: nameA }).locator("button").first().click();
    await panel(page).getByRole("button", { name: "History", exact: true }).click();
    await expect(panel(page).locator(".diff-commit-message")).toContainText(a.initial);
  } finally { a.cleanup(); b.cleanup(); }
});

test("committed file reads leave loading on disconnect and can be reopened", async ({ page }) => {
  const a = fixture("disconnect");
  let hold = true;
  let heldFiles = 0;
  let disconnect: (() => Promise<void>) | undefined;
  await page.routeWebSocket("**/ws**", route => {
    const server = route.connectToServer();
    disconnect = async () => {
      await Promise.all([route.close({ code: 1001, reason: "review connection probe" }), server.close({ code: 1001 })]);
    };
    route.onMessage(data => server.send(data));
    server.onMessage(data => {
      const message = JSON.parse(data.toString());
      if (hold && message.type === "git.file") heldFiles += 1;
      else route.send(data);
    });
  });
  try {
    await authenticate(page); await createSession(page, a.repo, `Disconnect ${Date.now()}`);
    await panel(page).getByRole("button", { name: "History", exact: true }).click();
    await expect(panel(page).locator(".diff-commit-message")).toContainText(a.head);
    await panel(page).locator('.diffs-file-jump[data-diff-file-path="same.ts"]').click();
    await panel(page).getByRole("button", { name: "View committed file", exact: true }).click();
    const file = page.getByRole("dialog", { name: "Committed file", exact: true });
    await expect.poll(() => heldFiles).toBeGreaterThan(0);
    if (!disconnect) throw new Error("WebSocket route was not established");
    await disconnect();
    await expect(file.getByRole("alert")).toContainText(/connection/i);
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await file.getByRole("button", { name: "Close", exact: true }).click();
    hold = false;
    await panel(page).locator('.diffs-file-jump[data-diff-file-path="same.ts"]').click();
    await panel(page).getByRole("button", { name: "View committed file", exact: true }).click();
    await expect(page.locator(".git-file-content")).toHaveText(a.contents("disconnect_1"));
  } finally { a.cleanup(); }
});

test("popout review keeps commit navigation after patch rerenders", async ({ page }, info) => {
  const a = fixture("popout");
  let popout: Page | null = null;
  try {
    await authenticate(page); await createSession(page, a.repo, `Popout ${Date.now()}`);
    await panel(page).getByRole("button", { name: "History", exact: true }).click();
    await expect(panel(page).locator(".diff-commit-message")).toContainText(a.head);
    const opened = page.waitForEvent("popup");
    await page.locator(".dv-groupview").filter({ has: page.locator(".dv-tab").filter({ hasText: "Git changes" }) }).locator(".panel-popout-btn").click();
    popout = await opened;
    await expect(panel(popout).locator(".diff-commit-message")).toContainText(a.head);
    await panel(popout).getByRole("button", { name: "Refresh", exact: true }).click();
    await panel(popout).locator('.diffs-file-jump[data-diff-file-path="same.ts"]').click();
    await expect(panel(popout).locator(".diff-line-add")).toContainText("popout_1");
    await expect(panel(popout).getByRole("button", { name: "Newer commit", exact: true })).toBeVisible();
    await expect(panel(popout).getByRole("button", { name: "Older commit", exact: true })).toBeVisible();
    await panel(popout).locator(".git-history-heading strong").click();
    await popout.keyboard.press("n");
    await expect(panel(popout).locator(".diff-commit-message")).toContainText(a.initial);
    await popout.keyboard.press("p");
    await expect(panel(popout).locator(".diff-commit-message")).toContainText(a.head);
    await popout.screenshot({ path: info.outputPath("popout-review.png") });
  } finally { await popout?.close(); a.cleanup(); }
});

test("commit shortcuts stay in the focused review and survive asynchronous rerenders", async ({ page }) => {
  const a = fixture("keyboard", 3);
  try {
    await authenticate(page); await createSession(page, a.repo, `Keyboard ${Date.now()}`);
    const view = panel(page);
    await view.getByRole("button", { name: "History", exact: true }).click();
    await expect(view.locator(".diff-commit-message")).toContainText(a.head);
    await view.locator(".git-history-heading strong").click();
    await page.keyboard.press("n");
    await expect(view.locator(".diff-commit-message")).toContainText(a.commits[2]);
    await expect(view.locator(".diff-line-add")).toContainText("keyboard_2");
    await page.keyboard.press("n");
    await expect(view.locator(".diff-commit-message")).toContainText(a.commits[1]);
    await page.keyboard.press("p");
    await expect(view.locator(".diff-commit-message")).toContainText(a.commits[2]);
    await view.locator(".diff-filter-input").click();
    await page.keyboard.type("n");
    await expect(view.locator(".diff-commit-message")).toContainText(a.commits[2]);
    await page.locator("#promptInput").click();
    await page.keyboard.type("p");
    await expect(view.locator(".diff-commit-message")).toContainText(a.commits[2]);
    await view.locator(".git-history-heading strong").click();
    await page.keyboard.press("Control+n");
    await expect(view.locator(".diff-commit-message")).toContainText(a.commits[2]);
    await page.keyboard.press("p");
    await expect(view.locator(".diff-commit-message")).toContainText(a.head);
    await page.keyboard.press("p");
    await expect(view.locator(".diff-commit-message")).toContainText(a.head);
  } finally { a.cleanup(); }
});

test("ordinary entry chooses from the selected real repository and respects manual navigation", async ({ page }, info) => {
  const a = fixture("entry-A"), b = fixture("entry-B");
  const mode = () => panel(page).locator(".git-review-navigation [aria-pressed=true]");
  const enter = async () => {
    const restore = panel(page).getByRole("button", { name: "Restore layout", exact: true });
    if (await restore.count()) {
      const previous = await mode().textContent();
      await restore.click();
      await expect(panel(page).getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
      await expect(mode()).toHaveText(previous!);
    }
    await panel(page).locator(".git-review-options > summary").click();
    await panel(page).getByRole("button", { name: "Advanced Compare", exact: true }).click();
    await page.locator("#cwdPickerDiffAgentSession").uncheck();
    await page.locator("#cwdPickerCreate").click();
    await expect(panel(page)).toBeHidden();
    await page.locator(".dv-tab:visible").filter({ hasText: "Git changes" }).click();
  };
  try {
    git(b.repo, "restore", "--worktree", "same.ts");
    await authenticate(page); await createSession(page, a.repo, `Entry defaults ${Date.now()}`);
    await expect(mode()).toHaveText("Current changes");
    await addRepo(page, b.repo);
    await expect(mode()).toHaveText("History");
    await expect(panel(page).locator(".git-root-path")).toHaveText(b.repo);
    await expect(panel(page).locator(".diff-commit-message")).toContainText(b.head);
    await panel(page).getByRole("button", { name: "Current changes", exact: true }).click();
    const before = bytes(b.repo);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(panel(page).getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(mode()).toHaveText("Current changes");
    expect(bytes(b.repo)).toEqual(before);
    await enter();
    await expect(mode()).toHaveText("History");
    await expect(panel(page).locator(".diff-commit-message")).toContainText(b.head);
    await page.screenshot({ path: info.outputPath("clean-entry-history.png") });
    writeFileSync(path.join(b.repo, "same.ts"), b.contents("dirty again"));
    await enter();
    await expect(mode()).toHaveText("Current changes");
    await panel(page).getByRole("button", { name: "History", exact: true }).click();
    await expect(panel(page).locator(".diff-commit-message")).toContainText(b.head);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(mode()).toHaveText("History");
    await panel(page).locator(".git-review-options > summary").click();
    await panel(page).getByRole("button", { name: "Advanced Compare", exact: true }).click();
    await expect(page.locator("#cwdPickerDiffHead")).toHaveValue(b.head);
    await page.locator("#cwdPickerCancel").click();
    git(b.repo, "restore", "--worktree", "same.ts");
    await enter();
    await expect(mode()).toHaveText("History");
    await panel(page).getByRole("combobox", { name: "Repository", exact: true }).selectOption(a.repo);
    await expect(mode()).toHaveText("Current changes");
    await expect(panel(page).locator(".git-root-path")).toHaveText(a.repo);
  } finally { a.cleanup(); b.cleanup(); }
});

test("ordinary entry recognizes real staged untracked ignored conflicted and unborn states", async ({ page }, info) => {
  test.setTimeout(120000);
  const cases = ["staged", "untracked", "ignored", "conflicted", "unborn"] as const;
  const fixtures = cases.map(kind => ({ kind, ...fixture(`entry-${kind}`) }));
  try {
    await authenticate(page);
    for (const item of fixtures) {
      if (item.kind === "staged") git(item.repo, "add", "same.ts");
      else {
        git(item.repo, "restore", "--worktree", "same.ts");
        if (item.kind === "untracked") writeFileSync(path.join(item.repo, "new.txt"), "untracked\n");
        if (item.kind === "ignored") {
          writeFileSync(path.join(item.repo, ".git", "info", "exclude"), "ignored.txt\n");
          writeFileSync(path.join(item.repo, "ignored.txt"), "ignored\n");
        }
        if (item.kind === "conflicted") {
          git(item.repo, "checkout", "-qb", "conflicting", item.initial);
          writeFileSync(path.join(item.repo, "same.ts"), "conflicting branch\n");
          git(item.repo, "add", "same.ts");
          git(item.repo, "-c", "commit.gpgsign=false", "commit", "-qm", "conflict");
          git(item.repo, "checkout", "-q", "main");
          try { git(item.repo, "merge", "conflicting"); } catch { /* Expected fixture conflict. */ }
          expect(git(item.repo, "ls-files", "-u")).not.toBe("");
        }
        if (item.kind === "unborn") {
          const empty = path.join(item.parent, "unborn"); mkdirSync(empty);
          git(empty, "init", "-q", "-b", "main");
          item.repo = empty;
        }
      }
      const before = bytes(item.repo);
      await createSession(page, item.repo, `Entry ${item.kind} ${Date.now()}`);
      await expect(panel(page).locator(".git-review-navigation [aria-pressed=true]"))
        .toHaveText(item.kind === "ignored" || item.kind === "unborn" ? "History" : "Current changes");
      if (item.kind === "unborn") await expect(panel(page).locator(".git-history-browser")).toContainText("No commits yet");
      expect(bytes(item.repo)).toEqual(before);
      if (item.kind === "staged") {
        await page.setViewportSize({ width: 760, height: 850 });
        await panel(page).locator(".git-review-navigation [aria-pressed=true]").scrollIntoViewIfNeeded();
        await expect(panel(page).locator(".git-review-navigation [aria-pressed=true]")).toBeInViewport();
        await page.screenshot({ path: info.outputPath("staged-entry-narrow.png") });
        await page.setViewportSize({ width: 1440, height: 960 });
      }
    }
  } finally { for (const item of fixtures) item.cleanup(); }
});

test("ordinary entry keeps missing-repository and refused-status diagnostics actionable", async ({ page }, info) => {
  const item = fixture("entry-filter");
  const plain = path.join(item.parent, "not-git"); mkdirSync(plain);
  const marker = path.join(item.parent, "filter-ran");
  const filter = path.join(item.parent, "filter");
  try {
    git(item.repo, "add", "same.ts");
    writeFileSync(filter, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`);
    chmodSync(filter, 0o700);
    writeFileSync(path.join(item.repo, ".git", "info", "attributes"), "same.ts filter=entry-probe\n");
    git(item.repo, "config", "filter.entry-probe.clean", filter);
    writeFileSync(path.join(item.repo, "same.ts"), readFileSync(path.join(item.repo, "same.ts")));
    const before = bytes(item.repo);
    await authenticate(page); await createSession(page, plain, `Missing repository ${Date.now()}`);
    await expect(panel(page).locator(".diffs-error")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "History", exact: true })).toBeEnabled();
    await createSession(page, item.repo, `Refused status ${Date.now()}`);
    await expect(panel(page).locator(".diffs-error")).toBeVisible();
    await expect(panel(page).locator(".git-review-navigation [aria-pressed=true]")).toHaveCount(0);
    await panel(page).getByRole("button", { name: "History", exact: true }).click();
    await expect(panel(page).locator(".diff-commit-message")).toContainText(item.head);
    await panel(page).getByRole("button", { name: "Current changes", exact: true }).click();
    await panel(page).getByRole("combobox", { name: "Git change group", exact: true }).selectOption("staged");
    await expect(panel(page).locator(".diffs-main-body")).toContainText("entry-filter_WORKTREE_ONLY");
    await expect(panel(page).locator(".diffs-error")).toBeVisible();
    expect(existsSync(marker)).toBe(false);
    expect(bytes(item.repo)).toEqual(before);
    await page.screenshot({ path: info.outputPath("status-error-staged-still-readable.png") });
  } finally { item.cleanup(); }
});
