import { comparisonKey, parseDiffRows, resolvedRefLabel, type ParsedDiffRow } from "./diffState";
import type { DiffCheckoutTarget, DiffLineLocation, DiffReviewAnnotation, RepoDiffState } from "./protocol";

export type DiffPreviewDraft = {
  sessionId: string;
  state: RepoDiffState;
  comparisonKey: string;
  comments: DiffReviewAnnotation[];
};

const DIFF_CONTEXT_RADIUS = 4;

export function createDiffReviewAnnotation(input: {
  id: string;
  kind: "comment" | "question";
  state: RepoDiffState;
  location: DiffLineLocation;
  text: string;
  status?: "draft" | "sent";
  createdAt?: string;
}): DiffReviewAnnotation {
  return {
    id: input.id,
    kind: input.kind,
    comparisonKey: comparisonKey(input.state),
    anchor: { ...input.location },
    text: input.text.trim(),
    status: input.status ?? (input.kind === "question" ? "sent" : "draft"),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function annotationsForDiffLocation(
  annotations: DiffReviewAnnotation[],
  key: string,
  location: DiffLineLocation,
): DiffReviewAnnotation[] {
  return annotations.filter(
    annotation =>
      annotation.comparisonKey === key &&
      annotation.anchor.oldPath === location.oldPath &&
      annotation.anchor.newPath === location.newPath &&
      annotation.anchor.hunk === location.hunk &&
      annotation.anchor.side === location.side &&
      annotation.anchor.kind === location.kind &&
      annotation.anchor.oldLine === location.oldLine &&
      annotation.anchor.newLine === location.newLine &&
      annotation.anchor.text === location.text,
  );
}

export function selectedDiffAnnotations(
  annotations: DiffReviewAnnotation[],
  key: string,
  kind?: "comment" | "question",
): DiffReviewAnnotation[] {
  return annotations.filter(annotation => annotation.comparisonKey === key && (!kind || annotation.kind === kind));
}

export function removeSelectedDiffComments(annotations: DiffReviewAnnotation[], key: string): DiffReviewAnnotation[] {
  return annotations.filter(annotation => annotation.comparisonKey !== key || annotation.kind !== "comment");
}

export function formatDiffLocation(annotation: DiffReviewAnnotation): string {
  return formatDiffLineLocation(annotation.anchor);
}

export function formatDiffLineLocation(location: DiffLineLocation): string {
  const path = location.side === "left" ? location.oldPath ?? location.newPath : location.newPath;
  const parts = [path || "unknown file", location.side.toUpperCase()];
  if (location.oldLine !== undefined) parts.push(`old:${location.oldLine}`);
  if (location.newLine !== undefined) parts.push(`new:${location.newLine}`);
  return parts.join(" ");
}

function diffRowText(row: ParsedDiffRow): string {
  return row.type === "line" ? row.location.text : row.text;
}

function isAnnotationLocation(row: ParsedDiffRow, annotation: DiffReviewAnnotation): boolean {
  return (
    row.type === "line" &&
    row.location.oldPath === annotation.anchor.oldPath &&
    row.location.newPath === annotation.anchor.newPath &&
    row.location.hunk === annotation.anchor.hunk &&
    row.location.side === annotation.anchor.side &&
    row.location.kind === annotation.anchor.kind &&
    row.location.oldLine === annotation.anchor.oldLine &&
    row.location.newLine === annotation.anchor.newLine &&
    row.location.text === annotation.anchor.text
  );
}

function buildDiffAnnotationContext(rows: ParsedDiffRow[], annotation: DiffReviewAnnotation): string {
  const index = rows.findIndex(row => isAnnotationLocation(row, annotation));
  if (index === -1) {
    return [annotation.anchor.hunk, annotation.anchor.text].filter((line): line is string => Boolean(line)).join("\n");
  }

  const before: string[] = [];
  let beforeLineCount = 0;
  for (let i = index - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) break;
    if (row.type === "file") break;
    if (row.type === "hunk") {
      if (row.newPath === annotation.anchor.newPath && row.hunk === annotation.anchor.hunk) before.unshift(row.text);
      break;
    }
    if (row.type === "line" && row.location.newPath === annotation.anchor.newPath && row.location.hunk === annotation.anchor.hunk) {
      if (beforeLineCount >= DIFF_CONTEXT_RADIUS) break;
      before.unshift(diffRowText(row));
      beforeLineCount += 1;
    }
  }

  if (annotation.anchor.hunk && !before.some(line => line === annotation.anchor.hunk)) before.unshift(annotation.anchor.hunk);

  const after: string[] = [];
  let afterLineCount = 0;
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) break;
    if (row.type === "file" || row.type === "hunk") break;
    if (row.type === "line" && row.location.newPath === annotation.anchor.newPath && row.location.hunk === annotation.anchor.hunk) {
      if (afterLineCount >= DIFF_CONTEXT_RADIUS) break;
      after.push(diffRowText(row));
      afterLineCount += 1;
    }
  }

  const targetRow = rows[index];
  return targetRow ? [...before, diffRowText(targetRow), ...after].join("\n") : annotation.anchor.text;
}

