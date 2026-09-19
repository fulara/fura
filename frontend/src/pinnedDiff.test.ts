import { describe, expect, it } from "vitest";
import { PinnedDiff, pinnedPatchKey } from "./pinnedDiff";
import type { ClientMessage, DiffReviewableState, ServerMessage } from "./protocol";

function state(key = "original"): DiffReviewableState {
  return {
    comparison: { repoRoot: "/repo/a", base: { kind: "index" }, head: { kind: "workingTree" },
      leftTreeOrCommit: "a".repeat(40), rightTreeOrCommit: "worktree", detailMode: "filePatch", contextLines: 3,
      generatedAt: "now", comparisonKey: key },
    summary: { files: [{ newPath: "a.ts", status: "modified", added: 1, removed: 1 }], truncated: false },
    review: { commits: [], currentCommitOid: null },
  };
}

function harness(clientId = "client-a", initial = state()) {
  const sent: ClientMessage[] = [];
  let sequence = 0;
  const pin = new PinnedDiff(clientId, "session-a", "Agent A", initial,
    { selectedFile: "a.ts", layout: "split", ignoreWhitespace: false, changeKind: "unstaged" },
    message => { sent.push(message); return true; }, () => `generation-${++sequence}`, () => {});
  pin.remember(pinnedPatchKey(initial, "a.ts"), { patch: "old patch", rows: [], truncated: false, contextLines: 3 });
  return { pin, sent };
}

function summary(pin: PinnedDiff, key: string): ServerMessage {
  return { type: "sessionChanges.summary", state: { ...state(key), status: "ready", targetClientId: pin.clientId,
    diffId: pin.diffId!, sessionId: "session-a", repos: [], selectedRepoId: "/repo/a",
    comparison: { ...state(key).comparison, ignoreWhitespace: pin.ignoreWhitespace },
    request: { scope: "sessionChanges", sessionId: "session-a", clientId: pin.clientId, diffId: pin.diffId!, changeKind: "unstaged", detailMode: "filePatch" } } };
}

function content(pin: PinnedDiff, key: string, patch: string): ServerMessage {
  return { type: "diff.content", content: { targetClientId: pin.clientId, diffId: pin.diffId!, scope: pin.scope,
    comparisonKey: key, file: { newPath: "a.ts" }, patch, rows: [], truncated: false, contextLines: pin.contextLines,
    ignoreWhitespace: pin.ignoreWhitespace, generatedAt: "now" } };
}

