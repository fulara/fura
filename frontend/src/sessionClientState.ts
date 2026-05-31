import type { ClientMessage, SessionProjection, SessionProjectionDelta, SessionSummary, TranscriptEntry } from "./protocol";

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

function transcriptEntryKey(entry: TranscriptEntry): string {
  return entry.kind === "message" ? `m:${entry.id}` : `${entry.kind === "review" ? "r" : "t"}:${entry.toolCallId}`;
}

function transcriptEntryIsLive(entry: TranscriptEntry): boolean {
  // A message the bridge flagged as freshly arrived, or a tool/review card still in flight.
  return entry.kind === "message" ? entry.isNew : entry.isActive;
}

/**
 * Whether `next` should light the unread "new activity" dot relative to what this client last knew.
 *
 * With a `previous` baseline: true only when `next` introduces a transcript entry
 * (message/tool/review) whose id `previous` did not already contain. Metadata-only updates — status
 * flips, token/cost/context/goal ticks, pending-ask changes, and in-place tool-card progress (same
 * id, new content) — return false. This kills the periodic no-new-message snapshots/deltas a live
 * session emits while otherwise idle.
 *
 * Without a baseline (first projection this client has seen for the session): the transcript is the
 * session's existing state, not necessarily new activity, so light only when it carries a live entry
 * (an `isNew` message or an in-flight card). A pure metadata/historical first snapshot for a
 * never-opened session must not light the dot.
 */
export function projectionAddsTranscriptEntries(
  previous: SessionProjection | undefined,
  next: SessionProjection,
): boolean {
  if (next.transcript.length === 0) return false;
  if (!previous) return next.transcript.some(transcriptEntryIsLive);
  const known = new Set<string>();
  for (const entry of previous.transcript) known.add(transcriptEntryKey(entry));
  for (const entry of next.transcript) {
    if (!known.has(transcriptEntryKey(entry))) return true;
  }
  return false;
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
