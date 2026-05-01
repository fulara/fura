export type PendingImage = { type: "image"; marker: string; data: string; mimeType: string };
export type PendingSnippet = { type: "snippet"; marker: string; text: string };

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mimeType>;base64,<data>" — strip the prefix
      resolve(stripDataUrlPrefix(result));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

export function createPendingMarker(label: "Image" | "Snippet", id: number): string {
  return `[${label} ${id}]`;
}

export function removePendingMarkerFromText(value: string, marker: string): string {
  const index = value.indexOf(marker);
  if (index === -1) return value;

  let start = index;
  let end = index + marker.length;
  if (start > 0 && value[start - 1] === " " && (end === value.length || value[end] === " ")) {
    start--;
  } else if (end < value.length && value[end] === " ") {
    end++;
  }

  return `${value.slice(0, start)}${value.slice(end)}`;
}

export function expandSnippetTokens(text: string, snippets: PendingSnippet[]): string {
  let expanded = text;
  for (const snippet of snippets) {
    expanded = expanded.split(snippet.marker).join(`\n\n--- ${snippet.marker.slice(1, -1)} ---\n${snippet.text}\n---`);
  }
  return expanded;
}

type RenderAttachmentPreviewsOptions = {
  onRemoveImage(index: number, image: PendingImage): void;
  onRemoveSnippet(index: number, snippet: PendingSnippet): void;
};

export function renderAttachmentPreviews(
  container: HTMLElement,
  images: PendingImage[],
  snippets: PendingSnippet[],
  options: RenderAttachmentPreviewsOptions,
): void {
  container.replaceChildren();
  if (images.length === 0 && snippets.length === 0) {
    container.hidden = true;
    return;
  }

  const owner = container.ownerDocument;
  container.hidden = false;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const thumb = owner.createElement("div");
    thumb.className = "image-thumb";

    const el = owner.createElement("img");
    el.src = `data:${img.mimeType};base64,${img.data}`;
    el.alt = img.marker.slice(1, -1);

    const remove = owner.createElement("button");
    remove.type = "button";
    remove.className = "image-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove image");
    remove.addEventListener("click", () => options.onRemoveImage(i, img));

    thumb.append(el, remove);
    container.append(thumb);
  }

  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i];
    const chip = owner.createElement("div");
    chip.className = "snippet-chip";
    chip.textContent = `${snippet.marker} ${snippet.text.split(/\s+/).slice(0, 8).join(" ")}`;
    const remove = owner.createElement("button");
    remove.type = "button";
    remove.className = "image-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove snippet");
    remove.addEventListener("click", () => options.onRemoveSnippet(i, snippet));
    chip.append(remove);
    container.append(chip);
  }
}
