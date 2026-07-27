import { describe, expect, it } from "vitest";
import { comparisonKey } from "./diffState";
import {
  createDiffReviewAnnotation,
  createReviewCommentCreateMessage,
  diffCommentFlushEditorText,
  diffCommentPreviewStatus,
  isReviewCommentMatched,
  pathForDiffLocation,
  prepareDiffAnnotationPrompt,
  selectedDiffAnnotations,
  reviewCommentsForDiffLocation,
  reviewCommentsForComparison,
} from "./diffReview";
import type { DiffLineLocation, DiffReviewableState, DiffRow, ReviewComment } from "./protocol";

const rows: DiffRow[] = [
  { type: "file", text: "diff --git a/src/main.ts b/src/main.ts", oldPath: "src/main.ts", newPath: "src/main.ts", filePath: "src/main.ts" },
  { type: "hunk", text: "@@ -1,3 +1,3 @@", oldPath: "src/main.ts", newPath: "src/main.ts", filePath: "src/main.ts", hunk: "@@ -1,3 +1,3 @@" },
  { type: "line", prefix: " ", location: { oldPath: "src/main.ts", newPath: "src/main.ts", hunk: "@@ -1,3 +1,3 @@", side: "right", kind: "context", oldLine: 1, newLine: 1, text: " const same = true;" } },
  { type: "line", prefix: "-", location: { oldPath: "src/main.ts", newPath: "src/main.ts", hunk: "@@ -1,3 +1,3 @@", side: "left", kind: "remove", oldLine: 2, text: "-const value = 'old';" } },
  { type: "line", prefix: "+", location: { oldPath: "src/main.ts", newPath: "src/main.ts", hunk: "@@ -1,3 +1,3 @@", side: "right", kind: "add", newLine: 2, text: "+const value = 'new';" } },
  { type: "line", prefix: " ", location: { oldPath: "src/main.ts", newPath: "src/main.ts", hunk: "@@ -1,3 +1,3 @@", side: "right", kind: "context", oldLine: 3, newLine: 3, text: " export { value };" } },
];

const state: DiffReviewableState = {
  comparison: {
    repoRoot: "/repo",
    base: { kind: "gitRef", input: "main", refKind: "branch", oid: "a".repeat(40), display: "main" },
    head: { kind: "gitRef", input: "feature", refKind: "branch", oid: "b".repeat(40), display: "feature" },
    leftTreeOrCommit: "a".repeat(40),
    rightTreeOrCommit: "b".repeat(40),
    detailMode: "filePatch",
    currentCommitOid: "b".repeat(40),
    contextLines: 3,
    generatedAt: "1",
    comparisonKey: "/repo|commit",
  },
  summary: { files: [], stat: null, truncated: false },
  patchRows: rows,
  review: {
    commits: [{ oid: "b".repeat(40), shortOid: "bbbbbbbbbbbb", subject: "change value", message: "change value", committedAt: "2026-05-03T00:00:00Z", parentOids: ["a".repeat(40)], isMerge: false }],
    currentCommitOid: "b".repeat(40),
    currentCommitIndex: 0,
    previousCommitOid: "a".repeat(40),
  },
};

const addLocation: DiffLineLocation = rows.find((row): row is Extract<DiffRow, { type: "line" }> => row.type === "line" && row.location.kind === "add")!.location;
const removeLocation: DiffLineLocation = rows.find((row): row is Extract<DiffRow, { type: "line" }> => row.type === "line" && row.location.kind === "remove")!.location;

describe("diffReview", () => {
  it("tracks comments and questions separately", () => {
    const comment = createDiffReviewAnnotation({ id: "c", kind: "comment", state, location: addLocation, text: "Keep API stable", createdAt: "now" });
    const question = createDiffReviewAnnotation({ id: "q", kind: "question", state, location: addLocation, text: "Why this value?", createdAt: "now" });

    expect(comment.status).toBe("draft");
    expect(question.status).toBe("sent");
    expect(selectedDiffAnnotations([comment, question], comparisonKey(state), "comment")).toEqual([comment]);
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
    const result = prepareDiffAnnotationPrompt(state, [comment]);
    if (!result.ok) throw new Error(result.message);
    const prompt = result.prompt;

    expect(prompt.split("\n")[0]).toBe("I have read the code and have some comments please read them and address them");
    expect(prompt).toContain("Do not edit files, generate patches, or modify a checkout");
    expect(prompt).toContain("Repository: /repo");
    expect(prompt).toContain("Base: main (aaaaaaaaaaaa)");
    expect(prompt).toContain("Head: feature (bbbbbbbbbbbb)");
    expect(prompt).toContain("Review mode: single commit bbbbbbbbbbbb — change value.");
    expect(prompt).toContain("File: src/main.ts");
    expect(prompt).toContain("Location: src/main.ts RIGHT new:2");
    expect(prompt).toContain("Comment: Please keep the exported name stable.");
    expect(prompt).toContain("```diff\n@@ -1,3 +1,3 @@\n const same = true;\n-const value = 'old';\n+const value = 'new';\n export { value };\n```");
  });


  it("selects the path for a left-side diff location", () => {
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

    const currentRows = rows;
    expect(reviewCommentsForComparison([comment, stale], comparisonKey(state))).toEqual([comment, stale]);
    expect(reviewCommentsForDiffLocation([comment, stale], comparisonKey(state), addLocation)).toEqual([comment]);
    expect(isReviewCommentMatched(currentRows, comparisonKey(state), comment)).toBe(true);
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
    expect(isReviewCommentMatched(rows, comparisonKey(state), persisted)).toBe(true);
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
    expect(isReviewCommentMatched(rows, comparisonKey(state), persisted)).toBe(true);
  });

  it("formats diff comment labels", () => {
    expect(diffCommentFlushEditorText(1)).toBe("Flush 1 diff comment");
    expect(diffCommentFlushEditorText(2)).toBe("Flush 2 diff comments");
    expect(diffCommentPreviewStatus(1)).toBe("1 comment ready to send");
  });
});
