import { describe, expect, it } from "vitest";
import { renderReviewCard, reviewCardRenderKey } from "./reviewCard";
import type { ReviewCard, ReviewFinding, ReviewVerdict } from "./protocol";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: "Validate token before use",
    body: "Empty token authenticates.",
    priority: "P0",
    confidence: 0.9,
    filePath: "src/auth.rs",
    lineStart: 12,
    lineEnd: 12,
    ...overrides,
  };
}

function review(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    toolCallId: "task-1",
    timestamp: Date.UTC(2026, 4, 1, 9, 0),
    isActive: false,
    verdicts: [],
    findings: [],
    renderHash: "review-hash",
    ...overrides,
  };
}

describe("renderReviewCard", () => {
  it("renders findings with priority chip, stripped title, location, and markdown body", () => {
    const node = renderReviewCard(review({
      findings: [finding({ title: "[P0] Validate token", filePath: "src/a.rs", lineStart: 4, lineEnd: 6, body: "Bug body." })],
    }));

    const item = node.querySelector(".review-finding")!;
    expect(item).not.toBeNull();
    expect(item.querySelector(".review-priority")?.textContent).toBe("P0");
    expect(item.querySelector(".review-finding-title")?.textContent).toBe("Validate token");
    expect(item.querySelector(".review-finding-loc")?.textContent).toBe("src/a.rs:4-6");
    expect(item.querySelector(".review-finding-body")?.textContent).toContain("Bug body.");
  });

  it("renders single-line location without a range", () => {
    const node = renderReviewCard(review({ findings: [finding({ lineStart: 9, lineEnd: 9 })] }));
    expect(node.querySelector(".review-finding-loc")?.textContent).toBe("src/auth.rs:9");
  });

  it("shows an incorrect verdict badge and explanation", () => {
    const node = renderReviewCard(review({
      verdicts: [{ overallCorrectness: "incorrect", explanation: "One blocking bug.", confidence: 0.9 }],
      findings: [finding()],
    }));

    const badge = node.querySelector(".review-verdict-badge")!;
    expect(badge.classList.contains("verdict-incorrect")).toBe(true);
    expect(badge.textContent).toBe("Needs changes");
    expect(node.querySelector(".review-verdict-text")?.textContent).toBe("One blocking bug.");
  });

  it("shows a correct verdict badge when no reviewer flagged issues", () => {
    const node = renderReviewCard(review({
      verdicts: [{ overallCorrectness: "correct", explanation: "Looks good.", confidence: 0.8 }],
    }));

    const badge = node.querySelector(".review-verdict-badge")!;
    expect(badge.classList.contains("verdict-correct")).toBe(true);
    expect(badge.textContent).toBe("Looks correct");
    expect(node.querySelector(".review-empty")?.textContent).toBe("No blocking findings reported.");
  });

  it("does not claim 'no findings' when the verdict is incorrect with no structured findings", () => {
    const node = renderReviewCard(review({
      verdicts: [{ overallCorrectness: "incorrect", explanation: "Broken but unanchored.", confidence: 0.7 }],
    }));

    expect(node.querySelector(".review-empty")).toBeNull();
    expect(node.querySelector(".review-verdict-badge")?.textContent).toBe("Needs changes");
    expect(node.querySelector(".review-verdict-text")?.textContent).toBe("Broken but unanchored.");
  });

  it("summarizes finding counts by priority", () => {
    const node = renderReviewCard(review({
      findings: [finding({ priority: "P0" }), finding({ priority: "P2", filePath: "src/b.rs" })],
    }));
    expect(node.querySelector(".review-summary")?.textContent).toBe("2 findings · P0 1 · P2 1");
  });

  it("labels per-agent verdicts when multiple reviewers ran", () => {
    const verdicts: ReviewVerdict[] = [
      { agent: "reviewer.1", overallCorrectness: "correct", explanation: "Module A ok.", confidence: 0.8 },
      { agent: "reviewer.2", overallCorrectness: "incorrect", explanation: "Module B leaks.", confidence: 0.7 },
    ];
    const node = renderReviewCard(review({ verdicts }));
    const agents = [...node.querySelectorAll(".review-verdict-agent")].map(el => el.textContent);
    expect(agents).toEqual(["reviewer.1", "reviewer.2"]);
    // Any incorrect reviewer makes the overall verdict "needs changes".
    expect(node.querySelector(".review-verdict-badge")?.textContent).toBe("Needs changes");
  });

  it("marks an in-progress review as active", () => {
    const node = renderReviewCard(review({ isActive: true }));
    expect(node.classList.contains("review-active")).toBe(true);
    expect(node.querySelector(".review-verdict-badge.verdict-active")?.textContent).toBe("Reviewing…");
  });
});

describe("reviewCardRenderKey", () => {
  it("changes when findings change", () => {
    const a = reviewCardRenderKey(review({ renderHash: "h1" }));
    const b = reviewCardRenderKey(review({ renderHash: "h2" }));
    expect(a).not.toBe(b);
  });

  it("falls back to content when render hash is absent", () => {
    const base = review({ renderHash: undefined, findings: [finding()] });
    const changed = review({ renderHash: undefined, findings: [finding({ title: "Different" })] });
    expect(reviewCardRenderKey(base)).not.toBe(reviewCardRenderKey(changed));
  });
});
