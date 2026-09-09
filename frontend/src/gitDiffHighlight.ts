import { createDiffHighlighter, DIFF_HIGHLIGHT_LIMITS } from "./diffHighlight";
import type { DiffHighlighter, DiffHighlightRow } from "./diffHighlight";
import type { DiffRow } from "./protocol";

/** Presentation-only adapter. Keep the original wire rows/anchors untouched. */
export function createGitDiffHighlighter(rows: readonly DiffRow[], owner: Document): DiffHighlighter {
  const textOf = (row: DiffRow) => (row.type === "line" ? row.location.text : row.text);
  const plain: DiffHighlighter = {
    renderLine: (index, target) => {
      target.textContent = textOf(rows[index]);
    },
  };
  if (rows.length > DIFF_HIGHLIGHT_LIMITS.maxRows) return plain;
  let units = 0;
  for (const row of rows) {
    units += textOf(row).length;
    if (units > DIFF_HIGHLIGHT_LIMITS.maxTextCodeUnits) return plain;
  }
  const normalized: DiffHighlightRow[] = [];
  const indices: number[] = [];
  let previousHunk: string | null | undefined;
  for (const row of rows) {
    const text = textOf(row);
    if (row.type !== "line") {
      indices.push(normalized.length);
      normalized.push({ text, kind: "meta", prefixLength: 0, oldPath: null, newPath: null });
      previousHunk = undefined;
      continue;
    }
    const { location } = row;
    // Even an older peer omitting explicit hunk rows must not merge contexts.
    // A missing hunk identity cannot establish a replacement pair.
    if (location.hunk === null || (previousHunk !== undefined && previousHunk !== location.hunk)) {
      normalized.push({ text: "", kind: "meta", prefixLength: 0, oldPath: null, newPath: null });
    }
    previousHunk = location.hunk;
    const prefix = location.kind === "add" ? "+" : location.kind === "remove" ? "-" : " ";
    indices.push(normalized.length);
    normalized.push({
      text,
      kind: row.prefix === prefix && text.startsWith(prefix) ? location.kind : "meta",
      prefixLength: prefix.length,
      oldPath: location.oldPath ?? location.newPath,
      newPath: location.newPath,
    });
  }
  const highlighter = createDiffHighlighter(normalized, owner);
  return { renderLine: (index, target) => highlighter.renderLine(indices[index], target) };
}
