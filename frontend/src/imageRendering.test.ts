import { afterEach, describe, expect, it, vi } from "vitest";
import { openImageLightbox, renderImageAttachment } from "./imageRendering";

afterEach(() => {
  document.body.replaceChildren();
});

describe("renderImageAttachment", () => {
  it("opens a full-size lightbox when the image preview is clicked", () => {
    const node = renderImageAttachment({ data: "abc", mimeType: "image/png", alt: "Generated chart" }, "image-block");
    document.body.append(node);

    node.querySelector<HTMLButtonElement>(".image-preview-button")?.click();

    const dialog = document.querySelector<HTMLElement>(".image-lightbox");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(dialog?.querySelector("img")?.getAttribute("alt")).toBe("Generated chart");
    expect(dialog?.querySelector(".image-lightbox-meta")?.textContent).toBe("Generated chart · image/png");
    expect(dialog?.querySelector<HTMLAnchorElement>("a.image-lightbox-action")?.textContent).toBe("Open full size");
    expect(dialog?.querySelector<HTMLAnchorElement>("a.image-lightbox-action")?.href).toBe("data:image/png;base64,abc");
    expect(dialog?.querySelector<HTMLAnchorElement>("a[download]")?.download).toBe("fura-generated-chart.png");
  });

  it("does not open a lightbox for unsupported image mime types", () => {
    const result = openImageLightbox({ data: "abc", mimeType: "image/svg+xml" });

    expect(result).toBeNull();
    expect(document.querySelector(".image-lightbox")).toBeNull();
  });
});

describe("openImageLightbox", () => {
  it("closes from the close button, backdrop click, and Escape key", () => {
    openImageLightbox({ data: "abc", mimeType: "image/webp" });
    document.querySelector<HTMLButtonElement>(".image-lightbox-close")?.click();
    expect(document.querySelector(".image-lightbox")).toBeNull();

    const backdrop = openImageLightbox({ data: "abc", mimeType: "image/webp" });
    backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".image-lightbox")).toBeNull();

    openImageLightbox({ data: "abc", mimeType: "image/webp" });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".image-lightbox")).toBeNull();
  });

  it("copies image blobs to the clipboard when supported", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { write } });
    class TestClipboardItem {
      constructor(public readonly items: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    vi.useFakeTimers();

    openImageLightbox({ data: "aGVsbG8=", mimeType: "image/png" });
    const copy = Array.from(document.querySelectorAll<HTMLButtonElement>(".image-lightbox-action"))
      .find(button => button.textContent === "Copy image");
    copy?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(write).toHaveBeenCalledOnce();
    const [[clipboardItems]] = write.mock.calls;
    expect(clipboardItems).toHaveLength(1);
    expect(clipboardItems[0].items["image/png"]).toBeInstanceOf(Blob);
    expect(copy?.textContent).toBe("Copied");

    vi.runAllTimers();
    expect(copy?.textContent).toBe("Copy image");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
