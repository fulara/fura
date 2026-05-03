import { mkEl } from "./dom";
import { renderMarkdown, renderMessage } from "./transcriptView";
import { buildTranscriptReviewPrompt, type TranscriptReviewComment, type TranscriptReviewLine } from "./transcriptReview";
import type { ClientMessage, ServerMessage, TranscriptMessage } from "./protocol";

export type PlanReviewMessage = Extract<ServerMessage, { type: "plan.review" }>;
export type PendingPlanReview = Omit<PlanReviewMessage, "type">;
export type PlanReviewMode = "pending" | "refining";
export type VisiblePlanReview = { review: PendingPlanReview; mode: PlanReviewMode };
type PlanReviewLineReviewOptions = {
  active: boolean;
  comments: TranscriptReviewComment[];
  onStart?(message: TranscriptMessage): void;
  onAddComment?(message: TranscriptMessage, line: TranscriptReviewLine): void;
  onCancel?(message: TranscriptMessage): void;
  onFlush?(message: TranscriptMessage): void;
};

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

export function planReviewRenderKey(review: PendingPlanReview, mode: PlanReviewMode = "pending"): string {
  return [mode, review.sessionId, review.planFilePath, review.finalPlanFilePath, review.title ?? "", review.content].join("\u0000");
}
export function planReviewTranscriptMessage(review: PendingPlanReview): TranscriptMessage {
  return {
    id: `plan-review:${review.sessionId}:${review.planFilePath}:${review.finalPlanFilePath}`,
    role: "assistant",
    blocks: [{ kind: "text", text: review.content }],
    timestamp: null,
    isNew: false,
  };
}

export function buildPlanReviewPrompt(review: PendingPlanReview, comments: TranscriptReviewComment[]): string {
  return buildTranscriptReviewPrompt(planReviewTranscriptMessage(review), comments, {
    subject: "a finalized plan",
    roleLabel: "plan",
    contextDescription: "Only the context around commented plan lines is included below; the full plan is intentionally omitted.",
    closingInstruction: "Please refine the plan to address these comments. Use the line numbers and quoted plan context to understand exactly what each comment refers to.",
  });
}

export function renderPlanReviewCard(
  review: PendingPlanReview,
  actions: {
    onApprove: (review: PendingPlanReview) => void;
    onRefine: (review: PendingPlanReview) => void;
  },
  mode: PlanReviewMode = "pending",
  lineReview?: PlanReviewLineReviewOptions,
): HTMLElement {
  const card = mkEl("section");
  card.className = `plan-review-card plan-review-${mode}`;
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", mode === "pending" ? "Plan ready for review" : "Plan available while refining");

  const header = mkEl("header");
  const headingGroup = mkEl("div");
  const kicker = mkEl("p");
  kicker.className = "plan-review-kicker";
  kicker.textContent = "Plan mode";
  const title = mkEl("h3");
  title.textContent = mode === "pending"
    ? review.title ? `Plan ready: ${review.title}` : "Plan ready"
    : review.title ? `Refining plan: ${review.title}` : "Refining plan";
  headingGroup.append(kicker, title);

  const meta = mkEl("p");
  meta.className = "plan-review-path";
  meta.textContent = review.finalPlanFilePath || review.planFilePath;
  header.append(headingGroup, meta);

  const body = mkEl("div");
  body.className = "plan-review-body";
  const explanation = mkEl("p");
  explanation.textContent = mode === "pending"
    ? "This session is waiting for your plan decision. Prompts stay disabled until you approve execution or choose to refine the plan."
    : "Use the composer below to tell the agent what to change. This plan stays visible as reference while you refine it.";

  const details = mkEl("details");
  details.open = true;
  const summary = mkEl("summary");
  summary.textContent = "Finalized plan preview";
  const truncated = review.content.length > PLAN_REVIEW_PREVIEW_LIMIT;
  if (mode === "refining" && lineReview) {
    details.append(summary, renderMessage(planReviewTranscriptMessage(review), {
      thinkingVisibilityMode: "hidden",
      review: lineReview,
    }));
  } else {
    const preview = renderMarkdown(
      truncated
        ? `${review.content.slice(0, PLAN_REVIEW_PREVIEW_LIMIT)}\n\n… preview truncated; approval uses the full plan file …`
        : review.content,
    );
    preview.classList.add("plan-review-markdown");
    details.append(summary, preview);
  }
  body.append(explanation, details);

  const footer = mkEl("footer");
  footer.className = "plan-review-actions";
  if (mode === "pending") {
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
  } else {
    const status = mkEl("p");
    status.className = "plan-review-refining-status";
    status.textContent = "Refinement mode: write the changes you want in the prompt composer.";
    footer.append(status);
  }

  card.append(header, body, footer);
  return card;
}