describe("PinnedDiff request ownership", () => {
  it("keeps the captured patch while refreshing, rejects previous generations and another pin's replies", () => {
    const { pin, sent } = harness();
    const other = harness("client-b").pin;
    pin.refresh();
    const oldSummary = summary(pin, "stale");
    const oldContent = content(pin, "stale", "wrong patch");
    pin.refresh();
    expect(sent).toContainEqual({ type: "diff.cancel", clientId: "client-a", diffId: "generation-1", scope: "sessionChanges", reason: "refreshed" });
    pin.handle(oldSummary);
    pin.handle(oldContent);
    expect(pin.state.comparison.comparisonKey).toBe("original");
    expect(pin.cache.get(pinnedPatchKey(pin.state, "a.ts"))?.patch).toBe("old patch");
    expect(other.handle(summary(pin, "new"))).toBe(false);
    pin.handle(summary(pin, "new"));
    expect(pin.loading).toBe(true);
    expect(pin.state.comparison.comparisonKey).toBe("original");
    pin.handle(content(pin, "new", "new patch"));
    expect(pin.loading).toBe(false);
    expect(pin.state.comparison.comparisonKey).toBe("new");
    expect(pin.cache.get(pinnedPatchKey(pin.state, "a.ts"))?.patch).toBe("new patch");
    expect(other.cache.get(pinnedPatchKey(other.state, "a.ts"))?.patch).toBe("old patch");
  });

  it("keeps failures readable and rejects late replies after disconnect and close", () => {
    const { pin, sent } = harness();
    pin.refresh();
    const response = summary(pin, "late");
    pin.disconnect();
    expect(pin.loading).toBe(false);
    expect(pin.error).toContain("Connection closed");
    pin.handle(response);
    expect(pin.state.comparison.comparisonKey).toBe("original");
    expect(pin.cache.size).toBe(1);
    pin.refresh();
    const afterClose = summary(pin, "closed");
    const diffId = pin.diffId;
    pin.close();
    pin.handle(afterClose);
    expect(pin.state.comparison.comparisonKey).toBe("original");
    expect(pin.cache.size).toBe(0);
    expect(sent.at(-1)).toEqual({ type: "diff.cancel", clientId: pin.clientId, diffId, scope: "sessionChanges", reason: "closed" });
  });

  it("keeps the user's latest file choice when selection changes during a refresh", () => {
    const { pin } = harness();
    pin.refresh();
    const oldSummary = summary(pin, "obsolete");
    pin.selectFile(null);
    pin.handle(oldSummary);
    expect(pin.selectedFile).toBeNull();
    const latest = summary(pin, "latest");
    pin.handle(latest);
    const aggregate = content(pin, "latest", "all files");
    if (aggregate.type !== "diff.content") throw new Error("Expected content");
    aggregate.content.file = null;
    pin.handle(aggregate);
    expect(pin.selectedFile).toBeNull();
    expect(pin.cache.get(pinnedPatchKey(pin.state, null))?.patch).toBe("all files");
  });

  it("pins an initial History commit through its OID without trying to resolve the empty tree as a commit", () => {
    const initial = state();
    initial.review.currentCommitOid = "b".repeat(40);
    initial.comparison.base = { kind: "emptyTree" };
    initial.comparison.head = { kind: "commit", oid: "b".repeat(40), shortOid: "bbbbbbbbbbbb" };
    const { pin, sent } = harness("history-owner", initial);
    pin.refresh();
    expect(sent[0]).toMatchObject({ type: "sessionChanges.request", sessionId: "session-a", repoId: "/repo/a", currentCommitOid: "b".repeat(40) });
  });

  it("pins historical resolved OIDs rather than branch labels", () => {
    const initial = state();
    initial.comparison.base = { kind: "gitRef", input: "main", display: "main", refKind: "branch", oid: "a".repeat(40) };
    initial.comparison.head = { kind: "gitRef", input: "topic", display: "topic", refKind: "branch", oid: "b".repeat(40) };
    initial.comparison.rightTreeOrCommit = "b".repeat(40);
    const sent: ClientMessage[] = [];
    const pin = new PinnedDiff("client-history", null, "No agent", initial,
      { selectedFile: null, layout: "unified", ignoreWhitespace: false },
      message => { sent.push(message); return true; }, () => "history-generation", () => {});
    pin.refresh();
    expect(sent[0]).toMatchObject({ type: "compareDiff.request", repoRoot: "/repo/a",
      base: { kind: "gitRef", value: "a".repeat(40) }, head: { kind: "gitRef", value: "b".repeat(40) }, mergeBase: false });
    expect(pin.ownerSessionId).toBeNull();
  });

  it("rejects wrong whitespace and file responses without replacing the captured patch", () => {
    const { pin } = harness();
    pin.ignoreWhitespace = true;
    pin.refresh();
    pin.handle(summary(pin, "whitespace"));
    const wrong = content(pin, "whitespace", "wrong");
    if (wrong.type !== "diff.content") throw new Error("Expected content");
    wrong.content.ignoreWhitespace = false;
    pin.handle(wrong);
    expect(pin.state.comparison.comparisonKey).toBe("original");
    wrong.content.ignoreWhitespace = true;
    wrong.content.file = { newPath: "another.ts" };
    pin.handle(wrong);
    expect(pin.state.comparison.comparisonKey).toBe("original");
    pin.handle(content(pin, "whitespace", "filtered"));
    expect(pin.state.comparison.ignoreWhitespace).toBe(true);
    expect(pin.cache.get(pinnedPatchKey(pin.state, "a.ts"))?.patch).toBe("filtered");
  });
});