function reviewModeLine(state: RepoDiffState): string {
  if (state.reviewProgress.mode === "commit") {
    const commit = state.reviewProgress.commits.find(candidate => candidate.oid === state.reviewProgress.selectedCommitOid);
    return `Review mode: single commit ${commit?.shortOid ?? state.reviewProgress.selectedCommitOid ?? "unknown"}${commit?.subject ? ` — ${commit.subject}` : ""}.`;
  }
  return "Review mode: full range.";
}

function comparisonLines(state: RepoDiffState): string[] {
  return [
    `Repository: ${state.repoRoot}`,
    `Base: ${resolvedRefLabel(state.comparison.base)}`,
    `Head: ${resolvedRefLabel(state.comparison.head)}`,
    reviewModeLine(state),
    `Comparison key: ${comparisonKey(state)}`,
  ];
}

const reviewHelperInstruction = [
  "You are helping review and understand this exact diff context.",
  "Answer as a review helper: explain risk, intent, correctness, and questions about the shown changes.",
  "Do not edit files, generate patches, or modify a checkout from this review prompt. If implementation changes are needed, say that they should be handled in a separate coding session/worktree.",
].join(" ");

export function buildDiffCommentPrompt(state: RepoDiffState, comments: DiffReviewAnnotation[]): string {
  const key = comparisonKey(state);
  const selectedComments = comments.filter(annotation => annotation.kind === "comment" && annotation.comparisonKey === key);
  const rows = parseDiffRows(state.diff);
  const commentSections = selectedComments
    .map((comment, index) =>
      [
        `### Comment ${index + 1}`,
        `Location: ${formatDiffLocation(comment)}`,
        comment.anchor.hunk ? `Hunk: ${comment.anchor.hunk}` : undefined,
        `Diff line: ${comment.anchor.text}`,
        `Comment: ${comment.text}`,
        "",
        "Relevant diff context:",
        "```diff",
        buildDiffAnnotationContext(rows, comment),
        "```",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return [
    "I reviewed a repository diff in Fura and left comments on specific diff lines.",
    reviewHelperInstruction,
    ...comparisonLines(state),
    "",
    "Only the diff context around commented lines is included below; the full diff is intentionally omitted.",
    "",
    commentSections,
    "",
    "Please respond to these review comments using the path, side, and old/new diff line metadata to locate each comment precisely.",
  ].join("\n");
}

export function buildDiffQuestionPrompt(state: RepoDiffState, question: DiffReviewAnnotation): string {
  const rows = parseDiffRows(state.diff);
  return [
    "I have a question about this exact diff line in Fura.",
    reviewHelperInstruction,
    ...comparisonLines(state),
    "",
    `Question location: ${formatDiffLocation(question)}`,
    question.anchor.hunk ? `Hunk: ${question.anchor.hunk}` : undefined,
    `Diff line: ${question.anchor.text}`,
    `Question: ${question.text}`,
    "",
    "Relevant diff context:",
    "```diff",
    buildDiffAnnotationContext(rows, question),
    "```",
    "",
    "Please answer the question against this diff context. Do not propose direct file edits unless you explicitly frame them as work for a separate coding session.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function diffCommentFlushEditorText(count: number): string {
  return `Flush ${count} diff comment${count === 1 ? "" : "s"}`;
}

export function diffCommentPreviewStatus(count: number): string {
  return `${count} comment${count === 1 ? "" : "s"} ready to send`;
}

export function checkoutTargetForDiffLocation(state: RepoDiffState, location: DiffLineLocation): DiffCheckoutTarget {
  if (location.side === "left") {
    const previous = state.reviewProgress.mode === "commit" ? state.reviewProgress.previousCommitOid : null;
    if (previous) return { kind: "commit", oid: previous };
    return state.comparison.base.kind === "gitRef" ? { kind: "commit", oid: state.comparison.base.oid } : { kind: "workingTree" };
  }
  const selected = state.reviewProgress.mode === "commit" ? state.reviewProgress.selectedCommitOid : null;
  if (selected) return { kind: "commit", oid: selected };
  return state.comparison.head.kind === "gitRef" ? { kind: "commit", oid: state.comparison.head.oid } : { kind: "workingTree" };
}

export function pathForDiffLocation(location: DiffLineLocation): string {
  return location.side === "left" ? location.oldPath ?? location.newPath : location.newPath;
}

export function implementationChangeGuidance(): string {
  return "Implementation changes should be made in a separate coding session/worktree, not by asking the review prompt to patch this diff checkout.";
}
