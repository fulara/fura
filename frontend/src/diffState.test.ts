import { describe, expect, it } from "vitest";
import { comparisonKey, DEFAULT_SESSION_CHANGES_DETAIL_MODE, diffRefInputFromText, diffRefInputText, parseDiffRows, resolvedDiffRefInputText, sessionChangesRefreshOptions, summarizeDiffFiles } from "./diffState";
import type { DiffReviewableState, SessionChangesSummaryState } from "./protocol";

const patch = [
  "diff --git a/src/old.ts b/src/new.ts",
  "similarity index 88%",
  "rename from src/old.ts",
  "rename to src/new.ts",
  "index 1111111..2222222 100644",
  "--- a/src/old.ts",
  "+++ b/src/new.ts",
  "@@ -1,2 +1,3 @@",
  " const same = true;",
  "-const removed = true;",
  "+const added = true;",
  "+const another = true;",
].join("\n");

const sessionStartEndpoint = {
  kind: "sessionStartSnapshot" as const,
  snapshot: {
    entryId: "snapshot-1",
    label: "session-start",
    createdAt: "now",
    refName: "refs/omp/diff-snapshots/start",
    tree: "a".repeat(40),
    commit: "a".repeat(40),
  },
};

const state = (selectedCommitOid: string | null = null): DiffReviewableState => ({
  comparison: {
    repoRoot: "/repo",
    base: { kind: "gitRef", input: "main", refKind: "branch", oid: "a".repeat(40), display: "main" },
    head: { kind: "gitRef", input: "feature", refKind: "branch", oid: "b".repeat(40), display: "feature" },
    leftTreeOrCommit: "a".repeat(40),
    rightTreeOrCommit: "b".repeat(40),
    detailMode: "filePatch",
    currentCommitOid: selectedCommitOid,
    generatedAt: "1",
    comparisonKey: `/repo|${selectedCommitOid ?? "range"}`,
  },
  summary: { files: [], stat: null, truncated: false },
  patch,
  review: { commits: [], currentCommitOid: selectedCommitOid },
});

describe("diffState", () => {
  it("parses git patch rows with side-aware file, hunk, and line metadata", () => {
    const rows = parseDiffRows(patch);

    expect(rows).toContainEqual({ type: "file", text: "diff --git a/src/old.ts b/src/new.ts", oldPath: "src/old.ts", newPath: "src/new.ts", filePath: "src/new.ts" });
    expect(rows).toContainEqual({ type: "hunk", text: "@@ -1,2 +1,3 @@", oldPath: "src/old.ts", newPath: "src/new.ts", filePath: "src/new.ts", hunk: "@@ -1,2 +1,3 @@" });
    expect(rows).toContainEqual({
      type: "line",
      prefix: "-",
      location: {
        oldPath: "src/old.ts",
        newPath: "src/new.ts",
        hunk: "@@ -1,2 +1,3 @@",
        side: "left",
        kind: "remove",
        oldLine: 2,
        text: "-const removed = true;",
      },
    });
    expect(rows).toContainEqual({
      type: "line",
      prefix: "+",
      location: {
        oldPath: "src/old.ts",
        newPath: "src/new.ts",
        hunk: "@@ -1,2 +1,3 @@",
        side: "right",
        kind: "add",
        newLine: 2,
        text: "+const added = true;",
      },
    });
  });

  it("summarizes changed files and tracks annotation kinds", () => {
    const rows = parseDiffRows(patch);
    const key = comparisonKey(state());

    expect(summarizeDiffFiles(rows, [
      { id: "c", kind: "comment", comparisonKey: key, anchor: { oldPath: "src/old.ts", newPath: "src/new.ts", hunk: null, side: "right", kind: "add", text: "+x" }, text: "comment", status: "draft", createdAt: "now" },
      { id: "q", kind: "question", comparisonKey: key, anchor: { oldPath: "src/old.ts", newPath: "src/new.ts", hunk: null, side: "right", kind: "add", text: "+x" }, text: "question", status: "sent", createdAt: "now" },
    ], key)).toEqual([{ filePath: "src/new.ts", oldPath: "src/old.ts", added: 2, removed: 1, commentCount: 1, questionCount: 1 }]);
  });

  it("distinguishes range and commit-step comparison keys", () => {
    expect(comparisonKey(state())).not.toBe(comparisonKey(state("c".repeat(40))));
  });

  it("keeps binary diffs parseable as metadata", () => {
    const rows = parseDiffRows("diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ");
    expect(rows).toContainEqual({ type: "file", text: "diff --git a/a.png b/a.png", oldPath: "a.png", newPath: "a.png", filePath: "a.png" });
    expect(rows).toContainEqual({ type: "meta", text: "Binary files a/a.png and b/a.png differ" });
  });

  it("round-trips the working tree pseudo-ref for diff controls", () => {
    expect(diffRefInputFromText("WORKTREE", { kind: "gitRef", value: "HEAD" })).toEqual({ kind: "workingTree" });
    expect(diffRefInputText({ kind: "workingTree" })).toBe("WORKTREE");
    expect(resolvedDiffRefInputText({ kind: "workingTree" }, { kind: "gitRef", value: "HEAD" })).toBe("WORKTREE");
    expect(diffRefInputFromText("feature", { kind: "workingTree" })).toEqual({ kind: "gitRef", value: "feature" });
  });

  it("builds focus-refresh options from the visible session changes state", () => {
    const readyState: SessionChangesSummaryState = {
      status: "ready",
      targetClientId: "client",
      diffId: "diff-1",
      request: {
        scope: "sessionChanges",
        clientId: "client",
        diffId: "diff-1",
        sessionId: "session-1",
        repoId: "repo-2",
        detailMode: "filePatch",
        currentCommitOid: null,
      },
      comparison: {
        repoRoot: "/repo",
        base: sessionStartEndpoint,
        head: { kind: "workingTree" },
        leftTreeOrCommit: "a".repeat(40),
        rightTreeOrCommit: "b".repeat(40),
        detailMode: "filePatch",
        currentCommitOid: "c".repeat(40),
        generatedAt: "now",
        comparisonKey: "key",
      },
      sessionId: "session-1",
      repos: [],
      selectedRepoId: "repo-2",
      summary: { files: [], stat: null, truncated: false },
      review: { commits: [], currentCommitOid: "d".repeat(40) },
    };

    expect(sessionChangesRefreshOptions(readyState, "statOnly")).toEqual({
      repoId: "repo-2",
      payloadKind: "filePatch",
      currentCommitOid: "d".repeat(40),
    });
    expect(sessionChangesRefreshOptions(undefined, DEFAULT_SESSION_CHANGES_DETAIL_MODE)).toEqual({ payloadKind: "filePatch" });
  });
});
