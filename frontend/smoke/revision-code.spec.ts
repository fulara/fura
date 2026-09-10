import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-C", root, ...args], { env: gitEnvironment, encoding: "utf8" }).trim();
}
const oldPath = "before name λ.rs",
  newPath = "after name λ.rs";
function source(value: string) {
  return [
    "// Full historical source — λ 👩‍💻",
    "/* pub fn inside_comment() {}",
    "still a comment */",
    "#[derive(Debug)]",
    "pub struct Value;",
    "pub fn answer<'a>(name: &'a str) -> Option<u32> {",
    `    let label = "${value}";`,
    '    println!("<img src=x onerror=alert(1)>");',
    "    Some(42)",
    "}",
    "// Beyond the changed hunk",
    "",
  ].join("\n");
}
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-revision-code-git-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Revision Reviewer");
  git(root, "config", "user.email", "revision@example.invalid");
  writeFileSync(path.join(root, oldPath), source("INITIAL"));
  git(root, "add", ".");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "Initial Rust file");
  const initial = git(root, "rev-parse", "HEAD");
  git(root, "mv", oldPath, newPath);
  writeFileSync(path.join(root, newPath), source("RENAMED"));
  git(root, "add", ".");
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "Rename Rust file");
  const renamed = git(root, "rev-parse", "HEAD");
  git(root, "rm", newPath);
  git(root, "-c", "commit.gpgsign=false", "commit", "-qm", "Delete Rust file");
  const deleted = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(root, newPath), source("WORKTREE_ONLY"));
  return { root, initial, renamed, deleted, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function repositoryBytes(root: string): string {
  const hash = createHash("sha256");
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(directory, entry.name);
      hash.update(path.relative(root, name));
      if (entry.isDirectory()) visit(name);
      else hash.update(readFileSync(name));
    }
  }
  visit(root);
  return hash.digest("hex");
}
async function start(page: Page, root: string) {
  await page.goto("/");
  await page.locator("#authTokenInput").fill(process.env.FURA_SMOKE_TOKEN ?? "dev");
  await page.locator("#authSubmit").click();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerNameInput").fill(`Revision Code ${Date.now()}`);
  await page.locator("#cwdPickerInput").fill(root);
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await page.locator(".dv-tab").filter({ hasText: "Git changes" }).click();
  await page.locator(".session-changes-view:visible").getByRole("button", { name: "History", exact: true }).click();
}
async function fileMenu(page: Page, file: string, keyboard = false) {
  const jump = page.locator(".session-changes-view:visible .diffs-file-jump").filter({ hasText: file });
  if (keyboard) {
    await jump.focus();
    await jump.press("Shift+F10");
  } else await jump.click({ button: "right" });
  const menu = page.locator(".diffs-file-menu:visible");
  await expect(menu.getByRole("button", { name: "View committed file", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "View this revision in Code", exact: true })).toBeVisible();
  return menu;
}
async function gitPanel(page: Page) {
  await page.locator(".dv-tab").filter({ hasText: "Git changes" }).click();
}

test.beforeEach(({ page }) =>
  page.on("pageerror", (error) => {
    throw error;
  }),
);

