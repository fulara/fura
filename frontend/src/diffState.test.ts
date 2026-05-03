import { describe, expect, it } from "vitest";
import { deriveDiffSelection, parseDiffRows, summarizeDiffFiles } from "./diffState";

const patch = [
  "diff --git a/src/old.ts b/src/new.ts",
  "index 1111111..2222222 100644",
  "--- a/src/old.ts",
  "+++ b/src/new.ts",
  "@@ -1,2 +1,3 @@",
  " const same = true;",
  "-const removed = true;",
  "+const added = true;",
  "+const another = true;",
].join("\n");

describe("diffState", () => {
  it("parses git patch rows with file, hunk, and line metadata", () => {
    const rows = parseDiffRows(patch);

    expect(rows).toContainEqual({ type: "file", text: "diff --git a/src/old.ts b/src/new.ts", filePath: "src/new.ts" });
    expect(rows).toContainEqual({ type: "hunk", text: "@@ -1,2 +1,3 @@", filePath: "src/new.ts", hunk: "@@ -1,2 +1,3 @@" });
    expect(rows).toContainEqual({
      type: "line",
      prefix: "-",
      location: {
        filePath: "src/new.ts",
        hunk: "@@ -1,2 +1,3 @@",
        kind: "remove",
        oldLine: 2,
        text: "-const removed = true;",
      },
    });
    expect(rows).toContainEqual({
      type: "line",
      prefix: "+",
      location: {
        filePath: "src/new.ts",
        hunk: "@@ -1,2 +1,3 @@",
        kind: "add",
        newLine: 2,
        text: "+const added = true;",
      },
    });
  });

  it("summarizes changed files without counting context lines", () => {
    const rows = parseDiffRows(patch);

    expect(summarizeDiffFiles(rows)).toEqual([{ filePath: "src/new.ts", added: 2, removed: 1, commentCount: 0 }]);
  });

  it("prefers the cwd-matching repository before backend selected snapshot defaults", () => {
    const repoA = { entryId: "repo-a-base", label: "repo A", kind: "session-start" as const, createdAt: "2026-05-02T00:00:00Z", repoRoot: "/repo-a" };
    const repoB = { entryId: "repo-b-base", label: "repo B", kind: "session-start" as const, createdAt: "2026-05-02T00:00:00Z", repoRoot: "/work/repo-b" };

    expect(deriveDiffSelection({
      state: { snapshots: [repoA, repoB], selectedSnapshot: repoA, headSnapshot: null, diff: "", stat: false },
      cwd: "/work/repo-b/src",
    })).toMatchObject({
      repoRoot: "/work/repo-b",
      selectedSnapshot: repoB,
      headSnapshot: null,
    });
  });

  it("preserves an explicit working-tree comparison instead of falling back to backend head snapshot", () => {
    const base = { entryId: "base", label: "base", kind: "session-start" as const, createdAt: "2026-05-02T00:00:00Z", repoRoot: "/repo" };
    const head = { entryId: "head", label: "head", kind: "manual" as const, createdAt: "2026-05-02T01:00:00Z", repoRoot: "/repo" };

    expect(deriveDiffSelection({
      state: { snapshots: [base, head], selectedSnapshot: base, headSnapshot: head, diff: "", stat: false },
      cwd: "/repo",
      headSelection: { kind: "working-tree" },
    }).headSnapshot).toBeNull();
  });

  it("falls back to the backend head snapshot when head selection is unset", () => {
    const base = { entryId: "base", label: "base", kind: "session-start" as const, createdAt: "2026-05-02T00:00:00Z", repoRoot: "/repo" };
    const head = { entryId: "head", label: "head", kind: "manual" as const, createdAt: "2026-05-02T01:00:00Z", repoRoot: "/repo" };

    expect(deriveDiffSelection({
      state: { snapshots: [base, head], selectedSnapshot: base, headSnapshot: head, diff: "", stat: false },
      cwd: "/repo",
    }).headSnapshot).toBe(head);
  });

  it("uses an explicit snapshot head selection", () => {
    const base = { entryId: "base", label: "base", kind: "session-start" as const, createdAt: "2026-05-02T00:00:00Z", repoRoot: "/repo" };
    const head = { entryId: "head", label: "head", kind: "manual" as const, createdAt: "2026-05-02T01:00:00Z", repoRoot: "/repo" };

    expect(deriveDiffSelection({
      state: { snapshots: [base, head], selectedSnapshot: base, headSnapshot: null, diff: "", stat: false },
      cwd: "/repo",
      headSelection: { kind: "snapshot", entryId: "head" },
    }).headSnapshot).toBe(head);
  });

  it("does not fall back to backend head snapshot when explicit snapshot head is stale", () => {
    const base = { entryId: "base", label: "base", kind: "session-start" as const, createdAt: "2026-05-02T00:00:00Z", repoRoot: "/repo" };
    const head = { entryId: "head", label: "head", kind: "manual" as const, createdAt: "2026-05-02T01:00:00Z", repoRoot: "/repo" };

    expect(deriveDiffSelection({
      state: { snapshots: [base, head], selectedSnapshot: base, headSnapshot: head, diff: "", stat: false },
      cwd: "/repo",
      headSelection: { kind: "snapshot", entryId: "deleted-head" },
    }).headSnapshot).toBeNull();
  });
});
