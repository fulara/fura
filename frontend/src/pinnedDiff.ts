import type { ClientMessage, DiffDetailMode, DiffRefInput, DiffReviewableState, DiffRow, DiffScope, ServerMessage } from "./protocol";
import type { PinnedDiffPanelId } from "./desktopDockview";
import { acceptGitHistoryResult, beginGitHistoryRequest, createGitHistoryState, selectGitHistoryRef, type GitHistoryState, type GitReviewView } from "./gitHistory";

export type PinnedPatch = { patch: string; truncated: boolean; rows: DiffRow[]; contextLines: number };
export type PinnedTarget =
  | { scope: "sessionChanges"; repoRoot: string; sessionId: string; changeKind: "unstaged" | "staged" | "untracked"; currentCommitOid: string | null }
  | { scope: "compareDiff"; repoRoot: string; base: DiffRefInput; head: DiffRefInput };

export function pinnedPatchKey(state: DiffReviewableState, file: string | null, whitespace = state.comparison.ignoreWhitespace ?? false): string {
  return `${state.comparison.comparisonKey}\0${file ?? ""}\0${whitespace}`;
}

/** A pin owns its source, generation and bounded cache; never reads active-session state. */
export class PinnedDiff {
  readonly id: PinnedDiffPanelId;
  readonly target: PinnedTarget;
  readonly cache = new Map<string, PinnedPatch>();
  readonly history: GitHistoryState | null;
  private requestedHistoryRef: string | null = null;
  state: DiffReviewableState;
  selectedFile: string | null;
  layout: "unified" | "split";
  ignoreWhitespace: boolean;
  detailMode: DiffDetailMode;
  contextLines: number;
  generation = 0;
  diffId: string | null = null;
  pendingState: DiffReviewableState | null = null;
  pendingFile: string | null = null;
  loading = false;
  error: string | null = null;
  unavailable: string | null = null;
  closed = false;

  constructor(
    readonly clientId: string,
    readonly ownerSessionId: string | null,
    readonly ownerLabel: string,
    state: DiffReviewableState,
    settings: { selectedFile: string | null; layout: "unified" | "split"; ignoreWhitespace: boolean; changeKind?: "unstaged" | "staged" | "untracked"; history?: GitHistoryState },
    private readonly send: (message: ClientMessage) => boolean,
    private readonly uuid: () => string,
    private readonly changed: () => void,
  ) {
    this.id = `pinnedDiff:${clientId}`;
    this.state = { ...state, comparison: { ...state.comparison, selectedFile: null } };
    this.selectedFile = settings.selectedFile;
    this.layout = settings.layout;
    this.ignoreWhitespace = settings.ignoreWhitespace;
    this.detailMode = state.comparison.detailMode;
    this.contextLines = state.comparison.contextLines;
    const comparison = state.comparison;
    this.target = settings.changeKind && ownerSessionId
      ? { scope: "sessionChanges", repoRoot: comparison.repoRoot, sessionId: ownerSessionId, changeKind: settings.changeKind, currentCommitOid: state.review.currentCommitOid ?? null }
      : { scope: "compareDiff", repoRoot: comparison.repoRoot,
        base: { kind: "gitRef", value: comparison.leftTreeOrCommit },
        head: (comparison.displayedPatchRange?.head ?? comparison.head).kind === "workingTree" ? { kind: "workingTree" } : { kind: "gitRef", value: comparison.rightTreeOrCommit } };
    this.history = this.target.scope === "sessionChanges" ? createGitHistoryState(comparison.repoRoot) : null;
    if (this.history) {
      const source = settings.history;
      if (source) {
        this.history.branches = [...source.branches];
        this.history.branchesTruncated = source.branchesTruncated;
        // Capture the branch name, not HEAD which may later point at another branch.
        this.history.historyRef = source.historyRef ?? (source.page?.branch ? `refs/heads/${source.page.branch}` : null);
        this.history.page = source.page ? { ...source.page, commits: [...source.page.commits] } : null;
      }
      this.history.selectedOid = state.review.currentCommitOid ?? null;
      this.history.view = this.history.selectedOid ? "history" : "changes";
    }
  }

  get scope(): DiffScope { return this.target.scope; }
  get stale(): boolean { return this.loading || Boolean(this.error || this.unavailable); }

