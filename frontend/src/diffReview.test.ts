import { describe, expect, it } from "vitest";
import { comparisonKey, parseDiffRows } from "./diffState";
import {
  buildDiffCommentPrompt,
  buildDiffQuestionPrompt,
  checkoutTargetForDiffLocation,
  createDiffReviewAnnotation,
  createReviewCommentCreateMessage,
  diffCommentFlushEditorText,
  diffCommentPreviewStatus,
  implementationChangeGuidance,
  isReviewCommentMatched,
  pathForDiffLocation,
  removeSelectedDiffComments,
  selectedDiffAnnotations,
  reviewCommentsForDiffLocation,
  reviewCommentsForComparison,
} from "./diffReview";
import type { DiffLineLocation, DiffReviewableState, ReviewComment } from "./protocol";

const patch = [
  "diff --git a/src/main.ts b/src/main.ts",
  "@@ -1,3 +1,3 @@",
  " const same = true;",
  "-const value = 'old';",
  "+const value = 'new';",
  " export { value };",
].join("\n");

const state: DiffReviewableState = {
  comparison: {
    repoRoot: "/repo",
    base: { kind: "gitRef", input: "main", refKind: "branch", oid: "a".repeat(40), display: "main" },
    head: { kind: "gitRef", input: "feature", refKind: "branch", oid: "b".repeat(40), display: "feature" },
    leftTreeOrCommit: "a".repeat(40),
    rightTreeOrCommit: "b".repeat(40),
    detailMode: "filePatch",
    currentCommitOid: "b".repeat(40),
    generatedAt: "1",
    comparisonKey: "/repo|commit",
  },
  summary: { files: [], stat: null, truncated: false },
  patch,
  review: {
    commits: [{ oid: "b".repeat(40), shortOid: "bbbbbbbbbbbb", subject: "change value", message: "change value", committedAt: "2026-05-03T00:00:00Z", parentOids: ["a".repeat(40)], isMerge: false }],
    currentCommitOid: "b".repeat(40),
    currentCommitIndex: 0,
    previousCommitOid: "a".repeat(40),
  },
};

const addLocation: DiffLineLocation = parseDiffRows(patch).find((row): row is Extract<ReturnType<typeof parseDiffRows>[number], { type: "line" }> => row.type === "line" && row.location.kind === "add")!.location;
const removeLocation: DiffLineLocation = parseDiffRows(patch).find((row): row is Extract<ReturnType<typeof parseDiffRows>[number], { type: "line" }> => row.type === "line" && row.location.kind === "remove")!.location;

