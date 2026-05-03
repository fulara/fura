import { describe, expect, it } from "vitest";
import {
  busyPromptAttachmentNote,
  busyPromptDisplayText,
  createBusyPromptDraft,
  createBusyPromptDraftFromServer,
  restoreBusyPromptEditorText,
} from "./promptBusy";

describe("prompt busy helpers", () => {
  it("restores server prompt.busy image payloads into composer drafts", () => {
    let marker = 0;
    const draft = createBusyPromptDraftFromServer(
      {
        sessionId: "s1",
        text: "look",
        images: [
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "text", text: "ignored" },
        ],
      },
      () => `[Image #${++marker}]`,
    );

    expect(draft).toMatchObject({
      sessionId: "s1",
      text: "look",
      editorText: "look",
      images: [{ type: "image", marker: "[Image #1]", data: "abc", mimeType: "image/png" }],
      snippets: [],
    });
  });

  it("formats display text, attachment notes, and restored editor text", () => {
    const draft = createBusyPromptDraft({
      sessionId: "s1",
      text: "expanded",
      editorText: "typed",
      images: [{ type: "image", marker: "[Image #1]", data: "abc", mimeType: "image/png" }],
    });

    expect(busyPromptDisplayText(draft)).toBe("typed");
    expect(busyPromptAttachmentNote(draft)).toBe("1 attachment will be sent with this prompt.");
    expect(restoreBusyPromptEditorText(draft, "current")).toBe("typed\n\ncurrent");
  });
});
