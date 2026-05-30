import { afterEach, describe, expect, it, vi } from "vitest";
import hljs from "highlight.js/lib/common";
import { messageText, renderBlock, renderCodeBlock, renderMarkdown, renderMessage, updateRenderedMessage } from "./transcriptView";
import type { TranscriptMessage } from "./protocol";

describe("messageText", () => {
  it("preserves text, image placeholders, and thinking while omitting redacted thinking", () => {
    const message = {
      id: "m1",
      role: "assistant",
      isNew: false,
      renderHash: "test-transcriptView.test-10",
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
      renderHash: "test-transcriptView.test-28",
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
      renderHash: "test-transcriptView.test-44",
      blocks: [{ kind: "thinking", thinking: "not shown" }],
    }, { thinkingVisibilityMode: "hidden" });

    expect(node.hidden).toBe(true);
  });

  it("keeps image-only messages visible when thinking is hidden", () => {
    const node = renderMessage({
      id: "m-image",
      role: "assistant",
      isNew: false,
      renderHash: "test-transcriptView.test-55",
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
      renderHash: "test-transcriptView.test-68",
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
      renderHash: "test-transcriptView.test-88",
      blocks: [{ kind: "text", text: "Copy me" }],
    }, { thinkingVisibilityMode: "auto" });

    const button = node.querySelector<HTMLButtonElement>("header button");
    button?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("Copy me");
    expect(button?.textContent).toBe("Copied");
    vi.runAllTimers();
    expect(button?.textContent).toBe("Copy");
    vi.useRealTimers();
  });

  it("updates message body without replacing copy controls", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const node = renderMessage({
      id: "m-streaming",
      role: "assistant",
      isNew: true,
      renderHash: "test-transcriptView.test-109",
      blocks: [{ kind: "text", text: "First chunk" }],
    }, { thinkingVisibilityMode: "auto" });
    const button = node.querySelector<HTMLButtonElement>("header button");
    if (!button) throw new Error("copy button missing");
    const initialBlock = node.querySelector<HTMLElement>(".text-block");
    if (!initialBlock) throw new Error("text block missing");

    updateRenderedMessage(node, {
      id: "m-streaming",
      role: "assistant",
      isNew: true,
      renderHash: "test-transcriptView.test-109",
      blocks: [{ kind: "text", text: "First chunk" }],
    }, { thinkingVisibilityMode: "auto" });
    expect(node.querySelector<HTMLElement>(".text-block")).toBe(initialBlock);


    updateRenderedMessage(node, {
      id: "m-streaming",
      role: "assistant",
      isNew: true,
      renderHash: "test-transcriptView.test-129",
      blocks: [{ kind: "text", text: "First chunk plus more" }],
    }, { thinkingVisibilityMode: "auto" });

    expect(node.querySelector<HTMLButtonElement>("header button")).toBe(button);
    expect(node.textContent).toContain("First chunk plus more");
    button.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("First chunk plus more");
  });

  it("uses structural message signatures when renderHash is absent", () => {
    const node = renderMessage({
      id: "m-legacy",
      role: "assistant",
      isNew: false,
      blocks: [{ kind: "text", text: "Old body" }],
    }, { thinkingVisibilityMode: "auto" });
    const button = node.querySelector<HTMLButtonElement>("header button");

    updateRenderedMessage(node, {
      id: "m-legacy",
      role: "assistant",
      isNew: false,
      blocks: [{ kind: "text", text: "New body" }],
    }, { thinkingVisibilityMode: "auto" });

    expect(node.querySelector<HTMLButtonElement>("header button")).toBe(button);
    expect(node.textContent).toContain("New body");
    expect(node.textContent).not.toContain("Old body");
  });

  it("renders live text as markdown while streaming", () => {
    const live = renderMessage({
      id: "m-live-markdown",
      role: "assistant",
      isNew: true,
      renderHash: "test-transcriptView.test-144",
      blocks: [{ kind: "text", text: "```ts\nconst value = 1;\n```" }],
    }, { thinkingVisibilityMode: "auto" });

    expect(live.querySelector(".streaming-text-content")).toBeNull();
    expect(live.querySelector(".code-block")).toBeTruthy();
  });

  it("renders an unclosed streaming code fence as a code block", () => {
    const live = renderMessage({
      id: "m-live-open-fence",
      role: "assistant",
      isNew: true,
      renderHash: "test-transcriptView.test-156",
      blocks: [{ kind: "text", text: "```ts\nconst value = 1;" }],
    }, { thinkingVisibilityMode: "auto" });

    expect(live.querySelector(".streaming-text-content")).toBeNull();
    expect(live.querySelector(".code-block")).toBeTruthy();
    expect(live.querySelector(".code-lang")?.textContent).toBe("ts");
    expect(live.querySelector("code")?.textContent).toContain("const value = 1;");
  });

  it("styles optimistic pending prompts distinctly", () => {
    const pending = renderMessage({
      id: "__pending_prompt:1",
      role: "user",
      isNew: true,
      renderHash: "test-transcriptView.test-170",
      blocks: [{ kind: "text", text: "pending prompt" }],
    }, { thinkingVisibilityMode: "auto" });
    expect(pending.classList.contains("message-pending-prompt")).toBe(true);
    expect(pending.querySelector(".message-pending-badge")?.textContent).toBe("sending");

    updateRenderedMessage(pending, {
      id: "user-1",
      role: "user",
      isNew: true,
      renderHash: "test-transcriptView.test-179",
      blocks: [{ kind: "text", text: "pending prompt" }],
    }, { thinkingVisibilityMode: "auto" });
    expect(pending.classList.contains("message-pending-prompt")).toBe(false);
    expect(pending.querySelector(".message-pending-badge")).toBeNull();
  });

  it("renders command notices without pending sending state", () => {
    const notice = renderMessage({
      id: "__command_notice:1",
      role: "system",
      isNew: true,
      blocks: [{ kind: "text", text: "Command requested: /review" }],
    }, { thinkingVisibilityMode: "auto" });

    expect(notice.classList.contains("message-command-notice")).toBe(true);
    expect(notice.classList.contains("message-pending-prompt")).toBe(false);
    expect(notice.querySelector(".message-heading strong")?.textContent).toBe("Command");
    expect(notice.querySelector(".message-pending-badge")).toBeNull();
    expect(notice.textContent).toContain("Command requested: /review");
  });


  it("renders transcript review mode with line comments and actions", () => {
    const onStart = vi.fn();
    const onAddComment = vi.fn();
    const onCancel = vi.fn();
    const onFlush = vi.fn();
    const onEditComment = vi.fn();
    const onDeleteComment = vi.fn();
    const message: TranscriptMessage = {
      id: "m-review",
      role: "assistant",
      isNew: false,
      renderHash: "test-transcriptView.test-196",
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
        onEditComment,
        onDeleteComment,
        onCancel,
        onFlush,
      },
    });

    expect(node.className).toContain("message-reviewing");
    expect(node.querySelector(".text-block")).toBeNull();
    expect(node.querySelector(".transcript-review-view-toggle")).toBeNull();
    expect(Array.from(node.querySelectorAll(".transcript-review-gutter")).map(el => el.textContent)).toEqual(["1", "2"]);
    expect(node.querySelector(".transcript-review-inline-comment")?.textContent).toContain("Explain this.");

    node.querySelector<HTMLButtonElement>(".transcript-review-comment-btn")?.click();
    expect(onAddComment).toHaveBeenCalledWith(message, { lineNumber: 1, text: "line one" });
    node.querySelector<HTMLButtonElement>(".review-comment-actions button:first-child")?.click();
    expect(onEditComment).toHaveBeenCalledWith(message, expect.objectContaining({ id: "c1" }));
    node.querySelector<HTMLButtonElement>(".review-comment-actions button:last-child")?.click();
    expect(onDeleteComment).toHaveBeenCalledWith(message, expect.objectContaining({ id: "c1" }));

    node.querySelectorAll<HTMLButtonElement>(".transcript-review-actions button")[0]?.click();
    expect(onCancel).toHaveBeenCalledWith(message);
    node.querySelectorAll<HTMLButtonElement>(".transcript-review-actions button")[1]?.click();
    expect(onFlush).toHaveBeenCalledWith(message);
  });

  it("renders Markdown review blocks with toggle and granular comment buttons", () => {
    const onAddComment = vi.fn();
    const message: TranscriptMessage = {
      id: "m-markdown-review",
      role: "assistant",
      isNew: false,
      renderHash: "test-transcriptView.test-245",
      blocks: [{ kind: "text", text: "# Heading\n\n- first\n- second" }],
    };

    const node = renderMessage(message, {
      thinkingVisibilityMode: "auto",
      review: {
        active: true,
        comments: [],
        onAddComment,
      },
    });

    expect(node.querySelector(".transcript-review-markdown-preview")?.textContent).toContain("Rendered Markdown review");
    expect(node.querySelector(".transcript-review-markdown-preview h1")?.textContent).toBe("Heading");
    expect(node.querySelector<HTMLDivElement>(".transcript-review-lines")?.hidden).toBe(true);
    expect(node.querySelectorAll(".transcript-review-markdown-block .transcript-review-comment-btn")).toHaveLength(3);

    node.querySelectorAll<HTMLButtonElement>(".transcript-review-markdown-block .transcript-review-comment-btn")[1]?.click();
    expect(onAddComment).toHaveBeenCalledWith(message, { lineNumber: 3, text: "- first" });

    node.querySelector<HTMLButtonElement>('.transcript-review-view-toggle button[data-review-view="source"]')?.click();
    expect(node.querySelector<HTMLDivElement>(".transcript-review-lines")?.hidden).toBe(false);
    expect(node.querySelector<HTMLElement>('.transcript-review-markdown-preview')?.hidden).toBe(true);
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

  it("renders a /review <diff> block as one diff code block instead of shredded markdown", () => {
    const review = [
      "## Code Review Request",
      "",
      "### Diff",
      "",
      "<diff>",
      "diff --git a/.gitignore b/.gitignore",
      "@@ -9,6 +9,7 @@",
      " /bridge-debug*.jsonl",
      "+rotated-logs/",
      "",
      " /.cert",
      "-const old = <b>raw</b>;",
      "</diff>",
      "",
      "### Additional Instructions",
      "",
      "Be thorough.",
    ].join("\n");

    const node = renderMarkdown(review);

    const codeBlocks = node.querySelectorAll(".code-block");
    expect(codeBlocks.length).toBe(1);
    const code = codeBlocks[0].querySelector("code");
    expect(code?.textContent).toContain("diff --git a/.gitignore b/.gitignore");
    expect(code?.textContent).toContain("+rotated-logs/");
    // The blank context line must stay inside the single diff block, not split it.
    expect(code?.textContent).toContain(" /.cert");
    // Raw HTML inside the diff is escaped by the highlighter, never injected.
    expect(code?.querySelector("b")).toBeNull();
    expect(code?.textContent).toContain("<b>raw</b>");

    // Surrounding Markdown still renders, and the diff is not shredded into
    // stray list items or leaked `<diff>` literals.
    expect(node.querySelector("h2")?.textContent).toBe("Code Review Request");
    expect([...node.querySelectorAll("h3")].map(h => h.textContent)).toEqual(["Diff", "Additional Instructions"]);
    expect(node.querySelector("ul, ol")).toBeNull();
    expect(node.textContent).not.toContain("<diff>");
    expect(node.textContent).not.toContain("</diff>");
  });

  it("does not hijack a literal <diff> tag inside a fenced code block", () => {
    const text = [
      "Explaining the review format:",
      "",
      "```md",
      "<diff>",
      "-old",
      "+new",
      "",
      "context",
      "</diff>",
      "```",
      "",
      "Done.",
    ].join("\n");

    const node = renderMarkdown(text);

    // Exactly one code block: the fence itself, rendered verbatim with its tags.
    const codeBlocks = node.querySelectorAll(".code-block");
    expect(codeBlocks.length).toBe(1);
    expect(codeBlocks[0].querySelector(".code-lang")?.textContent).toBe("md");
    const code = codeBlocks[0].querySelector("code");
    expect(code?.textContent).toContain("<diff>");
    expect(code?.textContent).toContain("</diff>");
    // Surrounding prose is intact; the fence was not split apart.
    expect(node.textContent).toContain("Explaining the review format:");
    expect(node.textContent).toContain("Done.");
  });

  it("keeps a diff intact when its body contains fence-like context lines", () => {
    // Reviewing a Markdown/TS file means the unified diff carries lines like a
    // space-indented ``` (a context line). The Markdown lexer would treat that as
    // a code fence and split the diff; extraction from raw text must not.
    const review = [
      "### Diff",
      "",
      "<diff>",
      "diff --git a/README.md b/README.md",
      "@@ -1,5 +1,5 @@",
      " # Title",
      " ",
      " ```ts",
      "-const a = 1;",
      "+const a = 2;",
      " ```",
      " done",
      "</diff>",
      "",
      "### Notes",
    ].join("\n");

    const node = renderMarkdown(review);

    const codeBlocks = node.querySelectorAll(".code-block");
    expect(codeBlocks.length).toBe(1);
    expect(codeBlocks[0].querySelector(".code-lang")?.textContent).toBe("diff");
    const code = codeBlocks[0].querySelector("code");
    // Whole diff stayed in one block, including the fence-like context lines.
    expect(code?.textContent).toContain("diff --git a/README.md b/README.md");
    expect(code?.textContent).toContain("```ts");
    expect(code?.textContent).toContain("-const a = 1;");
    expect(code?.textContent).toContain("+const a = 2;");
    expect(code?.textContent).toContain(" done");
    // Headings on both sides render; nothing leaked or shredded.
    expect([...node.querySelectorAll("h3")].map(h => h.textContent)).toEqual(["Diff", "Notes"]);
    expect(node.textContent).not.toContain("<diff>");
    expect(node.textContent).not.toContain("</diff>");
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
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(button?.textContent).toBe("Copied");

    vi.runAllTimers();
    expect(button?.textContent).toBe("Copy");
    vi.useRealTimers();
  });
});

