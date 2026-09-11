import { describe, expect, it } from "vitest";
import { acceptGitHistoryResult, beginGitHistoryRequest, createGitHistoryState, gitHeadLabel, MAX_LOADED_COMMITS, renderGitHistoryBrowser, selectGitHistoryRef } from "./gitHistory";
import type { DiffCommitSummary, GitHistoryPage } from "./protocol";

function commit(index: number): DiffCommitSummary {
  const oid = index.toString(16).padStart(40, "0");
  return { oid, shortOid: oid.slice(-8), subject: `Change ${index}`, message: `Change ${index}`, authorName: "Reviewer", committedAt: "2026-09-08T12:00:00Z", parentOids: [], isMerge: false };
}
function page(commits: DiffCommitSummary[], overrides: Partial<GitHistoryPage> = {}): GitHistoryPage {
  return { repoRoot: "/repo", branch: "main", headOid: "a".repeat(40), historyHeadOid: "a".repeat(40), historyRef: null, historyTipOid: "a".repeat(40), branches: [], branchesTruncated: false, commits, nextCursor: "next", ...overrides };
}

function controls(state: ReturnType<typeof createGitHistoryState>) {
  const browser = renderGitHistoryBrowser(state, {
    select: () => {}, loadOlder: () => {}, refresh: () => {}, selectBranch: () => {},
  });
  return {
    browser,
    latest: browser.querySelector<HTMLButtonElement>(".git-history-heading button")!,
    older: browser.querySelector<HTMLButtonElement>(".git-history-footer button")!,
    branch: browser.querySelector<HTMLSelectElement>(".git-history-branch")!,
  };
}

