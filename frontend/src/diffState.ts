import { shortPath } from "./format";
import type { DiffReviewAnnotation, DiffLineLocation, RepoDiffState, ResolvedDiffRef } from "./protocol";

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

export function diffRepoRoots(state: RepoDiffState | undefined): string[] {
  return state?.repoRoot ? [state.repoRoot] : [];
}

export function inferDiffRepoRootFromCwd(cwd: string | undefined, repoRoots: string[]): string | null {
  if (!cwd) return null;
  const matchingRoots = repoRoots
    .filter(repoRoot => cwd === repoRoot || cwd.startsWith(`${repoRoot}/`) || cwd.startsWith(`${repoRoot}\\`))
    .sort((left, right) => right.length - left.length);
  return matchingRoots[0] ?? null;
}

export function formatDiffRepoLabel(repoRoot: string): string {
  const parts = repoRoot.split(/[/\\]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? repoRoot;
  return name === repoRoot ? repoRoot : `${name} — ${shortPath(repoRoot)}`;
}

export function resolvedRefLabel(ref: ResolvedDiffRef): string {
  return ref.kind === "workingTree" ? "working tree" : `${ref.display} (${ref.oid.slice(0, 12)})`;
}

export function comparisonKey(state: RepoDiffState): string {
  const base = state.comparison.base.kind === "gitRef"
    ? `${state.comparison.base.input}:${state.comparison.base.oid}`
    : "workingTree";
  const head = state.comparison.head.kind === "gitRef"
    ? `${state.comparison.head.input}:${state.comparison.head.oid}`
    : "workingTree";
  const selected = state.reviewProgress.mode === "commit" ? state.reviewProgress.selectedCommitOid ?? "unknown" : "range";
  return [state.repoRoot, base, head, state.comparison.mode, state.reviewProgress.mode, selected].join("|");
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
