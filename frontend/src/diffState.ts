import { shortPath } from "./format";
import type { DiffComment, DiffLineLocation, DiffSnapshotSummary, RepoDiffState } from "./protocol";

export type ParsedDiffRow =
  | { type: "meta"; text: string }
  | { type: "file"; text: string; filePath: string }
  | { type: "hunk"; text: string; filePath: string; hunk: string }
  | { type: "line"; prefix: string; location: DiffLineLocation };

export type DiffFileSummary = {
  filePath: string;
  added: number;
  removed: number;
  commentCount: number;
};

export type DiffSelection = {
  repoRoot: string | null;
  snapshots: DiffSnapshotSummary[];
  selectedSnapshot: DiffSnapshotSummary | null;
  headSnapshot: DiffSnapshotSummary | null;
  stat: boolean;
};

export type DiffHeadSelection =
  | { kind: "unset" }
  | { kind: "working-tree" }
  | { kind: "snapshot"; entryId: string };

export function diffHeadSelectionFromEntryId(
  entryId: string | null | undefined,
  isExplicit: boolean,
): DiffHeadSelection {
  if (!isExplicit) return { kind: "unset" };
  if (entryId === null) return { kind: "working-tree" };
  if (entryId === undefined) return { kind: "unset" };
  return { kind: "snapshot", entryId };
}

export type DiffSelectionInput = {
  state: RepoDiffState | undefined;
  cwd?: string;
  explicitRepoRoot?: string;
  explicitSnapshotEntryId?: string;
  headSelection?: DiffHeadSelection;
  stat?: boolean;
  defaultStat?: boolean;
};

export function diffRepoRoots(state: RepoDiffState | undefined): string[] {
  if (!state) return [];
  const roots: string[] = [];
  for (const snapshot of state.snapshots) {
    if (!roots.includes(snapshot.repoRoot)) roots.push(snapshot.repoRoot);
  }
  return roots;
}

export function diffSnapshotsForRepo(state: RepoDiffState | undefined, repoRoot: string | null): DiffSnapshotSummary[] {
  if (!state) return [];
  if (!repoRoot) return state.snapshots;
  return state.snapshots.filter(snapshot => snapshot.repoRoot === repoRoot);
}

function inferDiffRepoRootFromCwd(cwd: string | undefined, repoRoots: string[]): string | null {
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

export function deriveDiffSelection(input: DiffSelectionInput): DiffSelection {
  const repoRoots = diffRepoRoots(input.state);
  const repoRoot = resolveDiffRepoRoot(input, repoRoots);
  const snapshots = diffSnapshotsForRepo(input.state, repoRoot);
  const selectedSnapshot = snapshots.find(snapshot => snapshot.entryId === input.explicitSnapshotEntryId)
    ?? (input.state?.selectedSnapshot?.repoRoot === repoRoot ? input.state.selectedSnapshot : null)
    ?? snapshots[snapshots.length - 1]
    ?? null;
  const headSnapshot = resolveDiffHeadSnapshot(input, snapshots, repoRoot);

  return {
    repoRoot,
    snapshots,
    selectedSnapshot,
    headSnapshot,
    stat: input.stat ?? input.state?.stat ?? input.defaultStat ?? false,
  };
}

function resolveDiffRepoRoot(input: DiffSelectionInput, repoRoots: string[]): string | null {
  const explicit = input.explicitRepoRoot;
  if (explicit && repoRoots.includes(explicit)) return explicit;

  const inferred = inferDiffRepoRootFromCwd(input.cwd, repoRoots);
  if (inferred) return inferred;

  const selectedRepoRoot = input.state?.selectedSnapshot?.repoRoot;
  if (selectedRepoRoot && repoRoots.includes(selectedRepoRoot)) return selectedRepoRoot;

  return repoRoots[0] ?? null;
}

function resolveDiffHeadSnapshot(
  input: DiffSelectionInput,
  snapshots: DiffSnapshotSummary[],
  repoRoot: string | null,
): DiffSnapshotSummary | null {
  const headSelection = input.headSelection ?? { kind: "unset" };
  if (headSelection.kind === "working-tree") return null;
  if (headSelection.kind === "snapshot") {
    return snapshots.find(snapshot => snapshot.entryId === headSelection.entryId) ?? null;
  }

  return input.state?.headSnapshot?.repoRoot === repoRoot ? input.state.headSnapshot : null;
}

export function parseDiffRows(diffText: string): ParsedDiffRow[] {
  const rows: ParsedDiffRow[] = [];
  let filePath = "";
  let hunk: string | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const text of diffText.split("\n")) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/u.exec(text);
    if (fileMatch) {
      filePath = fileMatch[2] ?? fileMatch[1] ?? "";
      hunk = null;
      rows.push({ type: "file", text, filePath });
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      hunk = text;
      rows.push({ type: "hunk", text, filePath, hunk });
      continue;
    }

    if (text.startsWith("+") && !text.startsWith("+++")) {
      rows.push({ type: "line", prefix: "+", location: { filePath, hunk, kind: "add", newLine, text } });
      newLine += 1;
      continue;
    }

    if (text.startsWith("-") && !text.startsWith("---")) {
      rows.push({ type: "line", prefix: "-", location: { filePath, hunk, kind: "remove", oldLine, text } });
      oldLine += 1;
      continue;
    }

    if (text.startsWith(" ")) {
      rows.push({
        type: "line",
        prefix: " ",
        location: { filePath, hunk, kind: "context", oldLine, newLine, text },
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    rows.push({ type: "meta", text });
  }

  return rows;
}

export function isSameDiffComparison(
  comment: DiffComment,
  baseSnapshot: DiffSnapshotSummary | null,
  headSnapshot: DiffSnapshotSummary | null,
): boolean {
  if (!baseSnapshot) return false;
  return (
    comment.baseSnapshotEntryId === baseSnapshot.entryId &&
    comment.headSnapshotEntryId === (headSnapshot?.entryId ?? null)
  );
}

export function summarizeDiffFiles(
  rows: ParsedDiffRow[],
  comments: DiffComment[] = [],
  baseSnapshot: DiffSnapshotSummary | null = null,
  headSnapshot: DiffSnapshotSummary | null = null,
): DiffFileSummary[] {
  const byPath = new Map<string, DiffFileSummary>();

  for (const row of rows) {
    if (row.type !== "line") continue;
    if (!row.location.filePath) continue;
    const existing = byPath.get(row.location.filePath) ?? {
      filePath: row.location.filePath,
      added: 0,
      removed: 0,
      commentCount: 0,
    };
    if (row.location.kind === "add") existing.added += 1;
    if (row.location.kind === "remove") existing.removed += 1;
    byPath.set(row.location.filePath, existing);
  }

  for (const comment of comments) {
    if (!isSameDiffComparison(comment, baseSnapshot, headSnapshot)) continue;
    const existing = byPath.get(comment.filePath) ?? {
      filePath: comment.filePath,
      added: 0,
      removed: 0,
      commentCount: 0,
    };
    existing.commentCount += 1;
    byPath.set(comment.filePath, existing);
  }

  return [...byPath.values()];
}