test("desktop revision Code preserves modal, deletion base, rename and initial file", async ({ page, context }, info) => {
  const repo = fixture(),
    before = repositoryBytes(repo.root);
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await start(page, repo.root);
    const view = page.locator(".session-changes-view:visible");
    await expect(view.locator(".diff-commit-message")).toContainText(repo.deleted);
    let menu = await fileMenu(page, newPath, true);
    await page.screenshot({ path: info.outputPath("desktop-revision-menu.png") });
    await menu.getByRole("button", { name: "View committed file", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Committed file", exact: true });
    await expect(modal.locator(".git-file-content")).toHaveText(source("RENAMED"));
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    menu = await fileMenu(page, newPath);
    await menu.getByRole("button", { name: "View this revision in Code", exact: true }).click();
    const code = page.locator(".code-revision-view:visible");
    await expect(code).toContainText(repo.renamed.slice(0, 12));
    await expect(code.getByRole("button", { name: "Back to working-tree Code", exact: true })).toBeFocused();
    await expect(code).toContainText(repo.root);
    await expect(code).toContainText(/read-only/i);
    await expect(code).toContainText("before deletion");
    await expect(code.locator(".code-file-path")).toHaveText(newPath);
    expect(await code.locator(".code-line-content").allTextContents()).toEqual(source("RENAMED").slice(0, -1).split("\n"));
    await expect(code.locator(".code-line-content").filter({ hasText: "pub fn answer" }).locator(".hljs-keyword").first()).toHaveText(
      "pub",
    );
    await expect(code.locator(".code-line-content img, .code-line-content script")).toHaveCount(0);
    await expect(code).not.toContainText("WORKTREE_ONLY");
    await expect(modal).toHaveCount(0);
    await code.getByRole("button", { name: "Copy", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source("RENAMED"));
    await page.screenshot({ path: info.outputPath("desktop-revision-code.png") });
    await gitPanel(page);
    await view.getByRole("button", { name: "Older commit", exact: true }).click();
    await expect(view.locator(".diff-commit-message")).toContainText(repo.renamed);
    menu = await fileMenu(page, newPath);
    await menu.getByRole("button", { name: "View this revision in Code", exact: true }).click();
    await expect(code.locator(".code-file-path")).toHaveText(newPath);
    await expect(code).toContainText("RENAMED");
    await gitPanel(page);
    await view.getByRole("button", { name: "Older commit", exact: true }).click();
    await expect(view.locator(".diff-commit-message")).toContainText(repo.initial);
    menu = await fileMenu(page, oldPath);
    await menu.getByRole("button", { name: "View this revision in Code", exact: true }).click();
    await expect(code.locator(".code-file-path")).toHaveText(oldPath);
    await expect(code).toContainText(repo.initial.slice(0, 12));
    await expect(code).toContainText("INITIAL");
    await code.getByRole("button", { name: "Back to working-tree Code", exact: true }).click();
    await expect(code).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const viewer = document.querySelector(".code-viewer");
      return viewer?.parentElement?.contains(document.activeElement) ?? false;
    })).toBe(true);
    await gitPanel(page);
    await view.getByRole("button", { name: "Current changes", exact: true }).click();
    await view.getByRole("combobox", { name: "Git change group", exact: true }).selectOption("untracked");
    const jump = view.locator(".diffs-file-jump").filter({ hasText: newPath });
    await jump.click({ button: "right" });
    await page.locator(".diffs-file-menu:visible").getByRole("button", { name: "Open in Code", exact: true }).click();
    await expect(page.locator(".code-viewer:visible .code-review-lines")).toContainText("WORKTREE_ONLY");
    expect(git(repo.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(repo.root, "rev-parse", "HEAD")).toBe(repo.deleted);
    expect(repositoryBytes(repo.root)).toBe(before);
  } finally {
    repo.cleanup();
  }
});

test("explicit Compare revision uses the selected base, not the deletion parent", async ({ page }, info) => {
  const repo = fixture(),
    before = repositoryBytes(repo.root);
  try {
    await page.goto("/");
    await page.locator("#authTokenInput").fill(process.env.FURA_SMOKE_TOKEN ?? "dev");
    await page.locator("#authSubmit").click();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await page.locator("#createSessionButton").click();
    await page.locator("#cwdPickerDiffTab").click();
    await page.locator("#cwdPickerDiffRepo").fill(repo.root);
    await page.locator("#cwdPickerDiffBase").fill(repo.initial);
    await page.locator("#cwdPickerDiffHead").fill(repo.deleted);
    await page.locator("#cwdPickerDiffAgentSession").uncheck();
    await page.locator("#cwdPickerCreate").click();
    await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
    await page.locator(".compare-view .diffs-file-jump").filter({ hasText: oldPath }).click({ button: "right" });
    const menu = page.locator(".diffs-file-menu:visible");
    await expect(menu.getByRole("button", { name: "View committed file", exact: true })).toBeVisible();
    await menu.getByRole("button", { name: "View this revision in Code", exact: true }).click();
    const code = page.locator(".code-revision-view:visible");
    await expect(code).toContainText(repo.initial.slice(0, 12));
    await expect(code.locator(".code-file-path")).toHaveText(oldPath);
    await expect(code.locator(".code-review-lines")).toContainText("INITIAL");
    await expect(code.locator(".code-review-lines")).not.toContainText("RENAMED");
    await page.screenshot({ path: info.outputPath("explicit-base-revision-code.png") });
    expect(repositoryBytes(repo.root)).toBe(before);
    expect(git(repo.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
  } finally {
    repo.cleanup();
  }
});

test("historical binary and oversized files fail without working-tree fallback", async ({ page }, info) => {
  const repo = fixture();
  try {
    writeFileSync(path.join(repo.root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(path.join(repo.root, "large.rs"), "x".repeat(1_000_001));
    git(repo.root, "add", "binary.dat", "large.rs");
    git(repo.root, "-c", "commit.gpgsign=false", "commit", "-qm", "Add non-previewable files");
    const head = git(repo.root, "rev-parse", "HEAD"),
      before = repositoryBytes(repo.root);
    await start(page, repo.root);
    for (const [file, error] of [
      ["binary.dat", "binary"],
      ["large.rs", "1 MB"],
    ] as const) {
      await gitPanel(page);
      const menu = await fileMenu(page, file);
      await menu.getByRole("button", { name: "View this revision in Code", exact: true }).click();
      const code = page.locator(".code-revision-view:visible");
      await expect(code.getByRole("alert")).toContainText(error);
      await expect(code.locator(".code-file-path")).toHaveText(file);
      await expect(code).toContainText(head.slice(0, 12));
      await expect(code.locator(".code-line-content")).toHaveCount(0);
      await expect(code.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: info.outputPath("revision-size-error.png") });
    expect(repositoryBytes(repo.root)).toBe(before);
  } finally {
    repo.cleanup();
  }
});