describe("Git history browsing", () => {
  it("renders a History branch selector with HEAD and stored local and remote branches", () => {
    const state = createGitHistoryState("/repo");
    const branches = [
      { name: "refs/heads/origin/topic", shortName: "origin/topic", refKind: "branch" as const, oid: "b".repeat(40) },
      { name: "refs/remotes/origin/topic", shortName: "origin/topic", refKind: "remote" as const, oid: "c".repeat(40) },
    ];
    beginGitHistoryRequest(state, "initial", null);
    acceptGitHistoryResult(state, "initial", { ...page([commit(1)]), historyRef: null, historyTipOid: "a".repeat(40), branches }, null);
    const selected: (string | null)[] = [];
    const actions = { select: () => {}, loadOlder: () => {}, refresh: () => {}, selectBranch: (ref: string | null) => selected.push(ref) };
    const browser = renderGitHistoryBrowser(state, actions);
    const selector = browser.querySelector<HTMLSelectElement>('select[aria-label="History branch"]');
    expect(selector).not.toBeNull();
    expect(Array.from(selector!.options, option => option.value)).toEqual(["", "refs/heads/origin/topic", "refs/remotes/origin/topic"]);
    expect(selector!.value).toBe("");
    expect(selector!.options[1].textContent).not.toBe(selector!.options[2].textContent);
    selector!.value = "refs/remotes/origin/topic";
    selector!.dispatchEvent(new Event("change"));
    expect(selected).toEqual(["refs/remotes/origin/topic"]);
    selector!.value = "";
    selector!.dispatchEvent(new Event("change"));
    expect(selected).toEqual(["refs/remotes/origin/topic", null]);
  });

  it("ignores superseded and other-repository responses without ending the active load", () => {
    const state = createGitHistoryState("/repo");
    beginGitHistoryRequest(state, "first", null);
    beginGitHistoryRequest(state, "second", null);
    expect(acceptGitHistoryResult(state, "first", page([commit(1)]), null)).toBe(false);
    expect(acceptGitHistoryResult(state, "second", page([commit(2)], { repoRoot: "/other" }), null)).toBe(false);
    expect(controls(state).latest.disabled).toBe(true);
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
    acceptGitHistoryResult(state, "refresh", page([commit(8)], { headOid: "b".repeat(40), historyHeadOid: "b".repeat(40), historyTipOid: "b".repeat(40), branch: null }), null);
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
    expect(controls(state).latest.disabled).toBe(false);
    expect(state.error).toBe("Repository disappeared");
  });

  it("switches branches without accepting stale pages or failures from the previous selection", () => {
    const state = createGitHistoryState("/repo");
    state.view = "history";
    const branches = [{ name: "refs/heads/topic", shortName: "topic", refKind: "branch" as const, oid: "b".repeat(40) }];
    beginGitHistoryRequest(state, "head", null);
    acceptGitHistoryResult(state, "head", page([commit(1)], { branches }), null);
    state.selectedOid = commit(1).oid;
    beginGitHistoryRequest(state, "older-head", "next");
    state.error = "Previous request failed";
    selectGitHistoryRef(state, "refs/heads/topic");
    expect(state.view).toBe("history");
    expect(state.page).toBeNull();
    expect(state.selectedOid).toBeNull();
    expect(controls(state).latest.disabled).toBe(false);
    expect(state.error).toBeNull();
    expect(state.branches).toEqual(branches);
    beginGitHistoryRequest(state, "topic", null);
    expect(acceptGitHistoryResult(state, "older-head", page([commit(2)]), null)).toBe(false);
    expect(acceptGitHistoryResult(state, "older-head", null, "Stale failure")).toBe(false);
    expect(acceptGitHistoryResult(state, "topic", page([commit(2)]), null)).toBe(false);
    expect(controls(state).latest.disabled).toBe(true);
    expect(state.error).toBeNull();
    expect(acceptGitHistoryResult(state, "topic", page([commit(3)], {
      historyRef: "refs/heads/topic", historyHeadOid: "b".repeat(40), historyTipOid: "b".repeat(40), branches,
    }), null)).toBe(true);
    expect(state.page?.commits.map(item => item.oid)).toEqual([commit(3).oid]);
    selectGitHistoryRef(state, null);
    beginGitHistoryRequest(state, "head-again", null);
    acceptGitHistoryResult(state, "head-again", page([commit(1)]), null);
    expect(state.historyRef).toBeNull();
    expect(state.page?.commits.map(item => item.oid)).toEqual([commit(1).oid]);
  });

  it("rejects an initial page whose pinned traversal differs from the selected ref tip", () => {
    const state = createGitHistoryState("/repo");
    beginGitHistoryRequest(state, "initial", null);
    acceptGitHistoryResult(state, "initial", page([commit(1)], { historyTipOid: "b".repeat(40) }), null);
    expect(state.page).toBeNull();
    expect(controls(state).latest.disabled).toBe(false);
    expect(state.error).not.toBeNull();
  });

  it("retains branch choices and pinned history when the viewed ref moves or disappears", () => {
    const state = createGitHistoryState("/repo");
    const historyRef = "refs/remotes/origin/topic";
    const tip = "b".repeat(40);
    const branches = [{ name: historyRef, shortName: "origin/topic", refKind: "remote" as const, oid: tip }];
    const actions = { select: () => {}, loadOlder: () => {}, refresh: () => {}, selectBranch: () => {} };
    selectGitHistoryRef(state, historyRef);
    beginGitHistoryRequest(state, "initial", null);
    acceptGitHistoryResult(state, "initial", page([commit(1)], { historyRef, historyHeadOid: tip, historyTipOid: tip, branches, branchesTruncated: true }), null);
    const initial = renderGitHistoryBrowser(state, actions);
    expect(initial.textContent).toContain(`Viewing ${historyRef}`);
    expect(initial.textContent).toContain(`Pinned ${tip.slice(0, 12)}`);
    expect(initial.textContent).not.toContain("has moved");
    expect(gitHeadLabel(state.page!)).toContain(`Checkout: main · ${"a".repeat(12)}`);
    expect(initial.querySelector('[role="status"]')?.textContent).toMatch(/limited.*1,000/);
    state.selectedOid = commit(1).oid;
    beginGitHistoryRequest(state, "moved", "next");
    acceptGitHistoryResult(state, "moved", page([commit(2)], { historyRef, historyHeadOid: tip, historyTipOid: "c".repeat(40), branches: null }), null);
    expect(state.branches).toEqual(branches);
    expect(renderGitHistoryBrowser(state, actions).querySelector('[role="status"]')?.textContent).toMatch(/limited.*1,000/);
    expect(state.page?.commits.map(item => item.oid)).toEqual([commit(1).oid, commit(2).oid]);
    expect(renderGitHistoryBrowser(state, actions).textContent).toContain(`${historyRef} has moved`);
    beginGitHistoryRequest(state, "deleted", "next");
    acceptGitHistoryResult(state, "deleted", page([commit(3)], { historyRef, historyHeadOid: tip, historyTipOid: null, branches: null }), null);
    expect(state.branches).toEqual(branches);
    expect(state.page?.commits.map(item => item.oid)).toEqual([commit(1).oid, commit(2).oid, commit(3).oid]);
    expect(renderGitHistoryBrowser(state, actions).textContent).toContain(`${historyRef} is no longer available`);
    beginGitHistoryRequest(state, "latest", null);
    acceptGitHistoryResult(state, "latest", page([commit(4)], { historyRef, historyHeadOid: "d".repeat(40), historyTipOid: "d".repeat(40), branches }), null);
    expect(state.selectedOid).toBe(commit(1).oid);
    expect(state.page?.commits.map(item => item.oid)).toEqual([commit(4).oid]);
    expect(renderGitHistoryBrowser(state, actions).textContent).not.toContain("has moved");
  });

  it("keeps an unlisted selected ref visible and allows branch changes during loading", () => {
    const state = createGitHistoryState("/repo");
    selectGitHistoryRef(state, "refs/heads/deleted");
    beginGitHistoryRequest(state, "missing", null);
    const selected: (string | null)[] = [];
    const browser = renderGitHistoryBrowser(state, {
      select: () => {}, loadOlder: () => {}, refresh: () => {}, selectBranch: ref => selected.push(ref),
    });
    const selector = browser.querySelector<HTMLSelectElement>('select[aria-label="History branch"]')!;
    expect(selector.value).toBe("refs/heads/deleted");
    expect(selector.selectedOptions[0].textContent).toContain("refs/heads/deleted");
    expect(selector.disabled).toBe(false);
    selector.value = "";
    selector.dispatchEvent(new Event("change"));
    expect(selected).toEqual([null]);
  });

  it("keeps readable rows and usable branch selection through pending, failed and retried loads", () => {
    const state = createGitHistoryState("/repo");
    beginGitHistoryRequest(state, "initial", null);
    acceptGitHistoryResult(state, "initial", page([commit(1)]), null);
    // Every string is a request identity; only null means no request.
    beginGitHistoryRequest(state, "", "next");
    let ui = controls(state);
    expect(ui.latest.disabled).toBe(true);
    expect(ui.older.disabled).toBe(true);
    expect(ui.branch.disabled).toBe(false);
    expect(ui.browser.querySelector(".git-history-commit")?.textContent).toContain("Change 1");
    acceptGitHistoryResult(state, "superseded", null, "Stale failure");
    ui = controls(state);
    expect(ui.latest.disabled).toBe(true);
    expect(ui.browser.querySelector('[role="alert"]')).toBeNull();

    acceptGitHistoryResult(state, "", null, "Repository disappeared");
    ui = controls(state);
    expect(ui.latest.disabled).toBe(false);
    expect(ui.older.disabled).toBe(false);
    expect(ui.browser.querySelector('[role="alert"]')?.textContent).toBe("Repository disappeared");
    expect(ui.browser.querySelector(".git-history-commit")?.textContent).toContain("Change 1");

    beginGitHistoryRequest(state, "retry", "next");
    expect(controls(state).browser.querySelector('[role="alert"]')).toBeNull();
    acceptGitHistoryResult(state, "retry", page([commit(2)], { nextCursor: null }), null);
    ui = controls(state);
    expect(ui.latest.disabled).toBe(false);
    expect(ui.older.disabled).toBe(true);
    expect([...ui.browser.querySelectorAll(".git-history-subject")].map(node => node.textContent)).toEqual(["Change 1", "Change 2"]);
    selectGitHistoryRef(state, "refs/heads/topic");
    ui = controls(state);
    expect(ui.latest.disabled).toBe(false);
    expect(ui.older.disabled).toBe(true);
    expect(ui.branch.value).toBe("refs/heads/topic");
    expect(ui.browser.querySelector(".git-history-commit")).toBeNull();
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
