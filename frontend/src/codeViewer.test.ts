import { describe, expect, it, vi } from "vitest";
import { formatCodeFileSize, parentCodePath, renderCodeViewer, type CodeViewerState } from "./codeViewer";

function baseState(overrides: Partial<CodeViewerState> = {}): CodeViewerState {
  return {
    activeSessionId: "session-1",
    workspace: {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      root: "/repo",
      status: "filesOnly",
      statusMessage: "Files only.",
    },
    treePath: "",
    entries: [],
    file: null,
    loadingWorkspace: false,
    loadingTree: false,
    loadingFile: false,
    error: null,
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

    renderCodeViewer(container, baseState({ activeSessionId: null, workspace: null }), {
      openWorkspace: vi.fn(),
      listTree: vi.fn(),
      openFile: vi.fn(),
    });

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
      { openWorkspace: vi.fn(), listTree, openFile },
    );

    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".code-tree-entry")];
    buttons[0].click();
    buttons[1].click();

    expect(listTree).toHaveBeenCalledWith("src");
    expect(openFile).toHaveBeenCalledWith("Cargo.toml");
  });

  it("renders an active read-only file", () => {
    const container = document.createElement("div");

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
      }),
      { openWorkspace: vi.fn(), listTree: vi.fn(), openFile: vi.fn() },
    );

    expect(container.querySelector(".code-file-header code")?.textContent).toBe("src/main.rs");
    expect(container.querySelector(".code-file-header span")?.textContent).toContain("read-only");
    expect(container.textContent).toContain("fn main");
  });
});
