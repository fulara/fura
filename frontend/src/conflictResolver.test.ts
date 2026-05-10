import { describe, expect, it, vi } from "vitest";
import { adjacentConflictId, conflictSelectionRange, containsConflictMarkerLines, draftConflictRegions, renderConflictResolver, resolveDraftConflict, selectedConflictPreview, type ConflictResolverActions, type ConflictResolverState } from "./conflictResolver";

const conflicted = [
  "one",
  "<<<<<<< HEAD",
  "current",
  "=======",
  "incoming",
  ">>>>>>> branch",
  "three",
  "",
].join("\n");

describe("conflict resolver conflict helpers", () => {
  const conflicted = [
    "one",
    "<<<<<<< HEAD",
    "current",
    "=======",
    "incoming",
    ">>>>>>> branch",
    "three",
    "",
  ].join("\n");

  it("finds conflict marker regions", () => {
    expect(draftConflictRegions(conflicted)).toEqual([{
      id: "conflict-1",
      startLine: 2,
      separatorLine: 4,
      endLine: 6,
    }]);
  });

  it("resolves a selected conflict using incoming text", () => {
    const resolved = resolveDraftConflict(conflicted, "conflict-1", "incoming");

    expect(resolved.resolved).toBe(true);
    expect(resolved.text).toBe("one\nincoming\nthree\n");
  });

  it("can preserve both sides in current then incoming order", () => {
    const resolved = resolveDraftConflict(conflicted, "conflict-1", "currentThenIncoming");

    expect(resolved.text).toBe("one\ncurrent\nincoming\nthree\n");
  });

  it("detects incomplete conflict markers", () => {
    expect(containsConflictMarkerLines("<<<<<<< HEAD\nunfinished\n")).toBe(true);
    expect(containsConflictMarkerLines("resolved\nclean\n")).toBe(false);
  });

  it("returns a selection range for the chosen conflict", () => {
    expect(conflictSelectionRange(conflicted, "conflict-1")).toEqual({ start: 4, end: 56 });
  });

  it("navigates between complete conflicts", () => {
    const multi = [
      conflicted.trimEnd(),
      "<<<<<<< HEAD",
      "again current",
      "=======",
      "again incoming",
      ">>>>>>> branch",
      "",
    ].join("\n");
    expect(adjacentConflictId(multi, "conflict-1", 1)).toBe("conflict-2");
    expect(adjacentConflictId(multi, "conflict-2", -1)).toBe("conflict-1");
  });

  it("builds a preview for the selected conflict", () => {
    expect(selectedConflictPreview(conflicted, "conflict-1")).toEqual({
      id: "conflict-1",
      index: 1,
      total: 1,
      startLine: 2,
      endLine: 6,
      current: "current",
      incoming: "incoming",
    });
  });

});

describe("conflict resolver preview rendering", () => {
  function baseState(overrides: Partial<ConflictResolverState> = {}): ConflictResolverState {
    return {
      root: "/repo",
      repos: [{
        repoId: "/repo",
        root: "/repo",
        operation: "merge",
        files: [{ path: "src/main.ts", kind: "bothModified", supported: true }],
      }],
      selectedRepoId: "/repo",
      selectedPath: "src/main.ts",
      file: {
        repoId: "/repo",
        path: "src/main.ts",
        kind: "bothModified",
        ours: { label: "Current branch", language: "typescript", text: "const ours = true;\n", size: 19 },
        base: { label: "Common ancestor", language: "typescript", text: "const base = true;\n", size: 19 },
        theirs: { label: "Incoming change", language: "typescript", text: "const theirs = true;\n", size: 21 },
        result: { label: "Result", language: "typescript", text: conflicted, size: conflicted.length },
        conflicts: draftConflictRegions(conflicted),
        version: "1:9",
      },
      draftResult: conflicted,
      selectedConflictId: "conflict-1",
      draftDirty: false,
      saving: false,
      staging: false,
      previewingMagicWand: false,
      wandPreview: null,
      requestingAgentAssistance: false,
      agentInstructions: "",
      agentResult: null,
      status: null,
      loadingScan: false,
      loadingFile: false,
      error: null,
      ...overrides,
    };
  }

  function actions(): ConflictResolverActions {
    return {
      refresh: vi.fn(),
      selectFile: vi.fn(),
      leave: vi.fn(),
      updateResult: vi.fn(),
      selectConflict: vi.fn(),
      shiftConflict: vi.fn(),
      resolveConflict: vi.fn(),
      previewMagicWand: vi.fn(),
      applyMagicWandPreview: vi.fn(),
      discardMagicWandPreview: vi.fn(),
      updateAgentInstructions: vi.fn(),
      requestAgentExplain: vi.fn(),
      requestAgentProposeConflict: vi.fn(),
      requestAgentProposeFile: vi.fn(),
      applyAgentResult: vi.fn(),
      discardAgentResult: vi.fn(),
      saveResult: vi.fn(),
      stageResolved: vi.fn(),
    };
  }

  it("renders magic wand preview details", () => {
    const container = document.createElement("div");
    renderConflictResolver(container, baseState({
      wandPreview: {
        repoId: "/repo",
        path: "src/main.ts",
        sourceVersion: "1:9",
        content: "const merged = true;\n",
        resolvedConflictCount: 1,
        remainingConflictCount: 0,
        summary: "Resolved 1 conflict block with the magic wand. 0 conflict blocks remain.",
        rules: [{ conflictId: "conflict-1", rule: "sameLineNonOverlappingEdits", summary: "Combined non-overlapping same-line edits from both sides." }],
      },
      status: "Resolved 1 conflict block with the magic wand. 0 conflict blocks remain.",
    }), actions());

    expect(container.textContent).toContain("Magic wand preview");
    expect(container.textContent).toContain("Same-line non-overlap");
    expect(container.textContent).toContain("const merged = true;");
  });

  it("disables magic wand preview while the draft is dirty", () => {
    const container = document.createElement("div");
    renderConflictResolver(container, baseState({
      draftDirty: true,
      draftResult: "resolved\n",
    }), actions());

    const previewButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Preview magic wand");
    expect(previewButton?.disabled).toBe(true);
    expect(container.textContent).toContain("Save or discard draft edits before previewing the magic wand.");
  });

  it("renders agent proposal details with risk label", () => {
    const container = document.createElement("div");
    renderConflictResolver(container, baseState({
      agentResult: {
        repoId: "/repo",
        path: "src/main.ts",
        sourceVersion: "1:9",
        mode: "propose",
        scope: "selectedConflict",
        conflictId: "conflict-1",
        risk: "medium",
        summary: "Merged the selected branch-specific edits and kept the remaining conflicts untouched.",
        explanation: "This keeps both initialization changes in the selected block. Remaining conflict markers stay for manual review.",
        content: "const merged = true;\n",
        remainingConflictCount: 0,
      },
    }), actions());

    expect(container.textContent).toContain("Agent assistance");
    expect(container.textContent).toContain("Proposal · selected conflict · Medium risk");
    expect(container.textContent).toContain("kept the remaining conflicts untouched");
    expect(container.textContent).toContain("const merged = true;");
  });
});
