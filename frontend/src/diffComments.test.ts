import { describe, expect, it } from "vitest";
import {
  buildDiffCommentPrompt,
  commentsForDiffLocation,
  createDiffComment,
  diffCommentFlushEditorText,
  diffCommentPreviewStatus,
  removeSelectedDiffComments,
  selectedDiffComments,
} from "./diffComments";
import type { DiffSnapshotSummary, RepoDiffState } from "./protocol";

const base: DiffSnapshotSummary = {
  entryId: "base-1",
  label: "session start",
  kind: "session-start",
  createdAt: "2026-05-02T00:00:00Z",
  repoRoot: "/repo",
};

const head: DiffSnapshotSummary = {
  entryId: "head-1",
  label: "manual",
  kind: "manual",
  createdAt: "2026-05-02T01:00:00Z",
  repoRoot: "/repo",
};

const patch = [
  "diff --git a/src/main.ts b/src/main.ts",
  "@@ -1,3 +1,3 @@",
  " const same = true;",
  "-const value = 'old';",
  "+const value = 'new';",
  " export { value };",
].join("\n");

const state: RepoDiffState = {
  snapshots: [base, head],
  selectedSnapshot: base,
  headSnapshot: null,
  diff: patch,
  stat: false,
};

describe("diffComments", () => {
  it("matches comments by comparison and exact diff line location", () => {
    const location = {
      filePath: "src/main.ts",
      hunk: "@@ -1,3 +1,3 @@",
      kind: "add" as const,
      newLine: 2,
      text: "+const value = 'new';",
    };
    const currentComment = createDiffComment({ id: "comment-1", baseSnapshot: base, headSnapshot: null, location, text: "Use a clearer name" });
    const headComment = createDiffComment({ id: "comment-2", baseSnapshot: base, headSnapshot: head, location, text: "Only for head comparison" });

    expect(selectedDiffComments([currentComment, headComment], base, null)).toEqual([currentComment]);
    expect(commentsForDiffLocation([currentComment, headComment], base, null, location)).toEqual([currentComment]);
    expect(removeSelectedDiffComments([currentComment, headComment], base, null)).toEqual([headComment]);
  });

  it("builds the same focused flush prompt text for desktop and mobile", () => {
    const comment = createDiffComment({
      id: "comment-1",
      baseSnapshot: base,
      headSnapshot: null,
      location: {
        filePath: "src/main.ts",
        hunk: "@@ -1,3 +1,3 @@",
        kind: "add",
        newLine: 2,
        text: "+const value = 'new';",
      },
      text: "Please keep the exported name stable.",
    });

    const prompt = buildDiffCommentPrompt(state, [comment], base, null);

    expect(prompt).toContain("I reviewed the repository diff in Fura");
    expect(prompt).toContain("Base snapshot: session start (base-1)");
    expect(prompt).toContain("Compared to: current working tree");
    expect(prompt).toContain("Location: src/main.ts new:2");
    expect(prompt).toContain("Comment: Please keep the exported name stable.");
    expect(prompt).toContain("```diff\n@@ -1,3 +1,3 @@\n const same = true;\n-const value = 'old';\n+const value = 'new';\n export { value };\n```");
  });

  it("formats flush labels and preview statuses", () => {
    expect(diffCommentFlushEditorText(1)).toBe("Flush 1 diff comment");
    expect(diffCommentFlushEditorText(2)).toBe("Flush 2 diff comments");
    expect(diffCommentPreviewStatus(1)).toBe("1 comment ready to send");
    expect(diffCommentPreviewStatus(2)).toBe("2 comments ready to send");
  });
});
