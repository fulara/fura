import { describe, expect, it } from "vitest";
import {
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
          { type: "image", data: "abc", mimeType: "image/png", detail: "high" },
          { type: "text", text: "ignored" },
        ],
      },
      () => `[Image #${++marker}]`,
    );

    expect(draft).toMatchObject({
      sessionId: "s1",
      text: "look",
      editorText: "look",
      images: [{ type: "image", marker: "[Image #1]", data: "abc", mimeType: "image/png", detail: "high" }],
      snippets: [],
    });
  });

  it("uses raw editor text for display and restores it before current text", () => {
    const draft = createBusyPromptDraft({
      sessionId: "s1",
      text: "expanded",
      editorText: "typed",
      images: [{ type: "image", marker: "[Image #1]", data: "abc", mimeType: "image/png" }],
    });

    expect(busyPromptDisplayText(draft)).toBe("typed");
    expect(restoreBusyPromptEditorText(draft, "current")).toBe("typed\n\ncurrent");
  });

  it("preserves exact whitespace and Unicode on both sides of restored editor text", () => {
    const editorText = "\t  Zażółć 漢字 e\u0301\n\n  old line  \n";
    const currentText = " \n\tnew line \u{1D11E}  \n\n ";
    const draft = createBusyPromptDraft({ sessionId: "s1", text: "expanded", editorText });

    expect(restoreBusyPromptEditorText(draft, currentText)).toBe(`${editorText}\n\n${currentText}`);
  });

  it("retains whitespace-only current text and adds separators only between nonempty texts", () => {
    const draft = createBusyPromptDraft({ sessionId: "s1", text: "typed" });
    expect(restoreBusyPromptEditorText(draft, " \t\n ")).toBe("typed\n\n \t\n ");
    expect(restoreBusyPromptEditorText(draft, "")).toBe("typed");

    const empty = createBusyPromptDraft({ sessionId: "s1", text: "", editorText: "" });
    expect(restoreBusyPromptEditorText(empty, " \t\n ")).toBe(" \t\n ");
    expect(restoreBusyPromptEditorText(empty, "")).toBe("");
  });
});
