import { describe, expect, it, vi } from "vitest";
import { formatCodeFileSize, parentCodePath, renderCodeContextMenu, renderCodeViewer, renderRevisionCodeViewer, utf16ColumnWithin, type CodeRevisionState, type CodeViewerState } from "./codeViewer";
import { DIFF_HIGHLIGHT_LIMITS } from "./diffHighlight";
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
    openContextMenu: vi.fn(),
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
        fileComments: [{ id: "c1", root: "/repo", fileVersion: 1, fileText: "fn main() {}\n", path: "src/main.rs", lineNumber: 1, lineText: "fn main() {}", text: "comment" }],
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

  it("shows the canonical root even when an external workspace has no session id", () => {
    const container = document.createElement("div");
    renderCodeViewer(container, baseState({
      workspace: {
        workspaceId: "workspace-B", sessionId: null, root: "/repoB",
        source: "session", status: "filesOnly", statusMessage: "Files only.",
      },
      file: { path: "same.ts", text: "B_WORK", language: "", size: 6, version: 1 },
    }), baseActions());
    expect(container.querySelector(".code-workspace-header")?.textContent).toContain("/repoB");
    expect(container.querySelector(".code-file-view")?.textContent).toContain("B_WORK");
    expect(container.querySelector<HTMLButtonElement>(".code-workspace-header button")?.disabled).toBe(false);
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

  it("opens the context menu on right-click over a code symbol", () => {
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
      }),
      actions,
    );

    const doc = container.ownerDocument as Document & { caretRangeFromPoint?: unknown };
    const originalCaret = doc.caretRangeFromPoint;
    doc.caretRangeFromPoint = () => {
      const codeEl = container.querySelector(".code-line-content code")!;
      const range = doc.createRange();
      range.selectNodeContents(codeEl);
      range.collapse(true);
      return range;
    };
    try {
      const content = container.querySelector<HTMLElement>(".code-line-content")!;
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
      content.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(actions.openContextMenu).toHaveBeenCalledWith(0, 0, 40, 60);
    } finally {
      doc.caretRangeFromPoint = originalCaret as never;
    }
  });

  it("leaves the native context menu alone without a Rust workspace", () => {
    const container = document.createElement("div");
    const actions = baseActions();
    renderCodeViewer(
      container,
      baseState({
        file: { path: "src/main.rs", language: "rust", text: "fn main() {}\n", size: 13, version: 1 },
      }),
      actions,
    );
    const content = container.querySelector<HTMLElement>(".code-line-content")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    content.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(actions.openContextMenu).not.toHaveBeenCalled();
  });

  it("leaves the native menu alone when right-clicking a code selection", () => {
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
      }),
      actions,
    );

    const codeEl = container.querySelector(".code-line-content code")!;
    const view = container.ownerDocument.defaultView!;
    const originalGetSelection = view.getSelection;
    view.getSelection = () =>
      ({ isCollapsed: false, anchorNode: codeEl.firstChild ?? codeEl, focusNode: codeEl.firstChild ?? codeEl }) as unknown as Selection;
    try {
      const content = container.querySelector<HTMLElement>(".code-line-content")!;
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
      content.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(actions.openContextMenu).not.toHaveBeenCalled();
    } finally {
      view.getSelection = originalGetSelection;
    }
  });

  it("leaves the native menu alone for a multi-line selection across the clicked line", () => {
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
        file: { path: "src/main.rs", language: "rust", text: "one\ntwo\nthree\n", size: 14, version: 1 },
      }),
      actions,
    );

    // Selection endpoints are in other lines; the middle line is only covered by
    // the range, so the guard must rely on intersectsNode (not the endpoints).
    const middle = container.querySelectorAll<HTMLElement>(".code-line-content code")[1]!;
    const view = container.ownerDocument.defaultView!;
    const originalGetSelection = view.getSelection;
    view.getSelection = () =>
      ({
        isCollapsed: false,
        anchorNode: null,
        focusNode: null,
        rangeCount: 1,
        getRangeAt: () => ({ intersectsNode: (node: Node) => node === middle }),
      }) as unknown as Selection;
    try {
      const content = middle.closest<HTMLElement>(".code-line-content")!;
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
      content.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(actions.openContextMenu).not.toHaveBeenCalled();
    } finally {
      view.getSelection = originalGetSelection;
    }
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

  it("renders the right-click popup hover and routes actions", () => {
    const menu = document.createElement("div");
    const goToDefinition = vi.fn();
    const findReferences = vi.fn();
    const renderHover = vi.fn((markdown: string) => {
      const el = document.createElement("div");
      el.className = "markdown-body";
      el.textContent = markdown;
      return el;
    });

    renderCodeContextMenu(
      menu,
      { line: 4, character: 2, hover: { status: "ready", contents: "fn target()" } },
      { goToDefinition, findReferences },
      renderHover,
    );

    expect(renderHover).toHaveBeenCalledWith("fn target()");
    expect(menu.querySelector(".code-context-hover")?.textContent).toContain("fn target()");
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>(".code-context-action")];
    buttons.find(button => button.textContent === "Go to definition")?.click();
    expect(goToDefinition).toHaveBeenCalledWith(4, 2);
    buttons.find(button => button.textContent === "Find references")?.click();
    expect(findReferences).toHaveBeenCalledWith(4, 2);

    renderCodeContextMenu(
      menu,
      { line: 4, character: 2, hover: { status: "loading", contents: null } },
      { goToDefinition, findReferences },
      renderHover,
    );
    expect(menu.querySelector(".code-context-hover-muted")?.textContent).toContain("Loading");
  });

  it("preserves scroll across same-file re-renders but resets on file change", () => {
    const container = document.createElement("div");
    const file = { path: "src/scroll.rs", language: "rust", text: "a\nb\nc\nd\n", size: 8, version: 1 };
    renderCodeViewer(container, baseState({ file }), baseActions());
    container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop = 120;
    container.querySelector<HTMLElement>(".code-review-lines")!.scrollLeft = 240;

    // Same file, a status-update re-render preserves the scroll position.
    renderCodeViewer(container, baseState({ file, analyzerStatus: "indexing" }), baseActions());
    expect(container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop).toBe(120);
    expect(container.querySelector<HTMLElement>(".code-review-lines")!.scrollLeft).toBe(240);

    // A different file starts at the top.
    const other = { path: "src/other.rs", language: "rust", text: "x\ny\n", size: 4, version: 1 };
    renderCodeViewer(container, baseState({ file: other }), baseActions());
    expect(container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop).toBe(0);
    expect(container.querySelector<HTMLElement>(".code-review-lines")!.scrollLeft).toBe(0);
  });
});

