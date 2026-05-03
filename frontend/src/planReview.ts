import { mkEl } from "./dom";
import type { ClientMessage, ServerMessage } from "./protocol";

export type PlanReviewMessage = Extract<ServerMessage, { type: "plan.review" }>;
export type PendingPlanReview = Omit<PlanReviewMessage, "type">;

const PLAN_REVIEW_PREVIEW_LIMIT = 12_000;

export function pendingPlanReviewFromMessage(message: PlanReviewMessage): PendingPlanReview {
  return {
    sessionId: message.sessionId,
    planFilePath: message.planFilePath,
    finalPlanFilePath: message.finalPlanFilePath,
    title: message.title,
    content: message.content,
  };
}

export function createApprovePlanReviewMessage(review: PendingPlanReview): ClientMessage {
  return {
    type: "raw.rpc",
    sessionId: review.sessionId,
    command: {
      type: "approve_plan_mode",
      planFilePath: review.planFilePath,
      finalPlanFilePath: review.finalPlanFilePath,
    },
  };
}

export function planReviewRenderKey(review: PendingPlanReview): string {
  return [review.sessionId, review.planFilePath, review.finalPlanFilePath, review.title ?? "", review.content].join("\u0000");
}

export function renderPlanReviewCard(
  review: PendingPlanReview,
  actions: {
    onApprove: (review: PendingPlanReview) => void;
    onRefine: (review: PendingPlanReview) => void;
  },
): HTMLElement {
  const card = mkEl("section");
  card.className = "plan-review-card";
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "Plan ready for review");

  const header = mkEl("header");
  const headingGroup = mkEl("div");
  const kicker = mkEl("p");
  kicker.className = "plan-review-kicker";
  kicker.textContent = "Plan mode";
  const title = mkEl("h3");
  title.textContent = review.title ? `Plan ready: ${review.title}` : "Plan ready";
  headingGroup.append(kicker, title);

  const meta = mkEl("p");
  meta.className = "plan-review-path";
  meta.textContent = review.finalPlanFilePath || review.planFilePath;
  header.append(headingGroup, meta);

  const body = mkEl("div");
  body.className = "plan-review-body";
  const explanation = mkEl("p");
  explanation.textContent = "This session is waiting for your plan decision. Prompts stay disabled until you approve execution or choose to refine the plan.";

  const details = mkEl("details");
  details.open = true;
  const summary = mkEl("summary");
  summary.textContent = "Finalized plan preview";
  const pre = mkEl("pre");
  const truncated = review.content.length > PLAN_REVIEW_PREVIEW_LIMIT;
  pre.textContent = truncated
    ? `${review.content.slice(0, PLAN_REVIEW_PREVIEW_LIMIT)}\n\n… preview truncated; approval uses the full plan file …`
    : review.content;
  details.append(summary, pre);
  body.append(explanation, details);

  const footer = mkEl("footer");
  footer.className = "plan-review-actions";
  const approve = mkEl("button");
  approve.type = "button";
  approve.className = "plan-review-approve";
  approve.textContent = "Approve and execute";
  approve.addEventListener("click", () => actions.onApprove(review));

  const refine = mkEl("button");
  refine.type = "button";
  refine.className = "plan-review-refine";
  refine.textContent = "Refine plan";
  refine.addEventListener("click", () => actions.onRefine(review));
  footer.append(approve, refine);

  card.append(header, body, footer);
  return card;
}
