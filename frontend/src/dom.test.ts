import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard, mkEl, mkFrag, mkText, reconcileChildren, requireElement, setRenderDocument } from "./dom";

describe("render document helpers", () => {
  it("creates nodes in the configured render document", () => {
    const owner = document.implementation.createHTMLDocument("popout");
    setRenderDocument(owner);

    const element = mkEl("section");
    const text = mkText("hello");
    const fragment = mkFrag();

    expect(element.ownerDocument).toBe(owner);
    expect(text.ownerDocument).toBe(owner);
    expect(fragment.ownerDocument).toBe(owner);
  });

  it("can be reset to the main document", () => {
    setRenderDocument(document);

    expect(mkEl("div").ownerDocument).toBe(document);
  });
});

describe("reconcileChildren", () => {
  it("keeps nodes already in the desired position attached", () => {
    const container = document.createElement("div");
    const first = document.createElement("span");
    const second = document.createElement("span");
    container.append(first, second);

    reconcileChildren(container, [first, second]);

    expect([...container.childNodes]).toEqual([first, second]);
  });

  it("moves, inserts, and removes only where needed", () => {
    const container = document.createElement("div");
    const first = document.createElement("span");
    const second = document.createElement("span");
    const stale = document.createElement("span");
    const inserted = document.createElement("span");
    container.append(first, second, stale);

    reconcileChildren(container, [second, inserted, first]);

    expect([...container.childNodes]).toEqual([second, inserted, first]);
    expect(stale.parentNode).toBeNull();
  });
});

describe("requireElement", () => {
  it("returns an element from the provided document", () => {
    const owner = document.implementation.createHTMLDocument("owner");
    const target = owner.createElement("button");
    target.id = "submit";
    owner.body.append(target);

    expect(requireElement<HTMLButtonElement>("submit", owner)).toBe(target);
  });

  it("throws a clear error for missing elements", () => {
    expect(() => requireElement("missing", document.implementation.createHTMLDocument("empty"))).toThrow("#missing missing");
  });
});

describe("copyTextToClipboard", () => {
  type MutableExecDoc = { execCommand?: (command: string) => boolean };
  const hadExecCommand = "execCommand" in document;

  function stubExecCommand(result: boolean): ReturnType<typeof vi.fn> {
    const exec = vi.fn().mockReturnValue(result);
    (document as unknown as MutableExecDoc).execCommand = exec;
    return exec;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (!hadExecCommand) delete (document as unknown as MutableExecDoc).execCommand;
  });

  it("writes through the owning document's window, not the main window", async () => {
    // A popped-out panel renders into a separate window whose navigator must be used.
    const popoutWrite = vi.fn().mockResolvedValue(undefined);
    const mainWrite = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: mainWrite } });
    const ownerLike = {
      defaultView: { navigator: { clipboard: { writeText: popoutWrite } } },
    } as unknown as Document;

    const ok = await copyTextToClipboard("payload", ownerLike);

    expect(ok).toBe(true);
    expect(popoutWrite).toHaveBeenCalledWith("payload");
    expect(mainWrite).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the clipboard API rejects (e.g. unfocused document)", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Document is not focused.", "NotAllowedError"));
    Object.assign(navigator, { clipboard: { writeText } });
    const exec = stubExecCommand(true);

    const ok = await copyTextToClipboard("payload", document);

    expect(writeText).toHaveBeenCalledWith("payload");
    expect(exec).toHaveBeenCalledWith("copy");
    expect(ok).toBe(true);
    // The temporary textarea must not linger in the DOM.
    expect(document.querySelector("textarea[aria-hidden=\"true\"]")).toBeNull();
  });

  it("falls back to execCommand when no async clipboard is available", async () => {
    Object.assign(navigator, { clipboard: undefined });
    const exec = stubExecCommand(true);

    const ok = await copyTextToClipboard("payload", document);

    expect(exec).toHaveBeenCalledWith("copy");
    expect(ok).toBe(true);
  });

  it("reports failure instead of throwing when every path fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("nope"));
    Object.assign(navigator, { clipboard: { writeText } });
    stubExecCommand(false);

    await expect(copyTextToClipboard("payload", document)).resolves.toBe(false);
  });
});
