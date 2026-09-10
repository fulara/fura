import { expect, type Page, test } from "@playwright/test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ServerMessage } from "../src/protocol";

const bridgeToken = "dev";
const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function observeRollbackResult(page: Page): Promise<Extract<ServerMessage, { type: "session.rewind.result" }>> {
  const { promise, resolve } = Promise.withResolvers<Extract<ServerMessage, { type: "session.rewind.result" }>>();
  page.on("websocket", socket => {
    let requestId: string | undefined;
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(payload.toString());
      if (message.type === "session.rewind.select") requestId = message.requestId;
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(payload.toString()) as ServerMessage;
      if (message.type === "session.rewind.result" && message.requestId === requestId) resolve(message);
    });
  });
  return promise;
}

async function pasteTinyPng(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((element, pngBase64) => {
    const bytes = Uint8Array.from(atob(pngBase64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "rollback.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, tinyPngBase64);
}

test.describe.configure({ mode: "serial" });

test.beforeEach(({ page }) => {
  page.on("pageerror", error => {
    throw error;
  });
});

async function authenticateDesktop(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#authGate")).toBeVisible();
  await page.locator("#authTokenInput").fill(bridgeToken);
  await page.locator("#authSubmit").click();
  await expect(page.locator("#authGate")).toBeHidden();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
}

async function authenticateMobile(page: Page): Promise<void> {
  await page.goto("/mobile.html");
  await expect(page.locator("#mobileAuthGate")).toBeVisible();
  await page.locator("#mobileAuthToken").fill(bridgeToken);
  await page.locator("#mobileAuthSubmit").click();
  await expect(page.locator("#mobileAuthGate")).toBeHidden();
  await expect(page.locator("#mobileConnectionStatus")).toHaveText("connected");
}

async function createDesktopSession(page: Page, name: string): Promise<void> {
  await page.locator("#createSessionButton").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeVisible();
  await page.locator("#cwdPickerNameInput").fill(name);
  await page.locator("#cwdPickerInput").fill("/tmp");
  await page.locator("#cwdPickerCreate").click();
  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(page.locator("#sessionTitle")).toContainText(name);
}

async function createMobileSession(page: Page, name: string): Promise<void> {
  await page.locator("#mobileCreateToggle").click();
  await expect(page.locator("#mobileCreateDrawer")).toBeVisible();
  await page.locator("#mobileCreateName").fill(name);
  await page.locator("#mobileCreateCwd").fill("/tmp");
  await page.locator("#mobileCreateSubmit").click();
  await expect(page.locator("#mobileCreateDrawer")).toBeHidden();
  await expect(page.locator("#mobileSessionTitle")).toContainText(name);
}

test("desktop authenticates, creates a mock session, and receives a prompt response", async ({ page }) => {
  const sessionName = `Desktop smoke ${Date.now()}`;

  await authenticateDesktop(page);
  await createDesktopSession(page, sessionName);

  await expect(page.locator(".message.system")).toContainText(
    "Background job completed [task] mock-bootstrap-job",
  );
  await expect(page.locator(".message.system")).not.toContainText("<system-notice>");

  await page.locator("#promptInput").fill("hello from desktop smoke");
  await page.locator("#sendButton").click();

  await expect(page.locator(".message.user")).toContainText("hello from desktop smoke");
  await expect(page.locator(".message.assistant")).toContainText("Mock assistant received");
  await expect.poll(async () => (await page.locator(".message.user").boundingBox())?.height ?? 0).toBeGreaterThan(20);
  await expect.poll(async () => (await page.locator(".message.assistant").boundingBox())?.height ?? 0).toBeGreaterThan(20);
});

test("desktop prompt keeps a roomy default after reload and fits short viewports", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await authenticateDesktop(page);
  const sessionName = `Prompt height smoke ${Date.now()}`;
  await createDesktopSession(page, sessionName);
  const prompt = page.locator("#promptInput");
  const usableHeight = () => prompt.evaluate(element => {
    const style = getComputedStyle(element);
    return element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  });
  // More than twice the old 39.6px text area, not extra container padding.
  expect(await usableHeight()).toBeGreaterThanOrEqual(80);
  await page.reload();
  await expect(page.locator("#connectionStatus")).toHaveText("connected");
  expect(await usableHeight()).toBeGreaterThanOrEqual(80);
  await page.locator("#sessionsList .session-item button").filter({ hasText: sessionName }).first().click();
  await expect(prompt).toBeEnabled();

  await page.setViewportSize({ width: 1440, height: 320 });
  // A previously enlarged editor must also fit when the window becomes short.
  await prompt.evaluate(element => { element.style.height = "288px"; });
  for (const selector of ["#promptInput", "#sendButton", "#abortButton", "#stopButton"]) {
    const bounds = await page.locator(selector).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320);
  }
  expect((await page.locator("#workspacePanelHost").boundingBox())!.height).toBeGreaterThan(100);
  await page.locator("#abortButton").click({ trial: true });
  await page.locator("#stopButton").click({ trial: true });
  await prompt.fill("Prompt from a short desktop window");
  await page.locator("#sendButton").click();
  await expect(page.locator(".message.assistant").last()).toContainText("Mock assistant received");
});

test("desktop rolls back a text and image prompt into an unsent draft", async ({ page }) => {
  const sessionName = `Desktop rollback ${Date.now()}`;
  const promptText = "desktop rollback draft";
  const rollbackResult = observeRollbackResult(page);

  await authenticateDesktop(page);
  await createDesktopSession(page, sessionName);

  await page.locator("#promptInput").fill(promptText);
  await pasteTinyPng(page, "#promptInput");
  await expect(page.locator("#imagePreviews img")).toBeVisible();
  const exactDraft = await page.locator("#promptInput").inputValue();
  await page.locator("#sendButton").click();
  await expect(page.locator(".message.assistant")).toContainText("Mock assistant received");

  await expect(page.locator("#workspaceOptionsToggle")).toHaveAttribute("title", "Session options");
  await page.locator("#workspaceOptionsToggle").click();
  const rollbackAction = page.getByRole("menuitem", { name: "Rollback chat…" });
  await expect(rollbackAction).toBeEnabled();
  await rollbackAction.click();
  await expect(page.getByRole("dialog", { name: "Rollback chat" })).toBeVisible();
  await expect(page.locator("#rollbackChatList")).toContainText(promptText);
  await page.locator("#rollbackChatRestore").click();

  await expect(page.locator("#rollbackChatOverlay")).toBeHidden();
  const branch = await rollbackResult;
  expect(branch.sessionId).not.toBe(branch.sourceSessionId);
  await expect(page.locator("#promptInput")).toHaveValue(exactDraft);
  await expect(page.locator("#imagePreviews img")).toBeVisible();
  await expect(page.locator(".message.user")).toHaveCount(0);
  await expect(page.locator(".message.assistant")).toHaveCount(0);

  await page.locator("#sendButton").click();
  await expect(page.locator(".message.user")).toContainText(promptText);
  await expect(page.locator(".message.assistant")).toContainText("Mock assistant received");
});

test("desktop lists and changes the active session model", async ({ page }) => {
  const sessionName = `Model smoke ${Date.now()}`;

  await authenticateDesktop(page);
  await createDesktopSession(page, sessionName);

  await page.locator("#promptInput").fill("/model list");
  await page.locator("#sendButton").click();
  await expect(page.locator("#modelPickerOverlay")).toBeVisible();
  await expect(page.locator("#modelPickerStatus")).toHaveText(/3 models/);

  await page.locator("#modelPickerSearch").fill("reasoner");
  await page.locator(".model-picker-row", { hasText: "mock/mock-reasoner" }).click();
  await page.locator("#modelPickerSelect").click();

  await expect(page.locator("#modelPickerOverlay")).toBeHidden();
  await expect(page.locator("#statusBar .model")).toHaveText("Mock Reasoner");
});

test("compact refreshes context and accepts the next prompt without reload on desktop and mobile", async ({ page }) => {
  await authenticateDesktop(page);
  await createDesktopSession(page, `Context smoke ${Date.now()}`);
  await page.locator("#promptInput").fill("/model local/tiny");
  await page.locator("#sendButton").click();
  await expect(page.locator("#statusBar .model")).toHaveText("Tiny Fast Mock");
  await expect(page.locator("#statusBar .context")).toHaveText("75.0%/32K");
  await page.locator("#promptInput").fill("/compact");
  await page.locator("#sendButton").click();
  await expect(page.locator("#statusBar .context")).toHaveText("12.5%/32K");
  await expect(page.locator("#promptInput")).toBeEnabled();
  await expect(page.locator(".message.assistant")).toHaveCount(0);
  await page.locator("#promptInput").fill("Continue after desktop compaction");
  await page.locator("#sendButton").click();
  await expect(page.locator(".message.assistant").last()).toContainText("Mock assistant received");

  await page.goto("/mobile.html");
  await expect(page.locator("#mobileConnectionStatus")).toHaveText("connected");
  await createMobileSession(page, `Mobile context smoke ${Date.now()}`);
  await expect(page.locator("#mobileStatusBar .context")).toHaveText("12.0%/200K");
  await page.locator("#mobilePromptInput").fill("/compact");
  await page.locator("#mobileSendButton").click();
  await expect(page.locator("#mobileStatusBar .context")).toHaveText("2.0%/200K");
  await expect(page.locator("#mobilePromptInput")).toBeEnabled();
  await expect(page.locator(".message.assistant")).toHaveCount(0);
  await page.locator("#mobilePromptInput").fill("Continue after mobile compaction");
  await page.locator("#mobileSendButton").click();
  await expect(page.locator(".message.assistant").last()).toContainText("Mock assistant received");
});

test("desktop explicit compare reads HEAD and working-tree content", async ({ page }) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-compare-smoke-")));
  const git = (...args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${path.join(root, ".no-hooks")}`, "-C", root, ...args]);
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fura smoke");
    git("config", "user.email", "smoke@example.invalid");
    writeFileSync(path.join(root, "value.ts"), "export const value = 'COMPARE_BASE';\n");
    git("add", "value.ts");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    writeFileSync(path.join(root, "value.ts"), "export const value = 'COMPARE_WORKTREE';\n");
    await authenticateDesktop(page);
    await page.locator("#createSessionButton").click();
    await page.locator("#cwdPickerDiffTab").click();
    await page.locator("#cwdPickerDiffRepo").fill(root);
    await page.locator("#cwdPickerDiffBase").fill("HEAD");
    await page.locator("#cwdPickerDiffHead").fill("WORKTREE");
    await page.locator("#cwdPickerDiffAgentSession").uncheck();
    await page.locator("#cwdPickerCreate").click();
    await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
    await expect(page.locator(".compare-main .diff-line-remove")).toContainText("COMPARE_BASE");
    await expect(page.locator(".compare-main .diff-line-add")).toContainText("COMPARE_WORKTREE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git groups keep independent patches, refresh, and open files from the selected repository", async ({ page }, testInfo) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fura-git-smoke-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fura smoke");
    git("config", "user.email", "smoke@example.invalid");
    writeFileSync(path.join(root, "same.ts"), "export const value = 'base';\n");
    git("add", "same.ts");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    writeFileSync(path.join(root, "same.ts"), "export const value = 'staged';\n");
    git("add", "same.ts");
    writeFileSync(path.join(root, "same.ts"), "export const value = 'unstaged';\n");
    writeFileSync(path.join(root, "new.ts"), "export const added = 'untracked';\n");
    const index = readFileSync(path.join(root, ".git/index"));
    const head = git("rev-parse", "HEAD");
    const refs = git("show-ref");
    await authenticateDesktop(page);
    const sessionName = `Git groups ${Date.now()}`;
    await createDesktopSession(page, sessionName);
    await page.locator(".dv-tab").filter({ hasText: "Git changes" }).click();
    const panel = page.locator(".session-changes-view:visible");
    await panel.locator(".git-review-options > summary").click();
    await expect(panel.getByRole("button", { name: "Add", exact: true })).toBeVisible();
    page.once("dialog", dialog => dialog.accept(root));
    await panel.getByRole("button", { name: "Add", exact: true }).click();
    const repos = panel.getByRole("combobox", { name: "Repository", exact: true });
    await expect(repos.locator("option", { hasText: path.basename(root) })).toHaveCount(1);
    await repos.selectOption(root);
    const group = panel.getByRole("combobox", { name: "Git change group" });
    await expect(group).toHaveValue("unstaged");
    await expect(panel.locator(".diffs-main-body")).toContainText("+export const value = 'unstaged';");
    await panel.locator('[data-diff-file-path="same.ts"].diffs-file-jump').click();
    await group.selectOption("staged");
    await expect(panel.locator(".diffs-main-body")).toContainText("+export const value = 'staged';");
    await expect(panel.locator(".diffs-main-body")).not.toContainText("unstaged");
    await expect(panel.getByRole("button", { name: "Code", exact: true })).toBeDisabled();
    await group.selectOption("untracked");
    await expect(panel.locator(".diffs-main-body")).toContainText("+export const added = 'untracked';");
    writeFileSync(path.join(root, "new.ts"), "export const added = 'refreshed';\n");
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(group).toHaveValue("untracked");
    await expect(panel.locator(".diffs-main-body")).toContainText("+export const added = 'refreshed';");
    await page.screenshot({ path: testInfo.outputPath("git-changes.png") });
    await panel.locator('[data-diff-file-path="new.ts"].diffs-file-jump').click();
    await panel.getByRole("button", { name: "Code", exact: true }).click();
    await expect(page.locator(".code-viewer:visible")).toContainText("refreshed");
    await page.reload();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await page.locator("#sessionsList .session-item").filter({ hasText: sessionName }).locator("button").first().click();
    await page.locator(".dv-tab").filter({ hasText: "Git changes" }).click();
    await expect(repos).toHaveValue(root);
    await group.selectOption("untracked");
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(panel.locator(".diffs-main-body")).toContainText("+export const added = 'refreshed';");
    await page.screenshot({ path: testInfo.outputPath("git-changes-restored.png") });
    expect(readFileSync(path.join(root, ".git/index"))).toEqual(index);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("show-ref")).toBe(refs);
    expect(git("symbolic-ref", "--short", "HEAD").trim()).toBe("main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop surfaces and approves a mock plan review", async ({ page }) => {
  const sessionName = `Plan smoke ${Date.now()}`;

  await authenticateDesktop(page);
  await createDesktopSession(page, sessionName);

  await page.locator("#promptInput").fill("/plan smoke plan");
  await page.locator("#sendButton").click();

  await expect(page.locator(".plan-review-card")).toContainText("Smoke Plan");
  await page.locator(".plan-review-approve-execute").click();
  await expect(page.locator(".plan-review-card")).toHaveCount(0);
});

test("mobile authenticates, creates a mock session, and receives a prompt response", async ({ page }) => {
  const sessionName = `Mobile smoke ${Date.now()}`;

  await authenticateMobile(page);
  await createMobileSession(page, sessionName);

  await page.locator("#mobilePromptInput").fill("hello from mobile smoke");
  await page.locator("#mobileSendButton").click();

  await expect(page.locator("#mobileTranscript .message.user")).toContainText("hello from mobile smoke");
  await expect(page.locator("#mobileTranscript .message.assistant")).toContainText("Mock assistant received");
});

test("mobile rolls back a text and image prompt into an unsent draft", async ({ page }) => {
  const sessionName = `Mobile rollback ${Date.now()}`;
  const promptText = "mobile rollback draft";
  const rollbackResult = observeRollbackResult(page);

  await authenticateMobile(page);
  await createMobileSession(page, sessionName);

  await page.locator("#mobilePromptInput").fill(promptText);
  await page.locator("#mobileImageInput").setInputFiles({
    name: "rollback.png",
    mimeType: "image/png",
    buffer: Buffer.from(tinyPngBase64, "base64"),
  });
  await expect(page.locator("#mobileImagePreviews img")).toBeVisible();
  const exactDraft = await page.locator("#mobilePromptInput").inputValue();
  await page.locator("#mobileSendButton").click();
  await expect(page.locator("#mobileTranscript .message.assistant")).toContainText("Mock assistant received");

  await expect(page.locator("#mobileOptionsToggle")).toHaveAttribute("title", "Session options");
  await page.locator("#mobileOptionsToggle").click();
  const rollbackAction = page.getByRole("menuitem", { name: "Rollback chat…" });
  await expect(rollbackAction).toBeEnabled();
  await rollbackAction.click();
  await expect(page.getByRole("dialog", { name: "Rollback chat" })).toBeVisible();
  await expect(page.locator("#mobileRollbackList")).toContainText(promptText);
  await page.locator("#mobileRollbackConfirm").click();

  await expect(page.locator("#mobileRollbackOverlay")).toBeHidden();
  const branch = await rollbackResult;
  expect(branch.sessionId).not.toBe(branch.sourceSessionId);
  await expect(page.locator("#mobilePromptInput")).toHaveValue(exactDraft);
  await expect(page.locator("#mobileImagePreviews img")).toBeVisible();
  await expect(page.locator("#mobileTranscript .message.user")).toHaveCount(0);
  await expect(page.locator("#mobileTranscript .message.assistant")).toHaveCount(0);

  await page.locator("#mobileSendButton").click();
  await expect(page.locator("#mobileTranscript .message.user")).toContainText(promptText);
  await expect(page.locator("#mobileTranscript .message.assistant")).toContainText("Mock assistant received");
});
