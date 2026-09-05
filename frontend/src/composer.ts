import type { ClientMessage, PromptImagePayload } from "./protocol";
import type { PendingImage, PendingSnippet } from "./composerAttachments";

export type PromptBehavior = "steer" | "followUp";
export type ComposerPromptDraft = {
  text: string;
  editorText: string;
  images: PendingImage[];
  snippets: PendingSnippet[];
};

const IMAGE_MARKER_PATTERN = /\[Image (?:#)?([1-9]\d*)(?:,[^\]\n]*)?\](?: attachment:\/\/\1)?/g;
export type PromptSubmitWorkspaceMode = "session" | "controller";
export type PromptSubmitAction =
  | { type: "ignore" }
  | { type: "controller.rejectImages" }
  | { type: "controller.submit" }
  | { type: "openModelPicker"; sessionId: string }
  | { type: "openCwdPicker" }
  | { type: "openForkPicker" }
  | { type: "openHandoffPicker" }
  | { type: "openCommandsPopup"; sessionId: string }
  | { type: "sendPrompt"; sessionId: string };

export type PromptSubmitDecisionInput = {
  workspaceMode: PromptSubmitWorkspaceMode;
  text: string;
  imageCount: number;
  activeSessionId: string | null;
  isModelPickerCommand: boolean;
  slashCommandName?: string | null;
};

export function resolvePromptSubmitAction(input: PromptSubmitDecisionInput): PromptSubmitAction {
  if (input.workspaceMode === "controller") {
    if (!input.text) return { type: "ignore" };
    if (input.imageCount > 0) return { type: "controller.rejectImages" };
    return { type: "controller.submit" };
  }

  if ((!input.text && input.imageCount === 0) || !input.activeSessionId) return { type: "ignore" };
  if (input.imageCount === 0 && input.isModelPickerCommand) {
    return { type: "openModelPicker", sessionId: input.activeSessionId };
  }
  if (input.slashCommandName === "new") return { type: "openCwdPicker" };
  if (input.slashCommandName === "fork") return { type: "openForkPicker" };
  if (input.slashCommandName === "handoff") return { type: "openHandoffPicker" };
  if (input.slashCommandName === "commands" || input.slashCommandName === "help") {
    return { type: "openCommandsPopup", sessionId: input.activeSessionId };
  }
  return { type: "sendPrompt", sessionId: input.activeSessionId };
}


export function isPromptImagePayload(value: unknown): value is PromptImagePayload {
  if (!value || typeof value !== "object") return false;
  const image = value as Record<string, unknown>;
  return image.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string";
}

export function restorePendingImagesFromDraft(
  text: string,
  images: readonly unknown[],
  createFallbackMarker: (label: "Image") => string,
): PendingImage[] {
  const markers = new Map<number, string>();
  for (const match of text.matchAll(IMAGE_MARKER_PATTERN)) {
    const position = Number(match[1]);
    if (!markers.has(position)) markers.set(position, match[0]);
  }

  const restored: PendingImage[] = [];
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    if (!isPromptImagePayload(image)) continue;
    const fallbackMarker = createFallbackMarker("Image");
    restored.push({
      ...image,
      marker: markers.get(index + 1) ?? fallbackMarker,
    });
  }
  return restored;
}

export function promptImagePayloads(images: PendingImage[]): PromptImagePayload[] {
  return images.map(image => {
    const { marker: _marker, ...payload } = image;
    return payload as PromptImagePayload;
  });
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
