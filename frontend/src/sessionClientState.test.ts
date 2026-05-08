import { describe, expect, it } from "vitest";
import type { SessionProjection, SessionSummary } from "./protocol";
import {
  activateSession,
  applySessionDelta,
  applySessionSnapshot,
  applySessionsSnapshot,
  mergeSessionSummary,
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
      transcript: [{ kind: "message", id: "m1", role: "assistant", blocks: [{ kind: "text", text: "old" }], timestamp: null, isNew: false }],
      isBusy: true,
    });
    const projections = new Map([["a", existing]]);

    const result = applySessionDelta([summary("a")], projections, "a", {
      summary: summary("a", { status: "idle", messageCount: 2 }),
      transcriptReplaceFrom: 1,
      transcriptAppend: [{ kind: "message", id: "m2", role: "assistant", blocks: [{ kind: "text", text: "new" }], timestamp: null, isNew: true }],
      isBusy: false,
      tokensTotal: 12,
      costUsd: 0.01,
      todoPhases: [],
    });

    expect(result?.projections.get("a")?.transcript.map(entry => entry.kind === "message" ? entry.id : entry.toolCallId)).toEqual(["m1", "m2"]);
    expect(result?.projections.get("a")?.isBusy).toBe(false);
    expect(result?.sessions[0]?.messageCount).toBe(2);
    expect(projections.get("a")).toBe(existing);
  });

  it("replaces the transcript tail from the supplied replace-from index", () => {
    const existing = projection("a", {
      transcript: [
        { kind: "message", id: "m1", role: "assistant", blocks: [{ kind: "text", text: "stable" }], timestamp: null, isNew: false },
        { kind: "message", id: "streaming", role: "assistant", blocks: [{ kind: "text", text: "old partial" }], timestamp: null, isNew: true },
      ],
    });
    const result = applySessionDelta([summary("a")], new Map([["a", existing]]), "a", {
      summary: summary("a", { messageCount: 1 }),
      transcriptReplaceFrom: 1,
      transcriptAppend: [{ kind: "message", id: "streaming", role: "assistant", blocks: [{ kind: "text", text: "new partial" }], timestamp: null, isNew: true }],
      isBusy: true,
      tokensTotal: 0,
      costUsd: 0,
      todoPhases: [],
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
    })).toBeNull();
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
