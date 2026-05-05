import { describe, expect, it } from "vitest";
import { comparisonKey, parseDiffRows } from "./diffState";
import {
  buildDiffCommentPrompt,
  buildDiffQuestionPrompt,
  checkoutTargetForDiffLocation,
  createDiffReviewAnnotation,
  diffCommentFlushEditorText,
  diffCommentPreviewStatus,
  implementationChangeGuidance,
  pathForDiffLocation,
  removeSelectedDiffComments,
  selectedDiffAnnotations,
} from "./diffReview";
import type { DiffLineLocation, DiffReviewableState } from "./protocol";

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
    commits: [{ oid: "b".repeat(40), shortOid: "bbbbbbbbbbbb", subject: "change value", committedAt: "2026-05-03T00:00:00Z", parentOids: ["a".repeat(40)], isMerge: false }],
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

  it("builds comment prompts with review helper boundaries and selected commit", () => {
    const comment = createDiffReviewAnnotation({ id: "c", kind: "comment", state, location: addLocation, text: "Please keep the exported name stable.", createdAt: "now" });
    const prompt = buildDiffCommentPrompt(state, [comment]);

    expect(prompt).toContain("I reviewed a repository diff in Fura");
    expect(prompt).toContain("Do not edit files, generate patches, or modify a checkout");
    expect(prompt).toContain("Repository: /repo");
    expect(prompt).toContain("Base: main (aaaaaaaaaaaa)");
    expect(prompt).toContain("Head: feature (bbbbbbbbbbbb)");
    expect(prompt).toContain("Review mode: single commit bbbbbbbbbbbb — change value.");
    expect(prompt).toContain("Location: src/main.ts RIGHT new:2");
    expect(prompt).toContain("Comment: Please keep the exported name stable.");
    expect(prompt).toContain("```diff\n@@ -1,3 +1,3 @@\n const same = true;\n-const value = 'old';\n+const value = 'new';\n export { value };\n```");
  });

  it("builds question prompts without mixing them into comment flushes", () => {
    const question = createDiffReviewAnnotation({ id: "q", kind: "question", state, location: addLocation, text: "Is this safe?", createdAt: "now" });
    const prompt = buildDiffQuestionPrompt(state, question);
    const commentPrompt = buildDiffCommentPrompt(state, [question]);

    expect(prompt).toContain("I have a question about this exact diff line");
    expect(prompt).toContain("Question: Is this safe?");
    expect(prompt).toContain("review helper");
    expect(commentPrompt).not.toContain("Question: Is this safe?");
  });

  it("selects review worktree checkout targets by diff side", () => {
    expect(checkoutTargetForDiffLocation(state, removeLocation)).toEqual({ kind: "commit", oid: "a".repeat(40) });
    expect(checkoutTargetForDiffLocation(state, addLocation)).toEqual({ kind: "commit", oid: "b".repeat(40) });
    expect(pathForDiffLocation(removeLocation)).toBe("src/main.ts");
  });

  it("formats labels and exposes implementation boundary guidance", () => {
    expect(diffCommentFlushEditorText(1)).toBe("Flush 1 diff comment");
    expect(diffCommentFlushEditorText(2)).toBe("Flush 2 diff comments");
    expect(diffCommentPreviewStatus(1)).toBe("1 comment ready to send");
    expect(implementationChangeGuidance()).toContain("separate coding session/worktree");
  });
});
