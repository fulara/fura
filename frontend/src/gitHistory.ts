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

let branchPickerId = 0;
type BranchPickerDraft = { query: string; activeRef: string | null; selectionStart: number | null; selectionEnd: number | null };
const branchPickerStates = new WeakMap<HTMLElement, {
  state: GitHistoryState;
  repoRoot: string;
  historyRef: string | null;
  capture(): BranchPickerDraft | null;
  restore(draft: BranchPickerDraft): void;
}>();

export function preserveHistoryBranchPicker(container: HTMLElement): (() => void) | undefined {
  const element = container.querySelector<HTMLElement>(".git-history-branch-picker");
  const previous = element ? branchPickerStates.get(element) : undefined;
  const draft = previous?.capture();
  if (!previous || !draft) return;
  return () => {
    const replacement = container.querySelector<HTMLElement>(".git-history-branch-picker");
    const next = replacement ? branchPickerStates.get(replacement) : undefined;
    if (next && next.state === previous.state && next.repoRoot === previous.repoRoot
      && next.historyRef === previous.historyRef) {
      next.restore(draft);
    }
  };
}

function renderHistoryBranchPicker(state: GitHistoryState, selectBranch: (ref: string | null) => void): HTMLElement {
  const picker = mkEl("div");
  picker.className = "git-history-branch-picker";
  const owner = picker.ownerDocument;
  const selectedRef = state.historyRef;
  const repoRoot = state.repoRoot;
  const choices = [
    { value: "", label: "HEAD", search: "head" },
    ...state.branches.map(ref => ({
      value: ref.name,
      label: `${ref.refKind === "remote" ? "Remote" : "Local"}: ${ref.shortName}`,
      search: `${ref.shortName}\n${ref.name}`.toLowerCase(),
    })),
  ];
  if (selectedRef && !choices.some(choice => choice.value === selectedRef)) {
    const kind = selectedRef.startsWith("refs/remotes/") ? "Remote" : "Local";
    choices.push({ value: selectedRef, label: `${kind}: ${selectedRef} (not in branch list)`, search: selectedRef.toLowerCase() });
  }
  const branch = mkEl("button");
  branch.type = "button";
  branch.className = "git-history-branch";
  branch.setAttribute("aria-label", "History branch");
  branch.setAttribute("aria-haspopup", "listbox");
  branch.setAttribute("aria-expanded", "false");
  branch.title = selectedRef ?? "HEAD";
  branch.textContent = `${choices.find(choice => choice.value === (selectedRef ?? ""))!.label} ▾`;
  const popup = mkEl("div");
  popup.className = "git-history-branch-popup";
  popup.popover = "auto";
  const input = mkEl("input");
  input.type = "search";
  input.placeholder = "Filter branches";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", "Filter History branches");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const list = mkEl("div");
  list.id = `git-history-branches-${++branchPickerId}`;
  list.className = "git-history-branch-options";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "History branches");
  input.setAttribute("aria-controls", list.id);
  branch.setAttribute("aria-controls", list.id);
  const empty = mkEl("p");
  empty.className = "git-history-branch-empty";
  empty.setAttribute("role", "status");
  empty.textContent = "No matching branches. ";
  const clear = mkEl("button");
  clear.type = "button";
  clear.textContent = "Clear filter";
  empty.append(clear);
  popup.append(input, list, empty);
  picker.append(branch, popup);
  let open = false;
  let composing = false;
  let filtered = choices;
  let activeRef: string | null = null;
  const current = () => picker.isConnected && state.repoRoot === repoRoot && state.historyRef === selectedRef;
  const reset = () => {
    open = false;
    composing = false;
    input.value = "";
    activeRef = null;
    list.replaceChildren();
    empty.hidden = true;
    branch.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const dismiss = (restoreFocus = false) => {
    if (open && popup.isConnected) popup.hidePopover();
    reset();
    if (restoreFocus && current()) branch.focus();
  };
  const choose = (value: string) => {
    if (!open || !current()) return;
    dismiss(true);
    selectBranch(value || null);
  };
  const highlight = () => {
    let row: HTMLElement | undefined;
    for (const child of list.children) {
      const option = child as HTMLElement;
      const active = option.dataset.ref === activeRef;
      option.classList.toggle("active", active);
      if (active) row = option;
    }
    if (row) {
      input.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView?.({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  const filter = () => {
    const query = input.value.toLowerCase();
    filtered = choices.filter(choice => choice.search.includes(query));
    activeRef = filtered[0]?.value ?? null;
    list.replaceChildren();
    for (const [index, choice] of filtered.entries()) {
      // Events can run after another window became the render-document context.
      const option = owner.createElement("div");
      option.id = `${list.id}-${index}`;
      option.className = "git-history-branch-option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(choice.value === (selectedRef ?? "")));
      option.dataset.ref = choice.value;
      option.title = choice.value || "HEAD";
      option.textContent = choice.label;
      option.addEventListener("mousedown", event => event.preventDefault());
      option.addEventListener("click", () => {
        if (option.isConnected && list.contains(option)) choose(choice.value);
      });
      list.append(option);
    }
    empty.hidden = filtered.length !== 0;
    highlight();
  };
  const show = (draft?: BranchPickerDraft) => {
    if (!current()) return;
    input.value = draft?.query ?? "";
    composing = false;
    filter();
    if (draft && draft.activeRef !== null) {
      activeRef = draft.activeRef;
    }
    const rect = branch.getBoundingClientRect();
    const view = owner.defaultView!;
    const below = view.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const upwards = below < 200 && above > below;
    const height = Math.min(320, Math.max(80, upwards ? above : below));
    popup.style.width = `${Math.min(Math.max(rect.width, 240), view.innerWidth - 16)}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.left, view.innerWidth - Math.max(rect.width, 240) - 8))}px`;
    popup.style.maxHeight = `${height}px`;
    popup.style.top = upwards ? "auto" : `${rect.bottom + 4}px`;
    popup.style.bottom = upwards ? `${view.innerHeight - rect.top + 4}px` : "auto";
    popup.showPopover();
    highlight();
    open = true;
    branch.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-expanded", "true");
    input.focus();
    if (draft) input.setSelectionRange(draft.selectionStart, draft.selectionEnd);
  };
  popup.addEventListener("pointerdown", event => event.stopPropagation());
  popup.addEventListener("beforetoggle", event => {
    if ((event as ToggleEvent).newState === "closed") reset();
  });
  picker.addEventListener("focusout", event => {
    if (!picker.contains(event.relatedTarget as Node | null)) dismiss();
  });
  branch.addEventListener("click", () => open ? dismiss() : show());
  input.addEventListener("input", () => { if (open && current()) filter(); });
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  clear.addEventListener("click", () => {
    if (!open || !current()) return;
    input.value = "";
    filter();
    input.focus();
  });
  picker.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      dismiss(true);
    } else if (event.key === "Tab") {
      // Put focus back on the trigger so native Tab reaches the next/previous control.
      if (open) dismiss(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) show();
      else {
        const index = filtered.findIndex(choice => choice.value === activeRef);
        activeRef = filtered[Math.max(0, Math.min(filtered.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.value ?? null;
        highlight();
      }
    } else if (event.key === "Enter" && event.target === input) {
      event.preventDefault();
      if (activeRef !== null && filtered.some(choice => choice.value === activeRef)) choose(activeRef);
    }
  });
  picker.addEventListener("keyup", event => event.stopPropagation());
  branchPickerStates.set(picker, {
    state, repoRoot, historyRef: selectedRef,
    capture: () => open && current() && !composing ? {
      query: input.value, activeRef,
      selectionStart: input.selectionStart, selectionEnd: input.selectionEnd,
    } : null,
    restore: show,
  });
  reset();
  return picker;
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
  const branch = renderHistoryBranchPicker(state, actions.selectBranch);
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
    limited.textContent = "Branch list limited to the newest 1,000 refs by tip commit date. Search only covers these loaded refs.";
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
