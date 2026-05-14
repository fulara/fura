import { describe, expect, it } from "vitest";
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
});
