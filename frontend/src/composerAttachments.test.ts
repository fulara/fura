import { describe, expect, it, vi } from "vitest";
import {
  createPendingMarker,
  expandSnippetTokens,
  removePendingMarkerFromText,
  renderAttachmentPreviews,
  stripDataUrlPrefix,
  type PendingImage,
  type PendingSnippet,
} from "./composerAttachments";

describe("createPendingMarker", () => {
  it("creates stable attachment markers", () => {
    expect(createPendingMarker("Image", 2)).toBe("[Image 2]");
    expect(createPendingMarker("Snippet", 3)).toBe("[Snippet 3]");
  });
});

describe("stripDataUrlPrefix", () => {
  it("strips a data URL prefix when present", () => {
    expect(stripDataUrlPrefix("data:image/png;base64,abc123")).toBe("abc123");
  });

  it("leaves raw data intact when no prefix exists", () => {
    expect(stripDataUrlPrefix("abc123")).toBe("abc123");
  });
});

describe("removePendingMarkerFromText", () => {
  it("removes marker and one surrounding space", () => {
    expect(removePendingMarkerFromText("hello [Image 1] world", "[Image 1]")).toBe("hello world");
  });

  it("removes following space at start", () => {
    expect(removePendingMarkerFromText("[Image 1] world", "[Image 1]")).toBe("world");
  });

  it("returns original text when marker is absent", () => {
    expect(removePendingMarkerFromText("hello", "[Image 1]")).toBe("hello");
  });
});

describe("expandSnippetTokens", () => {
  it("expands every occurrence of snippet markers", () => {
    const snippets: PendingSnippet[] = [{ type: "snippet", marker: "[Snippet 1]", text: "long pasted text" }];

    expect(expandSnippetTokens("Use [Snippet 1] and [Snippet 1]", snippets)).toBe(
      "Use \n\n--- Snippet 1 ---\nlong pasted text\n--- and \n\n--- Snippet 1 ---\nlong pasted text\n---",
    );
  });
});

describe("renderAttachmentPreviews", () => {
  it("hides the container when there are no attachments", () => {
    const container = document.createElement("div");

    renderAttachmentPreviews(container, [], [], { onRemoveImage: () => {}, onRemoveSnippet: () => {} });

    expect(container.hidden).toBe(true);
    expect(container.childElementCount).toBe(0);
  });

  it("renders image thumbnails and snippet chips with remove callbacks", () => {
    const container = document.createElement("div");
    const image: PendingImage = { type: "image", marker: "[Image 1]", data: "abc", mimeType: "image/png" };
    const snippet: PendingSnippet = { type: "snippet", marker: "[Snippet 2]", text: "one two three four five six seven eight nine" };
    const onRemoveImage = vi.fn();
    const onRemoveSnippet = vi.fn();

    renderAttachmentPreviews(container, [image], [snippet], { onRemoveImage, onRemoveSnippet });

    expect(container.hidden).toBe(false);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("Image 1");
    expect(container.querySelector(".snippet-chip")?.textContent).toContain("[Snippet 2] one two three four five six seven eight");

    container.querySelector<HTMLButtonElement>('button[aria-label="Remove image"]')?.click();
    container.querySelector<HTMLButtonElement>('button[aria-label="Remove snippet"]')?.click();

    expect(onRemoveImage).toHaveBeenCalledWith(0, image);
    expect(onRemoveSnippet).toHaveBeenCalledWith(0, snippet);
  });
});
