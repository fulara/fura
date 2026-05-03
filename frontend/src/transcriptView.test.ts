import { describe, expect, it, vi } from "vitest";
import { messageText, renderBlock, renderCodeBlock, renderMarkdown, renderMessage } from "./transcriptView";
import type { TranscriptMessage } from "./protocol";

describe("messageText", () => {
  it("preserves text, image placeholders, and thinking while omitting redacted thinking", () => {
    const message = {
      id: "m1",
      role: "assistant",
      isNew: false,
      blocks: [
        { kind: "text", text: "Answer" },
        { kind: "image", data: "abc", mimeType: "image/png", alt: "Chart" },
        { kind: "thinking", thinking: "private chain" },
        { kind: "redactedthinking" },
      ],
    } satisfies TranscriptMessage;

    expect(messageText(message)).toBe("Answer\n\n[Image: image/png]\n\n<thinking>\nprivate chain\n</thinking>");
  });
});

describe("renderMessage", () => {
  it("renders header, visible text blocks, and stable message id", () => {
    const node = renderMessage({
      id: "m1",
      role: "user",
      isNew: false,
      timestamp: Date.UTC(2026, 4, 1, 12, 34),
      blocks: [{ kind: "text", text: "Hello" }],
    }, { thinkingVisibilityMode: "auto" });

    expect(node.className).toBe("message user");
    expect(node.dataset.messageId).toBe("m1");
    expect(node.querySelector("strong")?.textContent).toBe("You");
    expect(node.querySelector("time")?.dateTime).toBe("2026-05-01T12:34:00.000Z");
    expect(node.querySelector(".text-block")?.textContent).toContain("Hello");
  });

  it("hides messages whose only block is hidden thinking", () => {
    const node = renderMessage({
      id: "m2",
      role: "assistant",
      isNew: false,
      blocks: [{ kind: "thinking", thinking: "not shown" }],
    }, { thinkingVisibilityMode: "hidden" });

    expect(node.hidden).toBe(true);
  });

  it("keeps image-only messages visible when thinking is hidden", () => {
    const node = renderMessage({
      id: "m-image",
      role: "assistant",
      isNew: false,
      blocks: [{ kind: "image", data: "abc", mimeType: "image/png", alt: "Generated chart" }],
    }, { thinkingVisibilityMode: "hidden" });

    expect(node.hidden).toBe(false);
    expect(node.querySelector(".image-block img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(node.querySelector(".image-block img")?.getAttribute("alt")).toBe("Generated chart");
  });

  it("renders user image attachments after transcript roundtrip", () => {
    const node = renderMessage({
      id: "m-user-image",
      role: "user",
      isNew: false,
      blocks: [
        { kind: "text", text: "See attached" },
        { kind: "image", data: "abc123", mimeType: "image/jpeg" },
      ],
    }, { thinkingVisibilityMode: "auto" });

    expect(node.querySelector("strong")?.textContent).toBe("You");
    expect(node.querySelector(".text-block")?.textContent).toContain("See attached");
    expect(node.querySelector(".image-block img")?.getAttribute("src")).toBe("data:image/jpeg;base64,abc123");
    expect(node.querySelector(".image-block img")?.getAttribute("alt")).toBe("[Image: image/jpeg]");
  });

  it("copies complete message text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.useFakeTimers();
    const node = renderMessage({
      id: "m3",
      role: "assistant",
      isNew: false,
      blocks: [{ kind: "text", text: "Copy me" }],
    }, { thinkingVisibilityMode: "auto" });

    const button = node.querySelector<HTMLButtonElement>("header button");
    button?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("Copy me");
    expect(button?.textContent).toBe("Copied");
    vi.runAllTimers();
    expect(button?.textContent).toBe("Copy");
    vi.useRealTimers();
  });

  it("renders transcript review mode with line comments and actions", () => {
    const onStart = vi.fn();
    const onAddComment = vi.fn();
    const onCancel = vi.fn();
    const onFlush = vi.fn();
    const message: TranscriptMessage = {
      id: "m-review",
      role: "assistant",
      isNew: false,
      blocks: [{ kind: "text", text: "line one\nline two" }],
    };

    const node = renderMessage(message, {
      thinkingVisibilityMode: "auto",
      review: {
        active: true,
        comments: [{
          id: "c1",
          messageId: "m-review",
          role: "assistant",
          lineNumber: 2,
          lineText: "line two",
          text: "Explain this.",
        }],
        onStart,
        onAddComment,
        onCancel,
        onFlush,
      },
    });

    expect(node.className).toContain("message-reviewing");
    expect(node.querySelector(".text-block")).toBeNull();
    expect(Array.from(node.querySelectorAll(".transcript-review-gutter")).map(el => el.textContent)).toEqual(["1", "2"]);
    expect(node.querySelector(".transcript-review-inline-comment")?.textContent).toBe("Explain this.");

    node.querySelector<HTMLButtonElement>(".transcript-review-comment-btn")?.click();
    expect(onAddComment).toHaveBeenCalledWith(message, { lineNumber: 1, text: "line one" });

    node.querySelectorAll<HTMLButtonElement>(".transcript-review-actions button")[0]?.click();
    expect(onCancel).toHaveBeenCalledWith(message);
    node.querySelectorAll<HTMLButtonElement>(".transcript-review-actions button")[1]?.click();
    expect(onFlush).toHaveBeenCalledWith(message);
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

  it("renders image blocks with stable selection data attributes", () => {
    const node = renderBlock(
      { kind: "image", data: "abc", mimeType: "image/webp", alt: "Preview" },
      false,
      "m1",
      4,
      { thinkingVisibilityMode: "auto" },
    );

    expect(node.className).toBe("image-block");
    expect(node.dataset.messageId).toBe("m1");
    expect(node.dataset.blockIndex).toBe("4");
    expect(node.dataset.blockKind).toBe("image");
    expect(node.querySelector("img")?.getAttribute("src")).toBe("data:image/webp;base64,abc");
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
