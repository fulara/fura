import type { GoalModeProjection, GoalStatus } from "./protocol";

export type GoalModeCardVariant = "desktop" | "mobile";

export function hasGoalMode(goalMode: GoalModeProjection | null | undefined): goalMode is GoalModeProjection {
  return Boolean(goalMode?.goal);
}

export function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "budget-limited":
      return "Budget limited";
    case "complete":
      return "Complete";
    case "dropped":
      return "Dropped";
  }
}

export function goalModeBadgeLabel(goalMode: GoalModeProjection | null | undefined): string | null {
  if (!goalMode?.goal) return null;
  if (goalMode.mode === "exiting" && goalMode.reason === "completed") return "Goal complete";
  if (!goalMode.enabled && goalMode.goal.status === "paused") return "Goal paused";
  return `Goal ${goalStatusLabel(goalMode.goal.status).toLowerCase()}`;
}

export function goalTokenText(goalMode: GoalModeProjection): string {
  const used = goalMode.goal.tokensUsed.toLocaleString();
  const budget = goalMode.goal.tokenBudget;
  if (budget == null) return `${used} tokens used`;
  const remaining = Math.max(0, budget - goalMode.goal.tokensUsed).toLocaleString();
  return `${used} / ${budget.toLocaleString()} tokens · ${remaining} left`;
}

export function goalElapsedText(seconds: number): string {
  if (seconds <= 0) return "No elapsed time recorded";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}h ${minutes}m elapsed`;
  if (minutes > 0) return `${minutes}m ${secs}s elapsed`;
  return `${secs}s elapsed`;
}

export function renderGoalModeCard(
  ownerDocument: Document,
  goalMode: GoalModeProjection | null | undefined,
  variant: GoalModeCardVariant,
): HTMLElement | null {
  if (!hasGoalMode(goalMode)) return null;
  const section = ownerDocument.createElement("section");
  section.className = `goal-mode-card goal-mode-card-${variant}`;
  section.dataset.status = goalMode.goal.status;
  section.setAttribute("aria-label", "Goal mode status");

  const header = ownerDocument.createElement("div");
  header.className = "goal-mode-card-header";
  const title = ownerDocument.createElement("strong");
  title.textContent = "Goal Mode";
  const badge = ownerDocument.createElement("span");
  badge.className = "goal-mode-badge";
  badge.textContent = goalModeBadgeLabel(goalMode) ?? "Goal";
  header.append(title, badge);

  const objective = ownerDocument.createElement("p");
  objective.className = "goal-mode-objective";
  objective.textContent = goalMode.goal.objective;

  const meta = ownerDocument.createElement("div");
  meta.className = "goal-mode-meta";
  const tokens = ownerDocument.createElement("span");
  tokens.textContent = goalTokenText(goalMode);
  const elapsed = ownerDocument.createElement("span");
  elapsed.textContent = goalElapsedText(goalMode.goal.timeUsedSeconds);
  meta.append(tokens, elapsed);

  section.append(header, objective, meta);
  return section;
}
