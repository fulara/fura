import { describe, expect, it } from "vitest";
import {
  CONTROLLER_DRAFT,
  NO_SESSION_DRAFT,
  SessionComposerDrafts,
  createPromptSendMessage,
  isPromptImagePayload,
  promptDraftAttachmentCount,
  promptDraftDisplayText,
  promptImagePayloads,
  restorePendingImagesFromDraft,
  resolvePromptSubmitAction,
} from "./composer";
import { removePendingMarkerFromText } from "./composerAttachments";
import type { PendingImage, PendingSnippet } from "./composerAttachments";

const image: PendingImage = { type: "image", marker: "[Image 1]", data: "abc", mimeType: "image/png" };
const snippet: PendingSnippet = { type: "snippet", marker: "[Snippet 1]", text: "long pasted text" };

describe("SessionComposerDrafts", () => {
  it("keeps exact session text and attachments across switches without sharing empty arrays", () => {
    const drafts = new SessionComposerDrafts();
    const first = drafts.get("session-1");
    const second = drafts.get("session-2");
    const text = "\t  Zażółć 漢字 e\u0301 \u{1D11E}\n\n  indented line\t\n ";
    first.editorText = text;
    first.images.push(image);
    first.snippets.push(snippet);

    expect(second).toEqual({ editorText: "", images: [], snippets: [] });
    second.editorText = "other session";
    expect(drafts.get("session-2")).toBe(second);
    expect(drafts.get("session-1")).toBe(first);
    expect(drafts.get("session-1")).toEqual({ editorText: text, images: [image], snippets: [snippet] });
    expect(drafts.get("session-2").editorText).toBe("other session");
    expect(drafts.isCurrent("session-1", first)).toBe(true);
    expect(drafts.isCurrent("session-1", { ...first })).toBe(false);
    expect(drafts.isCurrent("session-2", first)).toBe(false);
  });

  it("retains whitespace-only drafts", () => {
    const drafts = new SessionComposerDrafts();
    drafts.get("session-1").editorText = " \t\n\n  ";
    drafts.get("session-2");

    expect(drafts.get("session-1").editorText).toBe(" \t\n\n  ");
  });

  it("isolates controller and no-session drafts from each other and string session IDs", () => {
    const drafts = new SessionComposerDrafts();
    const keys = [
      CONTROLLER_DRAFT, NO_SESSION_DRAFT,
      "controller", "no-session", String(CONTROLLER_DRAFT), String(NO_SESSION_DRAFT),
    ];
    keys.forEach((key, index) => {
      drafts.get(key).editorText = `draft ${index}`;
    });

    keys.forEach((key, index) => {
      expect(drafts.get(key).editorText).toBe(`draft ${index}`);
    });
  });

  it("clears only the origin while retaining other sessions and workspace drafts", () => {
    const drafts = new SessionComposerDrafts();
    const origin = drafts.get("session-1");
    origin.editorText = "sent";
    const other = drafts.get("session-2");
    other.editorText = "still unsent";
    other.images.push(image);
    const controller = drafts.get(CONTROLLER_DRAFT);
    controller.editorText = "controller unsent";
    const noSession = drafts.get(NO_SESSION_DRAFT);
    noSession.snippets.push(snippet);

    drafts.clear("session-1");
    drafts.clear("missing-session");

    expect(drafts.get("session-1")).toEqual({ editorText: "", images: [], snippets: [] });
    expect(drafts.get("session-2")).toBe(other);
    expect(other).toEqual({ editorText: "still unsent", images: [image], snippets: [] });
    expect(drafts.get(CONTROLLER_DRAFT)).toBe(controller);
    expect(controller.editorText).toBe("controller unsent");
    expect(drafts.get(NO_SESSION_DRAFT)).toBe(noSession);
    expect(noSession.snippets).toEqual([snippet]);
  });

  it("invalidates detached drafts so delayed work cannot repopulate a sent or deleted draft", () => {
    const drafts = new SessionComposerDrafts();
    const detached = drafts.get("session-1");
    detached.editorText = "old draft";
    expect(drafts.isCurrent("session-1", detached)).toBe(true);

    drafts.clear("session-1");
    expect(drafts.isCurrent("session-1", detached)).toBe(false);
    const fresh = drafts.get("session-1");
    expect(fresh).not.toBe(detached);
    expect(drafts.isCurrent("session-1", detached)).toBe(false);
    expect(drafts.isCurrent("session-1", fresh)).toBe(true);

    detached.editorText = "late text";
    detached.images.push(image);
    detached.snippets.push(snippet);
    expect(drafts.get("session-1")).toEqual({ editorText: "", images: [], snippets: [] });
  });
});

