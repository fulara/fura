import { describe, expect, it } from "vitest";
import { nextThinkingVisibilityMode, parseThinkingVisibilityMode } from "./uiPreferences";

describe("parseThinkingVisibilityMode", () => {
  it("preserves supported values", () => {
    expect(parseThinkingVisibilityMode("shown")).toBe("shown");
    expect(parseThinkingVisibilityMode("hidden")).toBe("hidden");
    expect(parseThinkingVisibilityMode("auto")).toBe("auto");
  });

  it("keeps legacy true as shown", () => {
    expect(parseThinkingVisibilityMode("true")).toBe("shown");
  });

  it("falls back to auto for missing or invalid values", () => {
    expect(parseThinkingVisibilityMode(null)).toBe("auto");
    expect(parseThinkingVisibilityMode("false")).toBe("auto");
    expect(parseThinkingVisibilityMode("unexpected")).toBe("auto");
  });
});

describe("nextThinkingVisibilityMode", () => {
  it("cycles through auto, shown, and hidden", () => {
    expect(nextThinkingVisibilityMode("auto")).toBe("shown");
    expect(nextThinkingVisibilityMode("shown")).toBe("hidden");
    expect(nextThinkingVisibilityMode("hidden")).toBe("auto");
  });
});
