import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionProjection, TranscriptEntry } from "../src/protocol";

// Real desktop DOM and Dockview windows; controlled projections, not provider evidence.
test("cached panels preserve interaction state across updates and document moves", async ({ page }, info) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "fura-panel-cache-"));
  let socket: WebSocketRoute | undefined;
  let state: SessionProjection | undefined;
  let controlled = false;
  let popout: Page | undefined;
  await page.routeWebSocket(/\/ws(?:\?|$)/, route => {
    socket = route;
    const server = route.connectToServer();
    server.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (!controlled && message.type === "session.snapshot") state = message.state;
      if (!controlled || !["session.snapshot", "session.delta", "sessions.snapshot"].includes(message.type)) route.send(raw);
    });
  });
  const publish = async () => {
    if (!socket || !state) throw new Error("isolated session snapshot missing");
    state.seq += 1;
    state.summary.title = `Cache update ${state.seq}`;
    socket.send(JSON.stringify({ type: "session.snapshot", sessionId: state.summary.sessionId, state }));
    await expect(page.locator("#sessionTitle")).toHaveText(state.summary.title);
  };
  try {
    await page.goto("/");
    await page.locator("#authTokenInput").fill(process.env.FURA_SMOKE_TOKEN ?? "dev");
    await page.locator("#authSubmit").click();
    await expect(page.locator("#connectionStatus")).toHaveText("connected");
    await page.locator("#createSessionButton").click();
    await page.locator("#cwdPickerNameInput").fill("Panel cache characterization");
    await page.locator("#cwdPickerInput").fill(cwd);
    await page.locator("#cwdPickerCreate").click();
    await expect(page.locator("#cwdPickerOverlay")).toBeHidden();
    await expect.poll(() => state?.summary.title).toBe("Panel cache characterization");
    controlled = true;
    if (!state) throw new Error("isolated session missing");
    const message = (id: string, text: string): TranscriptEntry => ({
      kind: "message", id, role: "assistant", isNew: false,
      blocks: [{ kind: "text", text }], renderHash: id,
    });
    state.transcript = [
      { ...message("cache-anchor", "Cache anchor selectable text"), blocks: [
        { kind: "text", text: "Cache anchor selectable text" },
        { kind: "thinking", thinking: "Cache thinking stays open" },
      ] } as TranscriptEntry,
      { kind: "tool", toolCallId: "cache-tool", toolName: "bash", args: { command: "echo cache" },
        isActive: false, isError: false, result: { text: "Stable tool result" }, renderHash: "stable-tool" },
      ...Array.from({ length: 35 }, (_, i) => message(`cache-filler-${i}`, `History paragraph ${i}\n\nA readable stable transcript sibling.`)),
      message("cache-tail", "Original streaming tail"),
    ];
    await publish();
    const transcript = page.locator(".panel-content-transcript .panel-scroll:visible");
    const anchor = transcript.locator('article[data-message-id="cache-anchor"]');
    const anchorNode = await anchor.elementHandle();
    await anchor.locator(".thinking-label").click();
    await anchor.locator(".thinking-label").focus();
    await anchor.locator(".text-block p").evaluate(element => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      const selection = element.ownerDocument.getSelection();
      selection?.removeAllRanges(); selection?.addRange(range);
    });
    await transcript.evaluate(element => { element.scrollTop = 320; });
    const focused = await page.locator(":focus").elementHandle();
    await publish(); // Metadata only: unchanged content must not discard interaction state.
    expect(await anchor.evaluate((element, previous) => element === previous, anchorNode)).toBe(true);
    expect(await page.evaluate(previous => document.activeElement === previous, focused)).toBe(true);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe("Cache anchor selectable text");
    await expect(anchor.locator("details")).toHaveAttribute("open", "");
    expect(await transcript.evaluate(element => element.scrollTop)).toBe(320);

    state.transcript[state.transcript.length - 1] = { ...message("cache-tail", "Updated streaming tail"), renderHash: "tail-updated" };
    await publish();
    await expect(transcript.locator('article[data-message-id="cache-tail"]')).toContainText("Updated streaming tail");
    expect(await anchor.evaluate((element, previous) => element === previous, anchorNode)).toBe(true);
    expect(await page.evaluate(previous => document.activeElement === previous, focused)).toBe(true);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe("Cache anchor selectable text");
    expect(await transcript.evaluate(element => element.scrollTop)).toBe(320);

    const reviewed = transcript.locator('article[data-message-id="cache-filler-0"]');
    await reviewed.locator(".message-review-toggle").click();
    await expect(reviewed.locator(".transcript-review-body")).toBeVisible();
    expect(await anchor.evaluate((element, previous) => element === previous, anchorNode)).toBe(true);
    await reviewed.getByRole("button", { name: "Cancel review", exact: true }).click();
    await expect(reviewed.locator(".transcript-review-body")).toHaveCount(0);
    await expect(anchor.locator("details")).toHaveAttribute("open", "");

    for (const [title, className] of [["Transcript", "transcript"], ["Tools", "tools"]]) {
      await page.locator(".dv-tab:visible").filter({ hasText: title }).click();
      const opened = page.waitForEvent("popup");
      await page.locator(".dv-groupview:visible").filter({ has: page.locator(".dv-tab:visible").filter({ hasText: title }) }).locator(".panel-popout-btn").click();
      popout = await opened;
      const panel = popout.locator(`.panel-content-${className} .panel-scroll`);
      const tool = panel.locator('.tool-card[data-tool-name="bash"]');
      await expect(tool).toContainText("Stable tool result");
      const toolNode = await tool.elementHandle();
      await tool.locator(".tool-result-summary").click();
      await tool.locator(".tool-result-summary").focus();
      await tool.locator(".tool-result-text").evaluate(element => {
        const range = element.ownerDocument.createRange();
        range.selectNodeContents(element);
        const selection = element.ownerDocument.getSelection();
        selection?.removeAllRanges(); selection?.addRange(range);
      });
      const toolFocus = await popout.locator(":focus").elementHandle();
      await publish();
      expect(await tool.evaluate((element, previous) => element === previous, toolNode)).toBe(true);
      expect(await popout.evaluate(previous => document.activeElement === previous, toolFocus)).toBe(true);
      await expect(tool.locator(".tool-result-details")).toHaveAttribute("open", "");
      expect(await popout.evaluate(() => getSelection()?.toString())).toBe("Stable tool result");
      expect(await panel.evaluate(element => [...element.querySelectorAll("*")].every(node => node.ownerDocument === document))).toBe(true);
      state.transcript[1] = { kind: "tool", toolCallId: "cache-tool", toolName: "bash", args: { command: "echo cache" },
        isActive: false, isError: false, result: { text: "Changed tool result" }, renderHash: `changed-tool-${title}` };
      await publish();
      await expect(tool).toContainText("Changed tool result");
      expect(await tool.evaluate(element => element.ownerDocument === document)).toBe(true);
      await popout.screenshot({ path: info.outputPath(`${className}-popout.png`) });
      await popout.close({ runBeforeUnload: true }); popout = undefined;
      await expect(page.locator(`.panel-content-${className} .tool-card[data-tool-name="bash"]`)).toContainText("Changed tool result");
      await publish();
      expect(await page.locator(`.panel-content-${className} .tool-card[data-tool-name="bash"]`).evaluate(element => element.ownerDocument === document)).toBe(true);
      state.transcript[1] = { ...state.transcript[1], result: { text: "Stable tool result" }, renderHash: `stable-tool-${title}` } as TranscriptEntry;
      await publish();
    }
    await page.screenshot({ path: info.outputPath("panels-returned.png") });
  } finally {
    await popout?.close({ runBeforeUnload: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