describe("transcript code highlighting performance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-highlights identical code at most once (memoized across renders)", () => {
    const highlightSpy = vi.spyOn(hljs, "highlight");
    // Unique content so other tests' cache entries cannot satisfy this one.
    const code = "const memoizationProbe = 4242;";

    renderCodeBlock("ts", code);
    renderCodeBlock("ts", code);
    renderCodeBlock("ts", code);

    expect(highlightSpy).toHaveBeenCalledTimes(1);
  });

  it("renders the still-streaming trailing code fence as plain text", () => {
    const highlightSpy = vi.spyOn(hljs, "highlight");
    const highlightAutoSpy = vi.spyOn(hljs, "highlightAuto");

    const node = renderMarkdown("intro\n\n```ts\nconst streamingProbe = 1;\nconst half =");
    const codeEl = node.querySelector<HTMLElement>("pre code");

    expect(codeEl?.textContent).toContain("const half =");
    // Plain render: no highlight.js tokens (no <span>) and no highlighter invoked.
    expect(codeEl?.querySelector("span")).toBeNull();
    expect(highlightSpy).not.toHaveBeenCalled();
    expect(highlightAutoSpy).not.toHaveBeenCalled();
  });

  it("highlights a closed code fence", () => {
    const node = renderMarkdown("```ts\nconst closedProbe = 7;\n```");
    const codeEl = node.querySelector<HTMLElement>("pre code");

    expect(codeEl?.textContent).toContain("const closedProbe = 7;");
    // Highlighted: highlight.js wraps keywords in spans.
    expect(codeEl?.querySelector("span")).not.toBeNull();
  });

  it("treats a longer-opened fence as still streaming when only a shorter fence has arrived", () => {
    const highlightSpy = vi.spyOn(hljs, "highlight");
    const highlightAutoSpy = vi.spyOn(hljs, "highlightAuto");

    // Opened with four backticks; a three-backtick line is code content, not a close.
    const node = renderMarkdown("````ts\nconst quadProbe = 1;\n```");
    const codeEl = node.querySelector<HTMLElement>("pre code");

    expect(codeEl?.textContent).toContain("const quadProbe = 1;");
    expect(codeEl?.querySelector("span")).toBeNull();
    expect(highlightSpy).not.toHaveBeenCalled();
    expect(highlightAutoSpy).not.toHaveBeenCalled();
  });

  it("highlights a closed tilde fence", () => {
    const node = renderMarkdown("~~~ts\nconst tildeProbe = 9;\n~~~");
    const codeEl = node.querySelector<HTMLElement>("pre code");

    expect(codeEl?.textContent).toContain("const tildeProbe = 9;");
    expect(codeEl?.querySelector("span")).not.toBeNull();
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
