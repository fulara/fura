import type { ClientMessage } from "./protocol";
import type { PendingImage, PendingSnippet } from "./composerAttachments";

export type PromptBehavior = "steer" | "followUp";
export type PromptImagePayload = { type: "image"; data: string; mimeType: string };
export type ComposerPromptDraft = {
  text: string;
  editorText: string;
  images: PendingImage[];
  snippets: PendingSnippet[];
};

export function isPromptImagePayload(value: unknown): value is PromptImagePayload {
  if (!value || typeof value !== "object") return false;
  const image = value as Record<string, unknown>;
  return image.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string";
}

export function restorePendingImagesFromPayload(
  images: unknown[],
  createMarker: (label: "Image") => string,
): PendingImage[] {
  const restored: PendingImage[] = [];
  for (const image of images) {
    if (!isPromptImagePayload(image)) continue;
    restored.push({
      type: "image",
      marker: createMarker("Image"),
      data: image.data,
      mimeType: image.mimeType,
    });
  }
  return restored;
}

export function promptImagePayloads(images: PendingImage[]): PromptImagePayload[] {
  return images.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
}

export function createPromptSendMessage(
  sessionId: string,
  text: string,
  images: PendingImage[],
  behavior?: PromptBehavior,
): ClientMessage {
  const message: ClientMessage = {
    type: "prompt.send",
    sessionId,
    text,
  };
  if (images.length > 0) {
    message.images = promptImagePayloads(images);
  }
  if (behavior) {
    message.behavior = behavior;
  }
  return message;
}

export function promptDraftAttachmentCount(draft: Pick<ComposerPromptDraft, "images" | "snippets">): number {
  return draft.images.length + draft.snippets.length;
}

export function promptDraftDisplayText(draft: ComposerPromptDraft): string {
  return draft.editorText || draft.text || (draft.images.length > 0 ? "[Image prompt]" : "");
}
