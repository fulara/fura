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
      type: "raw.rpc",
      sessionId: "session-1",
      command: {
        type: "approve_plan_mode",
        planFilePath: "local://PLAN.md",
        finalPlanFilePath: "local://FINAL.md",
      },
    });
  });

  it("renders approve and refine actions without using a browser modal", () => {
    const review: PendingPlanReview = {
      sessionId: "session-1",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Migration",
      content: "Plan body",
    };
    const onApprove = vi.fn();
    const onRefine = vi.fn();

    const card = renderPlanReviewCard(review, { onApprove, onRefine });

    expect(card.textContent).toContain("Plan ready: Migration");
    expect(card.textContent).toContain("Plan body");
    card.querySelector<HTMLButtonElement>(".plan-review-approve")?.click();
    card.querySelector<HTMLButtonElement>(".plan-review-refine")?.click();

    expect(onApprove).toHaveBeenCalledWith(review);
    expect(onRefine).toHaveBeenCalledWith(review);
  });
});
