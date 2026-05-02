import type { ClientMessage, WorktreeCreateOptions } from "./protocol";

export type SessionCreateDraft = {
  requestId: string;
  name?: string;
  cwd?: string;
  category?: string;
  worktree?: {
    enabled: boolean;
    sourceRepo?: string;
    directory?: string;
    baseBranch?: string;
    branchName?: string;
  };
};

export type SessionCreateValidationTarget =
  | "name"
  | "cwd"
  | "worktreeSourceRepo"
  | "worktreeDirectory"
  | "worktreeBaseBranch"
  | "worktreeBranchName";

export type SessionCreateResult =
  | { type: "invalid"; message: string; target: SessionCreateValidationTarget }
  | { type: "message"; message: ClientMessage };

export function trimSessionCreateText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function buildWorktreeCreateOptions(draft: SessionCreateDraft): WorktreeCreateOptions | null {
  const worktree = draft.worktree;
  if (!worktree?.enabled) return null;
  const branchName = trimSessionCreateText(worktree.branchName);
  return {
    sourceRepo: trimSessionCreateText(worktree.sourceRepo),
    directory: trimSessionCreateText(worktree.directory),
    baseBranch: trimSessionCreateText(worktree.baseBranch),
    ...(branchName ? { branchName } : {}),
  };
}

export function resolveSessionCreateMessage(draft: SessionCreateDraft): SessionCreateResult {
  const requestId = trimSessionCreateText(draft.requestId);
  const name = trimSessionCreateText(draft.name);
  const category = trimSessionCreateText(draft.category);
  if (!requestId) {
    return { type: "invalid", message: "Request id is required.", target: "name" };
  }

  if (draft.worktree?.enabled) {
    if (!name) {
      return { type: "invalid", message: "Session name is required when creating a worktree.", target: "name" };
    }
    const worktree = buildWorktreeCreateOptions(draft);
    if (!worktree?.directory) {
      return { type: "invalid", message: "Worktree working directory is required.", target: "worktreeDirectory" };
    }
    if (!worktree.sourceRepo) {
      return { type: "invalid", message: "Source repo root is required.", target: "worktreeSourceRepo" };
    }
    if (!worktree.baseBranch) {
      return { type: "invalid", message: "Base branch/ref is required.", target: "worktreeBaseBranch" };
    }
    if (worktree.baseBranch.startsWith("-")) {
      return { type: "invalid", message: "Base branch/ref must not start with '-'.", target: "worktreeBaseBranch" };
    }
    if (worktree.branchName?.startsWith("-")) {
      return { type: "invalid", message: "Branch name must not start with '-'.", target: "worktreeBranchName" };
    }
    return {
      type: "message",
      message: {
        type: "session.create",
        requestId,
        name,
        ...(category ? { category } : {}),
        worktree,
      },
    };
  }

  const cwd = trimSessionCreateText(draft.cwd);
  if (!cwd) {
    return { type: "invalid", message: "Working directory is required.", target: "cwd" };
  }
  return {
    type: "message",
    message: {
      type: "session.create",
      requestId,
      ...(name ? { name } : {}),
      ...(category ? { category } : {}),
      cwd,
    },
  };
}
