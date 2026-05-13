import { comparisonKey, resolvedRefLabel } from "./diffState";
import type { ClientMessage, DiffCheckoutTarget, DiffEndpoint, DiffLineLocation, DiffReviewAnnotation, DiffReviewableState, DiffRow, ReviewComment } from "./protocol";

export type DiffPreviewDraft = {
  sessionId: string;
  state: DiffReviewableState;
  comparisonKey: string;
  annotations: DiffReviewAnnotation[];
};

export type DiffAnnotationPromptMode = "sessionChanges" | "comparisonReview";

export type DiffAnnotationPromptResult =
  | { ok: true; prompt: string }
  | { ok: false; message: string; missingFiles: string[] };

const DIFF_CONTEXT_RADIUS = 4;

export function createDiffReviewAnnotation(input: {
  id: string;
  kind: "comment" | "question";
  state: DiffReviewableState;
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

export function createReviewCommentCreateMessage(
  sessionId: string,
  state: DiffReviewableState,
  location: DiffLineLocation,
  body: string,
): Extract<ClientMessage, { type: "review.comment.create" }> {
  return {
    type: "review.comment.create",
    sessionId,
    repoRoot: state.comparison.repoRoot,
    comparisonKey: comparisonKey(state),
    anchor: location,
    body: body.trim(),
  };
}

function normalizedLineNumber(value: number | null | undefined): number | null {
  return value ?? null;
}

function diffLocationIdentity(location: DiffLineLocation): string {
  return [
    location.oldPath ?? "",
    location.newPath,
    location.side,
    location.kind,
    normalizedLineNumber(location.oldLine),
    normalizedLineNumber(location.newLine),
    location.text,
  ].join("\u0000");
}

export function isSameDiffLineLocation(left: DiffLineLocation, right: DiffLineLocation): boolean {
  return diffLocationIdentity(left) === diffLocationIdentity(right);
}

export function annotationsForDiffLocation(
  annotations: DiffReviewAnnotation[],
  key: string,
  location: DiffLineLocation,
): DiffReviewAnnotation[] {
  const identity = diffLocationIdentity(location);
  return annotations.filter(
    annotation =>
      annotation.comparisonKey === key &&
      diffLocationIdentity(annotation.anchor) === identity,
  );
}

export function reviewCommentsForDiffLocation(
  comments: ReviewComment[],
  key: string,
  location: DiffLineLocation,
): ReviewComment[] {
  return comments.filter(comment => isReviewCommentForLocation(comment, key, location));
}

export function isReviewCommentForLocation(
  comment: ReviewComment,
  key: string,
  location: DiffLineLocation,
): boolean {
  return (
    comment.comparisonKey === key &&
    diffLocationIdentity(comment.anchor) === diffLocationIdentity(location)
  );
}

export function reviewCommentsForComparison(comments: ReviewComment[], key: string): ReviewComment[] {
  return comments.filter(comment => comment.comparisonKey === key);
}

export function isReviewCommentMatched(rows: DiffRow[], key: string, comment: ReviewComment): boolean {
  return rows.some(row => row.type === "line" && isReviewCommentForLocation(comment, key, row.location));
}


export function selectedDiffAnnotations(
  annotations: DiffReviewAnnotation[],
  key: string,
  kind?: "comment" | "question",
): DiffReviewAnnotation[] {
  return annotations.filter(annotation => annotation.comparisonKey === key && (!kind || annotation.kind === kind));
}

export function removeSelectedDiffAnnotations(annotations: DiffReviewAnnotation[], key: string): DiffReviewAnnotation[] {
  return annotations.filter(annotation => annotation.comparisonKey !== key);
}

export function removeSelectedDiffComments(annotations: DiffReviewAnnotation[], key: string): DiffReviewAnnotation[] {
  return annotations.filter(annotation => annotation.comparisonKey !== key || annotation.kind !== "comment");
}

export function formatDiffLocation(annotation: DiffReviewAnnotation): string {
  return formatDiffLineLocation(annotation.anchor);
}

export function formatReviewCommentLocation(comment: ReviewComment): string {
  return formatDiffLineLocation(comment.anchor);
}

export function formatDiffLineLocation(location: DiffLineLocation): string {
  const path = location.side === "left" ? location.oldPath ?? location.newPath : location.newPath;
  const parts = [path || "unknown file", location.side.toUpperCase()];
  if (location.oldLine != null) parts.push(`old:${location.oldLine}`);
  if (location.newLine != null) parts.push(`new:${location.newLine}`);
  return parts.join(" ");
}

function diffRowText(row: DiffRow): string {
  return row.type === "line" ? row.location.text : row.text;
}

function isAnnotationLocation(row: DiffRow, annotation: DiffReviewAnnotation): boolean {
  return row.type === "line" && diffLocationIdentity(row.location) === diffLocationIdentity(annotation.anchor);
}

function buildDiffAnnotationContext(rows: DiffRow[], annotation: DiffReviewAnnotation): string {
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

function reviewRows(state: DiffReviewableState): DiffRow[] {
  return state.patchRows ?? [];
}
function reviewModeLine(state: DiffReviewableState): string {
  if (state.review.currentCommitOid) {
    const commit = state.review.commits.find(candidate => candidate.oid === state.review.currentCommitOid);
    return `Review mode: single commit ${commit?.shortOid ?? state.review.currentCommitOid ?? "unknown"}${commit?.subject ? ` — ${commit.subject}` : ""}.`;
  }
  return "Review mode: full range.";
}

function comparisonLines(state: DiffReviewableState): string[] {
  return [
    `Repository: ${state.comparison.repoRoot}`,
    `Base: ${resolvedRefLabel(state.comparison.base)}`,
    `Head: ${resolvedRefLabel(state.comparison.head)}`,
    reviewModeLine(state),
    `Comparison key: ${comparisonKey(state)}`,
  ];
}

function reviewHelperInstruction(promptMode: DiffAnnotationPromptMode): string {
  if (promptMode === "sessionChanges") {
    return [
      "You are helping review and act on changes shown in Fura's Diffs view for the active coding session.",
      "The user's note may be a question, concern, instruction, or request for an implementation change.",
      "Use the diff metadata and nearby context to locate the issue. If the note asks for a code change, make the change in the active checkout; otherwise answer or explain the review concern.",
    ].join(" ");
  }

  return [
    "You are helping review and understand this exact diff context.",
    "Answer as a review helper: explain risk, intent, correctness, and questions about the shown changes.",
    "Do not edit files, generate patches, or modify a checkout from this review prompt. If implementation changes are needed, say that they should be handled in a separate coding session/worktree.",
  ].join(" ");
}

function buildAnnotationSection(annotation: DiffReviewAnnotation, index: number, rows: DiffRow[]): string {
  const label = annotation.kind === "question" ? "Question" : "Comment";
  return [
    `### ${label} ${index + 1}`,
    `File: ${pathForDiffLocation(annotation.anchor)}`,
    `Location: ${formatDiffLocation(annotation)}`,
    annotation.anchor.hunk ? `Hunk: ${annotation.anchor.hunk}` : undefined,
    `Diff line: ${annotation.anchor.text}`,
    `${label}: ${annotation.text}`,
    "",
    "Relevant diff context:",
    "```diff",
    buildDiffAnnotationContext(rows, annotation),
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

export function prepareDiffAnnotationPrompt(
  state: DiffReviewableState,
  annotations: DiffReviewAnnotation[],
  rowsForAnnotation?: (annotation: DiffReviewAnnotation) => DiffRow[] | null,
  promptMode: DiffAnnotationPromptMode = "comparisonReview",
): DiffAnnotationPromptResult {
  const key = comparisonKey(state);
  const selectedAnnotations = annotations.filter(annotation => annotation.comparisonKey === key);
  const missingFiles = new Set<string>();
  const allComments = selectedAnnotations.length > 0 && selectedAnnotations.every(annotation => annotation.kind === "comment");
  const sections = selectedAnnotations
    .map((annotation, index) => {
      const rows = rowsForAnnotation?.(annotation) ?? reviewRows(state);
      if (rows.length === 0) {
        missingFiles.add(pathForDiffLocation(annotation.anchor));
        return null;
      }
      return buildAnnotationSection(annotation, index, rows);
    })
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
  if (missingFiles.size > 0) {
    const files = [...missingFiles].sort();
    return {
      ok: false,
      message: files.length === 1
        ? `Load patch for ${files[0]} before flushing review notes.`
        : `Load patches for ${files.join(", ")} before flushing review notes.`,
      missingFiles: files,
    };
  }
  return {
    ok: true,
    prompt: [
      allComments
        ? "I have read the code and have some comments please read them and address them"
        : promptMode === "sessionChanges"
          ? "I reviewed changes in Fura's Diffs view and left notes/questions on specific diff lines."
          : "I reviewed a repository diff in Fura's Diff view and left comments/questions on specific diff lines.",
      reviewHelperInstruction(promptMode),
      ...comparisonLines(state),
      "",
      "Only the diff context around annotated lines is included below; the full diff is intentionally omitted.",
      "",
      sections,
      "",
      promptMode === "sessionChanges"
        ? "Please respond to these review notes using the path, side, and old/new diff line metadata to locate each item precisely. Treat each note as the user's actual instruction: it may ask a question, flag a concern, or request a concrete change."
        : "Please respond to these review notes using the path, side, and old/new diff line metadata to locate each item precisely.",
    ].join("\n"),
  };
}

export function prepareDiffCommentPrompt(
  state: DiffReviewableState,
  comments: DiffReviewAnnotation[],
  rowsForComment?: (comment: DiffReviewAnnotation) => DiffRow[] | null,
  promptMode: DiffAnnotationPromptMode = "comparisonReview",
): DiffAnnotationPromptResult {
  return prepareDiffAnnotationPrompt(
    state,
    comments.filter(annotation => annotation.kind === "comment"),
    rowsForComment,
    promptMode,
  );
}

export function buildDiffCommentPrompt(state: DiffReviewableState, comments: DiffReviewAnnotation[], promptMode: DiffAnnotationPromptMode = "comparisonReview"): string {
  const prompt = prepareDiffCommentPrompt(state, comments, undefined, promptMode);
  return prompt.ok ? prompt.prompt : "";
}

export function buildDiffQuestionPrompt(state: DiffReviewableState, question: DiffReviewAnnotation, promptMode: DiffAnnotationPromptMode = "comparisonReview"): string {
  const rows = reviewRows(state);
  return [
    promptMode === "sessionChanges"
      ? "I used the ? action in Fura's Diffs view on this exact diff line."
      : "I have a question about this exact diff line in Fura's Diff view.",
    reviewHelperInstruction(promptMode),
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
    promptMode === "sessionChanges"
      ? "Please respond to this note against the diff context. If it asks for a change, make that change in the active checkout; otherwise answer the question or explain the concern."
      : "Please answer the question against this diff context. Do not propose direct file edits unless you explicitly frame them as work for a separate coding session.",
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

function checkoutTargetForEndpoint(endpoint: DiffEndpoint): DiffCheckoutTarget {
  if (endpoint.kind === "workingTree") return { kind: "workingTree" };
  if (endpoint.kind === "commit") return { kind: "commit", oid: endpoint.oid };
  if (endpoint.kind === "sessionStartSnapshot") {
    return endpoint.snapshot.commit ? { kind: "commit", oid: endpoint.snapshot.commit } : { kind: "gitRef", value: endpoint.snapshot.refName };
  }
  return { kind: "commit", oid: endpoint.oid };
}

export function checkoutTargetForDiffLocation(state: DiffReviewableState, location: DiffLineLocation): DiffCheckoutTarget {
  if (location.side === "left") {
    if (state.review.previousCommitOid) return { kind: "commit", oid: state.review.previousCommitOid };
    return checkoutTargetForEndpoint(state.comparison.base);
  }
  if (state.review.currentCommitOid) return { kind: "commit", oid: state.review.currentCommitOid };
  return checkoutTargetForEndpoint(state.comparison.head);
}

export function checkoutTargetForDiffFile(state: DiffReviewableState): DiffCheckoutTarget {
  if (state.review.currentCommitOid) return { kind: "commit", oid: state.review.currentCommitOid };
  return checkoutTargetForEndpoint(state.comparison.head);
}

export function pathForDiffLocation(location: DiffLineLocation): string {
  return location.side === "left" ? location.oldPath ?? location.newPath : location.newPath;
}

export function implementationChangeGuidance(): string {
  return "Implementation changes should be made in a separate coding session/worktree, not by asking the review prompt to patch this diff checkout.";
}
