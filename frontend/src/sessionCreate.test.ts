import { describe, expect, it } from "vitest";
import { buildWorktreeCreateOptions, resolveSessionCreateMessage, trimSessionCreateText } from "./sessionCreate";

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