  remember(key: string, patch: PinnedPatch): void {
    this.cache.delete(key);
    this.cache.set(key, patch);
    let bytes = 0;
    for (const entry of this.cache.values()) bytes += entry.patch.length;
    while (this.cache.size > 20 || bytes > 8 * 1024 * 1024) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      bytes -= this.cache.get(oldest)!.patch.length;
      this.cache.delete(oldest);
    }
  }

  requestHistory(cursor: string | null = null): void {
    if (!this.history || this.target.scope !== "sessionChanges" || this.closed || this.unavailable) return;
    // Older pages keep their original cursor/ref binding; Latest resolves the captured branch.
    this.requestedHistoryRef = cursor && this.history.page ? this.history.page.historyRef : this.history.historyRef;
    const requestId = this.uuid();
    beginGitHistoryRequest(this.history, requestId, cursor);
    if (!this.send({ type: "git.history.request", clientId: this.clientId, requestId,
      sessionId: this.target.sessionId, repoId: this.target.repoRoot, historyRef: this.requestedHistoryRef, cursor })) {
      acceptGitHistoryResult(this.history, requestId, null, "Not connected to the Fura bridge.");
    }
    this.changed();
  }

  selectBranch(ref: string | null): void {
    if (!this.history || this.closed || this.unavailable || this.history.historyRef === ref) return;
    this.cancel("refreshed");
    this.loading = false;
    this.pendingState = null;
    selectGitHistoryRef(this.history, ref);
    this.requestHistory();
  }

  selectCommit(oid: string): void {
    if (!this.history || this.target.scope !== "sessionChanges" || this.closed || this.unavailable) return;
    this.history.view = "history";
    this.history.selectedOid = oid;
    this.target.currentCommitOid = oid;
    this.selectedFile = null;
    this.refresh();
  }

  selectView(view: GitReviewView): void {
    if (!this.history || this.target.scope !== "sessionChanges" || this.closed || this.unavailable) return;
    this.history.view = view;
    if (view === "history") {
      const oid = this.history.selectedOid ?? this.history.page?.commits[0]?.oid;
      if (oid) this.selectCommit(oid);
      else this.requestHistory();
    } else {
      this.target.currentCommitOid = null;
      this.selectedFile = null;
      this.refresh();
    }
  }

  refresh(): void {
    if (this.closed || this.unavailable) return;
    this.cancel("refreshed");
    this.generation++;
    this.diffId = this.uuid();
    this.loading = true;
    this.error = null;
    this.pendingState = null;
    this.pendingFile = this.selectedFile;
    const options = { clientId: this.clientId, diffId: this.diffId, detailMode: this.detailMode,
      currentCommitOid: null, selectedFile: null, contextLines: this.contextLines, ignoreWhitespace: this.ignoreWhitespace };
    const sent = this.target.scope === "sessionChanges"
      ? this.send({ type: "sessionChanges.request", ...options, sessionId: this.target.sessionId, repoId: this.target.repoRoot, changeKind: this.target.changeKind, currentCommitOid: this.target.currentCommitOid })
      : this.send({ type: "compareDiff.request", ...options, repoRoot: this.target.repoRoot, base: this.target.base, head: this.target.head, mergeBase: false });
    if (!sent) this.fail("Not connected to the Fura bridge. Refresh to retry.");
    else this.changed();
  }

  selectFile(file: string | null): void {
    if (file === this.selectedFile) return;
    this.selectedFile = file;
    if (this.loading) this.refresh();
  }

  requestContent(file: string | null, contextLines?: number): void {
    if (this.closed || this.unavailable || this.loading || this.error) return;
    this.selectedFile = file;
    if (contextLines !== undefined) this.contextLines = contextLines;
    // Each new read has a fresh generation, including repeated reads of one file.
    // This also re-establishes the backend slot after reconnect without borrowing another view's slot.
    this.refresh();
  }

  handle(message: ServerMessage): boolean {
    if (message.type === "git.history") {
      if (message.targetClientId !== this.clientId) return false;
      if (this.closed || this.unavailable || !this.history || this.target.scope !== "sessionChanges"
        || message.sessionId !== this.target.sessionId) return true;
      const result = { ...this.history, historyRef: this.requestedHistoryRef };
      if (!acceptGitHistoryResult(result, message.requestId, message.page, message.error)) return true;
      Object.assign(this.history, result, { historyRef: this.history.historyRef });
      if (this.history.view === "history" && !this.history.selectedOid && this.history.page?.commits[0]) {
        this.selectCommit(this.history.page.commits[0].oid);
      } else this.changed();
      return true;
    }
    let client: string | null | undefined;
    let diffId: string | null | undefined;
    let scope: string | undefined;
    if (message.type === "sessionChanges.summary" || message.type === "compareDiff.summary") {
      client = message.state.targetClientId; diffId = message.state.diffId; scope = message.state.request.scope;
    } else if (message.type === "diff.content") {
      client = message.content.targetClientId; diffId = message.content.diffId; scope = message.content.scope;
    } else if (message.type === "diff.error" || message.type === "diff.complete" || message.type === "diff.cancelled") {
      client = message.targetClientId; diffId = message.diffId; scope = message.scope;
    } else return false;
    if (client !== this.clientId) return false;
    if (this.closed || diffId !== this.diffId || scope !== this.scope) return true;
    if (message.type === "sessionChanges.summary" || message.type === "compareDiff.summary") {
      const state = message.state;
      if ("status" in state && state.status === "missingRepo") { this.fail(state.reason); return true; }
      const ready = state as DiffReviewableState;
      if (ready.comparison.repoRoot !== this.target.repoRoot || (ready.comparison.ignoreWhitespace ?? false) !== this.ignoreWhitespace) {
        this.fail("The response did not match the pinned repository or whitespace mode."); return true;
      }
      this.pendingState = { ...ready, comparison: { ...ready.comparison, selectedFile: null } };
      if (this.pendingFile && !ready.summary.files.some(file => file.newPath === this.pendingFile)) this.pendingFile = null;
      if (this.detailMode === "statOnly") this.accept();
      else {
        const file = ready.summary.files.find(file => file.newPath === this.pendingFile);
        if (!this.send({ type: "diff.content.request", clientId: this.clientId, diffId: this.diffId!, scope: this.scope,
          sessionId: this.target.scope === "sessionChanges" ? this.target.sessionId : null,
          comparisonKey: ready.comparison.comparisonKey, selectedFile: file ? { oldPath: file.oldPath, newPath: file.newPath } : null,
          contextLines: this.contextLines, ignoreWhitespace: this.ignoreWhitespace })) this.fail("Not connected to the Fura bridge. Refresh to retry.");
      }
    } else if (message.type === "diff.content") {
      const content = message.content;
      if (!this.pendingState || content.comparisonKey !== this.pendingState.comparison.comparisonKey
        || (content.file?.newPath ?? null) !== this.pendingFile || (content.ignoreWhitespace ?? false) !== this.ignoreWhitespace
        || content.contextLines !== this.contextLines) return true;
      this.remember(pinnedPatchKey(this.pendingState, this.pendingFile), content);
      this.accept();
    } else if (message.type === "diff.error" || message.type === "diff.cancelled") {
      this.fail(message.type === "diff.error" ? message.message : "Pinned diff request cancelled. Refresh to retry.");
    }
    return true;
  }

  private accept(): void {
    if (!this.pendingState) return;
    this.state = this.pendingState;
    this.selectedFile = this.pendingFile;
    this.pendingState = null;
    this.loading = false;
    this.error = null;
    for (const key of this.cache.keys()) {
      if (!key.startsWith(`${this.state.comparison.comparisonKey}\0`)) this.cache.delete(key);
    }
    this.changed();
  }

  private fail(message: string): void {
    this.cancel("closed");
    this.loading = false;
    this.pendingState = null;
    this.error = message;
    this.changed();
  }

  cancel(reason: "closed" | "refreshed"): void {
    if (this.diffId) this.send({ type: "diff.cancel", clientId: this.clientId, diffId: this.diffId, scope: this.scope, reason });
    this.diffId = null;
  }

  disconnect(): void {
    if (this.history) {
      this.history.requestId = null;
      this.history.error = "Connection closed. Refresh history to retry.";
    }
    this.cancel("closed");
    this.generation++;
    this.fail("Connection closed. Showing the captured result; Refresh to reconnect this pin.");
  }

  close(): void {
    if (this.history) this.history.requestId = null;
    this.closed = true;
    this.cancel("closed");
    this.cache.clear();
    this.pendingState = null;
  }
}
