import type { ClientMessage, SessionProjection, SessionSummary } from "./protocol";

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
