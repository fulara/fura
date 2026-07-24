import { describe, expect, it } from "vitest";
import {
  formatDuration,
  isCompactReadCard,
  renderCurrentTodoCard,
  renderReadToolCard,
  renderReadToolGroup,
  renderToolCard,
  toolResultText,
  toolResultImages,
  truncate,
} from "./toolCards";
import type { TodoPhase, ToolCard, TranscriptEntry } from "./protocol";

function tool(overrides: Partial<ToolCard> = {}): ToolCard {
  return {
    toolCallId: "tool-1",
    timestamp: Date.UTC(2026, 4, 1, 12, 34),
    toolName: "bash",
    intent: null,
    args: {},
    isActive: false,
    isError: false,
    renderHash: "tool-hash",
    ...overrides,
  };
}

describe("renderToolCard", () => {
  it("renders generic tool status, name, args summary, timestamp, and result", () => {
    const node = renderToolCard(tool({
      toolName: "bash",
      args: { command: "npm test" },
      result: { text: "ok" },
    }));

    expect(node.className).toContain("tool-card");
    expect(node.dataset.toolName).toBe("bash");
    expect(node.querySelector(".tool-status-icon")?.textContent).toBe("✓");
    expect(node.querySelector(".tool-name")?.textContent).toBe("bash");
    expect(node.querySelector(".tool-args-summary")?.textContent).toBe("npm test");
    expect(node.querySelector("time")?.dateTime).toBe("2026-05-01T12:34:00.000Z");
    expect(node.querySelector(".tool-result-text")?.textContent).toBe("ok");
  });

  it("renders file type icons for generic file tools", () => {
    const node = renderToolCard(tool({
      toolName: "write",
      args: { path: "/home/aleksander/repos/fura/frontend/src/main.ts" },
      result: { text: "wrote file" },
    }));

    expect(node.querySelector(".tool-args-summary")?.textContent).toBe("🟦 …/src/main.ts");
  });

  it("marks active and error tools", () => {
    const node = renderToolCard(tool({ isActive: true, isError: true }));

    expect(node.className).toContain("tool-active");
    expect(node.className).toContain("tool-error");
    expect(node.querySelector(".tool-status-icon")?.textContent).toBe("⠋");
  });

  it("routes the renamed `todo` tool and historical `todo_write` to the todo card", () => {
    for (const toolName of ["todo", "todo_write"]) {
      const node = renderToolCard(tool({
        toolName,
        result: { details: { phases: [{ name: "Phase", tasks: [{ content: "Do it", status: "completed" }] }] } },
      }));
      expect(node.className).toContain("todo-write-card");
    }
  });

  it("renders generate_image details images", () => {
    const node = renderToolCard(tool({
      toolName: "generate_image",
      args: { subject: "a chart" },
      result: {
        content: [{ type: "text", text: "Generated 1 image" }],
        details: {
          images: [{ data: "abc", mimeType: "image/webp", alt: "Generated chart" }],
        },
      },
    }));

    expect(node.dataset.toolName).toBe("generate_image");
    expect(node.querySelector(".tool-args-summary")?.textContent).toBe("a chart");
    expect(node.querySelector(".tool-result-text")?.textContent).toBe("Generated 1 image");
    expect(node.querySelector(".tool-image-grid img")?.getAttribute("src")).toBe("data:image/webp;base64,abc");
    expect(node.querySelector(".tool-image-grid img")?.getAttribute("alt")).toBe("Generated chart");
  });
});

