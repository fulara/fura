import { describe, expect, it, vi } from "vitest";
import {
  formatDuration,
  isCompactReadCard,
  renderCurrentTodoCard,
  renderReadToolCard,
  renderReadToolGroup,
  renderToolCard,
  shouldRenderToolInTranscript,
  toolResultText,
  toolResultImages,
  truncate,
} from "./toolCards";
import type { TodoPhase, ToolCard, TranscriptEntry } from "./protocol";
import { DIFF_HIGHLIGHT_LIMITS } from "./diffHighlight";

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

  it("highlights Rust syntax without changing recorded patch text", () => {
    const lines = [
      "@@ -1,5 +1,5 @@",
      " #[derive(Debug)]",
      " pub fn answer<'a>(value: &'a str) -> Option<u32> {",
      "     println!(\"<img src=x onerror=alert(1)>\");",
      "-    let result = Some(41);",
      "+    let result = Some(42);",
      " }",
    ];
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { path: "src/lib.rs", diff: lines.join("\n") } } }));
    expect([...node.querySelectorAll(".diff-line")].map(line => line.textContent)).toEqual(lines);
    expect([...node.querySelectorAll(".hljs-keyword")].map(token => token.textContent)).toContain("pub");
    expect([...node.querySelectorAll(".hljs-type")].map(token => token.textContent)).toContain("Option");
    expect(node.querySelector(".hljs-string")?.textContent).toContain("<img");
    expect(node.querySelector("img")).toBeNull();
  });

  it("emphasizes only the changed string in a small replacement pair", () => {
    const node = renderToolCard(tool({
      toolName: "edit",
      result: { details: { path: "src/lib.rs", diff: '@@ -1 +1 @@\n-let name = "old";\n+let name = "new";' } },
    }));
    expect(node.querySelector(".diff-intraline-remove")?.textContent).toBe("old");
    expect(node.querySelector(".diff-intraline-add")?.textContent).toBe("new");
    expect(node.querySelector(".diff-line-add")?.textContent).toBe('+let name = "new";');
  });

  it("excludes OMP numbered and hash-tag prefixes from syntax and copies exact raw text", async () => {
    const lines = [
      " 10#A1B2|pub fn main() {",
      '-11#A1B2|    let name = "old";',
      '+11#C3D4|    let name = "<img src=x>";',
      " 12|}",
    ];
    const raw = `${lines.join("\n")}\n`;
    const writeText = vi.fn().mockResolvedValue(undefined);
    const previousClipboard = navigator.clipboard;
    Object.assign(navigator, { clipboard: { writeText } });
    vi.useFakeTimers();
    try {
      const node = renderToolCard(tool({ toolName: "edit", result: { details: { path: "lib.rs", diff: raw } } }));
      expect([...node.querySelectorAll(".diff-line")].map(line => line.textContent)).toEqual(lines);
      expect(node.querySelector(".hljs-keyword")?.textContent).toBe("pub");
      for (const row of node.querySelectorAll(".diff-line")) {
        expect(row.querySelector(".diff-syntax")?.textContent).toBe(row.textContent!.slice(row.textContent!.indexOf("|") + 1));
      }
      expect(node.querySelector("img")).toBeNull();
      node.querySelector<HTMLButtonElement>(".edit-diff-actions button")!.click();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith(raw);
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
      Object.assign(navigator, { clipboard: previousClipboard });
    }
  });

  it("highlights only the opened file using its own language", () => {
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { perFileResults: [
      { path: "lib.rs", diff: "-let answer = 41;\n+let answer = 42;" },
      { path: "data.json", diff: '-{"answer": 41}\n+{"answer": 42}' },
    ] } } }));
    const files = [...node.querySelectorAll<HTMLDetailsElement>(".edit-file")];
    expect(node.querySelector(".diff-syntax")).toBeNull();
    files[1].querySelector<HTMLElement>("summary")!.click();
    expect(files[1].querySelector(".hljs-attr")?.textContent).toBe('"answer"');
    expect(files[0].querySelector(".edit-file-body")).toBeNull();
    files[0].querySelector<HTMLElement>("summary")!.click();
    expect(files[0].querySelector(".hljs-keyword")?.textContent).toBe("let");
  });

  it("uses sourcePath for removed code when a rename changes language", () => {
    const node = renderToolCard(tool({ toolName: "edit", result: { details: {
      path: "after.json", sourcePath: "before.rs", diff: '-let answer = 41;\n+{"answer": 42}',
    } } }));
    expect(node.querySelector(".diff-line-del .hljs-keyword")?.textContent).toBe("let");
    expect(node.querySelector(".diff-line-add .hljs-attr")?.textContent).toBe('"answer"');
    expect(node.querySelector(".diff-intraline-add, .diff-intraline-remove")).toBeNull();
  });

  it("keeps growing patches plain and highlights the final result without losing disclosure or focus", async () => {
    const options = { sessionId: "syntax-final-session" };
    const partialResult = { details: { path: "lib.rs", diff: '-let name = "old";\n+let name = "partial";' } };
    const pending = renderToolCard(tool({ toolName: "edit", isActive: true, partialResult }), options);
    document.body.append(pending);
    const summary = pending.querySelector<HTMLElement>(".edit-file summary")!;
    expect(pending.querySelector(".diff-syntax")).toBeNull();
    summary.click();
    summary.click();
    summary.focus();
    const finalLines = ['-let name = "old";', '+let name = "new";'];
    const complete = renderToolCard(tool({
      toolName: "edit", partialResult, result: { details: { path: "lib.rs", diff: finalLines.join("\n") } },
    }), options);
    pending.replaceWith(complete);
    await Promise.resolve();
    expect(complete.querySelector<HTMLDetailsElement>(".edit-file")!.open).toBe(true);
    expect(document.activeElement).toBe(complete.querySelector(".edit-file summary"));
    expect([...complete.querySelectorAll(".diff-line")].map(line => line.textContent)).toEqual(finalLines);
    expect(complete.querySelector(".hljs-keyword")?.textContent).toBe("let");
    expect(complete.querySelector(".diff-intraline-add")?.textContent).toBe("new");
    complete.remove();
  });

  it("retains multiline syntax through blank context and Show next chunk boundaries", () => {
    const lines = [
      "@@ -1,123 +1,123 @@", " /*",
      ...Array.from({ length: 117 }, () => " comment"),
      " ", " still a comment", " */", "-let value = 1;", "+let value = 2;",
    ];
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { path: "lib.rs", diff: lines.join("\n") } } }));
    node.querySelector<HTMLElement>(".edit-file summary")!.click();
    expect(node.querySelectorAll(".diff-line")).toHaveLength(120);
    node.querySelector<HTMLButtonElement>(".edit-diff-more")!.click();
    const rendered = [...node.querySelectorAll(".diff-line")];
    expect(rendered.map(line => line.textContent)).toEqual(lines);
    expect(rendered[120].querySelector(".hljs-comment")?.textContent).toBe("still a comment");
    expect(rendered[123].querySelector(".hljs-keyword")?.textContent).toBe("let");
  });

  it("tracks old context numbers after insertions shift the new side", () => {
    const lines = ["-1|/*", "+1|/*", "+2|inserted comment", " 2|still a comment", " 3|*/", " 4|let after = 1;"];
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { path: "lib.rs", diff: lines.join("\n") } } }));
    const rendered = [...node.querySelectorAll(".diff-line")];
    expect(rendered.map(line => line.textContent)).toEqual(lines);
    expect(rendered[3].querySelector(".hljs-comment")?.textContent).toBe("still a comment");
    expect(rendered[5].querySelector(".hljs-keyword")?.textContent).toBe("let");
  });

  it("keeps numeric bitwise expressions as source inside unified hunks", () => {
    const lines = ["@@ -1 +1 @@", "-0|value", "+1|value"];
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { path: "lib.rs", diff: lines.join("\n") } } }));
    expect([...node.querySelectorAll(".diff-line")].map(line => line.textContent)).toEqual(lines);
    expect(node.querySelector(".diff-line-add .diff-syntax")?.textContent).toBe("1|value");
    expect(node.querySelector(".diff-line-add .hljs-number")?.textContent).toBe("1");
  });

  it("tracks replacement positions after old-only deletions", () => {
    const lines = ["-1|let deleted = 0;", " 2|/*", "-3|let x = 1;", "+2|let x = 2;", " 4|*/"];
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { path: "lib.rs", diff: lines.join("\n") } } }));
    expect([...node.querySelectorAll(".diff-line")].map(line => line.textContent)).toEqual(lines);
    expect(node.querySelector(".diff-intraline-add")?.textContent).toBe("2");
    expect(node.querySelector(".diff-intraline-remove")?.textContent).toBe("1");
    expect(node.querySelector(".diff-line-add .hljs-keyword")).toBeNull();
    expect([...node.querySelectorAll(".diff-line-add .hljs-comment")].map(node => node.textContent).join("")).toBe("let x = 2;");
  });

  it("treats triple plus content inside a unified hunk as code, not a file header", () => {
    const lines = ["@@ -1,3 +1,4 @@", ' let raw = r#"', "+++ literal content", " pub fn inside_raw() {}", ' "#;'];
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { path: "lib.rs", diff: lines.join("\n") } } }));
    const rendered = [...node.querySelectorAll(".diff-line")];
    expect(rendered.map(line => line.textContent)).toEqual(lines);
    expect(rendered[2].querySelector(".hljs-string")?.textContent).toBe("++ literal content");
    expect(rendered[3].querySelector(".hljs-string")?.textContent).toBe("pub fn inside_raw() {}");
    expect(rendered[3].querySelector(".hljs-keyword")).toBeNull();
  });

  it.each([
    { label: "hunk", lines: ["@@ -1 +1 @@", " /*", "@@ -90 +90 @@", " let after = 1;"] },
    { label: "elision", lines: [" 1|/*", " …", " 90|let after = 1;"] },
    { label: "blank gap", lines: [" 1|/*", "", " 90|let after = 1;"] },
    { label: "number discontinuity", lines: [" 1|/*", " 90|let after = 1;"] },
    { label: "bare numbered context", lines: ["1#A1B2|/*", "90#C3D4|let after = 1;"] },
    { label: "unknown old position after additions", lines: ["+1|/*", " 90|let after = 1;"] },
  ])("does not carry multiline syntax across a $label", ({ lines }) => {
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { path: "lib.rs", diff: lines.join("\n") } } }));
    const rendered = [...node.querySelectorAll(".diff-line")];
    expect(rendered.map(line => line.textContent)).toEqual(lines);
    expect(rendered.at(-1)!.querySelector(".hljs-keyword")?.textContent).toBe("let");
    expect(rendered.at(-1)!.querySelector(".hljs-comment")).toBeNull();
  });

  it("does not pair disconnected numbered replacements or malformed numbered rows", () => {
    const lines = ['-1|let name = "old";', '+90|let name = "new";', '+91#BAD!|let broken = true;'];
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { path: "lib.rs", diff: lines.join("\n") } } }));
    expect([...node.querySelectorAll(".diff-line")].map(line => line.textContent)).toEqual(lines);
    expect(node.querySelector(".diff-intraline-add, .diff-intraline-remove")).toBeNull();
    expect(node.querySelectorAll(".diff-line")[2].querySelector(".diff-syntax")).toBeNull();
  });

  it("leaves anonymous and unknown-language patches plain without inferring header filenames", () => {
    for (const path of [undefined, "data.unknown-extension"]) {
      const lines = ["--- a/lib.rs", "+++ b/lib.rs", '@@ -1 +1 @@', '-let name = "old";', '+let name = "new";'];
      const node = renderToolCard(tool({ toolName: "edit", result: { details: { path, diff: lines.join("\n") } } }));
      const disclosure = node.querySelector<HTMLDetailsElement>(".edit-file")!;
      if (!disclosure.open) disclosure.querySelector<HTMLElement>("summary")!.click();
      expect([...node.querySelectorAll(".diff-line")].map(line => line.textContent)).toEqual(lines);
      expect(node.querySelector(".hljs-keyword, .diff-intraline-add, .diff-intraline-remove")).toBeNull();
    }
  });

  it("keeps over-budget patches on the plain 120-line chunk path", () => {
    const patches = [
      Array.from({ length: DIFF_HIGHLIGHT_LIMITS.maxRows + 1 }, () => "+let value = 1;").join("\n"),
      `+let value = "${"x".repeat(DIFF_HIGHLIGHT_LIMITS.maxTextCodeUnits)}";`,
    ];
    for (const patch of patches) {
      const node = renderToolCard(tool({ toolName: "edit", result: { details: { path: "lib.rs", diff: patch } } }));
      const disclosure = node.querySelector<HTMLDetailsElement>(".edit-file")!;
      if (!disclosure.open) disclosure.querySelector<HTMLElement>("summary")!.click();
      const lines = patch.split("\n");
      expect(node.querySelectorAll(".diff-line")).toHaveLength(Math.min(120, lines.length));
      const more = node.querySelector<HTMLButtonElement>(".edit-diff-more")!;
      while (!more.hidden) more.click();
      expect([...node.querySelectorAll(".diff-line")].map(line => line.textContent)).toEqual(lines);
      expect(node.querySelector(".diff-syntax")).toBeNull();
    }
  });

  it("hides the diff preview when showEditDiffs is false", () => {
    const node = renderToolCard(tool({
      toolName: "edit",
      args: { path: "/repo/src/main.rs" },
      result: { text: "edited", details: { diff } },
    }), { showEditDiffs: false });

    expect(node.querySelector(".edit-diff-preview")).toBeNull();
  });

  it("keeps multi-file paths and their patches separate, including duplicate basenames", () => {
    const node = renderToolCard(tool({
      toolName: "edit",
      result: { details: {
        diff: "-oldA\n+newA\n-oldB\n+newB\n",
        perFileResults: [
          { path: "/repo-a/src/config.ts", diff: "-oldA\n+newA\n" },
          { path: "/repo-b/src/config.ts", diff: "-oldB\n+newB\n" },
        ],
      } },
    }));
    const files = [...node.querySelectorAll<HTMLDetailsElement>(".edit-file")];
    expect(files.map(file => file.querySelector(".edit-file-path")?.textContent)).toEqual(["/repo-a/src/config.ts", "/repo-b/src/config.ts"]);
    expect(files.every(file => !file.open)).toBe(true);
    expect(node.querySelector(".edit-diff-preview")).toBeNull();
    files[1].querySelector<HTMLElement>("summary")!.click();
    expect(files[1].textContent).toContain("+newB");
    expect(files[1].textContent).not.toContain("+newA");
    expect(files[0].open).toBe(false);
  });

  it("keeps whole-call errors visible without claiming all files were untouched", () => {

    const error = renderToolCard(tool({
      toolName: "edit",
      isError: true,
      args: { path: "a.rs" },
      result: { text: "hashline mismatch" },
    }));
    expect(error.querySelector(".tool-result-text")?.textContent).toBe("hashline mismatch");
    expect(error.querySelector<HTMLDetailsElement>(".tool-result-details")?.open).toBe(true);
    expect(error.querySelector(".edit-file-status")?.textContent).toBe("Outcome unknown");
    expect(error.querySelector(".edit-tool-notice")?.textContent).toContain("may already have changed");
  });

  it("defers long patches and allows every line to be revealed in bounded chunks", () => {
    const longDiff = ["@@ -1 +1 @@", ...Array.from({ length: 250 }, (_, i) => `+line ${i}`)].join("\n");
    const node = renderToolCard(tool({
      toolName: "edit",
      args: { path: "big.rs" },
      result: { details: { diff: longDiff } },
    }));
    const file = node.querySelector<HTMLDetailsElement>(".edit-file")!;
    expect(file.open).toBe(false);
    expect(node.querySelector(".edit-diff-preview")).toBeNull();
    file.querySelector<HTMLElement>("summary")!.click();
    expect(node.textContent).toContain("+line 0");
    expect(node.textContent).not.toContain("+line 249");
    const more = node.querySelector<HTMLButtonElement>(".edit-diff-more")!;
    more.click();
    more.click();
    expect(node.textContent).toContain("+line 249");
    expect(more.hidden).toBe(true);
    file.querySelector<HTMLElement>("summary")!.click();
    expect(file.open).toBe(false);
    expect(file.querySelector(".edit-file-path")?.textContent).toBe("big.rs");
  });

  it("shows create, delete and rename metadata even without content changes or snapshots", () => {
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { perFileResults: [
      { path: "new.txt", op: "create", diff: "+1|new", snapshotsPruned: true },
      { path: "old.txt", op: "delete", diff: "-1|old" },
      { path: "next/name.rs", sourcePath: "old/name.rs", move: "next/name.rs", op: "update", diff: "" },
    ] } } }));
    expect([...node.querySelectorAll(".edit-file-operation")].map(el => el.textContent)).toEqual(["Create", "Delete", "Rename"]);
    expect(node.textContent).toContain("old/name.rs → next/name.rs");
    expect([...node.querySelectorAll(".edit-file-status")].map(el => el.textContent)).toEqual(["Completed", "Completed", "Completed"]);
    expect(node.querySelector(".edit-tool-header .edit-diff-stats")?.textContent).toBe("+1 -1");
  });

  it("does not assign an old combined diff to any of the requested files", () => {
    const node = renderToolCard(tool({
      toolName: "edit",
      args: { input: "*** Begin Patch\n[a.yaml#A1B2]\nPUT 1.=1:\n+yaml\n[b.rs#C3D4]\nPUT 2.=2:\n+rust\n*** End Patch" },
      result: { details: { diff: "-76|old yaml\n+76|new yaml\n-261|old rust\n+261|new rust" } },
    }));
    const files = [...node.querySelectorAll<HTMLDetailsElement>(".edit-file")];
    expect(files.map(file => file.querySelector(".edit-file-path")?.textContent)).toEqual(["a.yaml", "b.rs", "Unattributed combined diff"]);
    expect(files[0].querySelector(".edit-diff-stats")).toBeNull();
    expect(files[1].querySelector(".edit-diff-stats")).toBeNull();
    files[2].querySelector<HTMLElement>("summary")!.click();
    expect(files[2].textContent).toContain("without guessing");
    expect(files[2].textContent).toContain("+261|new rust");
  });

  it("retains a pathless historical patch without inventing a filename", () => {
    const node = renderToolCard(tool({ toolName: "edit", result: { details: { diff } } }));
    expect(node.textContent).toContain("File paths unavailable");
    const file = node.querySelector<HTMLDetailsElement>(".edit-file")!;
    expect(file.querySelector(".edit-file-path")?.textContent).toBe("Unattributed combined diff");
    file.querySelector<HTMLElement>("summary")!.click();
    expect(file.textContent).toContain("+let x = 2;");
  });

  it("distinguishes reported partial failures from missing outcomes", () => {
    const node = renderToolCard(tool({
      toolName: "edit", isError: true,
      args: { input: "*** Begin Patch\n*** Update File: a.rs\n@@\n-a\n+b\n*** Update File: b.rs\n@@\n-a\n+b\n*** Update File: c.rs\n@@\n-a\n+b\n*** End Patch" },
      result: { text: "Could not finish all writes", details: { perFileResults: [
        { path: "a.rs", diff: "-a\n+b", isError: false },
        { path: "b.rs", diff: "", isError: true, displayErrorText: "Permission denied" },
      ] } },
    }));
    const files = [...node.querySelectorAll<HTMLDetailsElement>(".edit-file")];
    expect(files.map(file => file.querySelector(".edit-file-status")?.textContent)).toEqual(["Completed", "Failed", "Outcome unknown"]);
    files[1].querySelector<HTMLElement>("summary")!.click();
    expect(files[1].textContent).toContain("Permission denied");
  });

  it("shows requested hashline operations while running without exposing patch bodies as filenames", () => {
    const card = tool({
      toolName: "edit", isActive: true,
      args: { input: "*** Begin Patch\n[old.rs#A1B2]\nPUT 1.=1:\n+[fake.rs#FFFF]\nMV new.rs\n[obsolete.rs#C3D4]\nREM\n*** End Patch" },
    });
    const node = renderToolCard(card);
    expect([...node.querySelectorAll(".edit-file-path")].map(el => el.textContent)).toEqual(["old.rs → new.rs", "obsolete.rs"]);
    expect([...node.querySelectorAll(".edit-file-status")].map(el => el.textContent)).toEqual(["Running", "Running"]);
    expect(shouldRenderToolInTranscript(card, false, true)).toBe(true);
    expect(shouldRenderToolInTranscript(card, false, false)).toBe(false);
  });

  it("retains combined output when per-file records omit their patches", () => {
    const node = renderToolCard(tool({ toolName: "edit", result: { details: {
      diff: "-oldA\n+newA\n-oldB\n+newB",
      perFileResults: [{ path: "a.rs", diff: "-oldA\n+newA" }, { path: "b.rs" }],
    } } }));
    const combined = [...node.querySelectorAll<HTMLDetailsElement>(".edit-file")]
      .find(file => file.querySelector(".edit-file-path")?.textContent === "Unattributed combined diff");
    expect(combined).toBeDefined();
    combined!.querySelector<HTMLElement>("summary")!.click();
    expect(combined!.textContent).toContain("+newB");
    expect(node.querySelector('[data-edit-path="b.rs"] .edit-diff-stats')).toBeNull();
  });

  it("normalizes quoted CRLF hashline paths and retains rename disclosure on completion", () => {
    const options = { sessionId: "quoted-edit-session", cwd: "/repo" };
    const args = { input: "[\"old name.rs\"#A1B2]  \r\nMV 'new name.rs'\r\n[b.rs#C3D4]\t\r\nPUT 1.=1:\r\n+B\r\n" };
    const pending = renderToolCard(tool({ toolName: "edit", isActive: true, args }), options);
    expect([...pending.querySelectorAll(".edit-file-path")].map(el => el.textContent)).toEqual(["old name.rs → new name.rs", "b.rs"]);
    pending.querySelector<HTMLElement>(".edit-file summary")!.click();
    const complete = renderToolCard(tool({ toolName: "edit", args, result: { details: { perFileResults: [
      { path: "/repo/new name.rs", sourcePath: "/repo/old name.rs", move: "/repo/new name.rs", diff: "" },
      { path: "/repo/b.rs", diff: "-b\n+B" },
    ] } } }), options);
    expect(complete.querySelector<HTMLDetailsElement>('[data-edit-path="/repo/new name.rs"]')?.open).toBe(true);
  });

  it("preserves file choices across stream completion, reordering, session switches and reload", async () => {
    const options = { sessionId: "edit-disclosure-session", cwd: "/repo" };
    const running = tool({ toolName: "edit", isActive: true, args: { input: "*** Begin Patch\n[a.rs#A1B2]\nPUT 1.=1:\n+a\n[b.rs#C3D4]\nPUT 1.=1:\n+b\n*** End Patch" } });
    const pending = renderToolCard(running, options);
    pending.querySelector<HTMLElement>(".edit-file summary")!.click();
    const complete = tool({ toolName: "edit", result: { details: { perFileResults: [
      { path: "/repo/b.rs", diff: "-b\n+B" },
      { path: "/repo/a.rs", diff: "-a\n+A" },
    ] } } });
    const updated = renderToolCard(complete, options);
    expect(updated.querySelector<HTMLDetailsElement>('[data-edit-path="/repo/a.rs"]')?.open).toBe(true);
    expect(updated.querySelector<HTMLDetailsElement>('[data-edit-path="/repo/b.rs"]')?.open).toBe(false);
    const other = renderToolCard(complete, { ...options, sessionId: "different-session" });
    expect([...other.querySelectorAll<HTMLDetailsElement>(".edit-file")].every(file => !file.open)).toBe(true);
    updated.querySelector<HTMLElement>('[data-edit-path="/repo/a.rs"] summary')!.click();
    updated.querySelector<HTMLElement>('[data-edit-path="/repo/b.rs"] summary')!.click();
    vi.resetModules();
    // Reload the module to exercise restoration from sessionStorage, not its memory cache.
    const reloaded = (await import("./toolCards")).renderToolCard(complete, options);
    expect(reloaded.querySelector<HTMLDetailsElement>('[data-edit-path="/repo/a.rs"]')?.open).toBe(false);
    expect(reloaded.querySelector<HTMLDetailsElement>('[data-edit-path="/repo/b.rs"]')?.open).toBe(true);
    const single = (await import("./toolCards")).renderToolCard(tool({
      toolName: "edit", result: { details: { path: "/repo/a.rs", diff: "-a\n+A" } },
    }), options);
    expect(single.querySelector<HTMLDetailsElement>(".edit-file")?.open).toBe(false);
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
