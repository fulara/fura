import { createDiffHighlighter, DIFF_HIGHLIGHT_LIMITS, type DiffHighlightRow } from "./diffHighlight";
import type { EditFile } from "./editToolResult";

// OMP context numbers refer to the old file; additions refer to the new file.
// Missing numbers never prove two snippets contiguous. Keep those boundaries
// explicit rather than letting a multiline token or replacement cross the gap.
export function createEditDiffHighlighter(file: EditFile, owner: Document) {
  const { diff, path } = file;
  if (!path || diff.length > DIFF_HIGHLIGHT_LIMITS.maxTextCodeUnits) return undefined;
  const rows: DiffHighlightRow[] = [];
  const displayedRows: number[] = [];
  const oldPath = file.sourcePath ?? path;
  let oldNext: number | undefined;
  let newNext: number | undefined;
  let previousFormat: "numbered" | "unified" | undefined;
  let oldRemaining: number | undefined;
  let newRemaining: number | undefined;
  const reset = () => {
    oldNext = newNext = undefined;
    previousFormat = undefined;
    oldRemaining = newRemaining = undefined;
  };
  const boundary = () => {
    rows.push({ text: "", kind: "meta", prefixLength: 0, oldPath, newPath: path });
    reset();
  };
  for (let offset = 0; offset < diff.length; ) {
    if (rows.length >= DIFF_HIGHLIGHT_LIMITS.maxRows) return undefined;
    const newline = diff.indexOf("\n", offset);
    const text = diff.slice(offset, newline < 0 ? diff.length : newline);
    offset = newline < 0 ? diff.length : newline + 1;
    let kind: DiffHighlightRow["kind"] = "meta";
    let prefixLength = 0;
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
    const insideUnifiedHunk = oldRemaining !== undefined && newRemaining !== undefined && (oldRemaining > 0 || newRemaining > 0);
    const metadata =
      /^(?:@@|diff |index |\\|\*\*\*)/.test(text) ||
      (!insideUnifiedHunk && /^(?:--- |\+\+\+ )/.test(text)) ||
      /^\s*(?:\.{3}|…)(?:\s.*)?$/.test(text) ||
      text === "" ||
      text === "\r";
    if (!metadata) {
      const numbered = !insideUnifiedHunk && /^([+\- ]?)(\d+)(?:#[A-Za-z0-9]+)?\|/.exec(text);
      if (numbered) {
        const number = Number(numbered[2]);
        if (Number.isSafeInteger(number) && number > 0) {
          kind = numbered[1] === "+" ? "add" : numbered[1] === "-" ? "remove" : "context";
          prefixLength = numbered[0].length;
          const expected = kind === "add" ? newNext : oldNext;
          if (
            previousFormat === "unified" ||
            (expected !== undefined && number !== expected) ||
            (kind !== "add" && oldNext === undefined && newNext !== undefined)
          )
            boundary();
          if (kind === "add") {
            newNext = number + 1;
          } else {
            newNext ??= number;
            if (kind === "context") newNext++;
            oldNext = number + 1;
          }
          previousFormat = "numbered";
        }
      } else if (/^[+\- ]/.test(text) && (insideUnifiedHunk || !/^[+\- ]?\d+(?:#|\|)/.test(text))) {
        if (previousFormat === "numbered") boundary();
        kind = text[0] === "+" ? "add" : text[0] === "-" ? "remove" : "context";
        prefixLength = 1;
        previousFormat = "unified";
      }
    }
    if (kind === "meta") {
      reset();
      if (hunk) {
        const before = Number(hunk[1] ?? 1),
          after = Number(hunk[2] ?? 1);
        if (Number.isSafeInteger(before) && Number.isSafeInteger(after)) {
          oldRemaining = before;
          newRemaining = after;
        }
      }
    } else if (previousFormat === "unified" && insideUnifiedHunk && oldRemaining !== undefined && newRemaining !== undefined) {
      if (kind !== "add") oldRemaining--;
      if (kind !== "remove") newRemaining--;
    }
    if (rows.length >= DIFF_HIGHLIGHT_LIMITS.maxRows) return undefined;
    displayedRows.push(rows.length);
    rows.push({ text, kind, prefixLength, oldPath, newPath: path });
  }
  const highlighter = createDiffHighlighter(rows, owner);
  return { renderLine: (index: number, target: HTMLElement) => highlighter.renderLine(displayedRows[index], target) };
}
