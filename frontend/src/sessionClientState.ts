import type { ClientMessage, SessionProjection, SessionProjectionDelta, SessionSummary } from "./protocol";

export type SessionsSnapshotUpdate = {
  sessions: SessionSummary[];
  activeSessionId: string | null;
};

export type SessionSnapshotUpdate = {
  sessions: SessionSummary[];
  projections: Map<string, SessionProjection>;
};

export function applySessionsSnapshot(
  sessions: SessionSummary[],
  activeSessionId: string | null,
): SessionsSnapshotUpdate {
  return {
    sessions,
    activeSessionId: activeSessionId && sessions.some(session => session.sessionId === activeSessionId)
      ? activeSessionId
      : null,
  };
}

export function mergeSessionSummary(sessions: SessionSummary[], summary: SessionSummary): SessionSummary[] {
  const index = sessions.findIndex(session => session.sessionId === summary.sessionId);
  if (index === -1) return [summary, ...sessions];
  const nextSessions = sessions.slice();
  nextSessions[index] = summary;
  return nextSessions;
}

export function applySessionSnapshot(
  sessions: SessionSummary[],
  projections: ReadonlyMap<string, SessionProjection>,
  sessionId: string,
  projection: SessionProjection,
): SessionSnapshotUpdate {
  const nextProjections = new Map(projections);
  nextProjections.set(sessionId, projection);
  return {
    sessions: mergeSessionSummary(sessions, projection.summary),
    projections: nextProjections,
  };
}

export function applySessionDelta(
  sessions: SessionSummary[],
  projections: ReadonlyMap<string, SessionProjection>,
  sessionId: string,
  delta: SessionProjectionDelta,
): SessionSnapshotUpdate | null {
  const previous = projections.get(sessionId);
  // Gap detection: the delta must apply directly on top of the projection we
  // hold. `baseSeq` is the server's broadcast sequence the delta extends; if it
  // does not match our stored `seq` we have missed (or reordered) a broadcast —
  // from a disconnect, broadcast-channel lag, or per-connection conflation — and
  // must resync from a fresh snapshot rather than splice onto a stale base.
  // The transcript-length check stays as a defensive backstop.
  if (!previous || previous.seq !== delta.baseSeq) return null;
  if (previous.transcript.length < delta.transcriptReplaceFrom) return null;
  const projection: SessionProjection = {
    summary: delta.summary,
    transcript: [...previous.transcript.slice(0, delta.transcriptReplaceFrom), ...delta.transcriptAppend],
    isBusy: delta.isBusy,
    model: delta.model,
    thinkingLevel: delta.thinkingLevel,
    tokensTotal: delta.tokensTotal,
    costUsd: delta.costUsd,
    contextTokens: delta.contextTokens,
    contextWindow: delta.contextWindow,
    contextPercent: delta.contextPercent,
    planMode: delta.planMode,
    pendingPlanReview: delta.pendingPlanReview,
    goalMode: delta.goalMode,
    todoPhases: delta.todoPhases,
    pendingAsk: delta.pendingAsk,
    seq: delta.seq,
  };
  return applySessionSnapshot(sessions, projections, sessionId, projection);
}

export function activateSession(unreadSessionIds: Set<string>, sessionId: string): string {
  unreadSessionIds.delete(sessionId);
  return sessionId;
}

export function sessionOpenOrAttachMessage(session: SessionSummary): ClientMessage {
  if (session.kind === "available" && session.sessionFile) {
    return { type: "session.open", sessionFile: session.sessionFile };
  }
  return { type: "session.attach", sessionId: session.sessionId };
}
