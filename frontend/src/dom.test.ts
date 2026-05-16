import { describe, expect, it } from "vitest";
import { mkEl, mkFrag, mkText, reconcileChildren, requireElement, setRenderDocument } from "./dom";

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