describe("read tool cards", () => {
  it("renders compact successful read cards without result body", () => {
    const node = renderReadToolCard(tool({
      toolName: "read",
      args: { path: "/home/aleksander/repos/fura/src/main.rs", sel: "10-20" },
      result: { text: "file content" },
    }));

    expect(node.className).toContain("tool-compact");
    expect(node.querySelector(".tool-name")?.textContent).toBe("Read");
    expect(node.querySelector(".tool-args-summary")?.textContent).toBe("🦀 …/src/main.rs:10-20");
    expect(node.querySelector(".tool-result-body")).toBeNull();
  });

  it("renders read errors with result body", () => {
    const node = renderReadToolCard(tool({
      toolName: "read",
      isError: true,
      args: { path: "missing.txt" },
      result: { text: "not found" },
    }));

    expect(node.className).toContain("tool-error");
    expect(node.className).not.toContain("tool-compact");
    expect(node.querySelector(".tool-result-text")?.textContent).toBe("not found");
  });

  it("renders successful read image results instead of compacting them away", () => {
    const imageRead = { kind: "tool", ...tool({
      toolName: "read",
      args: { path: "/tmp/omp-image.png" },
      result: { content: [{ type: "image", data: "abc", mimeType: "image/png" }] },
    }) } satisfies TranscriptEntry;
    const node = renderReadToolCard(imageRead);

    expect(isCompactReadCard(imageRead)).toBe(false);
    expect(node.className).not.toContain("tool-compact");
    expect(node.querySelector(".tool-result-body")).toBeNull();
    expect(node.querySelector(".tool-image-grid img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
  });

  it("renders read groups and detects compact read cards", () => {
    const first = { kind: "tool", ...tool({ toolName: "read", toolCallId: "read-1", args: { path: "a.ts" } }) } satisfies TranscriptEntry;
    const second = { kind: "tool", ...tool({ toolName: "read", toolCallId: "read-2", args: { path: "b.ts" } }) } satisfies TranscriptEntry;
    const error = { kind: "tool", ...tool({ toolName: "read", toolCallId: "read-3", isError: true }) } satisfies TranscriptEntry;

    expect(isCompactReadCard(first)).toBe(true);
    expect(isCompactReadCard(error)).toBe(false);

    const node = renderReadToolGroup([first, second]);
    expect(node.querySelector(".tool-count")?.textContent).toBe("(2)");
    expect(Array.from(node.querySelectorAll(".read-tool-path")).map(el => el.textContent)).toEqual(["🟦 a.ts", "🟦 b.ts"]);
  });
});

describe("todo cards", () => {
  it("renders current todos with remaining and total counts", () => {
    const phases: TodoPhase[] = [{
      name: "Implementation",
      tasks: [
        { content: "Write tests", status: "completed" },
        { content: "Extract cards", status: "in_progress", notes: ["moving safely"] },
        { content: "Run checks", status: "pending" },
        { content: "Wait on upstream", status: "blocked", blocker: "protocol v2" },
      ],
    }];

    const node = renderCurrentTodoCard(phases);

    expect(node.querySelector(".tool-name")?.textContent).toBe("Todos");
    expect(node.querySelector(".tool-args-summary")?.textContent).toBe("3 remaining · 4 total");
    expect(node.textContent).toContain("Write tests");
    expect(node.textContent).toContain("moving safely");
    expect(node.textContent).toContain("blocked: protocol v2");
    expect(node.querySelector(".todo-blocked .todo-icon")?.textContent).toBe("!");
  });
});

describe("grep cards", () => {
  it("summarizes no matches", () => {
    const node = renderToolCard(tool({
      toolName: "grep",
      args: { pattern: "needle", path: "/repo" },
      result: { text: "No matches found", details: { matchCount: 0, fileCount: 0, scopePath: "/repo" } },
    }));

    expect(node.querySelector(".grep-pattern")?.textContent).toBe("needle");
    expect(node.querySelector(".tool-args-summary")?.textContent).toContain("0 matches");
    expect(node.querySelector(".grep-tool-summary")?.textContent).toBe("No matches found");
  });

  it("summarizes upstream grep paths and case sensitivity args", () => {
    const node = renderToolCard(tool({
      toolName: "grep",
      args: { pattern: "needle", paths: ["src"], case: false },
      result: { text: "src/main.ts:1:needle", details: { matchCount: 1, fileCount: 1 } },
    }));

    const summary = node.querySelector(".tool-args-summary")?.textContent ?? "";
    expect(summary).toContain("1 match");
    expect(summary).toContain("1 file");
    expect(summary).toContain("in src");
    expect(summary).toContain("case:insensitive");
  });
});

describe("edit tool cards", () => {
  const diff = [
    "--- a/src/main.rs",
    "+++ b/src/main.rs",
    "@@ -1,2 +1,2 @@",
    "-let x = 1;",
    "+let x = 2;",
    " let y = 3;",
  ].join("\n");

  it("renders an inline diff preview with add/del line classes and stats", () => {
    const node = renderToolCard(tool({
      toolName: "edit",
      args: { path: "/repo/src/main.rs" },
      result: { text: "edited", details: { diff, path: "/repo/src/main.rs" } },
    }));

    expect(node.className).toContain("edit-tool-card");
    expect(node.querySelector(".tool-name")?.textContent).toBe("Edit");
    expect(node.querySelector(".edit-diff-stats")?.textContent).toBe("+1 -1");
    expect(node.querySelector(".diff-line-add")?.textContent).toBe("+let x = 2;");
    expect(node.querySelector(".diff-line-del")?.textContent).toBe("-let x = 1;");
    expect(node.querySelector(".diff-line-hunk")?.textContent).toBe("@@ -1,2 +1,2 @@");
  });

  it("hides the diff preview when showEditDiffs is false", () => {
    const node = renderToolCard(tool({
      toolName: "edit",
      args: { path: "/repo/src/main.rs" },
      result: { text: "edited", details: { diff } },
    }), { showEditDiffs: false });

    expect(node.querySelector(".edit-diff-preview")).toBeNull();
    expect(node.className).toContain("tool-compact");
  });

  it("summarizes multi-file edits and renders errors with the result body", () => {
    const multi = renderToolCard(tool({
      toolName: "edit",
      result: { details: { diff, perFileResults: [{ path: "a.rs", diff }, { path: "b.rs", diff }] } },
    }));
    expect(multi.querySelector(".tool-args-summary")?.textContent).toBe("2 files");

    const error = renderToolCard(tool({
      toolName: "edit",
      isError: true,
      args: { path: "a.rs" },
      result: { text: "hashline mismatch" },
    }));
    expect(error.querySelector(".edit-diff-preview")).toBeNull();
    expect(error.querySelector(".tool-result-text")?.textContent).toBe("hashline mismatch");
    expect(error.querySelector<HTMLDetailsElement>(".tool-result-details")?.open).toBe(true);
  });

  it("caps very long diffs with a more-lines marker", () => {
    const longDiff = ["@@ -1 +1 @@", ...Array.from({ length: 200 }, (_, i) => `+line ${i}`)].join("\n");
    const node = renderToolCard(tool({
      toolName: "edit",
      args: { path: "big.rs" },
      result: { details: { diff: longDiff } },
    }));

    expect(node.querySelectorAll(".diff-line").length).toBe(120);
    expect(node.querySelector(".edit-diff-more")?.textContent).toContain("81 lines more");
  });
});

describe("collapsed tool result bodies", () => {
  it("collapses generic tool output behind a line-count summary", () => {
    const node = renderToolCard(tool({
      toolName: "bash",
      args: { command: "ls" },
      result: { text: "a\nb\nc" },
    }));

    const details = node.querySelector<HTMLDetailsElement>(".tool-result-details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector(".tool-result-summary")?.textContent).toBe("└─ 3 lines");
    expect(details?.querySelector(".tool-result-text")?.textContent).toBe("a\nb\nc");
  });

  it("expands output for active and errored tools", () => {
    const active = renderToolCard(tool({ isActive: true, result: { text: "running" } }));
    expect(active.querySelector<HTMLDetailsElement>(".tool-result-details")?.open).toBe(true);

    const error = renderToolCard(tool({ isError: true, result: { text: "boom" } }));
    expect(error.querySelector<HTMLDetailsElement>(".tool-result-details")?.open).toBe(true);
  });

  it("offers a copy button for tool output", () => {
    const node = renderToolCard(tool({ result: { text: "payload" } }));
    expect(node.querySelector(".tool-copy")?.textContent).toBe("Copy");
  });
});

describe("tool helpers", () => {
  it("extracts text from structured tool result content", () => {
    expect(toolResultText({ content: [{ text: "a" }, { text: "b" }, { other: true }] })).toBe("a\nb");
    expect(toolResultText({ text: "direct" })).toBe("direct");
    expect(toolResultText(null)).toBe("");
  });

  it("extracts image blocks from content and details", () => {
    expect(toolResultImages({
      content: [{ type: "image", data: "content-image", mimeType: "image/png", alt: "Content" }],
      details: {
        images: [
          { data: "detail-image", mimeType: "image/webp", alt: "Detail" },
          { data: "missing-mime" },
        ],
      },
    })).toEqual([
      { data: "content-image", mimeType: "image/png", alt: "Content" },
      { data: "detail-image", mimeType: "image/webp", alt: "Detail" },
    ]);
  });

  it("truncates long strings", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });

  it("formats durations", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(1_250)).toBe("1.3s");
    expect(formatDuration(65_000)).toBe("1m5s");
    expect(formatDuration(3_600_000)).toBe("1h");
  });
});