describe("resolvePromptSubmitAction", () => {
  const base = {
    workspaceMode: "session" as const,
    text: "hello",
    imageCount: 0,
    activeSessionId: "session-1",
    isModelPickerCommand: false,
    slashCommandName: null,
  };

  it("ignores empty controller submits before checking images", () => {
    expect(resolvePromptSubmitAction({
      ...base,
      workspaceMode: "controller",
      text: "",
      imageCount: 1,
    })).toEqual({ type: "ignore" });
  });

  it("rejects Ask Fura image attachments and accepts text-only controller prompts", () => {
    expect(resolvePromptSubmitAction({
      ...base,
      workspaceMode: "controller",
      imageCount: 1,
    })).toEqual({ type: "controller.rejectImages" });
    expect(resolvePromptSubmitAction({
      ...base,
      workspaceMode: "controller",
    })).toEqual({ type: "controller.submit" });
  });

  it("ignores empty session submits and missing active sessions", () => {
    expect(resolvePromptSubmitAction({ ...base, text: "", imageCount: 0 })).toEqual({ type: "ignore" });
    expect(resolvePromptSubmitAction({ ...base, activeSessionId: null })).toEqual({ type: "ignore" });
  });

  it("opens the model picker only for image-free model picker commands", () => {
    expect(resolvePromptSubmitAction({ ...base, isModelPickerCommand: true })).toEqual({
      type: "openModelPicker",
      sessionId: "session-1",
    });
    expect(resolvePromptSubmitAction({ ...base, isModelPickerCommand: true, imageCount: 1 })).toEqual({
      type: "sendPrompt",
      sessionId: "session-1",
    });
  });

  it("routes known slash commands to their modal actions", () => {
    expect(resolvePromptSubmitAction({ ...base, slashCommandName: "new" })).toEqual({ type: "openCwdPicker" });
    expect(resolvePromptSubmitAction({ ...base, slashCommandName: "fork" })).toEqual({ type: "duplicateSession", sessionId: "session-1" });
    expect(resolvePromptSubmitAction({ ...base, slashCommandName: "handoff" })).toEqual({ type: "openHandoffPicker" });
    expect(resolvePromptSubmitAction({ ...base, slashCommandName: "commands" })).toEqual({ type: "openCommandsPopup", sessionId: "session-1" });
    expect(resolvePromptSubmitAction({ ...base, slashCommandName: "help" })).toEqual({ type: "openCommandsPopup", sessionId: "session-1" });
  });

  it("sends normal prompts and unknown slash commands", () => {
    expect(resolvePromptSubmitAction(base)).toEqual({ type: "sendPrompt", sessionId: "session-1" });
    expect(resolvePromptSubmitAction({ ...base, slashCommandName: "future" })).toEqual({ type: "sendPrompt", sessionId: "session-1" });
  });
});

describe("prompt image payloads", () => {
  it("recognizes only complete image payloads", () => {
    expect(isPromptImagePayload({ type: "image", data: "abc", mimeType: "image/png" })).toBe(true);
    expect(isPromptImagePayload({ type: "image", data: "abc" })).toBe(false);
    expect(isPromptImagePayload(null)).toBe(false);
  });

  it("restores exact OMP and legacy markers and creates fallbacks only when absent", () => {
    let nextId = 9;
    const restored = restorePendingImagesFromDraft(
      "a [Image #1, 640x480] attachment://1 b [Image 2] c [Image #4, detail]",
      [
        { type: "image", data: "one", mimeType: "image/png", detail: "high" },
        { type: "image", data: "two", mimeType: "image/jpeg", providerFile: "file-2" },
        { type: "image", data: "three", mimeType: "image/webp", url: "https://example.test/3" },
        { type: "image", data: "four", mimeType: "image/gif" },
      ],
      () => `[Image ${nextId++}]`,
    );

    expect(restored.map(value => value.marker)).toEqual([
      "[Image #1, 640x480] attachment://1",
      "[Image 2]",
      "[Image 11]",
      "[Image #4, detail]",
    ]);
    expect(removePendingMarkerFromText("before [Image #1, 640x480] attachment://1 after", restored[0]?.marker ?? ""))
      .toBe("before after");
    expect(promptImagePayloads(restored)).toEqual([
      { type: "image", data: "one", mimeType: "image/png", detail: "high" },
      { type: "image", data: "two", mimeType: "image/jpeg", providerFile: "file-2" },
      { type: "image", data: "three", mimeType: "image/webp", url: "https://example.test/3" },
      { type: "image", data: "four", mimeType: "image/gif" },
    ]);
    expect(nextId).toBe(13);
  });

  it("reserves restored marker ids before a new image is attached", () => {
    let nextId = 1;
    const createMarker = () => `[Image ${nextId++}]`;
    const restored = restorePendingImagesFromDraft(
      "existing [Image 1]",
      [{ type: "image", data: "old", mimeType: "image/png" }],
      createMarker,
    );
    const newMarker = createMarker();

    expect(restored[0]?.marker).toBe("[Image 1]");
    expect(newMarker).toBe("[Image 2]");
    expect(removePendingMarkerFromText(`existing [Image 1] ${newMarker}`, newMarker)).toBe("existing [Image 1]");
  });

  it("ignores malformed values while preserving every own payload field", () => {
    const restored = restorePendingImagesFromDraft("", [
      { type: "text", data: "ignored", mimeType: "text/plain" },
      { type: "image", data: "abc", mimeType: "image/png", detail: "low" },
    ], () => "[Image 1]");

    expect(restored).toEqual([
      { type: "image", marker: "[Image 1]", data: "abc", mimeType: "image/png", detail: "low" },
    ]);
  });
});

describe("createPromptSendMessage", () => {
  it("creates text-only prompt messages", () => {
    expect(createPromptSendMessage("session-1", "hello", [])).toEqual({
      type: "prompt.send",
      sessionId: "session-1",
      text: "hello",
    });
  });

  it("includes images and busy behavior when present", () => {
    expect(createPromptSendMessage("session-1", "hello", [image], "followUp")).toEqual({
      type: "prompt.send",
      sessionId: "session-1",
      text: "hello",
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
      behavior: "followUp",
    });
  });
});

describe("prompt draft helpers", () => {
  it("counts image and snippet attachments", () => {
    expect(promptDraftAttachmentCount({ images: [image], snippets: [snippet] })).toBe(2);
  });

  it("chooses editor text, fallback text, or an image-only label", () => {
    expect(promptDraftDisplayText({ text: "expanded", editorText: "raw", images: [], snippets: [] })).toBe("raw");
    expect(promptDraftDisplayText({ text: "expanded", editorText: "", images: [], snippets: [] })).toBe("expanded");
    expect(promptDraftDisplayText({ text: "", editorText: "", images: [image], snippets: [] })).toBe("[Image prompt]");
  });
});
