import { describe, expect, it } from "vitest";
import { deriveSessionDeleteView, sessionDeleteMessage } from "./sessionDelete";
import type { SessionSummary } from "./protocol";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    kind: "managed",
    sessionMode: "standard",
    sessionId: "session-123456",
    cwd: "/repo",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    ...overrides,
  };
}

describe("session delete view model", () => {
  it("enables worktree deletion only for Fura-managed worktree sessions", () => {
    const view = deriveSessionDeleteView(summary({ title: "Feature", worktree: { path: "/repo-feature" } }));

    expect(view).toMatchObject({
      sessionId: "session-123456",
      label: "Feature",
      canDeleteWorktree: true,
      worktreePath: "/repo-feature",
      worktreeHelp: "Linked worktree: /repo-feature",
    });
    expect(sessionDeleteMessage(view, true)).toEqual({
      type: "session.delete",
      sessionId: "session-123456",
      deleteWorktree: true,
    });
  });

  it("does not send deleteWorktree for regular sessions", () => {
    const view = deriveSessionDeleteView(summary({ worktree: null }));

    expect(view.canDeleteWorktree).toBe(false);
    expect(view.worktreeHelp).toBe("Fura does not know this session as a managed git worktree.");
    expect(sessionDeleteMessage(view, true)).toEqual({
      type: "session.delete",
      sessionId: "session-123456",
    });
  });
});
