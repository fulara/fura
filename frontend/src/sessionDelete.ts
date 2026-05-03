import { shortId } from "./format";
import type { SessionSummary } from "./protocol";

export type SessionDeleteView = {
  sessionId: string;
  label: string;
  message: string;
  canDeleteWorktree: boolean;
  worktreePath: string | null;
  worktreeHelp: string;
};

export function deriveSessionDeleteView(session: SessionSummary): SessionDeleteView {
  const label = session.title || shortId(session.sessionId);
  const worktreePath = normalizeWorktreePath(session.worktree?.path);
  return {
    sessionId: session.sessionId,
    label,
    message: `Delete session "${label}"? This will stop the session and permanently delete its file.`,
    canDeleteWorktree: Boolean(worktreePath),
    worktreePath,
    worktreeHelp: worktreePath
      ? `Linked worktree: ${worktreePath}`
      : "Fura does not know this session as a managed git worktree.",
  };
}

export function sessionDeleteMessage(view: SessionDeleteView, deleteWorktree: boolean): { type: "session.delete"; sessionId: string; deleteWorktree?: boolean } {
  return view.canDeleteWorktree && deleteWorktree
    ? { type: "session.delete", sessionId: view.sessionId, deleteWorktree: true }
    : { type: "session.delete", sessionId: view.sessionId };
}

function normalizeWorktreePath(path: string | null | undefined): string | null {
  const trimmed = path?.trim() ?? "";
  return trimmed ? trimmed : null;
}
