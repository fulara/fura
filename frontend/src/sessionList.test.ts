import { describe, expect, it } from "vitest";
import {
  formatMessageCount,
  formatSessionMeta,
  fuzzyCategoryScore,
  fuzzyMatchCategories,
  normalizedCategory,
  sessionCategories,
  sessionKindLabel,
  sessionStatusClass,
  sessionStatusLabel,
  visibleSessions,
} from "./sessionList";
import type { SessionSummary } from "./protocol";

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    kind: "managed",
    sessionId: "session-1",
    status: "idle",
    createdAt: 1,
    messageCount: 0,
    ...overrides,
  };
}

describe("session labels", () => {
  it("formats status labels and classes", () => {
    expect(sessionStatusLabel(session({ status: "starting" }))).toBe("Opening");
    expect(sessionStatusLabel(session({ status: "idle" }))).toBe("Ready");
    expect(sessionStatusLabel(session({ status: "busy" }))).toBe("Working");
    expect(sessionStatusLabel(session({ kind: "available", status: "error" }))).toBe("Saved");
    expect(sessionStatusClass(session({ kind: "available", status: "error" }))).toBe("available");
    expect(sessionStatusClass(session({ kind: "managed", status: "error" }))).toBe("error");
  });

  it("formats kind and message count", () => {
    expect(sessionKindLabel("managed")).toBe("Live");
    expect(sessionKindLabel("available")).toBe("Saved");
    expect(formatMessageCount(1)).toBe("1 msg");
    expect(formatMessageCount(2)).toBe("2 msgs");
  });
});

describe("session metadata", () => {
  it("normalizes categories", () => {
    expect(normalizedCategory("  work ")).toBe("work");
    expect(normalizedCategory(null)).toBe("");
  });

  it("formats session metadata", () => {
    expect(formatSessionMeta(session({
      cwd: "/home/aleksander/repos/fura",
      messageCount: 12,
      category: "Mobile",
    }))).toBe("Mobile · …/repos/fura · Live · 12 msgs");
  });
});

describe("categories", () => {
  it("deduplicates categories case-insensitively and sorts them", () => {
    const sessions = [
      session({ category: "Mobile" }),
      session({ sessionId: "session-2", category: "mobile" }),
      session({ sessionId: "session-3", category: "Backend" }),
      session({ sessionId: "session-4", category: "" }),
    ];

    expect(sessionCategories(sessions)).toEqual(["Backend", "Mobile"]);
  });

  it("scores fuzzy category matches", () => {
    expect(fuzzyCategoryScore("Mobile", "mob")).toBeLessThan(fuzzyCategoryScore("Maybe Mobile", "mob") ?? Infinity);
    expect(fuzzyCategoryScore("Backend", "mob")).toBeNull();
  });

  it("fuzzy matches categories in score order", () => {
    expect(fuzzyMatchCategories(["Maybe Mobile", "Mobile", "Backend"], "mob")).toEqual(["Mobile", "Maybe Mobile"]);
  });
});

describe("visibleSessions", () => {
  it("filters by exact normalized category", () => {
    const sessions = [session({ category: "Mobile" }), session({ sessionId: "session-2", category: "Backend" })];

    expect(visibleSessions(sessions, "")).toBe(sessions);
    expect(visibleSessions(sessions, "Mobile").map(item => item.sessionId)).toEqual(["session-1"]);
  });
});
