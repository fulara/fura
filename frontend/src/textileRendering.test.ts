import { afterEach, describe, expect, it } from "vitest";

import { renderTextileBlock, setTextileRedmineRootUrl } from "./textileRendering";

function inlineEventHandlerAttributes(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).flatMap(element =>
    Array.from(element.attributes)
      .filter(attribute => attribute.name.toLowerCase().startsWith("on"))
      .map(attribute => `${element.tagName.toLowerCase()}[${attribute.name}]`),
  );
}

function javascriptHrefValues(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .map(anchor => anchor.getAttribute("href") ?? "")
    .filter(href => href.trim().toLowerCase().startsWith("javascript:"));
}

afterEach(() => {
  setTextileRedmineRootUrl(null);
});

describe("renderTextileBlock", () => {
  it("preserves Textile heading levels as semantic headings", () => {
    const node = renderTextileBlock("h3. Foo");

    expect(node.querySelector("h3")?.textContent).toBe("Foo");
    expect(node.querySelector("h1, h2, h4, h5, h6")).toBeNull();
  });

  it("renders bold text, inline code, and lists as semantic elements", () => {
    const node = renderTextileBlock("This is *bold* and @code@.\n\n* first\n* second");

    expect(node.querySelector("strong")?.textContent).toBe("bold");
    expect(node.querySelector("code")?.textContent).toBe("code");
    expect(Array.from(node.querySelectorAll("ul > li")).map(item => item.textContent?.trim())).toEqual([
      "first",
      "second",
    ]);
  });

  it("leaves Redmine issue references as text until a root URL is configured", () => {
    const node = renderTextileBlock("Plain #19794");
    const preview = node.querySelector<HTMLElement>(".textile-preview")!;

    expect(preview.querySelector("a")).toBeNull();
    expect(preview.textContent).toContain("#19794");
  });

  it("links plain Redmine issue references from the configured root without rewriting code or existing links", () => {
    setTextileRedmineRootUrl("https://redmine.example.test/");
    const node = renderTextileBlock(`Plain #19794, inline code @#123@, and an authored link "#456":https://example.test/original.`);
    const preview = node.querySelector<HTMLElement>(".textile-preview")!;

    const redmineLink = preview.querySelector<HTMLAnchorElement>('a[href="https://redmine.example.test/issues/19794"]');
    expect(redmineLink?.textContent).toBe("#19794");
    expect(redmineLink?.href).toBe("https://redmine.example.test/issues/19794");
    expect(redmineLink?.target).toBe("_blank");
    expect(redmineLink?.rel).toBe("noopener");

    const code = preview.querySelector("code");
    expect(code?.textContent).toBe("#123");
    expect(code?.querySelector("a")).toBeNull();

    const authoredLink = Array.from(preview.querySelectorAll<HTMLAnchorElement>("a")).find(
      anchor => anchor.textContent === "#456",
    );
    expect(authoredLink?.href).toBe("https://example.test/original");
    expect(preview.querySelector('a[href="https://redmine.example.test/issues/456"]')).toBeNull();
  });

  it("sanitizes active content from Textile output before inserting HTML", () => {
    const node = renderTextileBlock(`h3. Safe title

<script>alert("owned")</script>
<img src="x" onerror="alert('owned')">
<a href="javascript:alert('owned')" onclick="alert('owned')">raw attack</a>
"textile attack":javascript:alert('owned')`);

    expect(node.querySelector("script")).toBeNull();
    expect(inlineEventHandlerAttributes(node)).toEqual([]);
    expect(javascriptHrefValues(node)).toEqual([]);
    expect(node.textContent).toContain("Safe title");
  });

  it("returns safe content for empty or malformed Textile input", () => {
    const empty = renderTextileBlock("");
    expect(empty).toBeInstanceOf(HTMLElement);
    expect(empty.textContent?.trim()).toBe("");
    expect(empty.querySelector("script")).toBeNull();
    expect(inlineEventHandlerAttributes(empty)).toEqual([]);
    expect(javascriptHrefValues(empty)).toEqual([]);

    let malformed: HTMLElement | undefined;
    expect(() => {
      malformed = renderTextileBlock("h3. <span onclick=alert(1)>unterminated");
    }).not.toThrow();
    expect(malformed).toBeInstanceOf(HTMLElement);
    if (!(malformed instanceof HTMLElement)) {
      throw new Error("Expected malformed Textile to render to an HTMLElement");
    }
    expect(malformed.querySelector("script")).toBeNull();
    expect(inlineEventHandlerAttributes(malformed)).toEqual([]);
    expect(javascriptHrefValues(malformed)).toEqual([]);
  });
});
