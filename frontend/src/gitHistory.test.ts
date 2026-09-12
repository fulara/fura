import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptGitHistoryResult, beginGitHistoryRequest, createGitHistoryState, gitHeadLabel, MAX_LOADED_COMMITS, preserveHistoryBranchPicker, renderGitHistoryBrowser, selectGitHistoryRef, type GitHistoryState } from "./gitHistory";
import type { DiffCommitSummary, GitHistoryPage } from "./protocol";
import { setRenderDocument } from "./dom";

function commit(index: number): DiffCommitSummary {
  const oid = index.toString(16).padStart(40, "0");
  return { oid, shortOid: oid.slice(-8), subject: `Change ${index}`, message: `Change ${index}`, authorName: "Reviewer", committedAt: "2026-09-08T12:00:00Z", parentOids: [], isMerge: false };
}
function page(commits: DiffCommitSummary[], overrides: Partial<GitHistoryPage> = {}): GitHistoryPage {
  return { repoRoot: "/repo", branch: "main", headOid: "a".repeat(40), historyHeadOid: "a".repeat(40), historyRef: null, historyTipOid: "a".repeat(40), branches: [], branchesTruncated: false, commits, nextCursor: "next", ...overrides };
}

function controls(state: GitHistoryState) {
  const browser = renderGitHistoryBrowser(state, {
    select: () => {}, loadOlder: () => {}, refresh: () => {}, selectBranch: () => {},
  });
  return {
    browser,
    latest: browser.querySelector<HTMLButtonElement>(".git-history-heading button")!,
    older: browser.querySelector<HTMLButtonElement>(".git-history-footer button")!,
    branch: browser.querySelector<HTMLButtonElement>(".git-history-branch")!,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  setRenderDocument(document);
  document.body.replaceChildren();
});

function mountPicker(state: GitHistoryState, selectBranch: (ref: string | null) => void = () => {}) {
  const browser = renderGitHistoryBrowser(state, {
    select: () => { throw new Error("Unexpected commit selection"); },
    loadOlder: () => { throw new Error("Unexpected history request"); },
    refresh: () => { throw new Error("Unexpected history refresh"); },
    selectBranch,
  });
  document.body.append(browser);
  const trigger = browser.querySelector<HTMLButtonElement>('button[aria-label="History branch"]')!;
  const input = browser.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const popup = browser.querySelector<HTMLElement>(".git-history-branch-popup")!;
  // jsdom lacks the native popover API. Only emulate its visibility event;
  // browser smoke covers real top-layer positioning and light dismissal.
  popup.showPopover = () => {};
  popup.hidePopover = () => popup.dispatchEvent(Object.assign(new Event("beforetoggle"), { newState: "closed" }));
  return {
    browser, trigger, input, popup,
    options: () => Array.from(browser.querySelectorAll<HTMLElement>('[role="option"]')),
    type: (query: string) => {
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    key: (key: string, init: KeyboardEventInit = {}) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })),
  };
}

