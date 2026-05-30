import { describe, expect, it } from "vitest";
import { buildTranscriptReviewPrompt, transcriptReviewLines, type TranscriptReviewComment } from "./transcriptReview";
import type { TranscriptMessage } from "./protocol";

function message(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    id: "msg-1",
    role: "assistant",
    isNew: false,
    blocks: [{ kind: "text", text: "first\nsecond\nthird" }],
    renderHash: "test-review-hash",
    ...overrides,
  };
}

describe("transcript review", () => {
  it("builds one-based review lines from transcript message text", () => {
    expect(transcriptReviewLines(message())).toEqual([
      { lineNumber: 1, text: "first" },
      { lineNumber: 2, text: "second" },
      { lineNumber: 3, text: "third" },
    ]);
  });

  it("builds a prompt with message metadata, comments, and nearby context", () => {
    const target = message();
    const comments: TranscriptReviewComment[] = [{
      id: "comment-1",
      messageId: "msg-1",
      role: "assistant",
      lineNumber: 2,
      lineText: "second",
      text: "Clarify this claim.",
    }];

    const prompt = buildTranscriptReviewPrompt(target, comments);

    expect(prompt).toContain("Message id: msg-1");
    expect(prompt).toContain("Message role: assistant");
    expect(prompt).toContain("Line: 2");
    expect(prompt).toContain("Comment: Clarify this claim.");
    expect(prompt).toContain("1: first\n2: second\n3: third");
    expect(prompt).toContain("Please address these comments.");
  });
});
