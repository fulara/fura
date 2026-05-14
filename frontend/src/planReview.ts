import { mkEl } from "./dom";
import { renderMarkdown, renderMessage } from "./transcriptView";
import { buildTranscriptReviewPrompt, type TranscriptReviewComment, type TranscriptReviewLine } from "./transcriptReview";
import type { ClientMessage, PlanApprovalMode, ServerMessage, TranscriptMessage } from "./protocol";

export type PlanReviewMessage = Extract<ServerMessage, { type: "plan.review" }>;
export type PendingPlanReview = Omit<PlanReviewMessage, "type">;
export type PlanReviewMode = "pending" | "refining" | "discussing";
export type VisiblePlanReview = { review: PendingPlanReview; mode: PlanReviewMode };
type PlanReviewLineReviewOptions = {
  active: boolean;
  comments: TranscriptReviewComment[];
  onStart?(message: TranscriptMessage): void;
  onAddComment?(message: TranscriptMessage, line: TranscriptReviewLine): void;
  onEditComment?(message: TranscriptMessage, comment: TranscriptReviewComment): void;
  onDeleteComment?(message: TranscriptMessage, comment: TranscriptReviewComment): void;
  onCancel?(message: TranscriptMessage): void;
  onFlush?(message: TranscriptMessage): void;
};


export function pendingPlanReviewFromMessage(message: PlanReviewMessage): PendingPlanReview {
  return {
    sessionId: message.sessionId,
    planFilePath: message.planFilePath,
    finalPlanFilePath: message.finalPlanFilePath,
    title: message.title,
    content: message.content,
  };
}

export function createApprovePlanReviewMessage(review: PendingPlanReview, approvalMode: PlanApprovalMode = "execute"): ClientMessage {
  return {
    type: "plan.approve",
    sessionId: review.sessionId,
    planFilePath: review.planFilePath,
    finalPlanFilePath: review.finalPlanFilePath,
    title: review.title,
    content: review.content,
    approvalMode,
  };
}

export function createDiscussPlanReviewMessage(review: PendingPlanReview): ClientMessage {
  return {
    type: "plan.discuss",
    sessionId: review.sessionId,
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
    onApprove: (review: PendingPlanReview, approvalMode: PlanApprovalMode) => void;
    onRefine: (review: PendingPlanReview) => void;
    onDiscuss: (review: PendingPlanReview) => void;
  },
  mode: PlanReviewMode = "pending",
  lineReview?: PlanReviewLineReviewOptions,
): HTMLElement {
  const card = mkEl("section");
  card.className = `plan-review-card plan-review-${mode}`;
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", mode === "pending" ? "Plan ready for review" : mode === "refining" ? "Plan available while refining" : "Plan available while discussing");

  const header = mkEl("header");
  const headingGroup = mkEl("div");
  const kicker = mkEl("p");
  kicker.className = "plan-review-kicker";
  kicker.textContent = "Plan mode";
  const title = mkEl("h3");
  title.textContent = mode === "pending"
    ? review.title ? `Plan ready: ${review.title}` : "Plan ready"
    : mode === "refining"
      ? review.title ? `Refining plan: ${review.title}` : "Refining plan"
      : review.title ? `Discussing plan: ${review.title}` : "Discussing plan";
  headingGroup.append(kicker, title);

  const meta = mkEl("p");
  meta.className = "plan-review-path";
  meta.textContent = review.finalPlanFilePath || review.planFilePath;
  header.append(headingGroup, meta);

  const body = mkEl("div");
  body.className = "plan-review-body";
  const explanation = mkEl("p");
  explanation.textContent = mode === "pending"
    ? "This session is waiting for your plan decision. Execute starts a fresh execution session; compact keeps the current session but distills planning context first; keep context executes in this session without compaction."
    : mode === "refining"
      ? "Use the composer below to tell the agent what to change. This plan stays visible as reference while you refine it."
      : "Use the composer below to ask questions about the plan. The agent should discuss it without rewriting the plan unless you ask for changes.";

  const details = mkEl("details");
  details.open = true;
  const summary = mkEl("summary");
  summary.textContent = "Finalized plan preview";
  if (mode === "refining" && lineReview) {
    details.append(summary, renderMessage(planReviewTranscriptMessage(review), {
      thinkingVisibilityMode: "hidden",
      review: lineReview,
    }));
  } else {
    const preview = renderMarkdown(review.content);
    preview.classList.add("plan-review-markdown");
    details.append(summary, preview);
  }
  body.append(explanation, details);

  const footer = mkEl("footer");
  footer.className = "plan-review-actions";
  if (mode === "pending") {
    const approve = mkEl("button");
    approve.type = "button";
    approve.className = "plan-review-approve plan-review-approve-execute";
    approve.textContent = "Approve and execute";
    approve.title = "Start a fresh execution session with this plan as the source of truth.";
    approve.addEventListener("click", () => actions.onApprove(review, "execute"));

    const compact = mkEl("button");
    compact.type = "button";
    compact.className = "plan-review-approve plan-review-approve-compact";
    compact.textContent = "Approve and compact context";
    compact.title = "Keep this session, compact the planning discussion first, then execute the approved plan.";
    compact.addEventListener("click", () => actions.onApprove(review, "compact"));

    const keep = mkEl("button");
    keep.type = "button";
    keep.className = "plan-review-approve plan-review-approve-keep";
    keep.textContent = "Approve and keep context";
    keep.title = "Keep this session and execute with the full planning discussion still in context.";
    keep.addEventListener("click", () => actions.onApprove(review, "keep"));
    const refine = mkEl("button");
    refine.type = "button";
    refine.className = "plan-review-refine";
    refine.textContent = "Refine plan";
    refine.addEventListener("click", () => actions.onRefine(review));

    const discuss = mkEl("button");
    discuss.type = "button";
    discuss.className = "plan-review-discuss";
    discuss.textContent = "Discuss plan";
    discuss.addEventListener("click", () => actions.onDiscuss(review));
    footer.append(approve, compact, keep, refine, discuss);
  } else {
    const status = mkEl("p");
    status.className = "plan-review-refining-status";
    status.textContent = mode === "refining"
      ? "Refinement mode: write the changes you want in the prompt composer."
      : "Discussion mode: ask questions about the plan in the prompt composer.";
    footer.append(status);
  }

  card.append(header, body, footer);
  return card;
}
