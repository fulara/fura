import { mkEl } from "./dom";
import { appendEventTimestamp } from "./eventTime";
import { renderMarkdown } from "./transcriptView";
import type { ReviewCard, ReviewFinding, ReviewPriority, ReviewVerdict } from "./protocol";

const PRIORITY_ORDER: ReviewPriority[] = ["P0", "P1", "P2", "P3"];

// Stable cache key: the backend render hash already fingerprints every field
// that affects this card's DOM, so a change in findings/verdict/active state
// reliably busts the cache.
export function reviewCardRenderKey(card: ReviewCard): string {
  const fallback = JSON.stringify([
    card.isActive,
    card.verdicts.map(v => [v.agent ?? null, v.overallCorrectness, v.explanation, v.confidence]),
    card.findings.map(f => [f.agent ?? null, f.priority, f.title, f.body, f.filePath, f.lineStart, f.lineEnd, f.confidence]),
  ]);
  return `review:${card.toolCallId}:${card.renderHash ?? fallback}`;
}

export function renderReviewCard(card: ReviewCard): HTMLElement {
  const wrapper = mkEl("section");
  wrapper.className = `review-card ${card.isActive ? "review-active" : ""}`.trim();
  wrapper.dataset.toolCallId = card.toolCallId;

  wrapper.append(renderReviewHeader(card));

  for (const verdict of card.verdicts) {
    if (verdict.explanation) wrapper.append(renderVerdictLine(verdict, card.verdicts.length > 1));
  }

  if (card.findings.length > 0) {
    const list = mkEl("ol");
    list.className = "review-findings";
    for (const finding of card.findings) list.append(renderFinding(finding));
    wrapper.append(list);
  } else if (!card.isActive && overallCorrectness(card.verdicts) !== "incorrect") {
    // Only reassure "no findings" when the verdict isn't a failure. An incorrect
    // verdict with zero structured findings is conveyed by the badge + explanation.
    const empty = mkEl("div");
    empty.className = "review-empty";
    empty.textContent = "No blocking findings reported.";
    wrapper.append(empty);
  }

  return wrapper;
}

function renderReviewHeader(card: ReviewCard): HTMLElement {
  const header = mkEl("div");
  header.className = "review-header";

  const icon = mkEl("span");
  icon.className = "review-status-icon";
  if (card.isActive) {
    icon.classList.add("is-running");
    icon.textContent = "⠋";
  } else {
    icon.textContent = "❖";
  }
  header.append(icon);

  header.append(reviewText("Review", "review-label"));

  const verdict = overallCorrectness(card.verdicts);
  if (verdict) {
    const badge = reviewText(verdict === "incorrect" ? "Needs changes" : "Looks correct", "review-verdict-badge");
    badge.classList.add(verdict === "incorrect" ? "verdict-incorrect" : "verdict-correct");
    header.append(badge);
  } else if (card.isActive) {
    header.append(reviewText("Reviewing…", "review-verdict-badge verdict-active"));
  }

  const summary = findingSummary(card.findings);
  if (summary) header.append(reviewText(summary, "review-summary"));

  appendEventTimestamp(header, card.timestamp);
  return header;
}

function renderVerdictLine(verdict: ReviewVerdict, showAgent: boolean): HTMLElement {
  const row = mkEl("div");
  row.className = `review-verdict verdict-${verdict.overallCorrectness}`;
  if (showAgent && verdict.agent) row.append(reviewText(verdict.agent, "review-verdict-agent"));
  row.append(reviewText(verdict.explanation, "review-verdict-text"));
  return row;
}

function renderFinding(finding: ReviewFinding): HTMLElement {
  const item = mkEl("li");
  item.className = `review-finding priority-${finding.priority.toLowerCase()}`;

  const head = mkEl("div");
  head.className = "review-finding-head";
  head.append(reviewText(finding.priority, `review-priority ${finding.priority.toLowerCase()}`));
  head.append(reviewText(strippedTitle(finding.title), "review-finding-title"));
  head.append(reviewText(findingLocation(finding), "review-finding-loc"));
  if (finding.agent) head.append(reviewText(finding.agent, "review-finding-agent"));
  item.append(head);

  if (finding.body.trim()) {
    const body = renderMarkdown(finding.body);
    body.classList.add("review-finding-body");
    item.append(body);
  }

  return item;
}

function reviewText(text: string, className: string): HTMLElement {
  const span = mkEl("span");
  span.className = className;
  span.textContent = text;
  return span;
}

// OMP titles are sometimes prefixed with their own `[P0]` marker; the priority
// chip already conveys severity, so drop the redundant prefix.
function strippedTitle(title: string): string {
  return title.replace(/^\[P\d\]\s*/, "");
}

function findingLocation(finding: ReviewFinding): string {
  return finding.lineEnd > finding.lineStart
    ? `${finding.filePath}:${finding.lineStart}-${finding.lineEnd}`
    : `${finding.filePath}:${finding.lineStart}`;
}

function overallCorrectness(verdicts: ReviewVerdict[]): "correct" | "incorrect" | null {
  if (verdicts.length === 0) return null;
  return verdicts.some(v => v.overallCorrectness === "incorrect") ? "incorrect" : "correct";
}

function findingSummary(findings: ReviewFinding[]): string {
  if (findings.length === 0) return "";
  const counts = new Map<ReviewPriority, number>();
  for (const finding of findings) counts.set(finding.priority, (counts.get(finding.priority) ?? 0) + 1);
  const breakdown = PRIORITY_ORDER.filter(priority => counts.has(priority))
    .map(priority => `${priority} ${counts.get(priority)}`)
    .join(" · ");
  const label = `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  return breakdown ? `${label} · ${breakdown}` : label;
}
