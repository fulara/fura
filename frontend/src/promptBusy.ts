import {
  promptDraftAttachmentCount,
  promptDraftDisplayText,
  restorePendingImagesFromPayload,
  type ComposerPromptDraft,
} from "./composer";
import type { PendingImage, PendingSnippet } from "./composerAttachments";

export type BusyPromptDraft = ComposerPromptDraft & {
  sessionId: string;
  onSend?: () => void;
};

export function createBusyPromptDraft(input: {
  sessionId: string;
  text: string;
  editorText?: string;
  images?: PendingImage[];
  snippets?: PendingSnippet[];
  onSend?: () => void;
}): BusyPromptDraft {
  return {
    sessionId: input.sessionId,
    text: input.text,
    editorText: input.editorText ?? input.text,
    images: (input.images ?? []).map(image => ({ ...image })),
    snippets: (input.snippets ?? []).map(snippet => ({ ...snippet })),
    onSend: input.onSend,
  };
}

export function createBusyPromptDraftFromServer(
  input: { sessionId: string; text: string; images?: unknown[] | null },
  createImageMarker: (label: "Image") => string,
): BusyPromptDraft {
  return createBusyPromptDraft({
    sessionId: input.sessionId,
    text: input.text,
    images: restorePendingImagesFromPayload(input.images ?? [], createImageMarker),
  });
}

export function busyPromptDisplayText(draft: BusyPromptDraft): string {
  return promptDraftDisplayText(draft);
}

export function busyPromptAttachmentNote(draft: BusyPromptDraft): string {
  const attachmentCount = promptDraftAttachmentCount(draft);
  return attachmentCount > 0
    ? `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"} will be sent with this prompt.`
    : "";
}

export function restoreBusyPromptEditorText(draft: BusyPromptDraft, currentText: string): string {
  return [draft.editorText, currentText.trim()].filter(Boolean).join("\n\n");
}
