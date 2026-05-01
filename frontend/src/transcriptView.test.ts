import { describe, expect, it, vi } from "vitest";
import { messageText, renderBlock, renderCodeBlock, renderMarkdown } from "./transcriptView";
import type { TranscriptMessage } from "./protocol";

describe("messageText", () => {
  it("preserves text and thinking blocks while omitting redacted thinking", () => {
    const message = {
      id: "m1",
      role: "assistant",
      isNew: false,
      blocks: [
        { kind: "text", text: "Answer" },
        { kind: "thinking", thinking: "private chain" },
        { kind: "redactedthinking" },
      ],
    } satisfies TranscriptMessage;

    expect(messageText(message)).toBe("Answer\n\n<thinking>\nprivate chain\n</thinking>");
  });
});

describe("renderMarkdown", () => {
  it("renders headings, emphasis, links, and task list inputs", () => {
    const node = renderMarkdown("# Title\n\nA **bold** [link](https://example.com)\n\n- [x] done");

    expect(node.querySelector("h1")?.textContent).toBe("Title");
    expect(node.querySelector("strong")?.textContent).toBe("bold");
    expect(node.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
    expect(node.querySelector("input[type='checkbox']")).not.toBeNull();
  });

  it("does not create javascript links", () => {
    const node = renderMarkdown("[bad](javascript:alert(1))");

    expect(node.querySelector("a")).toBeNull();
    expect(node.textContent).toContain("bad");
  });
});

describe("renderCodeBlock", () => {
  it("renders a copy button scoped to the code block", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.useFakeTimers();

    const node = renderCodeBlock("ts", "const answer = 42;");
    const button = node.querySelector<HTMLButtonElement>("button.code-copy");
    expect(button).not.toBeNull();

    button?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(button?.textContent).toBe("Copied");

    vi.runAllTimers();
    expect(button?.textContent).toBe("Copy");
    vi.useRealTimers();
  });
});

describe("renderBlock", () => {
  it("renders text blocks with stable selection data attributes", () => {
    const node = renderBlock(
      { kind: "text", text: "hello" },
      false,
      "m1",
      2,
      { thinkingVisibilityMode: "auto" },
    );

    expect(node.className).toBe("text-block");
    expect(node.dataset.messageId).toBe("m1");
    expect(node.dataset.blockIndex).toBe("2");
    expect(node.dataset.blockKind).toBe("text");
  });

  it("opens thinking blocks when visibility is shown or message is new", () => {
    const historical = renderBlock(
      { kind: "thinking", thinking: "hidden by default" },
      false,
      "m1",
      0,
      { thinkingVisibilityMode: "auto" },
    ) as HTMLDetailsElement;
    const forced = renderBlock(
      { kind: "thinking", thinking: "shown" },
      false,
      "m1",
      1,
      { thinkingVisibilityMode: "shown" },
    ) as HTMLDetailsElement;
    const live = renderBlock(
      { kind: "thinking", thinking: "live" },
      true,
      "m1",
      2,
      { thinkingVisibilityMode: "auto" },
    ) as HTMLDetailsElement;

    expect(historical.open).toBe(false);
    expect(forced.open).toBe(true);
    expect(live.open).toBe(true);
  });

  it("renders redacted thinking without provider data", () => {
    const node = renderBlock(
      { kind: "redactedthinking" },
      false,
      "m1",
      3,
      { thinkingVisibilityMode: "shown" },
    );

    expect(node.textContent).toBe("Thinking… (redacted by provider)");
    expect(node.dataset.blockKind).toBe("redactedthinking");
  });
});
