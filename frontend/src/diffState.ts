import { shortPath } from "./format";
import type { DiffDetailMode, DiffEndpoint, DiffRefInput, DiffReviewAnnotation, DiffReviewableState, ResolvedDiffRef, SessionChangesSummaryState, DiffFileSummary as WireDiffFileSummary } from "./protocol";

export const DEFAULT_SESSION_CHANGES_DETAIL_MODE: DiffDetailMode = "filePatch";
export const WORKING_TREE_DIFF_REF_TEXT = "WORKTREE";

const WORKING_TREE_REF_ALIASES = new Set([
  "workingtree",
  "working tree",
  "working-tree",
  "worktree",
  "work tree",
  "work-tree",
  "wt",
]);

export function diffRefInputFromText(value: string | undefined, fallback: DiffRefInput): DiffRefInput {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return WORKING_TREE_REF_ALIASES.has(trimmed.toLowerCase())
    ? { kind: "workingTree" }
    : { kind: "gitRef", value: trimmed };
}

export function diffRefInputText(input: DiffRefInput): string {
  return input.kind === "workingTree" ? WORKING_TREE_DIFF_REF_TEXT : input.value;
}



export type DiffFileSummary = {
  filePath: string;
  oldPath?: string | null;
  added: number;
  removed: number;
  commentCount: number;
  questionCount: number;
};


export type SessionChangesRefreshOptions = {
  repoId?: string | null;
  payloadKind?: DiffDetailMode | null;
  currentCommitOid?: string | null;
};

export function sessionChangesRefreshOptions(
  state: SessionChangesSummaryState | undefined,
  fallbackPayloadKind: DiffDetailMode,
): SessionChangesRefreshOptions {
  if (state?.status !== "ready") return { payloadKind: fallbackPayloadKind };
  return {
    repoId: state.selectedRepoId,
    payloadKind: state.comparison.detailMode,
    currentCommitOid: state.review.currentCommitOid ?? null,
  };
}

export function formatDiffRepoLabel(repoRoot: string): string {
  const parts = repoRoot.split(/[/\\]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? repoRoot;
  return name === repoRoot ? repoRoot : `${name} — ${shortPath(repoRoot)}`;
}

export function resolvedRefLabel(ref: DiffEndpoint | ResolvedDiffRef): string {
  if (ref.kind === "workingTree") return "working tree";
  if (ref.kind === "commit") return `${ref.shortOid}${ref.subject ? ` — ${ref.subject}` : ""}`;
  if (ref.kind === "sessionStartSnapshot") return `${ref.snapshot.label || "session-start"} (${ref.snapshot.refName})`;
  return `${ref.display} (${ref.oid.slice(0, 12)})`;
}


export function comparisonKey(state: DiffReviewableState): string {
  return state.comparison.comparisonKey;
}

export function summarizeWireDiffFiles(
  files: WireDiffFileSummary[],
  annotations: DiffReviewAnnotation[] = [],
  key: string | null = null,
 ): DiffFileSummary[] {
  const byPath = new Map<string, DiffFileSummary>();
  for (const file of files) {
    byPath.set(file.newPath, {
      filePath: file.newPath,
      oldPath: file.oldPath,
      added: file.added,
      removed: file.removed,
      commentCount: 0,
      questionCount: 0,
    });
  }
  for (const annotation of annotations) {
    if (key && !isSameDiffComparison(annotation, key)) continue;
    const existing = byPath.get(annotation.anchor.newPath);
    if (!existing) continue;
    if (annotation.kind === "comment") existing.commentCount += 1;
    if (annotation.kind === "question") existing.questionCount += 1;
  }
  return [...byPath.values()];
}

export function isSameDiffComparison(annotation: DiffReviewAnnotation, key: string): boolean {
  return annotation.comparisonKey === key;
}