import { expect, test, type WebSocketRoute } from "@playwright/test";
import type { SessionProjection, TranscriptEntry } from "../src/protocol";

// Real app layout with controlled projections: jsdom cannot detect grid overflow.
for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"} keeps wide transcript content inside its panel`, async ({ page }, info) => {
    await page.setViewportSize({ width: mobile ? 390 : 1440, height: 960 });
    let socket: WebSocketRoute | undefined;
    let state: SessionProjection | undefined;
    let controlled = false;
    await page.routeWebSocket(/\/ws(?:\?|$)/, route => {
      socket = route;
      const server = route.connectToServer();
      server.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (!controlled && message.type === "session.snapshot") state = message.state;
        if (!controlled || !["session.snapshot", "session.delta", "sessions.snapshot"].includes(message.type)) route.send(raw);
      });
    });
    await page.goto(mobile ? "/mobile.html" : "/index.html");
    await page.locator(mobile ? "#mobileAuthToken" : "#authTokenInput").fill(process.env.FURA_SMOKE_TOKEN ?? "dev");
    await page.locator(mobile ? "#mobileAuthSubmit" : "#authSubmit").click();
    await expect(page.locator(mobile ? "#mobileConnectionStatus" : "#connectionStatus")).toHaveText("connected");
    await page.locator(mobile ? "#mobileCreateToggle" : "#createSessionButton").click();
    await page.locator(mobile ? "#mobileCreateName" : "#cwdPickerNameInput").fill("Transcript width regression");
    await page.locator(mobile ? "#mobileCreateCwd" : "#cwdPickerInput").fill("/tmp");
    await page.locator(mobile ? "#mobileCreateSubmit" : "#cwdPickerCreate").click();
    await expect.poll(() => state?.summary.title).toBe("Transcript width regression");
    if (!state || !socket) throw new Error("Missing fixture session");
    controlled = true;
    const panel = page.locator(mobile ? "#mobileTranscript" : ".panel-content-transcript .btw-conversation");
    const task = "Review source contracts and boundary conditions. ".repeat(100);
    const code = `const value = "${"long-code-value".repeat(100)}";`;
    const prose: TranscriptEntry = {
      kind: "message", id: "width-prose", role: "assistant", isNew: false,
      blocks: [{ kind: "text", text: "This paragraph and its copy/review controls must stay inside the conversation." }],
    };
    const tool: TranscriptEntry = {
      kind: "tool", toolCallId: "width-task", toolName: "task", args: {}, isActive: true, isError: false,
      partialResult: { details: { progress: [{ id: "CoreReview", agent: "reviewer", task, status: "running" }] } },
    };
    // Separate cases: the task's nested grid and rich message content must each fit.
    for (const entry of [tool, {
      kind: "message", id: "width-code", role: "assistant", isNew: false,
      blocks: [{ kind: "text", text: `\`\`\`typescript\n${code}\n\`\`\`\n\nhttps://example.com/${"long-path".repeat(100)}` }],
    } satisfies TranscriptEntry]) {
      state.seq += 1;
      state.transcript = [prose, entry];
      socket.send(JSON.stringify({ type: "session.snapshot", sessionId: state.summary.sessionId, state }));
      await expect(panel.locator(entry.kind === "tool" ? ".task-agent-desc" : ".code-block")).toBeVisible();
      await expect.poll(() => panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      const bounds = await panel.evaluate(element => {
        const parent = element.getBoundingClientRect();
        return [...element.children].every(child => {
          const rect = child.getBoundingClientRect();
          return rect.left >= parent.left && rect.right <= parent.right;
        });
      });
      expect(bounds).toBe(true);
      if (entry.kind === "tool") {
        await expect(panel.locator(".task-agent-desc")).toHaveText(task.trim());
        expect(await panel.locator(".task-agent-desc").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      } else {
        await expect(panel.locator(".code-block code")).toHaveText(code);
      }
      await page.screenshot({ path: info.outputPath(`${mobile ? "mobile" : "desktop"}-${entry.kind}.png`) });
    }
  });
}