describe("Git history browsing", () => {
  it("does not replace a disappeared active ref after repeated rerenders", () => {
    const state = createGitHistoryState("/repo");
    state.branches = [
      { name: "refs/heads/topic", shortName: "topic", refKind: "branch", oid: "a".repeat(40) },
      { name: "refs/remotes/origin/topic", shortName: "origin/topic", refKind: "remote", oid: "b".repeat(40) },
    ];
    const selected: (string | null)[] = [];
    let ui = mountPicker(state, ref => selected.push(ref));
    ui.trigger.click(); ui.type("topic"); ui.key("ArrowDown");
    state.branches = state.branches.slice(0, 1);
    for (let rerender = 0; rerender < 2; rerender += 1) {
      const restore = preserveHistoryBranchPicker(document.body);
      ui.browser.remove();
      ui = mountPicker(state, ref => selected.push(ref));
      restore?.();
      ui.key("Enter");
      expect(selected).toEqual([]);
    }
    ui.key("ArrowDown"); ui.key("Enter");
    expect(selected).toEqual(["refs/heads/topic"]);
  });

  it("retains query, caret and active ref across same-review rerenders but not navigation", () => {
    // Removing jsdom's active node otherwise impersonates OS focus loss.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const state = createGitHistoryState("/repo");
    state.branches = [
      { name: "refs/heads/topic", shortName: "topic", refKind: "branch", oid: "a".repeat(40) },
      { name: "refs/remotes/origin/topic", shortName: "origin/topic", refKind: "remote", oid: "b".repeat(40) },
    ];
    const selected: (string | null)[] = [];
    const old = mountPicker(state);
    old.trigger.click(); old.type("topic"); old.key("ArrowDown");
    old.input.setSelectionRange(1, 3);
    const restore = preserveHistoryBranchPicker(document.body);
    old.browser.remove();
    state.branches.reverse();
    state.selectedOid = "a".repeat(40);
    const next = mountPicker(state, ref => selected.push(ref));
    restore?.();
    expect(next.input.value).toBe("topic");
    expect([next.input.selectionStart, next.input.selectionEnd]).toEqual([1, 3]);
    expect(document.activeElement).toBe(next.input);
    next.key("Enter");
    expect(selected).toEqual(["refs/remotes/origin/topic"]);
    next.trigger.click(); next.type("topic");
    const interrupted = preserveHistoryBranchPicker(document.body);
    next.browser.remove();
    state.historyRef = "refs/heads/topic";
    const changed = mountPicker(state);
    interrupted?.();
    expect(changed.trigger.getAttribute("aria-expanded")).toBe("false");
    changed.trigger.click();
    expect(changed.input.value).toBe("");
  });

  it("retains an inactive picker draft without moving focus from another input", () => {
    const state = createGitHistoryState("/repo");
    const old = mountPicker(state);
    old.trigger.click();
    old.type("topic");
    const restore = preserveHistoryBranchPicker(document.body, false);
    old.browser.remove();
    const next = mountPicker(state);
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    restore?.();
    expect(next.input.value).toBe("topic");
    expect(document.activeElement).toBe(outside);
  });

  it("selects full local and remote refs only on click or Enter, with HEAD first", () => {
    const state = createGitHistoryState("/repo");
    state.branches = [
      { name: "refs/heads/origin/topic", shortName: "origin/topic", refKind: "branch", oid: "b".repeat(40) },
      { name: "refs/remotes/origin/topic", shortName: "origin/topic", refKind: "remote", oid: "c".repeat(40) },
    ];
    const selected: (string | null)[] = [];
    const ui = mountPicker(state, ref => selected.push(ref));
    ui.trigger.click();
    expect(ui.options().map(option => option.title)).toEqual(["HEAD", "refs/heads/origin/topic", "refs/remotes/origin/topic"]);
    expect(ui.options().map(option => option.textContent)).toEqual(["HEAD", "Local: origin/topic", "Remote: origin/topic"]);
    expect(selected).toEqual([]);
    ui.options()[2].click();
    expect(selected).toEqual(["refs/remotes/origin/topic"]);
    ui.trigger.click();
    ui.key("ArrowDown");
    expect(selected).toEqual(["refs/remotes/origin/topic"]);
    ui.key("Enter");
    expect(selected).toEqual(["refs/remotes/origin/topic", "refs/heads/origin/topic"]);
    ui.trigger.click();
    ui.key("ArrowDown");
    ui.key("ArrowUp");
    ui.key("Enter");
    expect(selected).toEqual(["refs/remotes/origin/topic", "refs/heads/origin/topic", null]);
  });

  it("filters names and full refs case-insensitively without reordering or changing history", () => {
    const state = createGitHistoryState("/repo");
    state.branches = [
      { name: "refs/remotes/origin/ŻÓŁĆ/topic", shortName: "origin/ŻÓŁĆ/topic", refKind: "remote", oid: "b".repeat(40) },
      { name: "refs/heads/東京/topic", shortName: "東京/topic", refKind: "branch", oid: "c".repeat(40) },
      { name: "refs/heads/older/topic", shortName: "older/topic", refKind: "branch", oid: "d".repeat(40) },
    ];
    state.selectedOid = commit(1).oid;
    state.page = page([commit(1)]);
    state.requestId = "pending";
    const before = structuredClone(state);
    const selected: (string | null)[] = [];
    const ui = mountPicker(state, ref => selected.push(ref));
    ui.trigger.click();
    ui.type("/TOPIC");
    expect(ui.options().map(option => option.title)).toEqual(state.branches.map(ref => ref.name));
    ui.type("żółć");
    expect(ui.options().map(option => option.title)).toEqual([state.branches[0].name]);
    ui.type("REFS/HEADS/東京/");
    expect(ui.options().map(option => option.title)).toEqual([state.branches[1].name]);
    expect(state).toEqual(before);
    expect(selected).toEqual([]);
  });

  it("dismisses with Escape, Tab or outside focus and clears the transient query on reopen", () => {
    const selected: (string | null)[] = [];
    const ui = mountPicker(createGitHistoryState("/repo"), ref => selected.push(ref));
    const outside = document.createElement("button");
    document.body.append(outside);
    ui.trigger.click();
    ui.type("missing");
    ui.key("Escape");
    expect(document.activeElement).toBe(ui.trigger);
    expect(ui.trigger.getAttribute("aria-expanded")).toBe("false");
    ui.trigger.click();
    expect(ui.input.value).toBe("");
    expect(ui.options().map(option => option.title)).toEqual(["HEAD"]);
    ui.type("again");
    expect(ui.key("Tab")).toBe(true);
    expect(ui.trigger.getAttribute("aria-expanded")).toBe("false");
    ui.trigger.click();
    expect(ui.input.value).toBe("");
    outside.focus();
    expect(ui.trigger.getAttribute("aria-expanded")).toBe("false");
    ui.trigger.click();
    ui.type("native dismiss");
    ui.popup.hidePopover();
    expect(ui.input.value).toBe("");
    expect(ui.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(selected).toEqual([]);
  });

  it("keeps empty search recoverable without selecting anything", () => {
    const selected: (string | null)[] = [];
    const ui = mountPicker(createGitHistoryState("/repo"), ref => selected.push(ref));
    ui.trigger.click();
    ui.type("no such branch");
    expect(ui.options()).toEqual([]);
    expect(ui.input.hasAttribute("aria-activedescendant")).toBe(false);
    expect(ui.browser.querySelector<HTMLElement>(".git-history-branch-empty")!.hidden).toBe(false);
    ui.key("Enter");
    ui.browser.querySelector<HTMLButtonElement>(".git-history-branch-empty button")!.click();
    expect(ui.input.value).toBe("");
    expect(document.activeElement).toBe(ui.input);
    expect(ui.options().map(option => option.title)).toEqual(["HEAD"]);
    expect(selected).toEqual([]);
  });

  it("ignores composing Enter and Escape and isolates picker shortcuts", () => {
    const selected: (string | null)[] = [];
    const ui = mountPicker(createGitHistoryState("/repo"), ref => selected.push(ref));
    const propagated: string[] = [];
    ui.browser.addEventListener("keydown", event => propagated.push(event.key));
    ui.browser.addEventListener("keyup", event => propagated.push(event.key));
    ui.trigger.click();
    ui.key("Enter", { isComposing: true });
    ui.input.dispatchEvent(new CompositionEvent("compositionstart"));
    ui.key("Enter");
    ui.key("Escape");
    expect(ui.trigger.getAttribute("aria-expanded")).toBe("true");
    ui.input.dispatchEvent(new CompositionEvent("compositionend"));
    ui.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
    ui.key("n");
    ui.key("p");
    ui.key("Enter", { ctrlKey: true, isComposing: true });
    ui.input.dispatchEvent(new KeyboardEvent("keyup", { key: "m", altKey: true, bubbles: true }));
    expect(selected).toEqual([]);
    expect(propagated).toEqual([]);
    ui.key("Enter");
    expect(selected).toEqual([null]);
  });

  it("ignores stale options after filtering, dismissal, rerender and repository changes", () => {
    const state = createGitHistoryState("/repo");
    const selected: (string | null)[] = [];
    const ui = mountPicker(state, ref => selected.push(ref));
    ui.trigger.click();
    const filteredOut = ui.options()[0];
    ui.type("missing");
    filteredOut.click();
    ui.type("");
    const dismissed = ui.options()[0];
    ui.key("Escape");
    dismissed.click();
    ui.trigger.click();
    const detached = ui.options()[0];
    const replacement = mountPicker(createGitHistoryState("/other"));
    ui.browser.replaceWith(replacement.browser);
    detached.click();
    ui.key("Enter");
    ui.trigger.click();
    expect(selected).toEqual([]);
    const changed = mountPicker(state, ref => selected.push(ref));
    changed.trigger.click();
    state.repoRoot = "/changed";
    changed.options()[0].click();
    changed.key("Enter");
    expect(selected).toEqual([]);
  });

  it("creates filtered options in the popout document even after the render context changes", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const owner = frame.contentDocument!;
    setRenderDocument(owner);
    const browser = renderGitHistoryBrowser(createGitHistoryState("/repo"), {
      select: () => {}, loadOlder: () => {}, refresh: () => {}, selectBranch: () => {},
    });
    owner.body.append(browser);
    setRenderDocument(document);
    browser.querySelector<HTMLElement>(".git-history-branch-popup")!.showPopover = () => {};
    browser.querySelector<HTMLButtonElement>(".git-history-branch")!.click();
    const input = browser.querySelector<HTMLInputElement>('[role="combobox"]')!;
    input.value = "head";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(browser.querySelector('[role="option"]')?.ownerDocument).toBe(owner);
    expect(owner.activeElement).toBe(input);
    expect(input.getAttribute("aria-activedescendant")).toBe(browser.querySelector('[role="option"]')?.id);
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
    state.selectedOid = commit(1).oid;
    beginGitHistoryRequest(state, "moved", "next");
    acceptGitHistoryResult(state, "moved", page([commit(2)], { historyRef, historyHeadOid: tip, historyTipOid: "c".repeat(40), branches: null }), null);
    expect(state.branches).toEqual(branches);
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
    const ui = mountPicker(state, ref => selected.push(ref));
    expect(ui.trigger.title).toBe("refs/heads/deleted");
    expect(ui.trigger.textContent).toContain("refs/heads/deleted");
    expect(ui.trigger.disabled).toBe(false);
    ui.trigger.click();
    expect(ui.options().map(option => option.title)).toEqual(["HEAD", "refs/heads/deleted"]);
    expect(ui.options()[1].getAttribute("aria-selected")).toBe("true");
    ui.key("Enter");
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
    expect(ui.branch.title).toBe("refs/heads/topic");
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
