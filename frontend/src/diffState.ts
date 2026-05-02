import { shortPath } from "./format";
import type { DiffSnapshotSummary, RepoDiffState } from "./protocol";

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
