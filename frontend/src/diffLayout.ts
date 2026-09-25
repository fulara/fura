import type { DiffLineLocation, DiffRow } from "./protocol";

export type DiffSplitCell = { index: number; noteIndex?: number };
export type DiffSplitRow =
  | { type: "full"; index: number }
  | { type: "added"; index: number }
  | { type: "pair"; left: DiffSplitCell | null; right: DiffSplitCell | null };

function anchored(row: DiffRow): row is Extract<DiffRow, { type: "line" }> {
  if (row.type !== "line") return false;
  const { location, prefix } = row;
  if (!location.hunk || !location.newPath) return false;
  const expected = location.kind === "remove" ? "-" : location.kind === "add" ? "+" : " ";
  return (
    prefix === expected &&
    location.text.startsWith(prefix) &&
    location.side === (location.kind === "remove" ? "left" : "right") &&
    (location.kind === "add" || (Number.isSafeInteger(location.oldLine) && location.oldLine! > 0)) &&
    (location.kind === "remove" || (Number.isSafeInteger(location.newLine) && location.newLine! > 0))
  );
}

/** Layout only: indices retain canonical text and review anchors, never semantic line matching. */
export function splitDiffRows(rows: readonly DiffRow[]): DiffSplitRow[] {
  const result: DiffSplitRow[] = [];
  const removed: DiffSplitCell[] = [];
  const added: DiffSplitCell[] = [];
  let previous: DiffLineLocation | undefined;
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      result.push({ type: "pair", left: removed[index] ?? null, right: added[index] ?? null });
    }
    removed.length = added.length = 0;
    previous = undefined;
  };
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!anchored(row)) {
      flush();
      result.push({ type: "full", index });
      continue;
    }
    const { location } = row;
    // The parser maps /dev/null and new-file headers to a null oldPath.
    // An insertion-only hunk in an existing file still has an old path.
    if (location.kind === "add" && (location.oldPath === null || location.oldPath === "/dev/null")) {
      flush();
      result.push({ type: "added", index });
      continue;
    }
    if (
      previous &&
      (previous.hunk !== location.hunk ||
        previous.oldPath !== location.oldPath ||
        previous.newPath !== location.newPath ||
        (location.kind === "remove" && added.length > 0))
    ) {
      flush();
    }
    const cell: DiffSplitCell = { index };
    const next = rows[index + 1];
    if (next?.type === "meta" && next.text === "\\ No newline at end of file") cell.noteIndex = ++index;
    if (location.kind === "context") {
      flush();
      result.push({ type: "pair", left: cell, right: cell });
    } else {
      (location.kind === "remove" ? removed : added).push(cell);
      previous = location;
    }
  }
  flush();
  return result;
}
