import { isSameDiffComparison, parseDiffRows, type ParsedDiffRow } from "./diffState";
import type { DiffComment, DiffLineLocation, DiffSnapshotSummary, RepoDiffState } from "./protocol";

export type DiffPreviewDraft = {
  sessionId: string;
  state: RepoDiffState;
  baseSnapshot: DiffSnapshotSummary;
  headSnapshot: DiffSnapshotSummary | null;
  comments: DiffComment[];
};

const DIFF_COMMENT_CONTEXT_RADIUS = 4;

export function createDiffComment(input: {
  id: string;
  baseSnapshot: DiffSnapshotSummary;
  headSnapshot: DiffSnapshotSummary | null;
  location: DiffLineLocation;
  text: string;
}): DiffComment {
  return {
    id: input.id,
    baseSnapshotEntryId: input.baseSnapshot.entryId,
    headSnapshotEntryId: input.headSnapshot?.entryId ?? null,
    filePath: input.location.filePath,
    hunk: input.location.hunk,
    kind: input.location.kind,
    oldLine: input.location.oldLine,
    newLine: input.location.newLine,
    lineText: input.location.text,
    text: input.text.trim(),
  };
}

export function commentsForDiffLocation(
  comments: DiffComment[],
  baseSnapshot: DiffSnapshotSummary | null,
  headSnapshot: DiffSnapshotSummary | null,
  location: DiffLineLocation,
): DiffComment[] {
  return comments.filter(
    comment =>
      isSameDiffComparison(comment, baseSnapshot, headSnapshot) &&
      comment.filePath === location.filePath &&
      comment.hunk === location.hunk &&
      comment.kind === location.kind &&
      comment.oldLine === location.oldLine &&
      comment.newLine === location.newLine &&
      comment.lineText === location.text,
  );
}

export function selectedDiffComments(
  comments: DiffComment[],
  baseSnapshot: DiffSnapshotSummary | null,
  headSnapshot: DiffSnapshotSummary | null,
): DiffComment[] {
  if (!baseSnapshot) return [];
  return comments.filter(comment => isSameDiffComparison(comment, baseSnapshot, headSnapshot));
}

export function removeSelectedDiffComments(
  comments: DiffComment[],
  baseSnapshot: DiffSnapshotSummary,
  headSnapshot: DiffSnapshotSummary | null,
): DiffComment[] {
  return comments.filter(comment => !isSameDiffComparison(comment, baseSnapshot, headSnapshot));
}

export function formatDiffLocation(comment: DiffComment): string {
  const parts = [comment.filePath || "unknown file"];
  if (comment.oldLine !== undefined) parts.push(`old:${comment.oldLine}`);
  if (comment.newLine !== undefined) parts.push(`new:${comment.newLine}`);
  return parts.join(" ");
}

function diffRowText(row: ParsedDiffRow): string {
  return row.type === "line" ? row.location.text : row.text;
}

function isCommentLocation(row: ParsedDiffRow, comment: DiffComment): boolean {
  return (
    row.type === "line" &&
    row.location.filePath === comment.filePath &&
    row.location.hunk === comment.hunk &&
    row.location.kind === comment.kind &&
    row.location.oldLine === comment.oldLine &&
    row.location.newLine === comment.newLine &&
    row.location.text === comment.lineText
  );
}

function buildDiffCommentContext(rows: ParsedDiffRow[], comment: DiffComment): string {
  const index = rows.findIndex(row => isCommentLocation(row, comment));
  if (index === -1) {
    return [comment.hunk, comment.lineText].filter((line): line is string => Boolean(line)).join("\n");
  }

  const before: string[] = [];
  let beforeLineCount = 0;
  for (let i = index - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) break;
    if (row.type === "file") break;
    if (row.type === "hunk") {
      if (row.filePath === comment.filePath && row.hunk === comment.hunk) before.unshift(row.text);
      break;
    }
    if (
      row.type === "line" &&
      row.location.filePath === comment.filePath &&
      row.location.hunk === comment.hunk
    ) {
      if (beforeLineCount >= DIFF_COMMENT_CONTEXT_RADIUS) break;
      before.unshift(diffRowText(row));
      beforeLineCount += 1;
    }
  }

  if (comment.hunk && !before.some(line => line === comment.hunk)) before.unshift(comment.hunk);

  const after: string[] = [];
  let afterLineCount = 0;
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) break;
    if (row.type === "file" || row.type === "hunk") break;
    if (
      row.type === "line" &&
      row.location.filePath === comment.filePath &&
      row.location.hunk === comment.hunk
    ) {
      if (afterLineCount >= DIFF_COMMENT_CONTEXT_RADIUS) break;
      after.push(diffRowText(row));
      afterLineCount += 1;
    }
  }

  const targetRow = rows[index];
  return targetRow ? [...before, diffRowText(targetRow), ...after].join("\n") : comment.lineText;
}

export function buildDiffCommentPrompt(
  state: RepoDiffState,
  comments: DiffComment[],
  baseSnapshot: DiffSnapshotSummary,
  headSnapshot: DiffSnapshotSummary | null,
): string {
  const rows = parseDiffRows(state.diff);
  const commentSections = comments
    .map((comment, index) =>
      [
        `### Comment ${index + 1}`,
        `Location: ${formatDiffLocation(comment)}`,
        comment.hunk ? `Hunk: ${comment.hunk}` : undefined,
        `Diff line: ${comment.lineText}`,
        `Comment: ${comment.text}`,
        "",
        "Relevant diff context:",
        "```diff",
        buildDiffCommentContext(rows, comment),
        "```",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return [
    "I reviewed the repository diff in Fura and left comments on specific diff lines.",
    `Base snapshot: ${baseSnapshot.label} (${baseSnapshot.entryId})`,
    headSnapshot
      ? `Compared to snapshot: ${headSnapshot.label} (${headSnapshot.entryId})`
      : "Compared to: current working tree",
    "",
    "Only the diff context around commented lines is included below; the full diff is intentionally omitted.",
    "",
    commentSections,
    "",
    "Please address these comments. Use the file path and old/new diff line metadata to locate each comment precisely.",
  ].join("\n");
}

export function diffCommentFlushEditorText(count: number): string {
  return `Flush ${count} diff comment${count === 1 ? "" : "s"}`;
}

export function diffCommentPreviewStatus(count: number): string {
  return `${count} comment${count === 1 ? "" : "s"} ready to send`;
}
