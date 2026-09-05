import { expect, type Page, test } from "@playwright/test";
import path from "node:path";

const bridgeToken = "dev";
const repoRoot = path.resolve("..");
const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

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

test("desktop rolls back a text and image prompt into an unsent draft", async ({ page }) => {
  const sessionName = `Desktop rollback ${Date.now()}`;
  const promptText = "desktop rollback draft";

  await authenticateDesktop(page);
  await createDesktopSession(page, sessionName);
  const sessionCountBefore = await page.locator("#sessionsList .session-item").count();

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
  await expect(page.locator("#sessionsList .session-item")).toHaveCount(sessionCountBefore + 1);
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

test("desktop opens an explicit compare diff against the working tree", async ({ page }) => {
  await authenticateDesktop(page);

  await page.locator("#createSessionButton").click();
  await page.locator("#cwdPickerDiffTab").click();
  await page.locator("#cwdPickerDiffRepo").fill(repoRoot);
  await page.locator("#cwdPickerDiffBase").fill("HEAD");
  await page.locator("#cwdPickerDiffHead").fill("WORKTREE");
  await page.locator("#cwdPickerDiffAgentSession").uncheck();
  await page.locator("#cwdPickerCreate").click();

  await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
  await expect(page.locator(".compare-main .diffs-toolbar")).toContainText("Compare diff");
  await expect(page.locator(".compare-main .diffs-summary")).toContainText("working tree");
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

  await authenticateMobile(page);
  await createMobileSession(page, sessionName);
  const sessionCountBefore = await page.locator("#mobileSessionsList .session-item").count();

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
  await expect(page.locator("#mobileSessionsList .session-item")).toHaveCount(sessionCountBefore + 1);
  await expect(page.locator("#mobilePromptInput")).toHaveValue(exactDraft);
  await expect(page.locator("#mobileImagePreviews img")).toBeVisible();
  await expect(page.locator("#mobileTranscript .message.user")).toHaveCount(0);
  await expect(page.locator("#mobileTranscript .message.assistant")).toHaveCount(0);

  await page.locator("#mobileSendButton").click();
  await expect(page.locator("#mobileTranscript .message.user")).toContainText(promptText);
  await expect(page.locator("#mobileTranscript .message.assistant")).toContainText("Mock assistant received");
});
