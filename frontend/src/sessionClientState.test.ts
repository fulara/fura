import { describe, expect, it } from "vitest";
import type { SessionProjection, SessionSummary, TranscriptEntry } from "./protocol";
import {
  activateSession,
  applySessionDelta,
  applySessionSnapshot,
  applySessionsSnapshot,
  mergeSessionSummary,
  projectionAddsTranscriptEntries,
  sessionOpenOrAttachMessage,
} from "./sessionClientState";

function summary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    kind: "managed",
    sessionMode: "standard",
    sessionId,
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    ...overrides,
  };
}

function projection(sessionId: string, overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    summary: summary(sessionId),
    transcript: [],
    isBusy: false,
    tokensTotal: 0,
    costUsd: 0,
    todoPhases: [],
    seq: 0,
    ...overrides,
  };
}

describe("applySessionsSnapshot", () => {
  it("keeps the active session when it remains present", () => {
    const sessions = [summary("a"), summary("b")];

    expect(applySessionsSnapshot(sessions, "b")).toEqual({ sessions, activeSessionId: "b" });
  });

  it("clears the active session when it disappears", () => {
    const sessions = [summary("a")];

    expect(applySessionsSnapshot(sessions, "missing")).toEqual({ sessions, activeSessionId: null });
  });
});

describe("mergeSessionSummary", () => {
  it("prepends new summaries", () => {
    const sessions = [summary("existing")];
    const next = mergeSessionSummary(sessions, summary("new"));

    expect(next.map(session => session.sessionId)).toEqual(["new", "existing"]);
    expect(next).not.toBe(sessions);
  });

  it("replaces existing summaries without mutating the input", () => {
    const original = summary("a", { title: "old" });
    const sessions = [original, summary("b")];
    const next = mergeSessionSummary(sessions, summary("a", { title: "new" }));

    expect(next[0]?.title).toBe("new");
    expect(sessions[0]).toBe(original);
    expect(sessions[0]?.title).toBe("old");
  });
});

describe("applySessionSnapshot", () => {
  it("returns updated sessions and projections without mutating the input map", () => {
    const oldProjection = projection("old");
    const projections = new Map([["old", oldProjection]]);
    const nextProjection = projection("new", { summary: summary("new", { title: "New session" }) });

    const result = applySessionSnapshot([summary("old")], projections, "new", nextProjection);

    expect(result.sessions.map(session => session.sessionId)).toEqual(["new", "old"]);
    expect(result.projections.get("new")).toBe(nextProjection);
    expect(result.projections.get("old")).toBe(oldProjection);
    expect(result.projections).not.toBe(projections);
    expect(projections.has("new")).toBe(false);
  });
});

