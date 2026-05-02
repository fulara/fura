import { describe, expect, it } from "vitest";
import { parseDiffRows, summarizeDiffFiles } from "./diffState";

const patch = [
  "diff --git a/src/old.ts b/src/new.ts",
  "index 1111111..2222222 100644",
  "--- a/src/old.ts",
  "+++ b/src/new.ts",
  "@@ -1,2 +1,3 @@",
  " const same = true;",
  "-const removed = true;",
  "+const added = true;",
  "+const another = true;",
].join("\n");

describe("diffState", () => {
  it("parses git patch rows with file, hunk, and line metadata", () => {
    const rows = parseDiffRows(patch);

    expect(rows).toContainEqual({ type: "file", text: "diff --git a/src/old.ts b/src/new.ts", filePath: "src/new.ts" });
    expect(rows).toContainEqual({ type: "hunk", text: "@@ -1,2 +1,3 @@", filePath: "src/new.ts", hunk: "@@ -1,2 +1,3 @@" });
    expect(rows).toContainEqual({
      type: "line",
      prefix: "-",
      location: {
        filePath: "src/new.ts",
        hunk: "@@ -1,2 +1,3 @@",
        kind: "remove",
        oldLine: 2,
        text: "-const removed = true;",
      },
    });
    expect(rows).toContainEqual({
      type: "line",
      prefix: "+",
      location: {
        filePath: "src/new.ts",
        hunk: "@@ -1,2 +1,3 @@",
        kind: "add",
        newLine: 2,
        text: "+const added = true;",
      },
    });
  });

  it("summarizes changed files without counting context lines", () => {
    const rows = parseDiffRows(patch);

    expect(summarizeDiffFiles(rows)).toEqual([{ filePath: "src/new.ts", added: 2, removed: 1, commentCount: 0 }]);
  });
});
