import { describe, expect, it } from "vitest";
import {
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
    expect(resolvePromptSubmitAction({ ...base, slashCommandName: "fork" })).toEqual({ type: "openForkPicker" });
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
