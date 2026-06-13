import { describe, expect, it } from "vitest";
import {
  createPromptSendMessage,
  isPromptImagePayload,
  promptDraftAttachmentCount,
  promptDraftDisplayText,
  promptImagePayloads,
  restorePendingImagesFromPayload,
  resolvePromptSubmitAction,
} from "./composer";
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

  it("restores pending images from prompt.busy payloads and ignores malformed values", () => {
    let nextId = 1;

    expect(restorePendingImagesFromPayload([
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "text", data: "ignored", mimeType: "text/plain" },
      { type: "image", data: "def", mimeType: "image/jpeg" },
    ], () => `[Image ${nextId++}]`)).toEqual([
      { type: "image", marker: "[Image 1]", data: "abc", mimeType: "image/png" },
      { type: "image", marker: "[Image 2]", data: "def", mimeType: "image/jpeg" },
    ]);
  });

  it("strips local markers from outgoing image payloads", () => {
    expect(promptImagePayloads([image])).toEqual([{ type: "image", data: "abc", mimeType: "image/png" }]);
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
