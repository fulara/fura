import { mkEl } from "./dom";
import type { GitHistoryPage, GitRefSummary } from "./protocol";

export type GitReviewView = "changes" | "history";
export type GitHistoryState = {
  repoRoot: string;
  view: GitReviewView;
  historyRef: string | null;
  branches: GitRefSummary[];
  branchesTruncated: boolean;
  selectedOid: string | null;
  page: GitHistoryPage | null;
  requestId: string | null;
  requestedCursor: string | null;
  error: string | null;
};

// Keep a bounded browsing window, not every message from the repository history.
export const MAX_LOADED_COMMITS = 300;

export function createGitHistoryState(repoRoot: string): GitHistoryState {
  return { repoRoot, view: "changes", historyRef: null, branches: [], branchesTruncated: false, selectedOid: null, page: null, requestId: null, requestedCursor: null, error: null };
}

export function selectGitHistoryRef(state: GitHistoryState, ref: string | null): void {
  state.historyRef = ref;
  state.selectedOid = null;
  state.page = null;
  state.requestId = null;
  state.requestedCursor = null;
  state.error = null;
}

export function beginGitHistoryRequest(state: GitHistoryState, requestId: string, cursor: string | null): void {
  state.requestId = requestId;
  state.requestedCursor = cursor;
  state.error = null;
}

export function acceptGitHistoryResult(
  state: GitHistoryState,
  requestId: string,
  page: GitHistoryPage | null,
  error: string | null,
): boolean {
  if (state.requestId !== requestId) return false;
  if (page && state.repoRoot && page.repoRoot !== state.repoRoot) return false;
  if (page && page.historyRef !== state.historyRef) return false;
  state.requestId = null;
  state.error = error;
  if (!page) return true;
  if (state.requestedCursor
    ? !state.page || state.page.historyRef !== page.historyRef || state.page.historyHeadOid !== page.historyHeadOid
    : page.historyHeadOid !== page.historyTipOid) {
    state.error = "History changed while loading older commits. Refresh the history before continuing.";
    return true;
  }
  const commits = state.requestedCursor && state.page ? [...state.page.commits] : [];
  const seen = new Set(commits.map(commit => commit.oid));
  for (const commit of page.commits) {
    if (!seen.has(commit.oid)) {
      commits.push(commit);
      seen.add(commit.oid);
    }
  }
  state.repoRoot = page.repoRoot;
  if (page.branches !== null) {
    state.branches = page.branches;
    state.branchesTruncated = page.branchesTruncated;
  }
  state.page = { ...page, commits: commits.slice(-MAX_LOADED_COMMITS) };
  state.requestedCursor = null;
  // A refresh must never silently select another commit, even after a rebase.
  return true;
}

export function gitHeadLabel(page: GitHistoryPage): string {
  if (!page.headOid) return `Checkout: ${page.branch ?? "Repository"} · No commits yet`;
  return `Checkout: ${page.branch ?? "Detached HEAD"} · ${page.headOid.slice(0, 12)}`;
}

