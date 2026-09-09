import { afterEach, describe, expect, it, vi } from "vitest";
import hljs from "highlight.js/lib/common";
import { createDiffHighlighter, DIFF_HIGHLIGHT_LIMITS } from "./diffHighlight";
import type { DiffHighlightRow } from "./diffHighlight";

function row(text: string, kind: DiffHighlightRow["kind"] = "context", path = "src/lib.rs"): DiffHighlightRow {
  return { text, kind, prefixLength: kind === "meta" ? 0 : 1, oldPath: path, newPath: path };
}
function render(rows: DiffHighlightRow[]): HTMLElement[] {
  const highlighter = createDiffHighlighter(rows, document);
  return rows.map((_, index) => {
    const node = document.createElement("code");
    highlighter.renderLine(index, node);
    return node;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("diff syntax and intraline composition", () => {
  it("preserves Rust attributes, lifetimes, generic types, macros and exact source", () => {
    const rows = [
      row(" #[derive(Debug)]"),
      row(" pub fn borrow<'a>(text: &'a str) -> Option<u32> {"),
      row('     println!("hello");'),
      row("     let value = Some(42);"),
      row(" }"),
    ];
    const nodes = render(rows);
    expect(nodes.map((node) => node.textContent)).toEqual(rows.map((row) => row.text));
    expect(nodes[0].querySelector(".hljs-meta")?.textContent).toContain("derive");
    expect([...nodes[1].querySelectorAll(".hljs-keyword")].map((node) => node.textContent)).toEqual(expect.arrayContaining(["pub", "fn"]));
    expect([...nodes[1].querySelectorAll(".hljs-type")].map((node) => node.textContent)).toEqual(expect.arrayContaining(["Option", "u32"]));
    expect([...nodes[1].querySelectorAll(".hljs-symbol")].map((node) => node.textContent)).toContain("'a");
    expect(nodes[2].querySelector(".hljs-built_in")?.textContent).toBe("println!");
    expect(nodes[3].querySelector(".hljs-number")?.textContent).toBe("42");
  });

  it("keeps multiline comments, ordinary strings and raw strings within one fragment", () => {
    const rows = [
      row(" /* note"),
      row(" pub fn inside_comment() {}"),
      row(" */"),
      row(' let text = "first'),
      row(" pub fn inside_string() {}"),
      row(' last";'),
      row(' let raw = r##"first'),
      row(" pub fn inside_raw() {}"),
      row(' last"##;'),
      row(" pub fn outside() {}"),
    ];
    const nodes = render(rows);
    expect(nodes[1].querySelector(".hljs-comment")?.textContent).toContain("pub fn inside_comment");
    for (const index of [4, 7]) {
      expect(nodes[index].querySelector(".hljs-string")?.textContent).toContain("pub fn inside_");
      expect(nodes[index].querySelector(".hljs-keyword")).toBeNull();
    }
    expect(nodes[9].querySelector(".hljs-keyword")?.textContent).toBe("pub");
    expect(nodes.map((node) => node.textContent)).toEqual(rows.map((row) => row.text));
  });

  it("separates removed and added multiline contexts and resets at hunk boundaries", () => {
    const rows = [
      row("-/* removed opener", "remove"),
      row("+// new line comment", "add"),
      row(" pub fn visible() {}"),
      row("@@ -90 +90 @@", "meta"),
      row(" pub fn next_hunk() {}"),
    ];
    const nodes = render(rows);
    expect(nodes[0].querySelector(".hljs-comment")).not.toBeNull();
    expect(nodes[2].querySelector(".hljs-keyword")?.textContent).toBe("pub");
    expect(nodes[4].querySelector(".hljs-keyword")?.textContent).toBe("pub");
  });

  it("treats object-prototype extension names as unknown languages", () => {
    const rows = [row("+let value = 1;", "add", "file.constructor"), row("+let value = 2;", "add", "file.__proto__")];
    const nodes = render(rows);
    expect(nodes.map((node) => node.textContent)).toEqual(rows.map((row) => row.text));
    expect(nodes.every((node) => !node.querySelector(".diff-syntax"))).toBe(true);
  });

  it("keys cached tokens by full context, not just an unchanged displayed line", () => {
    const target = row(" pub fn same_line() {}");
    const comment = render([row(" /* first context"), target]);
    const code = render([row(" // changed context"), target]);
    expect(comment[1].querySelector(".hljs-comment")).not.toBeNull();
    expect(code[1].querySelector(".hljs-comment")).toBeNull();
    expect(code[1].querySelector(".hljs-keyword")?.textContent).toBe("pub");
  });

  it("leaves unknown languages, malformed prefixes and oversized inputs exactly plain", () => {
    const cases = [
      [row("+pub fn unknown() {}", "add", "file.unknown")],
      [{ ...row("+let x = 1;", "add"), prefixLength: -1 }],
      [row(`+let x = "${"a".repeat(DIFF_HIGHLIGHT_LIMITS.maxLineCodeUnits)}";`, "add")],
      Array.from({ length: DIFF_HIGHLIGHT_LIMITS.maxFragmentLines + 1 }, () => row(" let x = 1;")),
      Array.from({ length: DIFF_HIGHLIGHT_LIMITS.maxRows + 1 }, () => row(" let x = 1;")),
    ];
    for (const rows of cases) {
      const nodes = render(rows);
      expect(nodes.map((node) => node.textContent)).toEqual(rows.map((row) => row.text));
      expect(nodes.every((node) => !node.querySelector(".diff-syntax"))).toBe(true);
    }
  });

  it("never interprets HTML-like source as elements or normalizes whitespace", () => {
    const rows = [row(' let html = "<img src=x onerror=alert(1)><script>bad()</script>";'), row(' \tlet odd = "\u0000 & < > \\"";\r')];
    const nodes = render(rows);
    expect(nodes.map((node) => node.textContent)).toEqual(rows.map((row) => row.text));
    expect(nodes.every((node) => !node.querySelector("img, script, [onerror]"))).toBe(true);
  });

  it("does not intraline-pair multi-row edits, separate hunks, equal or unrelated lines", () => {
    const cases = [
      [row("-let a = 1;", "remove"), row("-let b = 2;", "remove"), row("+let a = 3;", "add"), row("+let b = 4;", "add")],
      [row("-let a = 1;", "remove"), row("@@ -9 +9 @@", "meta"), row("+let a = 2;", "add")],
      [row("-let a = 1;", "remove"), row("+let a = 1;", "add")],
      [row("-foo(x);", "remove"), row("+bar(y);", "add")],
    ];
    for (const rows of cases) {
      const nodes = render(rows);
      expect(nodes.every((node) => !node.querySelector(".diff-intraline-add, .diff-intraline-remove"))).toBe(true);
      expect(nodes.map((node) => node.textContent)).toEqual(rows.map((row) => row.text));
    }
  });

  it("composes syntax and Unicode-safe changed ranges without highlighting prefixes", () => {
    const rows = [row('-let icon = "👩🏽‍💻 old";\t', "remove"), row('+let icon = "👩🏽‍💻 new";\t', "add")];
    const nodes = render(rows);
    expect(nodes[0].querySelector(".hljs-string.diff-intraline-remove")?.textContent).toBe("old");
    expect(nodes[1].querySelector(".hljs-string.diff-intraline-add")?.textContent).toBe("new");
    expect(nodes.map((node) => node.textContent)).toEqual(rows.map((row) => row.text));
    expect(nodes[1].querySelector(".diff-prefix")?.textContent).toBe("+");
  });

  it("stops additional fragments when the measured work budget is exhausted", () => {
    let tick = 0;
    vi.spyOn(performance, "now").mockImplementation(() => tick++ * DIFF_HIGHLIGHT_LIMITS.maxWorkMs);
    const rows = [row(" let timed_one = 1;"), row("@@ next @@", "meta"), row(" let timed_two = 2;")];
    const nodes = render(rows);
    expect(nodes[2].querySelector(".diff-syntax")).toBeNull();
    expect(nodes.map((node) => node.textContent)).toEqual(rows.map((row) => row.text));
  });

  it("evicts cached syntax by payload bytes rather than retaining unbounded source", () => {
    // Real highlighter, fixed clock: eviction must not depend on runner CPU load.
    vi.spyOn(performance, "now").mockReturnValue(0);
    const calls = vi.spyOn(hljs, "highlight");
    const makeRows = (id: number) => [row(` /* cache-${id}`), ...Array.from({ length: 4 }, () => row(` ${"x".repeat(3000)}`)), row(" */")];
    render(makeRows(-1));
    const beforeHit = calls.mock.calls.length;
    render(makeRows(-1));
    expect(calls.mock.calls.length).toBe(beforeHit);
    for (let index = 0; index < 100; index++) render(makeRows(index));
    const beforeEvicted = calls.mock.calls.length;
    const restored = render(makeRows(-1));
    expect(calls.mock.calls.length).toBeGreaterThan(beforeEvicted);
    expect(restored[1].querySelector(".hljs-comment")?.textContent).toBe("x".repeat(3000));
  });
});
