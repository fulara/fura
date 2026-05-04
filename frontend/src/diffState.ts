import { shortPath } from "./format";
import type { DiffEndpoint, DiffPayload, DiffRefInput, DiffReviewAnnotation, DiffReviewableState, DiffLineLocation, ResolvedDiffRef, DiffFileSummary as WireDiffFileSummary } from "./protocol";

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

export function resolvedDiffRefInput(ref: ResolvedDiffRef | undefined, fallback: DiffRefInput): DiffRefInput {
  if (!ref) return fallback;
  return ref.kind === "workingTree" ? { kind: "workingTree" } : { kind: "gitRef", value: ref.input };
}

export function resolvedDiffRefInputText(ref: ResolvedDiffRef | undefined, fallback: DiffRefInput): string {
  return diffRefInputText(resolvedDiffRefInput(ref, fallback));
}

export type ParsedDiffRow =
  | { type: "meta"; text: string }
  | { type: "file"; text: string; oldPath?: string | null; newPath: string; filePath: string }
  | { type: "hunk"; text: string; oldPath?: string | null; newPath: string; filePath: string; hunk: string }
  | { type: "line"; prefix: string; location: DiffLineLocation };

export type DiffFileSummary = {
  filePath: string;
  oldPath?: string | null;
  added: number;
  removed: number;
  commentCount: number;
  questionCount: number;
};

export function diffEndpointInput(ref: DiffEndpoint | undefined, fallback: DiffRefInput): DiffRefInput {
  if (!ref) return fallback;
  if (ref.kind === "workingTree") return { kind: "workingTree" };
  if (ref.kind === "gitRef") return { kind: "gitRef", value: ref.input };
  if (ref.kind === "commit") return { kind: "gitRef", value: ref.oid };
  return { kind: "gitRef", value: ref.snapshot.refName };
}

export function diffEndpointInputText(ref: DiffEndpoint | undefined, fallback: DiffRefInput): string {
  return diffRefInputText(diffEndpointInput(ref, fallback));
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

function endpointKey(ref: DiffEndpoint): string {
  if (ref.kind === "workingTree") return "workingTree";
  if (ref.kind === "commit") return `commit:${ref.oid}`;
  if (ref.kind === "sessionStartSnapshot") return `sessionStart:${ref.snapshot.entryId}:${ref.snapshot.refName}`;
  return `gitRef:${ref.input}:${ref.oid}`;
}

export function diffPayloadKind(payload: DiffPayload): "statOnly" | "fullPatch" {
  return payload.kind;
}

export function diffPayloadText(payload: DiffPayload): string {
  return payload.kind === "fullPatch" ? payload.patch : payload.stat;
}

export function diffPayloadTruncated(payload: DiffPayload): boolean {
  return payload.truncated;
}

export function diffPayloadFiles(payload: DiffPayload): WireDiffFileSummary[] {
  return payload.files;
}

export function isFullPatchPayload(payload: DiffPayload | undefined): boolean {
  return payload?.kind === "fullPatch";
}

export function comparisonKey(state: DiffReviewableState): string {
  const selected = state.review.currentCommitOid ?? "range";
  return [state.range.repoRoot, endpointKey(state.range.base), endpointKey(state.range.head), state.range.payload.kind, selected].join("|");
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
    const existing = byPath.get(annotation.anchor.newPath) ?? {
      filePath: annotation.anchor.newPath,
      oldPath: annotation.anchor.oldPath,
      added: 0,
      removed: 0,
      commentCount: 0,
      questionCount: 0,
    };
    if (annotation.kind === "comment") existing.commentCount += 1;
    if (annotation.kind === "question") existing.questionCount += 1;
    byPath.set(annotation.anchor.newPath, existing);
  }
  return [...byPath.values()];
}

