import { describe, expect, it, vi } from "vitest";
import { goalModeBadgeLabel, renderGoalModeCard } from "./goalMode";
import type { GoalModeProjection } from "./protocol";

function goalMode(overrides: Partial<GoalModeProjection> = {}): GoalModeProjection {
  return {
    enabled: true,
    mode: "active",
    goal: {
      id: "goal-1",
      objective: "Ship Goal Mode projection",
      status: "active",
      tokenBudget: 50000,
      tokensUsed: 12500,
      timeUsedSeconds: 95,
      createdAt: 1,
      updatedAt: 2,
    },
    ...overrides,
  };
}

describe("goal mode rendering", () => {
  it("renders a desktop goal status card with objective and budget", () => {
    const card = renderGoalModeCard(document, goalMode(), "desktop");

    expect(card).not.toBeNull();
    expect(card?.className).toContain("goal-mode-card-desktop");
    expect(card?.querySelector(".goal-mode-badge")?.textContent).toBe("Goal active");
    expect(card?.querySelector(".goal-mode-objective")?.textContent).toBe("Ship Goal Mode projection");
    expect(card?.textContent).toContain("12,500 / 50,000 tokens");
    expect(card?.textContent).toContain("1m 35s elapsed");
  });

  it("renders mobile paused goal status without requiring desktop code", () => {
    const card = renderGoalModeCard(document, goalMode({ enabled: false, goal: { ...goalMode().goal, status: "paused" } }), "mobile");

    expect(card).not.toBeNull();
    expect(card?.className).toContain("goal-mode-card-mobile");
    expect(card?.dataset.status).toBe("paused");
    expect(card?.querySelector(".goal-mode-badge")?.textContent).toBe("Goal paused");
  });

  it("labels completed exiting state distinctly", () => {
    expect(goalModeBadgeLabel(goalMode({ enabled: false, mode: "exiting", reason: "completed", goal: { ...goalMode().goal, status: "complete" } }))).toBe("Goal complete");
  });

  it("renders start controls and validates goal objective", () => {
    const onStart = vi.fn();
    const card = renderGoalModeCard(document, null, "desktop", { onStart });

    expect(card).not.toBeNull();
    const form = card?.querySelector<HTMLFormElement>("form");
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    expect(onStart).not.toHaveBeenCalled();
    expect(card?.textContent).toContain("Goal objective cannot be empty.");

    const objective = card?.querySelector<HTMLTextAreaElement>(".goal-mode-objective-input");
    const budget = card?.querySelector<HTMLInputElement>(".goal-mode-budget-input");
    objective!.value = "Ship controls";
    budget!.value = "1234";
    form?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    expect(onStart).toHaveBeenCalledWith("Ship controls", 1234);
  });

  it("renders active controls and budget updates", () => {
    const onControl = vi.fn();
    const onSetBudget = vi.fn();
    const card = renderGoalModeCard(document, goalMode(), "desktop", { onControl, onSetBudget });

    card?.querySelectorAll<HTMLButtonElement>("button")[0]?.click();
    expect(onControl).toHaveBeenCalledWith("pause");

    const budget = card?.querySelector<HTMLInputElement>(".goal-mode-budget-input");
    budget!.value = "60000";
    const buttons = card?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.[buttons.length - 1]?.click();
    expect(onSetBudget).toHaveBeenCalledWith(60000);
  });
});
