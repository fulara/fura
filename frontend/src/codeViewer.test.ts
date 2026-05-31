import { describe, expect, it, vi } from "vitest";
import { formatCodeFileSize, parentCodePath, renderCodeViewer, utf16ColumnWithin, type CodeViewerState } from "./codeViewer";
import type { CodeLocation } from "./protocol";

function baseState(overrides: Partial<CodeViewerState> = {}): CodeViewerState {
  return {
    activeSessionId: "session-1",
    workspace: {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      root: "/repo",
      status: "filesOnly",
      statusMessage: "Files only.",
      source: "session",
    },
    treePath: "",
    entries: [],
    file: null,
    loadingWorkspace: false,
    loadingTree: false,
    loadingFile: false,
    error: null,
    searchOpen: false,
    searchBasePath: "/repo",
    searchQuery: "",
    searchResults: [],
    searchLoading: false,
    searchError: null,
    fileComments: [],
    navSelection: null,
    analyzerStatus: null,
    analyzerMessage: null,
    references: null,
    pendingScrollLine: null,
    ...overrides,
  };
}

function baseActions(overrides = {}) {
  return {
    openWorkspace: vi.fn(),
    listTree: vi.fn(),
    refreshTree: vi.fn(),
    openFile: vi.fn(),
    openSearch: vi.fn(),
    closeSearch: vi.fn(),
    updateSearchBasePath: vi.fn(),
    updateSearchQuery: vi.fn(),
    searchFiles: vi.fn(),
    openSearchResult: vi.fn(),
    addComment: vi.fn(),
    editComment: vi.fn(),
    deleteComment: vi.fn(),
    previewComments: vi.fn(),
    flushComments: vi.fn(),
    selectNavPosition: vi.fn(),
    clearNavSelection: vi.fn(),
    goToDefinition: vi.fn(),
    findReferences: vi.fn(),
    openReference: vi.fn(),
    closeReferences: vi.fn(),
    ...overrides,
  };
}

