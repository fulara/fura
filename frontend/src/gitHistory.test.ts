import { describe, expect, it } from "vitest";
import { acceptGitHistoryResult, beginGitHistoryRequest, createGitHistoryState, MAX_LOADED_COMMITS } from "./gitHistory";
import type { DiffCommitSummary, GitHistoryPage } from "./protocol";

function commit(index: number): DiffCommitSummary {
  const oid = index.toString(16).padStart(40, "0");
  return { oid, shortOid: oid.slice(-8), subject: `Change ${index}`, message: `Change ${index}`, authorName: "Reviewer", committedAt: "2026-09-08T12:00:00Z", parentOids: [], isMerge: false };
}
function page(commits: DiffCommitSummary[], overrides: Partial<GitHistoryPage> = {}): GitHistoryPage {
  return { repoRoot: "/repo", branch: "main", headOid: "a".repeat(40), historyHeadOid: "a".repeat(40), commits, nextCursor: "next", ...overrides };
}

describe("Git history browsing", () => {
  it("ignores superseded and other-repository responses without ending the active load", () => {
    const state = createGitHistoryState("/repo");
    beginGitHistoryRequest(state, "first", null);
    beginGitHistoryRequest(state, "second", null);
    expect(acceptGitHistoryResult(state, "first", page([commit(1)]), null)).toBe(false);
    expect(acceptGitHistoryResult(state, "second", page([commit(2)], { repoRoot: "/other" }), null)).toBe(false);
    expect(state.loading).toBe(true);
    expect(state.page).toBeNull();
    expect(acceptGitHistoryResult(state, "second", page([commit(3)]), null)).toBe(true);
    expect(state.page?.commits.map(item => item.oid)).toEqual([commit(3).oid]);
  });

  it("keeps the selected immutable commit when refresh advances or rewrites HEAD", () => {
    const state = createGitHistoryState("/repo");
    state.view = "history";
    state.selectedOid = commit(1).oid;
    beginGitHistoryRequest(state, "initial", null);
    acceptGitHistoryResult(state, "initial", page([commit(1)]), null);
    beginGitHistoryRequest(state, "refresh", null);
    acceptGitHistoryResult(state, "refresh", page([commit(8)], { headOid: "b".repeat(40), historyHeadOid: "b".repeat(40), branch: null }), null);
    expect(state.selectedOid).toBe(commit(1).oid);
    expect(state.page?.commits.map(item => item.oid)).toEqual([commit(8).oid]);
    expect(state.page?.branch).toBeNull();
  });

  it("rejects append pages from another history snapshot and retains the readable page on failure", () => {
    const state = createGitHistoryState("/repo");
    beginGitHistoryRequest(state, "initial", null);
    acceptGitHistoryResult(state, "initial", page([commit(1)]), null);
    beginGitHistoryRequest(state, "older", "next");
    acceptGitHistoryResult(state, "older", page([commit(2)], { historyHeadOid: "b".repeat(40) }), null);
    expect(state.page?.commits.map(item => item.oid)).toEqual([commit(1).oid]);
    expect(state.error).not.toBeNull();
    beginGitHistoryRequest(state, "retry", "next");
    acceptGitHistoryResult(state, "retry", null, "Repository disappeared");
    expect(state.page?.commits.map(item => item.oid)).toEqual([commit(1).oid]);
    expect(state.loading).toBe(false);
    expect(state.error).toBe("Repository disappeared");
  });

  it("loads beyond the first page without duplicate rows and bounds the retained window", () => {
    const state = createGitHistoryState("/repo");
    state.selectedOid = commit(1).oid;
    for (let batch = 0; batch < 12; batch += 1) {
      beginGitHistoryRequest(state, String(batch), batch ? "next" : null);
      const commits = Array.from({ length: 31 }, (_, index) => commit(batch * 30 + index + 1));
      acceptGitHistoryResult(state, String(batch), page(commits, { nextCursor: `cursor-${batch + 1}` }), null);
    }
    const oids = state.page!.commits.map(item => item.oid);
    expect(oids).toHaveLength(MAX_LOADED_COMMITS);
    expect(new Set(oids).size).toBe(MAX_LOADED_COMMITS);
    expect(oids[oids.length - 1]).toBe(commit(361).oid);
    expect(state.page?.nextCursor).toBe("cursor-12");
    expect(state.selectedOid).toBe(commit(1).oid);
  });
});
