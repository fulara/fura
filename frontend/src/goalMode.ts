import type { GoalControlAction, GoalModeProjection, GoalStatus } from "./protocol";

const GOAL_MODE_HELP_TEXT = "A goal is standing session context. It guides future prompts and progress tracking; it does not run work in the background.";

export type GoalModeCardVariant = "desktop" | "mobile";
export type GoalModeCardControls = {
  disabled?: boolean;
  onStart?: (objective: string, tokenBudget?: number) => void;
  onControl?: (action: GoalControlAction) => void;
  onSetBudget?: (tokenBudget?: number) => void;
};

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
  if (goalMode.goal.status === "active") return "Goal set";
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

function parseBudget(raw: string): { ok: true; value?: number; empty: boolean } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, empty: true };
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    return { ok: false, message: "Budget must be a positive integer." };
  }
  return { ok: true, value: parsed, empty: false };
}

function setStatus(ownerDocument: Document, container: HTMLElement, message: string): void {
  let status = container.querySelector<HTMLParagraphElement>(".goal-mode-control-status");
  if (!status) {
    status = ownerDocument.createElement("p");
    status.className = "goal-mode-control-status";
    status.setAttribute("aria-live", "polite");
    container.append(status);
  }
  status.textContent = message;
}

function goalControlField(
  ownerDocument: Document,
  labelText: string,
  control: HTMLInputElement | HTMLTextAreaElement,
  className?: string,
): HTMLLabelElement {
  const label = ownerDocument.createElement("label");
  label.className = className ? `goal-mode-field ${className}` : "goal-mode-field";
  const text = ownerDocument.createElement("span");
  text.className = "goal-mode-field-label";
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

function renderStartControls(ownerDocument: Document, section: HTMLElement, controls: GoalModeCardControls): void {
  if (!controls.onStart) return;
  const form = ownerDocument.createElement("form");
  form.className = "goal-mode-controls goal-mode-start-controls";

  const objective = ownerDocument.createElement("textarea");
  objective.className = "goal-mode-objective-input";
  objective.placeholder = "Goal objective";
  objective.rows = 2;
  objective.disabled = controls.disabled === true;

  const budget = ownerDocument.createElement("input");
  budget.className = "goal-mode-budget-input";
  budget.inputMode = "numeric";
  budget.placeholder = "Budget tokens (optional)";
  budget.disabled = controls.disabled === true;

  const start = ownerDocument.createElement("button");
  start.type = "submit";
  start.textContent = "Set goal";
  start.disabled = controls.disabled === true;

  form.append(
    goalControlField(ownerDocument, "Objective", objective, "goal-mode-objective-field"),
    goalControlField(ownerDocument, "Token budget", budget, "goal-mode-budget-field"),
    start,
  );
  form.addEventListener("submit", event => {
    event.preventDefault();
    const text = objective.value.trim();
    if (!text) {
      setStatus(ownerDocument, section, "Goal objective cannot be empty.");
      return;
    }
    const parsed = parseBudget(budget.value);
    if (!parsed.ok) {
      setStatus(ownerDocument, section, parsed.message);
      return;
    }
    controls.onStart?.(text, parsed.value);
    objective.value = "";
    budget.value = "";
    setStatus(ownerDocument, section, "Goal set for this session.");
  });
  section.append(form);
}

function appendActionButton(ownerDocument: Document, container: HTMLElement, label: string, action: GoalControlAction, controls: GoalModeCardControls): void {
  if (!controls.onControl) return;
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = controls.disabled === true;
  button.addEventListener("click", () => controls.onControl?.(action));
  container.append(button);
}

function renderActiveControls(ownerDocument: Document, section: HTMLElement, goalMode: GoalModeProjection, controls: GoalModeCardControls): void {
  if (!controls.onControl && !controls.onSetBudget) return;
  const actions = ownerDocument.createElement("div");
  actions.className = "goal-mode-controls goal-mode-action-controls";
  const isTransientTerminalState =
    goalMode.mode === "exiting" || goalMode.goal.status === "complete" || goalMode.goal.status === "dropped";
  const canManageGoal = !isTransientTerminalState && (
    (goalMode.enabled && (goalMode.goal.status === "active" || goalMode.goal.status === "budget-limited")) ||
    (!goalMode.enabled && goalMode.goal.status === "paused")
  );

  if (goalMode.enabled && (goalMode.goal.status === "active" || goalMode.goal.status === "budget-limited")) {
    appendActionButton(ownerDocument, actions, "Pause", "pause", controls);
  } else if (!goalMode.enabled && goalMode.goal.status === "paused") {
    appendActionButton(ownerDocument, actions, "Resume", "resume", controls);
  }
  if (canManageGoal) {
    appendActionButton(ownerDocument, actions, "Drop", "drop", controls);
  }

  if (controls.onSetBudget && goalMode.enabled && !isTransientTerminalState) {
    const budget = ownerDocument.createElement("input");
    budget.className = "goal-mode-budget-input";
    budget.inputMode = "numeric";
    budget.placeholder = goalMode.goal.tokenBudget == null ? "No budget" : String(goalMode.goal.tokenBudget);
    budget.disabled = controls.disabled === true;

    const apply = ownerDocument.createElement("button");
    apply.type = "button";
    apply.textContent = "Set budget";
    apply.disabled = budget.disabled;
    apply.addEventListener("click", () => {
      const parsed = parseBudget(budget.value);
      if (!parsed.ok) {
        setStatus(ownerDocument, section, parsed.message);
        return;
      }
      if (parsed.empty) {
        setStatus(ownerDocument, section, "Enter a budget value or use Clear budget.");
        return;
      }
      controls.onSetBudget?.(parsed.value);
      budget.value = "";
      setStatus(ownerDocument, section, "Goal budget update requested.");
    });
    actions.append(goalControlField(ownerDocument, "Token budget", budget, "goal-mode-budget-field"), apply);

    if (goalMode.goal.tokenBudget != null) {
      const clear = ownerDocument.createElement("button");
      clear.type = "button";
      clear.textContent = "Clear budget";
      clear.disabled = budget.disabled;
      clear.addEventListener("click", () => {
        controls.onSetBudget?.(undefined);
        budget.value = "";
        setStatus(ownerDocument, section, "Goal budget clear requested.");
      });
      actions.append(clear);
    }
  }

  if (actions.hasChildNodes()) section.append(actions);
}

export function renderGoalModeCard(
  ownerDocument: Document,
  goalMode: GoalModeProjection | null | undefined,
  variant: GoalModeCardVariant,
  controls?: GoalModeCardControls,
): HTMLElement | null {
  if (!hasGoalMode(goalMode)) {
    if (!controls?.onStart) return null;
    const section = ownerDocument.createElement("section");
    section.className = `goal-mode-card goal-mode-card-${variant} goal-mode-empty`;
    section.setAttribute("aria-label", "Goal mode controls");
    const header = ownerDocument.createElement("div");
    header.className = "goal-mode-card-header";
    const title = ownerDocument.createElement("strong");
    title.textContent = "Goal Mode";
    const badge = ownerDocument.createElement("span");
    badge.className = "goal-mode-badge";
    badge.textContent = "No goal";
    header.append(title, badge);
    const note = ownerDocument.createElement("p");
    note.className = "goal-mode-objective";
    // Keep this copy explicit: Goal Mode stores standing context, not an autonomous work loop.
    note.textContent = GOAL_MODE_HELP_TEXT;
    section.append(header, note);
    renderStartControls(ownerDocument, section, controls);
    return section;
  }

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
  renderActiveControls(ownerDocument, section, goalMode, controls ?? {});
  return section;
}
