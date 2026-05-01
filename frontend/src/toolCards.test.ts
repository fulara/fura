import { describe, expect, it } from "vitest";
import {
  formatDuration,
  isCompactReadCard,
  renderCurrentTodoCard,
  renderReadToolCard,
  renderReadToolGroup,
  renderToolCard,
  toolResultText,
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

  it("marks active and error tools", () => {
    const node = renderToolCard(tool({ isActive: true, isError: true }));

    expect(node.className).toContain("tool-active");
    expect(node.className).toContain("tool-error");
    expect(node.querySelector(".tool-status-icon")?.textContent).toBe("⠋");
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
    expect(node.querySelector(".tool-args-summary")?.textContent).toBe("…/src/main.rs:10-20");
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

  it("renders read groups and detects compact read cards", () => {
    const first = { kind: "tool", ...tool({ toolName: "read", toolCallId: "read-1", args: { path: "a.ts" } }) } satisfies TranscriptEntry;
    const second = { kind: "tool", ...tool({ toolName: "read", toolCallId: "read-2", args: { path: "b.ts" } }) } satisfies TranscriptEntry;
    const error = { kind: "tool", ...tool({ toolName: "read", toolCallId: "read-3", isError: true }) } satisfies TranscriptEntry;

    expect(isCompactReadCard(first)).toBe(true);
    expect(isCompactReadCard(error)).toBe(false);

    const node = renderReadToolGroup([first, second]);
    expect(node.querySelector(".tool-count")?.textContent).toBe("(2)");
    expect(Array.from(node.querySelectorAll(".read-tool-path")).map(el => el.textContent)).toEqual(["a.ts", "b.ts"]);
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
      ],
    }];

    const node = renderCurrentTodoCard(phases);

    expect(node.querySelector(".tool-name")?.textContent).toBe("Todos");
    expect(node.querySelector(".tool-args-summary")?.textContent).toBe("2 remaining · 3 total");
    expect(node.textContent).toContain("Write tests");
    expect(node.textContent).toContain("moving safely");
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
    expect(node.querySelector(".tool-args-summary")?.textContent).toContain("0 matchs");
    expect(node.querySelector(".grep-tool-summary")?.textContent).toBe("No matches found");
  });
});

describe("tool helpers", () => {
  it("extracts text from structured tool result content", () => {
    expect(toolResultText({ content: [{ text: "a" }, { text: "b" }, { other: true }] })).toBe("a\nb");
    expect(toolResultText({ text: "direct" })).toBe("direct");
    expect(toolResultText(null)).toBe("");
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
