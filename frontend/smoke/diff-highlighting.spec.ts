import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

const token = process.env.FURA_SMOKE_TOKEN ?? "dev";
const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-C", repo, ...args], { env: gitEnvironment, encoding: "utf8" }).trim();
}
function rustSource(value: string): string {
  return [
    "/* Available multiline context",
    "pub fn inside_comment() {}",
    ...Array.from({ length: 8 }, (_, i) => `context line ${i}`),
    "*/",
    "#[derive(Debug)]",
    "pub struct Counter;",
    "pub fn render<'a>(name: &'a str) -> Option<u32> {",
    `    let label = "${value}";`,
    "    let count = 42;",
    '    println!("<img src=x>");',
    "    Some(count)",
    "}",
    "",
  ].join("\n");
}
function fixture(value: string) {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-highlight-git-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Highlight Reviewer");
  git(repo, "config", "user.email", "highlight@example.invalid");
  writeFileSync(path.join(repo, "lib.rs"), rustSource("old"));
  git(repo, "add", ".");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "Initial Rust file");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(path.join(repo, "lib.rs"), rustSource(value));
  git(repo, "add", ".");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "Change Rust string");
  const head = git(repo, "rev-parse", "HEAD");
  writeFileSync(path.join(repo, "lib.rs"), rustSource("WORKING_TREE_ONLY"));
  return { repo, base, head, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}
async function authenticate(page: Page, mobile = false) {
  await page.goto(mobile ? "/mobile.html" : "/");
  await page.locator(mobile ? "#mobileAuthToken" : "#authTokenInput").fill(token);
  await page.locator(mobile ? "#mobileAuthSubmit" : "#authSubmit").click();
  await expect(page.locator(mobile ? "#mobileConnectionStatus" : "#connectionStatus")).toHaveText("connected");
}
async function createSession(page: Page, name: string, cwd = "/tmp", mobile = false) {
  await page.locator(mobile ? "#mobileCreateToggle" : "#createSessionButton").click();
  await page.locator(mobile ? "#mobileCreateName" : "#cwdPickerNameInput").fill(name);
  await page.locator(mobile ? "#mobileCreateCwd" : "#cwdPickerInput").fill(cwd);
  await page.locator(mobile ? "#mobileCreateSubmit" : "#cwdPickerCreate").click();
  await expect(page.locator(mobile ? "#mobileSessionTitle" : "#sessionTitle")).toContainText(name);
}

