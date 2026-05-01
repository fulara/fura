import { shortPath } from "./format";
import type { SessionSummary } from "./protocol";

export function sessionStatusLabel(session: SessionSummary): string {
  if (session.kind === "available") return "Saved";
  switch (session.status) {
    case "starting":
      return "Opening";
    case "idle":
      return "Ready";
    case "busy":
      return "Working";
    case "exited":
      return "Ended";
    case "error":
      return "Needs attention";
    case "available":
      return "Saved";
  }
}

export function sessionStatusClass(session: SessionSummary): string {
  return session.kind === "available" ? "available" : session.status;
}

export function sessionKindLabel(kind: SessionSummary["kind"]): string {
  return kind === "managed" ? "Live" : "Saved";
}

export function formatMessageCount(count: number): string {
  return `${count} msg${count === 1 ? "" : "s"}`;
}

export function normalizedCategory(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export function formatSessionMeta(session: SessionSummary): string {
  const cwdLabel = session.cwd ? shortPath(session.cwd) : "no dir";
  const category = normalizedCategory(session.category);
  const parts = [cwdLabel, sessionKindLabel(session.kind), formatMessageCount(session.messageCount)];
  if (category) parts.unshift(category);
  return parts.join(" · ");
}

export function sessionCategories(sessions: SessionSummary[]): string[] {
  const seen = new Map<string, string>();
  for (const session of sessions) {
    const category = normalizedCategory(session.category);
    if (!category) continue;
    const key = category.toLocaleLowerCase();
    if (!seen.has(key)) seen.set(key, category);
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function fuzzyCategoryScore(category: string, query: string): number | null {
  const normalizedCategoryValue = category.toLocaleLowerCase();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return 0;

  let score = 0;
  let categoryIndex = 0;
  let previousMatch = -1;
  for (const queryChar of normalizedQuery) {
    const matchIndex = normalizedCategoryValue.indexOf(queryChar, categoryIndex);
    if (matchIndex === -1) return null;
    score += matchIndex === previousMatch + 1 ? 1 : 4 + matchIndex - categoryIndex;
    previousMatch = matchIndex;
    categoryIndex = matchIndex + 1;
  }
  return score;
}

export function fuzzyMatchCategories(categories: string[], query: string): string[] {
  return categories
    .map(category => ({ category, score: fuzzyCategoryScore(category, query) }))
    .filter((match): match is { category: string; score: number } => match.score !== null)
    .sort((a, b) => a.score - b.score || a.category.localeCompare(b.category, undefined, { sensitivity: "base" }))
    .map(match => match.category);
}

export function visibleSessions(sessions: SessionSummary[], selectedCategoryFilter: string): SessionSummary[] {
  if (!selectedCategoryFilter) return sessions;
  return sessions.filter(session => normalizedCategory(session.category) === selectedCategoryFilter);
}
