import { describe, expect, it } from "vitest";
import { appendEventTimestamp, renderEventTimestamp } from "./eventTime";

describe("renderEventTimestamp", () => {
  it("returns null for missing, invalid, and non-positive timestamps", () => {
    expect(renderEventTimestamp(null)).toBeNull();
    expect(renderEventTimestamp(undefined)).toBeNull();
    expect(renderEventTimestamp(Number.NaN)).toBeNull();
    expect(renderEventTimestamp(0)).toBeNull();
    expect(renderEventTimestamp(-1)).toBeNull();
  });

  it("renders valid timestamps as time elements", () => {
    const node = renderEventTimestamp(Date.UTC(2026, 4, 1, 12, 34));

    expect(node?.tagName).toBe("TIME");
    expect(node?.dateTime).toBe("2026-05-01T12:34:00.000Z");
    expect(node?.className).toBe("event-timestamp");
    expect(node?.title).not.toBe("");
  });
});

describe("appendEventTimestamp", () => {
  it("appends only valid timestamps", () => {
    const container = document.createElement("div");

    appendEventTimestamp(container, null);
    expect(container.childElementCount).toBe(0);

    appendEventTimestamp(container, Date.UTC(2026, 4, 1, 12, 34));
    expect(container.querySelector("time")?.dateTime).toBe("2026-05-01T12:34:00.000Z");
  });
});