describe("applySessionDelta", () => {
  it("appends transcript entries and replaces scalar projection state", () => {
    const existing = projection("a", {
      transcript: [{ kind: "message", id: "m1", role: "assistant", blocks: [{ kind: "text", text: "old" }], timestamp: null, isNew: false, renderHash: "m1-old" }],
      isBusy: true,
    });
    const projections = new Map([["a", existing]]);

    const result = applySessionDelta([summary("a")], projections, "a", {
      summary: summary("a", { status: "idle", messageCount: 2 }),
      transcriptReplaceFrom: 1,
      transcriptAppend: [{ kind: "message", id: "m2", role: "assistant", blocks: [{ kind: "text", text: "new" }], timestamp: null, isNew: true, renderHash: "m2-new" }],
      isBusy: false,
      tokensTotal: 12,
      costUsd: 0.01,
      todoPhases: [],
      baseSeq: 0,
      seq: 1,
    });

    expect(result?.projections.get("a")?.transcript.map(entry => entry.kind === "message" ? entry.id : entry.toolCallId)).toEqual(["m1", "m2"]);
    expect(result?.projections.get("a")?.isBusy).toBe(false);
    expect(result?.sessions[0]?.messageCount).toBe(2);
    expect(projections.get("a")).toBe(existing);
  });

  it("replaces the transcript tail from the supplied replace-from index", () => {
    const existing = projection("a", {
      transcript: [
        { kind: "message", id: "m1", role: "assistant", blocks: [{ kind: "text", text: "stable" }], timestamp: null, isNew: false, renderHash: "m1-stable" },
        { kind: "message", id: "streaming", role: "assistant", blocks: [{ kind: "text", text: "old partial" }], timestamp: null, isNew: true, renderHash: "streaming-old" },
      ],
    });
    const result = applySessionDelta([summary("a")], new Map([["a", existing]]), "a", {
      summary: summary("a", { messageCount: 1 }),
      transcriptReplaceFrom: 1,
      transcriptAppend: [{ kind: "message", id: "streaming", role: "assistant", blocks: [{ kind: "text", text: "new partial" }], timestamp: null, isNew: true, renderHash: "streaming-new" }],
      isBusy: true,
      tokensTotal: 0,
      costUsd: 0,
      todoPhases: [],
      baseSeq: 0,
      seq: 1,
    });

    expect(result?.projections.get("a")?.transcript).toHaveLength(2);
    expect(result?.projections.get("a")?.transcript[1]).toMatchObject({
      kind: "message",
      id: "streaming",
      blocks: [{ kind: "text", text: "new partial" }],
    });
  });

  it("returns null when the delta replace-from index is beyond the current transcript", () => {
    const projections = new Map([["a", projection("a")]]);

    expect(applySessionDelta([summary("a")], projections, "a", {
      summary: summary("a"),
      transcriptReplaceFrom: 1,
      transcriptAppend: [],
      isBusy: false,
      tokensTotal: 0,
      costUsd: 0,
      todoPhases: [],
      baseSeq: 0,
      seq: 1,
    })).toBeNull();
  });

  it("returns null when the delta baseSeq does not match the stored seq", () => {
    // The stored projection is at seq 0 but the delta extends seq 1 — a broadcast
    // was missed (disconnect/lag/conflation), so we must resync, not splice.
    const existing = projection("a", {
      transcript: [{ kind: "message", id: "m1", role: "assistant", blocks: [{ kind: "text", text: "old" }], timestamp: null, isNew: false, renderHash: "m1-old" }],
      seq: 0,
    });
    expect(applySessionDelta([summary("a")], new Map([["a", existing]]), "a", {
      summary: summary("a", { messageCount: 1 }),
      transcriptReplaceFrom: 1,
      transcriptAppend: [{ kind: "message", id: "m2", role: "assistant", blocks: [{ kind: "text", text: "new" }], timestamp: null, isNew: true, renderHash: "m2-new" }],
      isBusy: false,
      tokensTotal: 0,
      costUsd: 0,
      todoPhases: [],
      baseSeq: 1,
      seq: 2,
    })).toBeNull();
  });

  it("advances the stored seq to the delta seq when applied", () => {
    const existing = projection("a", {
      transcript: [{ kind: "message", id: "m1", role: "assistant", blocks: [{ kind: "text", text: "old" }], timestamp: null, isNew: false, renderHash: "m1-old" }],
      seq: 5,
    });
    const result = applySessionDelta([summary("a")], new Map([["a", existing]]), "a", {
      summary: summary("a", { messageCount: 1 }),
      transcriptReplaceFrom: 1,
      transcriptAppend: [{ kind: "message", id: "m2", role: "assistant", blocks: [{ kind: "text", text: "new" }], timestamp: null, isNew: true, renderHash: "m2-new" }],
      isBusy: false,
      tokensTotal: 0,
      costUsd: 0,
      todoPhases: [],
      baseSeq: 5,
      seq: 6,
    });
    expect(result?.projections.get("a")?.seq).toBe(6);
  });
});

describe("activateSession", () => {
  it("clears unread state and returns the active session id", () => {
    const unread = new Set(["a", "b"]);

    expect(activateSession(unread, "a")).toBe("a");
    expect(Array.from(unread)).toEqual(["b"]);
  });
});