describe("diffReview", () => {
  it("tracks comments and questions separately", () => {
    const comment = createDiffReviewAnnotation({ id: "c", kind: "comment", state, location: addLocation, text: "Keep API stable", createdAt: "now" });
    const question = createDiffReviewAnnotation({ id: "q", kind: "question", state, location: addLocation, text: "Why this value?", createdAt: "now" });

    expect(comment.status).toBe("draft");
    expect(question.status).toBe("sent");
    expect(selectedDiffAnnotations([comment, question], comparisonKey(state), "comment")).toEqual([comment]);
    expect(removeSelectedDiffComments([comment, question], comparisonKey(state))).toEqual([question]);
  });

  it("builds persisted human review comment create messages from the shared diff state", () => {
    expect(createReviewCommentCreateMessage("s1", state, addLocation, "  Keep this API stable.  ")).toEqual({
      type: "review.comment.create",
      sessionId: "s1",
      repoRoot: "/repo",
      comparisonKey: comparisonKey(state),
      anchor: addLocation,
      body: "Keep this API stable.",
    });
  });

  it("builds comment prompts with review helper boundaries and selected commit", () => {
    const comment = createDiffReviewAnnotation({ id: "c", kind: "comment", state, location: addLocation, text: "Please keep the exported name stable.", createdAt: "now" });
    const prompt = buildDiffCommentPrompt(state, [comment]);

    expect(prompt).toContain("I reviewed a repository diff in Fura's Diff view");
    expect(prompt).toContain("Do not edit files, generate patches, or modify a checkout");
    expect(prompt).toContain("Repository: /repo");
    expect(prompt).toContain("Base: main (aaaaaaaaaaaa)");
    expect(prompt).toContain("Head: feature (bbbbbbbbbbbb)");
    expect(prompt).toContain("Review mode: single commit bbbbbbbbbbbb — change value.");
    expect(prompt).toContain("Location: src/main.ts RIGHT new:2");
    expect(prompt).toContain("Comment: Please keep the exported name stable.");
    expect(prompt).toContain("```diff\n@@ -1,3 +1,3 @@\n const same = true;\n-const value = 'old';\n+const value = 'new';\n export { value };\n```");
  });

  it("builds question prompts differently for Diff and Diffs views", () => {
    const question = createDiffReviewAnnotation({ id: "q", kind: "question", state, location: addLocation, text: "Is this safe?", createdAt: "now" });
    const prompt = buildDiffQuestionPrompt(state, question);
    const commentPrompt = buildDiffCommentPrompt(state, [question]);
    const sessionChangesPrompt = buildDiffQuestionPrompt(state, question, "sessionChanges");

    expect(prompt).toContain("I have a question about this exact diff line in Fura's Diff view");
    expect(prompt).toContain("Question: Is this safe?");
    expect(prompt).toContain("review helper");
    expect(sessionChangesPrompt).toContain("I used the ? action in Fura's Diffs view");
    expect(sessionChangesPrompt).toContain("request for an implementation change");
    expect(sessionChangesPrompt).toContain("make that change in the active checkout");
    expect(sessionChangesPrompt).not.toContain("Do not edit files");
    expect(commentPrompt).not.toContain("Question: Is this safe?");
  });

  it("selects review worktree checkout targets by diff side", () => {
    expect(checkoutTargetForDiffLocation(state, removeLocation)).toEqual({ kind: "commit", oid: "a".repeat(40) });
    expect(checkoutTargetForDiffLocation(state, addLocation)).toEqual({ kind: "commit", oid: "b".repeat(40) });
    expect(pathForDiffLocation(removeLocation)).toBe("src/main.ts");
  });

  it("matches persisted review comments and identifies stale unmatched anchors", () => {
    const comment: ReviewComment = {
      id: "persisted",
      sessionId: "s1",
      repoRoot: "/repo",
      comparisonKey: comparisonKey(state),
      author: "agent",
      body: "This changes the exported value.",
      stale: false,
      staleReason: null,
      anchor: addLocation,
      createdAt: "now",
      updatedAt: "now",
    };
    const stale: ReviewComment = {
      ...comment,
      id: "stale",
      anchor: { ...addLocation, text: "+const value = 'other';" },
    };

    const rows = parseDiffRows(patch);
    expect(reviewCommentsForComparison([comment, stale], comparisonKey(state))).toEqual([comment, stale]);
    expect(reviewCommentsForDiffLocation([comment, stale], comparisonKey(state), addLocation)).toEqual([comment]);
    expect(isReviewCommentMatched(rows, comparisonKey(state), comment)).toBe(true);
    expect(isReviewCommentMatched(rows, comparisonKey(state), stale)).toBe(false);
  });

  it("treats null and undefined missing line numbers as equivalent", () => {
    const persisted: ReviewComment = {
      id: "nullish",
      sessionId: "s1",
      repoRoot: "/repo",
      comparisonKey: comparisonKey(state),
      author: "user",
      body: "Missing old line is still same add line.",
      stale: false,
      staleReason: null,
      anchor: { ...addLocation, oldLine: null, newLine: addLocation.newLine ?? null },
      createdAt: "now",
      updatedAt: "now",
    };
    expect(reviewCommentsForDiffLocation([persisted], comparisonKey(state), addLocation)).toEqual([persisted]);
    expect(isReviewCommentMatched(parseDiffRows(patch), comparisonKey(state), persisted)).toBe(true);
  });

  it("matches persisted comments even if hunk metadata differs", () => {
    const persisted: ReviewComment = {
      id: "hunkless",
      sessionId: "s1",
      repoRoot: "/repo",
      comparisonKey: comparisonKey(state),
      author: "user",
      body: "Same line, different hunk metadata.",
      stale: false,
      staleReason: null,
      anchor: { ...addLocation, hunk: "@@ different @@" },
      createdAt: "now",
      updatedAt: "now",
    };
    expect(reviewCommentsForDiffLocation([persisted], comparisonKey(state), addLocation)).toEqual([persisted]);
    expect(isReviewCommentMatched(parseDiffRows(patch), comparisonKey(state), persisted)).toBe(true);
  });

  it("formats labels and exposes implementation boundary guidance", () => {
    expect(diffCommentFlushEditorText(1)).toBe("Flush 1 diff comment");
    expect(diffCommentFlushEditorText(2)).toBe("Flush 2 diff comments");
    expect(diffCommentPreviewStatus(1)).toBe("1 comment ready to send");
    expect(implementationChangeGuidance()).toContain("separate coding session/worktree");
  });
});
