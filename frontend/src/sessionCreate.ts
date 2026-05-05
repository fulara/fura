import type { ClientMessage, SessionMode, WorktreeCreateOptions } from "./protocol";

export type SessionCreateDraft = {
  requestId: string;
  name?: string;
  cwd?: string;
  category?: string;
  sessionMode?: SessionMode;
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

export type WorktreeCreateViewInput = {
  enabled: boolean;
  defaultCwd?: string | null;
  normalCwd?: string | null;
  sessionName?: string | null;
  sourceRepo?: string | null;
  directory?: string | null;
  baseBranch?: string | null;
  branchName?: string | null;
  sourceRepoAutofill: boolean;
  directoryAutofill: boolean;
  baseBranchAutofill: boolean;
  branchAutofill: boolean;
};

export type WorktreeCreateViewModel = {
  enabled: boolean;
  sourceRepo: string;
  directory: string;
  baseBranch: string;
  branchName: string;
  lastAutofilledDirectory: string;
  lastAutofilledBranch: string;
  summary: string;
};

export function trimSessionCreateText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function validateGitBranchName(value: string | null | undefined): string | null {
  const branchName = trimSessionCreateText(value);
  if (!branchName) return null;
  if (branchName.startsWith("-")) return "Branch name must not start with '-'.";
  if (branchName === "@") return "Branch name must not be '@'.";
  if (branchName.startsWith("/") || branchName.endsWith("/") || branchName.includes("//")) {
    return "Branch name must not start with '/', end with '/', or contain '//'.";
  }
  if (branchName.endsWith(".")) return "Branch name must not end with '.'.";
  if (branchName.includes("..")) return "Branch name must not contain '..'.";
  if (branchName.includes("@{")) return "Branch name must not contain '@{'.";
  if (branchName.includes("\\")) return "Branch name must not contain '\\'.";
  if (/[\x00-\x20\x7f~^:?*\[]/u.test(branchName)) {
    return "Branch name must not contain spaces, control characters, or any of ~ ^ : ? * [.";
  }
  const invalidComponent = branchName
    .split("/")
    .find(component => component.startsWith(".") || component.endsWith(".lock"));
  if (invalidComponent) {
    return "Branch path components must not start with '.' or end with '.lock'.";
  }
  return null;
}

export function trimTrailingPathSeparators(value: string): string {
  if (value.length <= 1) return value;
  return value.replace(/[\\/]+$/, "");
}

export function pathSeparatorFor(value: string): string {
  return value.includes("\\") && !value.includes("/") ? "\\" : "/";
}

export function worktreeDirectorySeed(sourceRepo: string): string {
  const source = trimSessionCreateText(sourceRepo);
  if (!source) return "";
  return `${trimTrailingPathSeparators(source)}${pathSeparatorFor(source)}`;
}

export function worktreeDirectoryForSession(sourceRepo: string, sessionName: string): string {
  const source = trimSessionCreateText(sourceRepo);
  const name = trimSessionCreateText(sessionName);
  if (!source || !name) return worktreeDirectorySeed(source);
  return `${trimTrailingPathSeparators(source)}-${name}`;
}

export function deriveWorktreeCreateView(input: WorktreeCreateViewInput): WorktreeCreateViewModel {
  const normalCwd = trimSessionCreateText(input.normalCwd);
  const defaultCwd = trimSessionCreateText(input.defaultCwd);
  const sourceRepo = input.sourceRepoAutofill
    ? normalCwd || defaultCwd || trimSessionCreateText(input.sourceRepo)
    : trimSessionCreateText(input.sourceRepo);
  const sessionName = trimSessionCreateText(input.sessionName);
  const lastAutofilledDirectory = worktreeDirectoryForSession(sourceRepo, sessionName);
  const directory = input.directoryAutofill ? lastAutofilledDirectory : trimSessionCreateText(input.directory);
  const baseBranch = input.baseBranchAutofill ? "HEAD" : trimSessionCreateText(input.baseBranch);
  const lastAutofilledBranch = sessionName;
  const branchName = input.branchAutofill ? lastAutofilledBranch : trimSessionCreateText(input.branchName);
  return {
    enabled: input.enabled,
    sourceRepo,
    directory,
    baseBranch,
    branchName,
    lastAutofilledDirectory,
    lastAutofilledBranch,
    summary: formatWorktreeCreateSummary({ enabled: input.enabled, sourceRepo, directory, baseBranch, branchName }),
  };
}

export function formatWorktreeCreateSummary(worktree: {
  enabled: boolean;
  sourceRepo?: string | null;
  directory?: string | null;
  baseBranch?: string | null;
  branchName?: string | null;
}): string {
  if (!worktree.enabled) return "Create a normal session in the selected working directory.";
  const sourceRepo = trimSessionCreateText(worktree.sourceRepo) || "source repo";
  const directory = trimSessionCreateText(worktree.directory) || "new worktree directory";
  const baseBranch = trimSessionCreateText(worktree.baseBranch) || "base ref";
  const branchName = trimSessionCreateText(worktree.branchName);
  return branchName
    ? `Create branch ${branchName} from ${baseBranch} at ${directory}, using ${sourceRepo}.`
    : `Create a worktree from ${baseBranch} at ${directory}, using ${sourceRepo}.`;
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
  const sessionMode = draft.sessionMode === "diffReview" ? draft.sessionMode : undefined;
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
    const branchNameError = validateGitBranchName(worktree.branchName);
    if (branchNameError) {
      return { type: "invalid", message: branchNameError, target: "worktreeBranchName" };
    }
    return {
      type: "message",
      message: {
        type: "session.create",
        requestId,
        name,
        ...(category ? { category } : {}),
        ...(sessionMode ? { sessionMode } : {}),
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
      ...(sessionMode ? { sessionMode } : {}),
      cwd,
    },
  };
}
