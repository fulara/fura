import { describe, expect, it } from "vitest";
import {
  buildWorktreeCreateOptions,
  deriveWorktreeCreateView,
  formatWorktreeCreateSummary,
  resolveSessionCreateMessage,
  trimSessionCreateText,
  worktreeDirectoryForSession,
  worktreeDirectorySeed,
} from "./sessionCreate";

describe("worktree path helpers", () => {
  it("builds directory seeds with the source path separator", () => {
    expect(worktreeDirectorySeed("/repo/project")).toBe("/repo/project/");
    expect(worktreeDirectoryForSession("/repo/project/", "feature")).toBe("/repo/project-feature");
    expect(worktreeDirectoryForSession("C:\\repo\\project", "feature")).toBe("C:\\repo\\project-feature");
  });
});

describe("deriveWorktreeCreateView", () => {
  it("derives shared source, directory, branch, base, and summary defaults", () => {
    expect(deriveWorktreeCreateView({
      enabled: true,
      defaultCwd: "/default",
      normalCwd: "/repo/project",
      sessionName: "feature mobile",
      sourceRepo: "",
      directory: "",
      baseBranch: "",
      branchName: "",
      sourceRepoAutofill: true,
      directoryAutofill: true,
      baseBranchAutofill: true,
      branchAutofill: true,
    })).toEqual({
      enabled: true,
      sourceRepo: "/repo/project",
      directory: "/repo/project-feature mobile",
      baseBranch: "HEAD",
      branchName: "feature mobile",
      lastAutofilledDirectory: "/repo/project-feature mobile",
      lastAutofilledBranch: "feature mobile",
      summary: "Create branch feature mobile from HEAD at /repo/project-feature mobile, using /repo/project.",
    });
  });

  it("preserves manually edited worktree fields", () => {
    expect(deriveWorktreeCreateView({
      enabled: true,
      defaultCwd: "/default",
      normalCwd: "/repo/project",
      sessionName: "feature mobile",
      sourceRepo: "/custom/source",
      directory: "/custom/worktree",
      baseBranch: "main",
      branchName: "feature/custom",
      sourceRepoAutofill: false,
      directoryAutofill: false,
      baseBranchAutofill: false,
      branchAutofill: false,
    })).toMatchObject({
      sourceRepo: "/custom/source",
      directory: "/custom/worktree",
      baseBranch: "main",
      branchName: "feature/custom",
      summary: "Create branch feature/custom from main at /custom/worktree, using /custom/source.",
    });
  });
});

describe("formatWorktreeCreateSummary", () => {
  it("describes normal and worktree session creates", () => {
    expect(formatWorktreeCreateSummary({ enabled: false })).toBe("Create a normal session in the selected working directory.");
    expect(formatWorktreeCreateSummary({ enabled: true, sourceRepo: "/repo", directory: "/repo-feature", baseBranch: "HEAD" }))
      .toBe("Create a worktree from HEAD at /repo-feature, using /repo.");
  });
});

describe("trimSessionCreateText", () => {
  it("trims missing and present values", () => {
    expect(trimSessionCreateText(undefined)).toBe("");
    expect(trimSessionCreateText(null)).toBe("");
    expect(trimSessionCreateText("  value  ")).toBe("value");
  });
});

describe("buildWorktreeCreateOptions", () => {
  it("returns null when worktree creation is disabled", () => {
    expect(buildWorktreeCreateOptions({ requestId: "r1", worktree: { enabled: false } })).toBeNull();
  });

  it("normalizes worktree fields", () => {
    expect(buildWorktreeCreateOptions({
      requestId: "r1",
      worktree: {
        enabled: true,
        sourceRepo: " /repo ",
        directory: " /repo-feature ",
        baseBranch: " HEAD ",
        branchName: " feature/mobile ",
      },
    })).toEqual({
      sourceRepo: "/repo",
      directory: "/repo-feature",
      baseBranch: "HEAD",
      branchName: "feature/mobile",
    });
  });
});

describe("resolveSessionCreateMessage", () => {
  it("builds a cwd-based session create message", () => {
    expect(resolveSessionCreateMessage({
      requestId: "r1",
      name: " Mobile ",
      cwd: " /repo ",
      category: " work ",
    })).toEqual({
      type: "message",
      message: {
        type: "session.create",
        requestId: "r1",
        name: "Mobile",
        category: "work",
        cwd: "/repo",
      },
    });
  });

  it("allows unnamed cwd-based sessions", () => {
    expect(resolveSessionCreateMessage({ requestId: "r1", cwd: "/repo" })).toEqual({
      type: "message",
      message: { type: "session.create", requestId: "r1", cwd: "/repo" },
    });
  });

  it("rejects cwd-based create without a working directory", () => {
    expect(resolveSessionCreateMessage({ requestId: "r1", cwd: " " })).toEqual({
      type: "invalid",
      message: "Working directory is required.",
      target: "cwd",
    });
  });

  it("builds a worktree session create message", () => {
    expect(resolveSessionCreateMessage({
      requestId: "r1",
      name: "Feature work",
      category: "client",
      worktree: {
        enabled: true,
        sourceRepo: "/repo",
        directory: "/repo-feature",
        baseBranch: "main",
        branchName: "feature/mobile",
      },
    })).toEqual({
      type: "message",
      message: {
        type: "session.create",
        requestId: "r1",
        name: "Feature work",
        category: "client",
        worktree: {
          sourceRepo: "/repo",
          directory: "/repo-feature",
          baseBranch: "main",
          branchName: "feature/mobile",
        },
      },
    });
  });

  it("rejects worktree create without a session name", () => {
    expect(resolveSessionCreateMessage({
      requestId: "r1",
      worktree: { enabled: true, sourceRepo: "/repo", directory: "/repo-feature", baseBranch: "main" },
    })).toEqual({
      type: "invalid",
      message: "Session name is required when creating a worktree.",
      target: "name",
    });
  });

  it("rejects incomplete worktree fields with precise targets", () => {
    expect(resolveSessionCreateMessage({ requestId: "r1", name: "Feature", worktree: { enabled: true } })).toEqual({
      type: "invalid",
      message: "Worktree working directory is required.",
      target: "worktreeDirectory",
    });
    expect(resolveSessionCreateMessage({
      requestId: "r1",
      name: "Feature",
      worktree: { enabled: true, directory: "/repo-feature" },
    })).toEqual({
      type: "invalid",
      message: "Source repo root is required.",
      target: "worktreeSourceRepo",
    });
    expect(resolveSessionCreateMessage({
      requestId: "r1",
      name: "Feature",
      worktree: { enabled: true, directory: "/repo-feature", sourceRepo: "/repo" },
    })).toEqual({
      type: "invalid",
      message: "Base branch/ref is required.",
      target: "worktreeBaseBranch",
    });
  });

  it("rejects branch-like fields that start with dashes", () => {
    expect(resolveSessionCreateMessage({
      requestId: "r1",
      name: "Feature",
      worktree: { enabled: true, directory: "/repo-feature", sourceRepo: "/repo", baseBranch: "-bad" },
    })).toEqual({
      type: "invalid",
      message: "Base branch/ref must not start with '-'.",
      target: "worktreeBaseBranch",
    });
    expect(resolveSessionCreateMessage({
      requestId: "r1",
      name: "Feature",
      worktree: { enabled: true, directory: "/repo-feature", sourceRepo: "/repo", baseBranch: "main", branchName: "-bad" },
    })).toEqual({
      type: "invalid",
      message: "Branch name must not start with '-'.",
      target: "worktreeBranchName",
    });
  });
});