function revisionState(overrides: Partial<CodeRevisionState> = {}): CodeRevisionState {
  const state: CodeRevisionState = {
    requestId: "revision-1",
    sessionId: "session-1",
    repoRoot: "/repo",
    commitOid: "0123456789abcdef0123456789abcdef01234567",
    path: "src/main.rs",
    side: "head",
    file: null,
    loading: false,
    error: null,
    ...overrides,
  };
  if (!("file" in overrides)) {
    state.file = {
      repoRoot: state.repoRoot,
      commitOid: state.commitOid,
      blobOid: "abcdef0123456789abcdef0123456789abcdef01",
      path: state.path,
      text: "pub fn main() {}\n",
    };
  }
  return state;
}

describe("historical revision Code viewer", () => {
  it("preserves keyboard focus when a revision read completes", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const state = revisionState();
    try {
      renderRevisionCodeViewer(container, { ...state, loading: true }, vi.fn());
      container.querySelector<HTMLButtonElement>(".code-revision-back")!.focus();
      renderRevisionCodeViewer(container, state, vi.fn());
      expect(document.activeElement).toBe(container.querySelector(".code-revision-back"));
    } finally { container.remove(); }
  });

  it("identifies the immutable source, highlights Rust and exposes only copy and return actions", () => {
    const container = document.createElement("div");
    const onReturn = vi.fn();
    const state = revisionState({ sessionId: null });
    state.file!.text = "/* historical comment\npub fn not_code() {}\n*/\npub fn main() {}\n";
    renderRevisionCodeViewer(container, state, onReturn);

    expect(container.querySelector(".code-revision-view.code-viewer")).not.toBeNull();
    expect(container.querySelector(".code-file-path")?.textContent).toBe(state.path);
    expect(container.querySelector(".code-revision-origin")?.textContent).toContain(state.repoRoot);
    expect(container.querySelector<HTMLElement>(".code-revision-commit")?.title).toBe(state.commitOid);
    expect(container.querySelector(".code-revision-commit")?.textContent).toBe(state.commitOid.slice(0, 12));
    const rows = [...container.querySelectorAll(".code-line-content")];
    expect(rows.map(row => row.textContent)).toEqual(["/* historical comment", "pub fn not_code() {}", "*/", "pub fn main() {}"]);
    expect(rows[1].querySelector(".hljs-comment")?.textContent).toBe("pub fn not_code() {}");
    expect(rows[3].querySelector(".hljs-keyword")?.textContent).toBe("pub");
    expect([...container.querySelectorAll(".diff-gutter")].map(gutter => gutter.textContent)).toEqual(["1", "2", "3", "4"]);
    expect(container.textContent).toContain("Historical revision");
    expect(container.textContent).toContain("not the working tree");
    expect(container.textContent).toContain("Comments and LSP navigation are unavailable");
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Back to working-tree Code", "Copy"]);
    expect(container.querySelector("textarea, input, [contenteditable], .diff-comment-btn")).toBeNull();
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    rows[3].dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    container.querySelector<HTMLButtonElement>(".code-revision-back")!.click();
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it("renders hostile source and origin as text, retaining Unicode and blank lines", () => {
    const container = document.createElement("div");
    const state = revisionState({ repoRoot: '/repo/<img src=x onerror="boom()">', path: "<script>boom()</script>.rs", side: "base" });
    const source = ['let text = r#"<img src=x onerror="boom()">"#;', "", "// Zażółć 🦀 <script>boom()</script>"];
    state.file!.text = source.join("\n") + "\n";
    renderRevisionCodeViewer(container, state, vi.fn());

    expect([...container.querySelectorAll(".code-line-content")].map(row => row.textContent)).toEqual(source);
    expect(container.querySelector("script, img, [onerror]")).toBeNull();
    expect(container.querySelector(".code-file-path")?.textContent).toBe(state.path);
    expect(container.textContent).toContain(state.repoRoot);
    expect(container.textContent).toContain("Comparison base · before deletion");
  });

  it("copies original full Unicode content, including CRLF and trailing newlines", async () => {
    const previousClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.useFakeTimers();
    try {
      const container = document.createElement("div");
      const state = revisionState();
      const source = '// Zażółć 🦀 e\u0301\r\n\tlet raw = "<script>";\r\n\r\n';
      state.file!.text = source;
      renderRevisionCodeViewer(container, state, vi.fn());
      const copy = [...container.querySelectorAll("button")].find(button => button.textContent === "Copy")!;
      copy.click();
      await vi.waitFor(() => expect(copy.textContent).toBe("Copied"));
      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith(source);
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
      Object.assign(navigator, { clipboard: previousClipboard });
    }
  });

  it("replaces ready content with explicit loading, failure and unavailable states without a working-tree fallback", () => {
    const container = document.createElement("div");
    const state = revisionState();
    renderRevisionCodeViewer(container, state, vi.fn());
    renderRevisionCodeViewer(container, { ...state, loading: true }, vi.fn());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading historical revision");
    expect(container.querySelector(".code-line-content")).toBeNull();
    expect(container.textContent).not.toContain("pub fn main");
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Back to working-tree Code"]);

    renderRevisionCodeViewer(container, { ...state, error: "Binary Git blob cannot be displayed." }, vi.fn());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Binary Git blob cannot be displayed.");
    expect(container.querySelector(".code-line-content")).toBeNull();
    expect(container.querySelector(".code-file-path")?.textContent).toBe(state.path);
    renderRevisionCodeViewer(container, { ...state, file: null }, vi.fn());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
    expect(container.querySelector(".code-line-content")).toBeNull();
  });

  it("keeps every line when large-file syntax falls back to plain text", () => {
    const container = document.createElement("div");
    const state = revisionState();
    const texts = Array.from({ length: DIFF_HIGHLIGHT_LIMITS.maxRows + 1 }, (_, index) => `pub fn revision_${index}() {}`);
    texts.push(`// ${"🦀".repeat(DIFF_HIGHLIGHT_LIMITS.maxTextCodeUnits)}`);
    state.file!.text = texts.join("\n");
    renderRevisionCodeViewer(container, state, vi.fn());
    expect(container.querySelectorAll(".code-line-content")).toHaveLength(DIFF_HIGHLIGHT_LIMITS.maxRows);
    const more = container.querySelector<HTMLButtonElement>(".code-revision-more");
    expect(more).not.toBeNull();
    more!.click();
    expect([...container.querySelectorAll(".code-line-content")].map(row => row.textContent)).toEqual(texts);
    expect(container.querySelector(".hljs-keyword")).toBeNull();
    expect(container.textContent).toContain("large or complex files remain complete plain text");
    expect(container.querySelector(".code-line:last-child .diff-gutter")?.textContent).toBe(String(texts.length));
  });

  it("shows an empty Git blob as an empty file rather than missing content", () => {
    const container = document.createElement("div");
    const state = revisionState();
    state.file!.text = "";
    renderRevisionCodeViewer(container, state, vi.fn());
    expect(container.textContent).toContain("empty file");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Copy")).toBe(true);
  });

  it("preserves both scroll axes only for the same repository, revision and path", () => {
    const container = document.createElement("div");
    const state = revisionState();
    renderRevisionCodeViewer(container, state, vi.fn());
    container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop = 120;
    container.querySelector<HTMLElement>(".code-review-lines")!.scrollLeft = 240;
    renderRevisionCodeViewer(container, { ...state, requestId: "revision-2" }, vi.fn());
    expect(container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop).toBe(120);
    expect(container.querySelector<HTMLElement>(".code-review-lines")!.scrollLeft).toBe(240);

    for (const change of [{ repoRoot: "/other" }, { commitOid: "fedcba9876543210fedcba9876543210fedcba98" }, { path: "src/other.rs" }]) {
      renderRevisionCodeViewer(container, state, vi.fn());
      container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop = 120;
      container.querySelector<HTMLElement>(".code-review-lines")!.scrollLeft = 240;
      renderRevisionCodeViewer(container, revisionState(change), vi.fn());
      expect(container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop).toBe(0);
      expect(container.querySelector<HTMLElement>(".code-review-lines")!.scrollLeft).toBe(0);
    }
  });

  it("does not transfer historical scroll into the working-tree viewer or back", () => {
    const container = document.createElement("div");
    const working = baseState({ file: { path: "src/main.rs", language: "rust", text: "pub fn working() {}\n", size: 20, version: 1 } });
    renderCodeViewer(container, working, baseActions());
    renderRevisionCodeViewer(container, revisionState(), vi.fn());
    container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop = 120;
    renderCodeViewer(container, working, baseActions());
    expect(container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop).toBe(0);
    container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop = 240;
    renderRevisionCodeViewer(container, revisionState(), vi.fn());
    expect(container.querySelector<HTMLElement>(".code-review-lines")!.scrollTop).toBe(0);
  });
});