describe("sessionOpenOrAttachMessage", () => {
  it("opens saved available sessions by session file", () => {
    expect(sessionOpenOrAttachMessage(summary("saved", {
      kind: "available",
      status: "available",
      sessionFile: "/tmp/session.jsonl",
    }))).toEqual({ type: "session.open", sessionFile: "/tmp/session.jsonl" });
  });

  it("attaches managed sessions by session id", () => {
    expect(sessionOpenOrAttachMessage(summary("live"))).toEqual({ type: "session.attach", sessionId: "live" });
  });

  it("attaches available sessions that lack a session file instead of inventing one", () => {
    expect(sessionOpenOrAttachMessage(summary("saved", {
      kind: "available",
      status: "available",
    }))).toEqual({ type: "session.attach", sessionId: "saved" });
  });
});

function messageEntry(id: string, overrides: Partial<Extract<TranscriptEntry, { kind: "message" }>> = {}): TranscriptEntry {
  return { kind: "message", id, role: "assistant", blocks: [], isNew: true, ...overrides };
}

function toolEntry(toolCallId: string, overrides: Partial<Extract<TranscriptEntry, { kind: "tool" }>> = {}): TranscriptEntry {
  return {
    kind: "tool",
    toolCallId,
    toolName: "bash",
    args: {},
    isActive: true,
    isError: false,
    ...overrides,
  };
}

describe("projectionAddsTranscriptEntries", () => {
  it("flags a never-seen session whose first projection carries a live message", () => {
    expect(projectionAddsTranscriptEntries(undefined, projection("a", { transcript: [messageEntry("m1", { isNew: true })] }))).toBe(true);
  });

  it("flags a never-seen session whose first projection has an in-flight tool card", () => {
    expect(projectionAddsTranscriptEntries(undefined, projection("a", { transcript: [toolEntry("t1", { isActive: true })] }))).toBe(true);
  });

  it("does not flag a never-seen session hydrated with only historical entries", () => {
    const transcript = [messageEntry("m1", { isNew: false }), toolEntry("t1", { isActive: false })];
    expect(projectionAddsTranscriptEntries(undefined, projection("a", { transcript }))).toBe(false);
  });

  it("does not flag a never-seen session with an empty transcript", () => {
    expect(projectionAddsTranscriptEntries(undefined, projection("a"))).toBe(false);
  });

  it("ignores metadata-only updates that keep the same transcript ids", () => {
    const previous = projection("a", { transcript: [messageEntry("m1")], summary: summary("a", { status: "idle" }), tokensTotal: 10 });
    const next = projection("a", { transcript: [messageEntry("m1")], summary: summary("a", { status: "busy" }), tokensTotal: 99 });
    expect(projectionAddsTranscriptEntries(previous, next)).toBe(false);
  });

  it("ignores in-place tool-card progress that keeps the same tool id", () => {
    const previous = projection("a", { transcript: [toolEntry("t1", { result: undefined })] });
    const next = projection("a", { transcript: [toolEntry("t1", { isActive: false, result: { ok: true } })] });
    expect(projectionAddsTranscriptEntries(previous, next)).toBe(false);
  });

  it("flags a newly appended message", () => {
    const previous = projection("a", { transcript: [messageEntry("m1")] });
    const next = projection("a", { transcript: [messageEntry("m1"), messageEntry("m2")] });
    expect(projectionAddsTranscriptEntries(previous, next)).toBe(true);
  });

  it("flags a newly started tool card", () => {
    const previous = projection("a", { transcript: [messageEntry("m1")] });
    const next = projection("a", { transcript: [messageEntry("m1"), toolEntry("t1")] });
    expect(projectionAddsTranscriptEntries(previous, next)).toBe(true);
  });

  it("does not flag a transcript that shrank after suppressed compaction", () => {
    const previous = projection("a", { transcript: [messageEntry("m1"), messageEntry("m2")] });
    const next = projection("a", { transcript: [messageEntry("m2")] });
    expect(projectionAddsTranscriptEntries(previous, next)).toBe(false);
  });
});
