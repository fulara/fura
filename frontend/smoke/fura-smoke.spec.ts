import { expect, type Page, test } from "@playwright/test";
import path from "node:path";

const bridgeToken = "dev";
const repoRoot = path.resolve("..");

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

  await page.locator("#promptInput").fill("hello from desktop smoke");
  await page.locator("#sendButton").click();

  await expect(page.locator(".message.user")).toContainText("hello from desktop smoke");
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
  await page.locator(".plan-review-approve").click();
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