describe("code viewer", () => {
  it("formats parent paths for breadcrumb navigation", () => {
    expect(parentCodePath("")).toBeNull();
    expect(parentCodePath("src")).toBe("");
    expect(parentCodePath("src/bin/main.rs")).toBe("src/bin");
  });

  it("formats file sizes", () => {
    expect(formatCodeFileSize(42)).toBe("42 B");
    expect(formatCodeFileSize(1536)).toBe("1.5 KB");
    expect(formatCodeFileSize(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("renders an empty session state", () => {
    const container = document.createElement("div");

    renderCodeViewer(container, baseState({ activeSessionId: null, workspace: null }), baseActions());

    expect(container.querySelector(".code-empty-main")?.textContent).toBe("Select a session to browse its workspace.");
  });

  it("routes directory and file clicks to code actions", () => {
    const container = document.createElement("div");
    const listTree = vi.fn();
    const openFile = vi.fn();

    renderCodeViewer(
      container,
      baseState({
        entries: [
          { kind: "directory", name: "src", path: "src" },
          { kind: "file", name: "Cargo.toml", path: "Cargo.toml", size: 120 },
        ],
      }),
      baseActions({ listTree, openFile }),
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".code-tree-entry")];
    buttons[0].click();
    buttons[1].click();

    expect(listTree).toHaveBeenCalledWith("src");
    expect(openFile).toHaveBeenCalledWith("Cargo.toml");
  });

  it("refreshes the current tree on demand", () => {
    const container = document.createElement("div");
    const refreshTree = vi.fn();

    renderCodeViewer(
      container,
      baseState({ treePath: "src", entries: [{ kind: "file", name: "main.rs", path: "src/main.rs", size: 12 }] }),
      baseActions({ refreshTree }),
    );

    const refreshButton = [...container.querySelectorAll<HTMLButtonElement>(".code-tree-actions button")]
      .find(button => button.textContent === "Refresh tree");
    refreshButton?.click();

    expect(refreshTree).toHaveBeenCalledOnce();
  });

  it("renders an active read-only file with comment actions", () => {
    const container = document.createElement("div");
    const addComment = vi.fn();
    const previewComments = vi.fn();
    const flushComments = vi.fn();
    const editComment = vi.fn();
    const deleteComment = vi.fn();

    renderCodeViewer(
      container,
      baseState({
        file: {
          path: "src/main.rs",
          language: "rust",
          text: "fn main() {}\n",
          size: 13,
          version: 1,
        },
        fileComments: [{ id: "c1", path: "src/main.rs", lineNumber: 1, lineText: "fn main() {}", text: "comment" }],
      }),
      baseActions({ addComment, editComment, deleteComment, previewComments, flushComments }),
    );

    const filePath = container.querySelector<HTMLElement>(".code-file-path");
    expect(filePath?.textContent).toBe("src/main.rs");
    expect(filePath?.title).toBe("src/main.rs");
    expect(container.querySelector(".code-file-header span")?.textContent).toContain("read-only");
    expect(container.textContent).toContain("fn main");

    container.querySelector<HTMLButtonElement>(".diff-comment-btn")?.click();
    container.querySelectorAll<HTMLButtonElement>(".code-file-actions button")[0]?.click();
    container.querySelectorAll<HTMLButtonElement>(".code-file-actions button")[1]?.click();
    container.querySelector<HTMLButtonElement>(".review-comment-actions button:first-child")?.click();
    container.querySelector<HTMLButtonElement>(".review-comment-actions button:last-child")?.click();

    expect(addComment).toHaveBeenCalledWith(1, "fn main() {}");
    expect(previewComments).toHaveBeenCalledOnce();
    expect(flushComments).toHaveBeenCalledOnce();
    expect(editComment).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    expect(deleteComment).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
  });
 

  it("marks long selected file paths for constrained display", () => {
    const container = document.createElement("div");
    const longPath = "packages/frontend/src/components/review/diff/very/deeply/nested/selected-file-with-a-long-name.ts";

    renderCodeViewer(
      container,
      baseState({
        file: {
          path: longPath,
          language: "typescript",
          text: "export const value = 1;\n",
          size: 23,
          version: 1,
        },
      }),
      baseActions(),
    );

    const title = container.querySelector<HTMLElement>(".code-file-title");
    const path = container.querySelector<HTMLElement>(".code-file-path");
    expect(title).toBeTruthy();
    expect(path?.textContent).toBe(longPath);
    expect(path?.title).toBe(longPath);
  });

  it("renders file search dialog and routes search actions", () => {
    const container = document.createElement("div");
    const searchFiles = vi.fn();
    const openSearchResult = vi.fn();
    const updateSearchBasePath = vi.fn();
    const updateSearchQuery = vi.fn();

    renderCodeViewer(
      container,
      baseState({
        searchOpen: true,
        searchQuery: "main",
        searchResults: [{ kind: "file", name: "main.rs", path: "src/main.rs", size: 12 }],
      }),
      baseActions({ searchFiles, openSearchResult, updateSearchBasePath, updateSearchQuery }),
    );

    container.querySelector<HTMLInputElement>("#codeSearchBasePath")!.value = "/repo/src";
    container.querySelector<HTMLInputElement>("#codeSearchBasePath")!.dispatchEvent(new Event("input"));
    container.querySelector<HTMLInputElement>("#codeSearchQuery")!.value = "lib";
    container.querySelector<HTMLInputElement>("#codeSearchQuery")!.dispatchEvent(new Event("input"));
    container.querySelector<HTMLFormElement>(".code-search-form")?.requestSubmit();
    container.querySelector<HTMLButtonElement>(".code-search-result")?.click();

    expect(container.querySelector(".code-search-dialog")?.textContent).toContain("Search files");
    expect(updateSearchBasePath).toHaveBeenCalledWith("/repo/src");
    expect(updateSearchQuery).toHaveBeenCalledWith("lib");
    expect(searchFiles).toHaveBeenCalledOnce();
    expect(openSearchResult).toHaveBeenCalledWith("src/main.rs");
  });

  it("computes UTF-16 columns across highlighted spans", () => {
    const code = document.createElement("code");
    const first = document.createElement("span");
    first.textContent = "let";
    const space = document.createTextNode(" ");
    const second = document.createElement("span");
    second.textContent = "value";
    code.append(first, space, second);

    expect(utf16ColumnWithin(code, first.firstChild!, 0)).toBe(0);
    // "let" (3) + " " (1) + caret one char into "value"
    expect(utf16ColumnWithin(code, second.firstChild!, 1)).toBe(5);
  });

  it("counts astral characters as two UTF-16 units", () => {
    const code = document.createElement("code");
    code.textContent = "a😀b";
    // text offset 3 sits just after the emoji (a=1 + 😀=2 surrogate units)
    expect(utf16ColumnWithin(code, code.firstChild!, 3)).toBe(3);
  });

  it("renders inline navigation actions for the selected position", () => {
    const container = document.createElement("div");
    const actions = baseActions();

    renderCodeViewer(
      container,
      baseState({
        workspace: {
          workspaceId: "ws-1",
          sessionId: "session-1",
          root: "/repo",
          rustRoot: "/repo",
          status: "filesOnly",
          statusMessage: "Files only.",
          source: "session",
        },
        file: { path: "src/main.rs", language: "rust", text: "fn main() {}\n", size: 13, version: 1 },
        navSelection: { line: 0, character: 3 },
      }),
      actions,
    );

    const bar = container.querySelector(".code-nav-actions");
    expect(bar).not.toBeNull();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".code-nav-actions button")];
    buttons.find(button => button.textContent === "Go to definition")?.click();
    expect(actions.goToDefinition).toHaveBeenCalledWith(0, 3);
    buttons.find(button => button.textContent === "Find references")?.click();
    expect(actions.findReferences).toHaveBeenCalledWith(0, 3);
  });

  it("renders grouped references and routes selection and dismissal", () => {
    const container = document.createElement("div");
    const actions = baseActions();
    const locations: CodeLocation[] = [
      { kind: "local", path: "src/main.rs", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } },
      { kind: "local", path: "src/target.rs", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } },
      { kind: "external", uri: "file:///dep/lib.rs", label: "/dep/lib.rs", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } },
    ];

    renderCodeViewer(
      container,
      baseState({
        file: { path: "src/main.rs", language: "rust", text: "fn main() {}\n", size: 13, version: 1 },
        references: { path: "src/main.rs", locations },
      }),
      actions,
    );

    const panel = container.querySelector(".code-references");
    expect(panel?.textContent).toContain("References (3)");
    expect(container.querySelectorAll(".code-references-group").length).toBe(3);
    // The external target is shown but not actionable.
    expect(container.querySelector(".code-references-external")?.textContent).toContain("external");

    container.querySelector<HTMLButtonElement>(".code-references-entry")?.click();
    expect(actions.openReference).toHaveBeenCalledWith(locations[0]);

    [...container.querySelectorAll<HTMLButtonElement>(".code-references-header button")]
      .find(button => button.textContent === "Close")
      ?.click();
    expect(actions.closeReferences).toHaveBeenCalledOnce();
  });

  it("surfaces analyzer indexing and error status", () => {
    const file = { path: "src/main.rs", language: "rust", text: "fn main() {}\n", size: 13, version: 1 };

    const indexing = document.createElement("div");
    renderCodeViewer(indexing, baseState({ file, analyzerStatus: "indexing" }), baseActions());
    expect(indexing.querySelector(".code-analyzer-status")?.textContent).toContain("indexing");

    const failed = document.createElement("div");
    renderCodeViewer(failed, baseState({ file, analyzerStatus: "error", analyzerMessage: "spawn failed" }), baseActions());
    const strip = failed.querySelector(".code-analyzer-status-error");
    expect(strip?.textContent).toContain("spawn failed");

    const ready = document.createElement("div");
    renderCodeViewer(ready, baseState({ file, analyzerStatus: "ready" }), baseActions());
    expect(ready.querySelector(".code-analyzer-status")).toBeNull();
  });
});
