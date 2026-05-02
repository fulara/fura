import { describe, expect, it } from "vitest";
import {
  createPromptSendMessage,
  isPromptImagePayload,
  promptDraftAttachmentCount,
  promptDraftDisplayText,
  promptImagePayloads,
  restorePendingImagesFromPayload,
} from "./composer";
import type { PendingImage, PendingSnippet } from "./composerAttachments";

const image: PendingImage = { type: "image", marker: "[Image 1]", data: "abc", mimeType: "image/png" };
const snippet: PendingSnippet = { type: "snippet", marker: "[Snippet 1]", text: "long pasted text" };

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