export function parseDiffRows(diffText: string): ParsedDiffRow[] {
  const rows: ParsedDiffRow[] = [];
  let oldPath: string | null = null;
  let newPath = "";
  let hunk: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let pendingRenameFrom: string | null = null;
  let pendingRenameTo: string | null = null;

  for (const text of diffText.split("\n")) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/u.exec(text);
    if (fileMatch) {
      oldPath = fileMatch[1] ?? null;
      newPath = fileMatch[2] ?? fileMatch[1] ?? "";
      pendingRenameFrom = null;
      pendingRenameTo = null;
      hunk = null;
      rows.push({ type: "file", text, oldPath, newPath, filePath: newPath });
      continue;
    }

    const renameFrom = /^rename from (.+)$/u.exec(text);
    if (renameFrom) {
      pendingRenameFrom = renameFrom[1] ?? null;
      if (rows[rows.length - 1]?.type === "file") {
        const row = rows[rows.length - 1] as Extract<ParsedDiffRow, { type: "file" }>;
        row.oldPath = pendingRenameFrom;
      }
      rows.push({ type: "meta", text });
      continue;
    }
    const renameTo = /^rename to (.+)$/u.exec(text);
    if (renameTo) {
      pendingRenameTo = renameTo[1] ?? null;
      newPath = pendingRenameTo;
      if (rows[rows.length - 1]?.type === "file") {
        const row = rows[rows.length - 1] as Extract<ParsedDiffRow, { type: "file" }>;
        row.newPath = pendingRenameTo;
        row.filePath = pendingRenameTo;
      }
      rows.push({ type: "meta", text });
      continue;
    }

    if (text.startsWith("Binary files ")) {
      rows.push({ type: "meta", text });
      continue;
    }

    const oldHeader = /^--- (?:a\/(.+)|\/dev\/null)$/u.exec(text);
    if (oldHeader) {
      oldPath = oldHeader[1] ?? null;
      rows.push({ type: "meta", text });
      continue;
    }
    const newHeader = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/u.exec(text);
    if (newHeader) {
      newPath = newHeader[1] ?? newPath;
      rows.push({ type: "meta", text });
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      hunk = text;
      rows.push({ type: "hunk", text, oldPath, newPath, filePath: newPath, hunk });
      continue;
    }

    if (text.startsWith("+") && !text.startsWith("+++")) {
      rows.push({ type: "line", prefix: "+", location: { oldPath, newPath, hunk, side: "right", kind: "add", newLine, text } });
      newLine += 1;
      continue;
    }

    if (text.startsWith("-") && !text.startsWith("---")) {
      rows.push({ type: "line", prefix: "-", location: { oldPath, newPath, hunk, side: "left", kind: "remove", oldLine, text } });
      oldLine += 1;
      continue;
    }

    if (text.startsWith(" ")) {
      rows.push({
        type: "line",
        prefix: " ",
        location: { oldPath, newPath, hunk, side: "right", kind: "context", oldLine, newLine, text },
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    rows.push({ type: "meta", text });
  }

  return rows;
}

export function isSameDiffComparison(annotation: DiffReviewAnnotation, key: string): boolean {
  return annotation.comparisonKey === key;
}

export function summarizeDiffFiles(
  rows: ParsedDiffRow[],
  annotations: DiffReviewAnnotation[] = [],
  key: string | null = null,
): DiffFileSummary[] {
  const byPath = new Map<string, DiffFileSummary>();

  for (const row of rows) {
    if (row.type !== "line") continue;
    if (!row.location.newPath) continue;
    const existing = byPath.get(row.location.newPath) ?? {
      filePath: row.location.newPath,
      oldPath: row.location.oldPath,
      added: 0,
      removed: 0,
      commentCount: 0,
      questionCount: 0,
    };
    if (row.location.kind === "add") existing.added += 1;
    if (row.location.kind === "remove") existing.removed += 1;
    byPath.set(row.location.newPath, existing);
  }

  for (const annotation of annotations) {
    if (key && !isSameDiffComparison(annotation, key)) continue;
    const filePath = annotation.anchor.newPath;
    const existing = byPath.get(filePath) ?? {
      filePath,
      oldPath: annotation.anchor.oldPath,
      added: 0,
      removed: 0,
      commentCount: 0,
      questionCount: 0,
    };
    if (annotation.kind === "comment") existing.commentCount += 1;
    if (annotation.kind === "question") existing.questionCount += 1;
    byPath.set(filePath, existing);
  }

  return [...byPath.values()];
}
