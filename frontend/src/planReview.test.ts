import { describe, expect, it, vi } from "vitest";
import {
  buildMoveBackToPlanPrompt,
  createApprovePlanReviewMessage,
  createDiscussPlanReviewMessage,
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
  it("builds the discuss-plan command for the originating session", () => {
    const review = pendingPlanReviewFromMessage({
      type: "plan.review",
      sessionId: "session-1",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Migration",
      content: "Plan body",
    });

    expect(createDiscussPlanReviewMessage(review)).toEqual({
      type: "plan.discuss",
      sessionId: "session-1",
    });
  });

  it("builds a return-to-plan prompt that asks the agent to decide whether to revise", () => {
    const review = pendingPlanReviewFromMessage({
      type: "plan.review",
      sessionId: "session-1",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Migration",
      content: "Plan body",
    });

    const prompt = buildMoveBackToPlanPrompt(review);

    expect(prompt).toContain("Review only the conversation that happened after you presented the current plan for approval.");
    expect(prompt).toContain("Decide whether that discussion requires changes to the plan.");
    expect(prompt).toContain("If changes are needed, update local://PLAN.md; otherwise leave it unchanged.");
    expect(prompt).toContain("present the final plan for approval again");
    expect(prompt).toContain("Do not begin implementation.");
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
    const onDiscuss = vi.fn();
    const onBackToPlan = vi.fn();

    const card = renderPlanReviewCard(review, { onApprove, onRefine, onDiscuss, onBackToPlan });

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
    card.querySelector<HTMLButtonElement>(".plan-review-discuss")?.click();

    expect(onApprove).toHaveBeenCalledWith(review, "execute");
    expect(onApprove).toHaveBeenCalledWith(review, "compact");
    expect(onApprove).toHaveBeenCalledWith(review, "keep");
    expect(onRefine).toHaveBeenCalledWith(review);
    expect(onDiscuss).toHaveBeenCalledWith(review);
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
      { onApprove: vi.fn(), onRefine: vi.fn(), onDiscuss: vi.fn(), onBackToPlan: vi.fn() },
      "refining",
      { active: false, comments: [], onStart },
    );

    expect(card.textContent).toContain("Refining plan: Migration");
    expect(card.textContent).toContain("Use the composer below");
    expect(card.querySelector(".plan-review-approve")).toBeNull();
    card.querySelector<HTMLButtonElement>(".message-review-toggle")?.click();
    expect(onStart).toHaveBeenCalled();
  });

  it("renders a move-back action while discussing", () => {
    const review: PendingPlanReview = {
      sessionId: "session-1",
      planFilePath: "local://PLAN.md",
      finalPlanFilePath: "local://FINAL.md",
      title: "Migration",
      content: "# Plan body",
    };
    const onBackToPlan = vi.fn();

    const card = renderPlanReviewCard(
      review,
      { onApprove: vi.fn(), onRefine: vi.fn(), onDiscuss: vi.fn(), onBackToPlan },
      "discussing",
    );

    expect(card.textContent).toContain("Discussing plan: Migration");
    expect(card.querySelector(".plan-review-approve")).toBeNull();
    card.querySelector<HTMLButtonElement>(".plan-review-back-to-plan")?.click();
    expect(onBackToPlan).toHaveBeenCalledWith(review);
  });
});
