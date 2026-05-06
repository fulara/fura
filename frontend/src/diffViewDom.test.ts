import { describe, expect, it } from "vitest";
import { captureDiffFilterFocus, restoreDiffFilterFocus } from "./diffViewDom";

describe("diff file filter focus helpers", () => {
  it("restores focus and text selection after rerender", () => {
    const container = document.createElement("div");
    const input = document.createElement("input");
    input.className = "diff-filter-input";
    input.type = "search";
    input.value = "review.rs";
    container.append(input);
    document.body.append(container);

    input.focus();
    input.setSelectionRange(3, 6);
    const snapshot = captureDiffFilterFocus(container);

    const replacement = document.createElement("input");
    replacement.className = "diff-filter-input";
    replacement.type = "search";
    replacement.value = "review.rs";
    container.replaceChildren(replacement);

    restoreDiffFilterFocus(container, snapshot);

    expect(document.activeElement).toBe(replacement);
    expect(replacement.selectionStart).toBe(3);
    expect(replacement.selectionEnd).toBe(6);

    container.remove();
  });

  it("ignores unrelated active elements", () => {
    const container = document.createElement("div");
    const button = document.createElement("button");
    button.textContent = "Other";
    container.append(button);
    document.body.append(container);

    button.focus();

    expect(captureDiffFilterFocus(container)).toBeNull();

    container.remove();
  });
});
