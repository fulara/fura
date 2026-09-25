import { expect, type Page, test } from "@playwright/test";

const token = process.env.FURA_SMOKE_TOKEN ?? "dev";
declare global {
  interface Window {
    insightSmokeSockets: WebSocket[];
    insightSmokeRequests: Array<{ type: string }>;
  }
}

async function start(page: Page, mobile = false) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.insightSmokeSockets = [];
    window.insightSmokeRequests = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        window.insightSmokeSockets.push(this);
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === "string") window.insightSmokeRequests.push(JSON.parse(data));
        super.send(data);
      }
    };
  });
  page.on("pageerror", error => { throw error; });
  await page.goto(mobile ? "/mobile.html" : "/");
  await page.locator(mobile ? "#mobileAuthToken" : "#authTokenInput").fill(token);
  await page.locator(mobile ? "#mobileAuthSubmit" : "#authSubmit").click();
  await expect(page.locator(mobile ? "#mobileConnectionStatus" : "#connectionStatus")).toHaveText("connected");
  await page.locator(mobile ? "#mobileCreateToggle" : "#createSessionButton").click();
  await page.locator(mobile ? "#mobileCreateName" : "#cwdPickerNameInput").fill(`Insights ${mobile ? "mobile" : "desktop"} ${Date.now()}`);
  await page.locator(mobile ? "#mobileCreateCwd" : "#cwdPickerInput").fill("/tmp");
  await page.locator(mobile ? "#mobileCreateSubmit" : "#cwdPickerCreate").click();
  const prompt = page.locator(mobile ? "#mobilePromptInput" : "#promptInput");
  await expect(prompt).toBeEnabled();
  await prompt.fill("mock session insights");
  await page.locator(mobile ? "#mobileSendButton" : "#sendButton").click();
  await expect(page.locator(".message.assistant").filter({ hasText: "The background build and preview are running." })).toBeVisible();
  const activity = page.locator(".session-activity:visible");
  await expect(activity).toHaveAttribute("data-state", "current");
  await activity.locator(":scope > summary").click();
  await expect(activity.locator(".session-activity-active")).toContainText("Preview server");
  await expect(activity.locator(".session-activity-recent")).toContainText("Build frontend");
  return activity;
}

test("desktop activity survives popout, distinguishes a ready service from completion, and Summary only reads", async ({ page }, info) => {
  const activity = await start(page);
  const service = activity.locator('[data-kind="service"]');
  await service.locator("summary").click();
  await expect(service.locator(".session-activity-output")).toContainText("Preview listening on loopback");
  await expect(service.locator("img")).toHaveCount(0);
  await service.getByRole("button", { name: "Show tool", exact: true }).click();
  await expect(page.locator('.panel-content-tools [data-tool-call-id]').first()).toBeFocused();

  const transcriptTab = page.locator(".dv-tab:visible").filter({ hasText: /^Transcript$/ });
  await transcriptTab.click();
  const popupPromise = page.waitForEvent("popup");
  await page.locator(".dv-groupview:visible").filter({ has: transcriptTab })
    .getByRole("button", { name: "Pop out", exact: true }).click();
  const popup = await popupPromise;
  await expect(popup.locator(".session-activity-active")).toContainText("Preview server");
  await expect(popup.locator(".session-activity-output").filter({ hasText: "Preview listening on loopback" })).toBeVisible();
  await popup.screenshot({ path: info.outputPath("activity-popout.png") });
  await popup.getByRole("button", { name: "Return to main", exact: true }).click();
  await expect(page.locator(".session-activity-active")).toContainText("Preview server");

  await page.locator("#sessionSummaryButton").click();
  const summary = page.getByRole("dialog", { name: "Session summary" });
  await expect(summary).toContainText("Frontend build passed. The preview server is still running.");
  await page.screenshot({ path: info.outputPath("activity-summary.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator("#sessionSummaryButton")).toBeFocused();
  await page.locator("#sessionSummaryButton").click();
  await expect(summary).toBeVisible();
  expect(await page.evaluate(() => window.insightSmokeRequests.filter(request => request.type === "prompt.send").length)).toBe(1);
});

test("mobile retains stale activity on disconnect and restores authoritative state on reconnect", async ({ page, context }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const activity = await start(page, true);
  const service = activity.locator('[data-kind="service"]');
  await service.locator("summary").click();
  await expect(service.locator(".session-activity-output")).toContainText("Preview listening on loopback");
  await context.setOffline(true);
  await page.evaluate(() => window.insightSmokeSockets.forEach(socket => socket.close()));
  await expect(activity).toHaveAttribute("data-state", "stale");
  await expect(service.locator(".session-activity-output")).toContainText("Preview listening on loopback");
  await page.screenshot({ path: info.outputPath("mobile-stale.png") });
  await context.setOffline(false);
  await expect(page.locator("#mobileConnectionStatus")).toHaveText("connected");
  await expect(activity).toHaveAttribute("data-state", "current");
  await page.locator("#mobileSummary").click();
  await expect(page.getByRole("dialog", { name: "Session summary" })).toContainText("Frontend build passed.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("mobile-reconnected-summary.png") });
});