export function renderGitHistoryBrowser(state: GitHistoryState, actions: {
  select(oid: string): void;
  loadOlder(): void;
  refresh(): void;
  selectBranch(ref: string | null): void;
}): HTMLElement {
  const loading = state.requestId !== null;
  const browser = mkEl("section");
  browser.className = "git-history-browser";
  const heading = mkEl("div");
  heading.className = "git-history-heading";
  const title = mkEl("strong");
  title.textContent = "Recent commits";
  const latest = mkEl("button");
  latest.type = "button";
  latest.textContent = "Latest";
  latest.title = "Reload the recent history without changing the selected commit";
  latest.disabled = loading;
  latest.addEventListener("click", actions.refresh);
  const branch = mkEl("select");
  branch.className = "git-history-branch";
  branch.setAttribute("aria-label", "History branch");
  const head = mkEl("option");
  head.value = "";
  head.textContent = "HEAD";
  branch.append(head);
  for (const ref of state.branches) {
    const option = mkEl("option");
    option.value = ref.name;
    option.textContent = `${ref.refKind === "remote" ? "Remote" : "Local"}: ${ref.shortName}`;
    branch.append(option);
  }
  if (state.historyRef && !state.branches.some(ref => ref.name === state.historyRef)) {
    const missing = mkEl("option");
    missing.value = state.historyRef;
    missing.textContent = `${state.historyRef} (not in branch list)`;
    branch.append(missing);
  }
  branch.value = state.historyRef ?? "";
  branch.addEventListener("change", () => actions.selectBranch(branch.value || null));
  const snapshot = mkEl("small");
  snapshot.className = "git-history-snapshot";
  snapshot.textContent = `Viewing ${state.historyRef ?? "HEAD"} · ${state.page?.historyHeadOid ? `Pinned ${state.page.historyHeadOid.slice(0, 12)}` : state.page ? "No commits yet" : "Not loaded"}`;
  snapshot.title = state.page?.historyHeadOid ?? "";
  heading.append(title, latest, branch, snapshot);
  browser.append(heading);
  const list = mkEl("div");
  list.className = "git-history-list";
  list.setAttribute("aria-label", "Recent commits");
  if (state.error) {
    const error = mkEl("p");
    error.className = "git-history-error";
    error.setAttribute("role", "alert");
    error.textContent = state.error;
    list.append(error);
  }
  if (!state.page?.commits.length) {
    const empty = mkEl("p");
    empty.textContent = loading ? "Loading commit history…" : state.page ? "No commits yet. Current changes are still available." : "Load history to review commits.";
    list.append(empty);
  }
  for (const commit of state.page?.commits ?? []) {
    const row = mkEl("button");
    row.type = "button";
    row.className = "git-history-commit";
    row.dataset.commitOid = commit.oid;
    row.setAttribute("aria-pressed", String(commit.oid === state.selectedOid));
    const subject = mkEl("strong");
    subject.className = "git-history-subject";
    subject.textContent = commit.subject || "(no subject)";
    const meta = mkEl("span");
    meta.className = "git-history-meta";
    const date = new Date(commit.committedAt);
    const time = Number.isNaN(date.getTime()) ? commit.committedAt : date.toLocaleString();
    meta.textContent = `${commit.shortOid} · ${commit.authorName || "Unknown author"} · ${time}${commit.isMerge ? " · Merge" : ""}`;
    row.title = `${commit.message || commit.subject || "(no subject)"}\n${commit.oid}\n${commit.authorName ?? ""}\n${commit.committedAt}`;
    row.append(subject, meta);
    row.addEventListener("click", () => actions.select(commit.oid));
    list.append(row);
  }
  browser.append(list);
  const footer = mkEl("div");
  footer.className = "git-history-footer";
  if (state.branchesTruncated) {
    const limited = mkEl("small");
    limited.setAttribute("role", "status");
    limited.textContent = "Branch list limited to the first 1,000 stored refs.";
    footer.append(limited);
  }
  if (state.selectedOid && state.page && !state.page.commits.some(commit => commit.oid === state.selectedOid)) {
    const pinned = mkEl("small");
    pinned.textContent = `Selected ${state.selectedOid.slice(0, 12)} is outside this loaded window. Its review remains pinned.`;
    footer.append(pinned);
  }
  if (state.page?.historyHeadOid && state.page.historyTipOid !== state.page.historyHeadOid) {
    const moved = mkEl("small");
    moved.textContent = state.page.historyTipOid
      ? `${state.historyRef ?? "HEAD"} has moved. These older pages still use the original history; use Latest to refresh.`
      : `${state.historyRef ?? "HEAD"} is no longer available. These older pages still use the original history.`;
    footer.append(moved);
  }
  const older = mkEl("button");
  older.type = "button";
  older.textContent = loading ? "Loading history…" : state.page?.nextCursor ? "Load older commits" : "End of history";
  older.disabled = loading || !state.page?.nextCursor;
  older.addEventListener("click", actions.loadOlder);
  footer.append(older);
  browser.append(footer);
  return browser;
}
