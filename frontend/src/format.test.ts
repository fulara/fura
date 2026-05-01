import { describe, expect, it } from "vitest";
import { formatContext, formatCost, formatTokens, shortId, shortPath } from "./format";

describe("shortPath", () => {
  it("keeps short and relative paths intact", () => {
    expect(shortPath("project/src")).toBe("project/src");
    expect(shortPath("/project/src")).toBe("/project/src");
  });

  it("collapses long absolute paths to their last two segments", () => {
    expect(shortPath("/home/aleksander/repos/fura")).toBe("…/repos/fura");
  });
});

describe("formatTokens", () => {
  it("formats invalid and non-positive values as zero tokens", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(-1)).toBe("0 tokens");
    expect(formatTokens(Number.NaN)).toBe("0 tokens");
  });

  it("formats finite token counts using compact units", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1K");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});

describe("formatCost", () => {
  it("formats invalid and non-positive values as zero dollars", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(-1)).toBe("$0.00");
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });

  it("formats positive values with two decimals", () => {
    expect(formatCost(0.125)).toBe("$0.13");
    expect(formatCost(12)).toBe("$12.00");
  });
});

describe("formatContext", () => {
  it("formats percentage and compact context window", () => {
    expect(formatContext(0.236, 900)).toBe("0.24%/900");
    expect(formatContext(2.84, 12_300)).toBe("2.8%/12K");
    expect(formatContext(19.99, 1_000_000)).toBe("20.0%/1.0M");
  });
});


describe("shortId", () => {
  it("returns the first eight characters", () => {
    expect(shortId("abcdefghi")).toBe("abcdefgh");
    expect(shortId("abc")).toBe("abc");
  });
});