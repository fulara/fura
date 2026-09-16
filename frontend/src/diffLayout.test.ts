import { describe, expect, it } from "vitest";
import { splitDiffRows } from "./diffLayout";
import type { DiffLineLocation, DiffRow } from "./protocol";

function line(kind: DiffLineLocation["kind"], content: string, location: Partial<DiffLineLocation> = {}): DiffRow {
  const prefix = kind === "remove" ? "-" : kind === "add" ? "+" : " ";
  return {
    type: "line",
    prefix,
    location: {
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
      hunk: "@@ -1,4 +1,4 @@",
      side: kind === "remove" ? "left" : "right",
      kind,
      oldLine: kind === "add" ? null : 1,
      newLine: kind === "remove" ? null : 1,
      text: prefix + content,
      ...location,
    },
  };
}
const pair = (left: number | null, right: number | null) => ({
  type: "pair",
  left: left === null ? null : { index: left },
  right: right === null ? null : { index: right },
});
const full = (index: number) => ({ type: "full", index });
const note: DiffRow = { type: "meta", text: "\\ No newline at end of file" };

describe("split Git diff layout", () => {
  it("duplicates context and aligns unequal replacements by original row order, not text similarity", () => {
    const rows = [
      line("context", "before"),
      line("remove", "matches later"),
      line("remove", "second"),
      line("add", "unrelated"),
      line("context", "between"),
      line("remove", "old"),
      line("add", "new"),
      line("add", "extra"),
      line("context", "after"),
    ];
    expect(splitDiffRows(rows)).toEqual([pair(0, 0), pair(1, 3), pair(2, null), pair(4, 4), pair(5, 6), pair(null, 7), pair(8, 8)]);
  });

  it("keeps metadata full-width and ends alignment at file, hunk and rename boundaries", () => {
    const rows: DiffRow[] = [
      line("remove", "old"),
      { type: "hunk", text: "@@ -9 +9 @@", hunk: "@@ -9 +9 @@", oldPath: "src/old.ts", newPath: "src/new.ts", filePath: "src/new.ts" },
      line("add", "new", { hunk: "@@ -9 +9 @@" }),
      { type: "file", text: "diff --git a/next.ts b/next.ts", oldPath: "next.ts", newPath: "next.ts", filePath: "next.ts" },
      line("remove", "next old", { oldPath: "next.ts", newPath: "next.ts" }),
      { type: "meta", text: "rename to renamed.ts" },
      line("add", "next new", { oldPath: "next.ts", newPath: "renamed.ts" }),
      { type: "meta", text: "Binary files differ" },
      { type: "meta", text: "@@@ combined patch @@@" },
    ];
    expect(splitDiffRows(rows)).toEqual([pair(0, null), full(1), pair(null, 2), full(3), pair(4, null), full(5), pair(null, 6), full(7), full(8)]);
  });

  it("does not cross omitted headers when either path or hunk identity changes", () => {
    const rows = [
      line("remove", "old"),
      line("add", "new", { hunk: "@@ -9 +9 @@" }),
      line("remove", "other old", { oldPath: "other.ts" }),
      line("add", "other new"),
      line("remove", "last old"),
      line("add", "last new", { newPath: "other.ts" }),
    ];
    expect(splitDiffRows(rows)).toEqual([pair(0, null), pair(null, 1), pair(2, null), pair(null, 3), pair(4, null), pair(null, 5)]);
  });

  it("preserves insertion/deletion-only files and distinguishes blank source lines from gaps", () => {
    const rows: DiffRow[] = [
      line("add", "", { oldPath: null, newPath: "new.ts" }),
      line("add", "new", { oldPath: null, newPath: "new.ts", newLine: 2 }),
      { type: "meta", text: "deleted file mode 100644" },
      line("remove", "", { oldPath: "deleted.ts", newPath: "deleted.ts" }),
      line("remove", "old", { oldPath: "deleted.ts", newPath: "deleted.ts", oldLine: 2 }),
      line("context", ""),
    ];
    expect(splitDiffRows(rows)).toEqual([pair(null, 0), pair(null, 1), full(2), pair(3, null), pair(4, null), pair(5, 5)]);
  });

  it("attaches no-newline metadata only to its preceding source side without breaking a replacement", () => {
    const rows = [line("remove", "old"), note, line("add", "new"), note, line("context", "same"), note];
    expect(splitDiffRows(rows)).toEqual([
      { type: "pair", left: { index: 0, noteIndex: 1 }, right: { index: 2, noteIndex: 3 } },
      { type: "pair", left: { index: 4, noteIndex: 5 }, right: { index: 4, noteIndex: 5 } },
    ]);
    expect(splitDiffRows([note, line("add", "new"), note, note])).toEqual([
      full(0),
      { type: "pair", left: null, right: { index: 1, noteIndex: 2 } },
      full(3),
    ]);
  });

  it("keeps unsupported or unanchored lines full-width instead of inventing source coordinates", () => {
    const malformed = line("add", "bad prefix");
    if (malformed.type === "line") malformed.prefix = "++";
    const rows = [
      line("remove", "old"),
      line("add", "no hunk", { hunk: null }),
      line("add", "no line", { newLine: null }),
      line("context", "one side only", { oldLine: null }),
      line("remove", "zero line", { oldLine: 0 }),
      line("add", "no path", { newPath: "" }),
      malformed,
      line("add", "bad text", { text: "missing prefix" }),
      line("add", "wrong side", { side: "left" }),
      note,
      line("add", "new"),
    ];
    expect(splitDiffRows(rows)).toEqual([pair(0, null), ...Array.from({ length: 9 }, (_, index) => full(index + 1)), pair(null, 10)]);
  });

  it("does not move an earlier insertion across a later replacement", () => {
    const rows = [line("add", "first"), line("remove", "old"), line("add", "replacement")];
    expect(splitDiffRows(rows)).toEqual([pair(null, 0), pair(1, 2)]);
  });

  it("leaves frozen canonical rows and their review locations unchanged", () => {
    const rows = [line("context", "same", { oldLine: 17, newLine: 29 }), line("remove", "old"), note, line("add", "new")];
    const original = JSON.stringify(rows);
    for (const row of rows) {
      if (row.type === "line") Object.freeze(row.location);
      Object.freeze(row);
    }
    Object.freeze(rows);
    expect(splitDiffRows(rows)).toEqual([pair(0, 0), { type: "pair", left: { index: 1, noteIndex: 2 }, right: { index: 3 } }]);
    expect(JSON.stringify(rows)).toBe(original);
    expect(splitDiffRows([])).toEqual([]);
  });
});
