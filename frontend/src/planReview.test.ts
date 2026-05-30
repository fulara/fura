import { describe, expect, it, vi } from "vitest";
import {
  createApprovePlanReviewMessage,
  pendingPlanReviewFromMessage,
  renderPlanReviewCard,
  type PendingPlanReview,
} from "./planReview";

describe("plan review helpers", () => {
  it("builds the RPC approval command for the originating session", () => {
    const review = pendingPlanReviewFromMessage({
      type: "plan.review",
      sessionId: "session-1",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Migration",
      content: "Plan body",
    });

    expect(createApprovePlanReviewMessage(review)).toEqual({
      type: "plan.approve",
      sessionId: "session-1",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Migration",
      content: "Plan body",
      approvalMode: "execute",
    });

    expect(createApprovePlanReviewMessage(review, "compact")).toMatchObject({
      type: "plan.approve",
      approvalMode: "compact",
    });
  });

  it("renders approve and refine actions without using a browser modal", () => {
    const review: PendingPlanReview = {
      sessionId: "session-1",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Migration",
      content: "# Plan body\n\n- First item\n- Second item",
    };
    const onApprove = vi.fn();
    const onRefine = vi.fn();

    const card = renderPlanReviewCard(review, { onApprove, onRefine });

    expect(card.textContent).toContain("Plan ready: Migration");
    expect(card.querySelector(".plan-review-markdown h1")?.textContent).toBe("Plan body");
    expect(Array.from(card.querySelectorAll(".plan-review-markdown li")).map(item => item.textContent)).toEqual([
      "First item",
      "Second item",
    ]);
    expect(card.querySelector(".plan-review-markdown pre")).toBeNull();
    card.querySelector<HTMLButtonElement>(".plan-review-approve-execute")?.click();
    card.querySelector<HTMLButtonElement>(".plan-review-approve-compact")?.click();
    card.querySelector<HTMLButtonElement>(".plan-review-approve-keep")?.click();
    card.querySelector<HTMLButtonElement>(".plan-review-refine")?.click();

    expect(onApprove).toHaveBeenCalledWith(review, "execute");
    expect(onApprove).toHaveBeenCalledWith(review, "compact");
    expect(onApprove).toHaveBeenCalledWith(review, "keep");
    expect(onRefine).toHaveBeenCalledWith(review);
  });

  it("keeps the plan visible with review controls while refining", () => {
    const review: PendingPlanReview = {
      sessionId: "session-1",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Migration",
      content: "# Plan body\n\n- First item",
    };
    const onStart = vi.fn();

    const card = renderPlanReviewCard(
      review,
      { onApprove: vi.fn(), onRefine: vi.fn() },
      "refining",
      { active: false, comments: [], onStart },
    );

    expect(card.textContent).toContain("Refining plan: Migration");
    expect(card.textContent).toContain("Use the composer below");
    expect(card.querySelector(".plan-review-approve")).toBeNull();
    card.querySelector<HTMLButtonElement>(".message-review-toggle")?.click();
    expect(onStart).toHaveBeenCalled();
  });

});
