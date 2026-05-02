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

function imageExtension(mimeType: string): string {
  switch (mimeType.trim().toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
    default:
      return "png";
  }
}

function imageDownloadName(image: RenderableImage): string {
  const label = image.alt?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const prefix = label ? `fura-${label}` : "fura-image";
  return `${prefix}.${imageExtension(image.mimeType)}`;
}

function imageBlob(image: RenderableImage): Blob | null {
  const mimeType = image.mimeType.trim().toLowerCase();
  if (!image.data || !isRenderableImageMime(mimeType)) return null;
  try {
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  } catch {
    return null;
  }
}

async function copyImageToClipboard(image: RenderableImage): Promise<void> {
  const blob = imageBlob(image);
  if (!blob || !navigator.clipboard || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is not supported in this browser.");
  }
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
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

  const button = mkEl("button");
  button.type = "button";
  button.className = "image-preview-button";
  button.setAttribute("aria-label", `Open image preview: ${image.alt?.trim() || image.mimeType}`);
  button.addEventListener("click", () => openImageLightbox(image, wrapper.ownerDocument));

  const img = mkEl("img");
  img.src = src;
  img.alt = image.alt?.trim() || imagePlaceholderText(image);
  img.loading = "lazy";
  img.decoding = "async";
  button.append(img);
  wrapper.append(button);

  if (image.alt?.trim()) {
    const caption = mkEl("figcaption");
    caption.textContent = image.alt.trim();
    wrapper.append(caption);
  }

  return wrapper;
}

export function openImageLightbox(image: RenderableImage, owner: Document = document): HTMLElement | null {
  const src = imageDataUrl(image);
  if (!src) return null;

  const overlay = owner.createElement("div");
  overlay.className = "image-lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", image.alt?.trim() || imagePlaceholderText(image));

  const panel = owner.createElement("div");
  panel.className = "image-lightbox-panel";

  const close = owner.createElement("button");
  close.type = "button";
  close.className = "image-lightbox-close";
  close.setAttribute("aria-label", "Close image preview");
  close.textContent = "×";

  const actions = owner.createElement("div");
  actions.className = "image-lightbox-actions";

  const open = owner.createElement("a");
  open.className = "image-lightbox-action";
  open.href = src;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = "Open full size";

  const download = owner.createElement("a");
  download.className = "image-lightbox-action";
  download.href = src;
  download.download = imageDownloadName(image);
  download.textContent = "Save as";

  const copy = owner.createElement("button");
  copy.type = "button";
  copy.className = "image-lightbox-action";
  copy.textContent = "Copy image";
  copy.addEventListener("click", async () => {
    copy.disabled = true;
    try {
      await copyImageToClipboard(image);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy unavailable";
    } finally {
      owner.defaultView?.setTimeout(() => {
        copy.disabled = false;
        copy.textContent = "Copy image";
      }, 1200);
    }
  });

  actions.append(open, download, copy);

  const img = owner.createElement("img");
  img.src = src;
  img.alt = image.alt?.trim() || imagePlaceholderText(image);

  const meta = owner.createElement("div");
  meta.className = "image-lightbox-meta";
  meta.textContent = image.alt?.trim() ? `${image.alt.trim()} · ${image.mimeType}` : image.mimeType;

  const cleanup = () => {
    owner.defaultView?.removeEventListener("keydown", onKeydown);
    overlay.remove();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") cleanup();
  };

  close.addEventListener("click", cleanup);
  overlay.addEventListener("click", event => {
    if (event.target === overlay) cleanup();
  });
  owner.defaultView?.addEventListener("keydown", onKeydown);

  panel.append(close, img, actions, meta);
  overlay.append(panel);
  owner.body.append(overlay);
  close.focus();
  return overlay;
}
