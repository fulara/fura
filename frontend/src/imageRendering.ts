import { mkEl } from "./dom";

export type RenderableImage = {
  data: string;
  mimeType: string;
  alt?: string | null;
};

const RENDERABLE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export function imagePlaceholderText(image: Pick<RenderableImage, "mimeType">): string {
  return `[Image: ${image.mimeType}]`;
}

export function isRenderableImageMime(mimeType: string): boolean {
  return RENDERABLE_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

export function imageDataUrl(image: RenderableImage): string | null {
  const mimeType = image.mimeType.trim().toLowerCase();
  if (!image.data || !isRenderableImageMime(mimeType)) return null;
  return `data:${mimeType};base64,${image.data}`;
}

export function renderImageAttachment(image: RenderableImage, className: string): HTMLElement {
  const wrapper = mkEl("figure");
  wrapper.className = className;
  wrapper.dataset.mimeType = image.mimeType;

  const src = imageDataUrl(image);
  if (!src) {
    const fallback = mkEl("figcaption");
    fallback.className = "image-fallback";
    fallback.textContent = imagePlaceholderText(image);
    wrapper.append(fallback);
    return wrapper;
  }

  const img = mkEl("img");
  img.src = src;
  img.alt = image.alt?.trim() || imagePlaceholderText(image);
  img.loading = "lazy";
  img.decoding = "async";
  wrapper.append(img);

  if (image.alt?.trim()) {
    const caption = mkEl("figcaption");
    caption.textContent = image.alt.trim();
    wrapper.append(caption);
  }

  return wrapper;
}
