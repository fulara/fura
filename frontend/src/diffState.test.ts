import { describe, expect, it } from "vitest";
import { comparisonKey, DEFAULT_SESSION_CHANGES_DETAIL_MODE, diffRefInputFromText, diffRefInputText, resolvedDiffRefInputText, sessionChangesRefreshOptions } from "./diffState";
import type { DiffReviewableState, SessionChangesSummaryState } from "./protocol";


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
    contextLines: 3,
    generatedAt: "1",
    comparisonKey: `/repo|${selectedCommitOid ?? "range"}`,
  },
  summary: { files: [], stat: null, truncated: false },
  review: { commits: [], currentCommitOid: selectedCommitOid },
});

describe("diffState", () => {
  it("distinguishes range and commit-step comparison keys", () => {
    expect(comparisonKey(state())).not.toBe(comparisonKey(state("c".repeat(40))));
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
        contextLines: 3,
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
        contextLines: 3,
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
