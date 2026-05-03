import { describe, expect, it } from "vitest";
import {
  extensionDialogBodyText,
  formatExtensionDialogNotification,
  parseExtensionDialogRequest,
} from "./extensionDialog";

describe("extension dialog parsing", () => {
  it("parses known extension UI dialog fields without dropping domain details", () => {
    const request = parseExtensionDialogRequest("s1", {
      id: "dialog-1",
      method: "select",
      title: "Pick one",
      message: "Choose carefully",
      options: ["alpha", 2, "beta"],
      timeout: 1500,
      promptStyle: true,
    });

    expect(request).toMatchObject({
      sessionId: "s1",
      id: "dialog-1",
      method: "select",
      title: "Pick one",
      message: "Choose carefully",
      options: ["alpha", "beta"],
      timeoutMs: 1500,
      promptStyle: true,
    });
  });

  it("rejects malformed requests that cannot be answered", () => {
    expect(parseExtensionDialogRequest("s1", null)).toBeNull();
    expect(parseExtensionDialogRequest("s1", { method: "confirm" })).toBeNull();
    expect(parseExtensionDialogRequest("s1", { id: "dialog-1" })).toBeNull();
  });

  it("formats fallback titles, body text, and notifications", () => {
    const request = parseExtensionDialogRequest("s1", {
      id: "dialog-2",
      method: "notify",
      message: "Heads up",
      notifyType: "warning",
    });

    expect(request?.title).toBe("Extension notice");
    expect(request ? extensionDialogBodyText(request) : "").toBe("Heads up");
    expect(request ? formatExtensionDialogNotification(request) : "").toBe("warning: Heads up");
  });
});