test.beforeEach(({ page }) =>
  page.on("pageerror", (error) => {
    throw error;
  }),
);

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} edit syntax and intraline preserve lazy streaming, selection, copy and restoration`, async ({
    page,
    context,
  }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await authenticate(page, mobile);
    const name = `Highlight ${mobile ? "mobile" : "desktop"} ${Date.now()}`;
    await createSession(page, name, "/tmp", mobile);
    await page.locator(mobile ? "#mobilePromptInput" : "#promptInput").fill("mock highlight");
    await page.locator(mobile ? "#mobileSendButton" : "#sendButton").click();
    const card = page.locator(mobile ? "#mobileTranscript .edit-tool-card" : ".panel-content-transcript .edit-tool-card");
    await expect(card.locator(".edit-file")).toHaveCount(2);
    const rust = card.locator('.edit-file[data-edit-path="src/lib.rs"]');
    const yaml = card.locator('.edit-file[data-edit-path="config.yaml"]');
    await rust.locator("summary").click();
    await expect(card).toHaveClass(/tool-active/);
    await expect(rust.locator(".edit-diff-lines")).toContainText("pub fn answer");
    await expect(rust.locator(".diff-syntax")).toHaveCount(0);
    await expect(card.locator(".edit-file-status-completed")).toHaveCount(2);
    await expect(rust).toHaveAttribute("open", "");
    await expect(rust.locator(".diff-intraline-add")).toHaveText("new");
    await expect(rust.locator(".hljs-keyword").filter({ hasText: /^pub$/ })).toHaveText("pub");
    await expect(rust.locator("img, script")).toHaveCount(0);
    await expect(yaml.locator(".edit-file-body")).toHaveCount(0);
    const selected = await rust.locator(".diff-line-add .diff-syntax").evaluate((element) => {
      const selection = element.ownerDocument.getSelection()!;
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      const text = selection.toString();
      selection.removeAllRanges();
      return text;
    });
    expect(selected).toBe('    let message = "new";');
    if (mobile) {
      const patch = rust.locator(".edit-diff-lines");
      await patch.evaluate((element) => {
        element.scrollLeft = 120;
      });
      await expect.poll(() => patch.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await patch.evaluate((element) => {
        element.scrollLeft = 0;
      });
    }
    await rust.getByRole("button", { name: "Copy", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(
      [
        " 1|#[derive(Debug)]",
        " 2|pub fn answer<'a>(label: &'a str) -> Option<u32> {",
        '-3|    let message = "old";',
        '+3|    let message = "new";',
        ' 4|    println!("<img src=x onerror=alert(1)>");',
        " 5|    Some(42)",
        " 6|}",
      ].join("\n"),
    );
    await yaml.locator("summary").click();
    await expect(yaml.locator(".hljs-attr").first()).toContainText("port");
    await expect(yaml.locator(".diff-intraline-add")).toHaveText("3001");
    await page.screenshot({ path: info.outputPath(`${mobile ? "mobile" : "desktop"}-edit-highlight.png`) });
    await rust.locator("summary").click();
    await page.reload();
    await expect(page.locator(mobile ? "#mobileConnectionStatus" : "#connectionStatus")).toHaveText("connected");
    if (!mobile) await page.locator("#sessionsList .session").filter({ hasText: name }).click();
    await expect(rust).not.toHaveAttribute("open", "");
    await expect(yaml).toHaveAttribute("open", "");
    await expect(yaml.locator(".diff-intraline-add")).toHaveText("3001");
  });
}

test("Rust commit syntax and intraline retain context, comments, file bytes and repository identity", async ({ page }, info) => {
  const first = fixture("new"),
    second = fixture("other");
  try {
    await authenticate(page);
    await createSession(page, `Highlight Git ${Date.now()}`, first.repo);
    await page.locator(".dv-tab").filter({ hasText: "Git changes" }).click();
    const review = page.locator(".session-changes-view:visible");
    await review.getByRole("button", { name: "History", exact: true }).click();
    await expect(review.locator(".diff-commit-message")).toContainText(first.head);
    await review.locator('.diffs-file-jump[data-diff-file-path="lib.rs"]').click();
    await expect(review.locator(".diff-intraline-add")).toHaveText("new");
    await expect(review.locator(".diffs-main-body")).not.toContainText("WORKING_TREE_ONLY");
    await review.getByRole("button", { name: "Show more context", exact: true }).click();
    const commentLine = review.locator(".diff-line-wrap").filter({ hasText: "pub fn inside_comment() {}" });
    // The first expansion starts at line 2, still inside an unknown comment.
    await expect(commentLine.locator(".hljs-keyword").filter({ hasText: /^pub$/ })).toHaveText("pub");
    await review.getByRole("button", { name: "Show more context", exact: true }).click();
    await expect(commentLine.locator(".hljs-comment")).toHaveText("pub fn inside_comment() {}");
    await expect(commentLine.locator(".hljs-keyword")).toHaveCount(0);
    await expect(review.locator(".diff-intraline-add")).toHaveText("new");
    await review.locator(".diff-line-add .diff-comment-btn").click();
    await review.locator(".review-comment-composer-input").fill("HIGHLIGHT_ANCHOR_NOTE");
    await review.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(review).toContainText("HIGHLIGHT_ANCHOR_NOTE");
    page.once("dialog", (dialog) => dialog.accept("Check highlighted string"));
    await review.locator(".diff-line-add .diff-question-btn").click();
    await review.getByRole("button", { name: "Preview questions (1)", exact: true }).click();
    const prompt = await page.locator("#diffPreviewText").inputValue();
    expect(prompt).toContain(first.repo);
    expect(prompt).toContain(first.base);
    expect(prompt).toContain(first.head);
    expect(prompt).toContain('+    let label = "new";');
    expect(prompt).not.toContain("hljs-");
    await page.locator("#diffPreviewClose").click();
    await page.screenshot({ path: info.outputPath("git-rust-highlight-context-comments.png") });
    await review.getByRole("button", { name: "View committed file", exact: true }).click();
    const file = page.getByRole("dialog", { name: "Committed file", exact: true });
    await expect(file.locator(".git-file-content")).toHaveText(rustSource("new"));
    await file.getByRole("button", { name: "Close", exact: true }).click();
    await review.getByRole("button", { name: "Older commit", exact: true }).click();
    await expect(review.locator(".diff-commit-message")).toContainText(first.base);
    await expect(review.locator(".diff-intraline-add, .diff-intraline-remove")).toHaveCount(0);
    await review.getByRole("button", { name: "Newer commit", exact: true }).click();
    await expect(review).toContainText("HIGHLIGHT_ANCHOR_NOTE");
    await expect(review.locator(".diff-intraline-add")).toHaveText("new");
    await review.locator(".git-review-options > summary").click();
    page.once("dialog", (dialog) => dialog.accept(second.repo));
    await review.getByRole("button", { name: "Add", exact: true }).click();
    await review.getByRole("combobox", { name: "Repository", exact: true }).selectOption(second.repo);
    await expect(review.locator(".diff-commit-message")).toContainText(second.head);
    await expect(review.locator(".diff-intraline-add")).toHaveText("other");
    await expect(review).not.toContainText("HIGHLIGHT_ANCHOR_NOTE");
    await review.getByRole("combobox", { name: "Repository", exact: true }).selectOption(first.repo);
    await expect(review.locator(".diff-intraline-add")).toHaveText("new");
    expect(readFileSync(path.join(first.repo, "lib.rs"), "utf8")).toBe(rustSource("WORKING_TREE_ONLY"));
    expect(git(first.repo, "rev-parse", "HEAD")).toBe(first.head);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});
